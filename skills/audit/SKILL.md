---
name: audit
description: "Standalone dependency-audit orchestrator: branches its own worktree off a target branch, runs the security auditor (CVE overrides, action-pins), carries its safe auto-fixes into a PR, and hands off to /pr-watch. Decoupled from /ship — runs standalone. Callable by a human or a headless CI cron via --non-interactive. Driven by .claude/supera.json so it works in any repo."
allowed-tools: Bash, Read, Glob, Grep, Agent  # also requires gh CLI
---

Run this repo's security auditor against a target branch (default the base) **without** needing `/ship` first. `/audit` cuts its own worktree off the target, lets the auditor **agent** apply its bounded safe auto-fixes (CVE overrides, action-pins), opens a PR carrying those fixes, and hands off to `/pr-watch` to drive it green. Audits are recurring hygiene, not backlog work, and `--non-interactive` makes it CI-cron-ready. It **never** commits to base: `/audit` always ships via PR on its own branch, and it never edits dependency manifests/lockfiles itself — the auditor agent is the implementer, exactly as `/pr-watch` step 6c dispatches it.

`/audit` fills the gaps the mechanical layer can't: Dependabot owns the deterministic version bumps and SHA-currency, while the auditor reasons about scoped transitive overrides, CVE verdicts, and the initial tag→SHA pin (the division of labor is canonical in `guidelines/auditor-base.md`).

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /start first."` Offer to run `/start` now. Do not proceed without config.
- `AUDIT_SEC = CONFIG.audits?.security === true` — security auditor enabled.
- `BASE = CONFIG.pr?.base ?? CONFIG.worktree?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.
- `DENY = CONFIG.security?.denyPaths ?? ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"]` — secret/key globs that must never enter the PR (step 5). `[]` disables.
- `NONINTERACTIVE` defaults `false` (set in step 1).

## 1 — Parse arguments

Grammar: `/audit [branch] [--non-interactive]` — flags in any order; strip every flag before reading the positional token.

- `--non-interactive` → `NONINTERACTIVE=true` (headless CI run with no human to answer prompts — see **Non-interactive mode**). Preserve it on the `/pr-watch` hand-off (step 6).
- positional token → `TARGET` branch to audit; default `TARGET = BASE`.

If the security auditor is not enabled, report plainly — `"Security auditor not enabled — set audits.security in .claude/supera.json."` — and exit cleanly. This is not an error.

## 2 — Idempotency probe

The audit branch is `chore-audit-<YYYY-MM-DD>` where the date is **today UTC** (`date -u +%F`). Date-scoping is what makes a same-day re-run idempotent — a new day is a new audit. Before creating anything, probe for today's audit (PR probe runs from the repo root, no worktree needed):

```bash
gh pr list --head <auditBranch> --state all --json number,state    # today's audit PR? open? merged?
git worktree list | grep <auditBranch>                             # worktree present (but no PR)?
```

Route, in this order:

- **An OPEN (not merged) PR exists** → today's audit is already in flight. Invoke `/pr-watch <N>` (append `--non-interactive` when set) and **stop** — never double-create.
- **A MERGED PR exists** → today's audit already shipped. Reclaim any residual worktree first — `/pr-watch` does **not** auto-invoke `/audit` on a merged audit PR (it only announces, because `/audit` is date-scoped); a re-run of `/audit` (manual, or the weekly cron) reclaims any residual `chore-audit-<date>` worktree. Audits are out of the `/ship` ladder, so `/audit` owns its own close-out/reclaim. Tear it down if present (guarded so a missing worktree/branch is a no-op), then report it and exit:
  ```bash
  git worktree list | grep -q "<WT_DIR>/<auditBranch>" && git worktree remove <WT_DIR>/<auditBranch>          # --force only if it refuses on an unclean tree
  git rev-parse --verify --quiet <auditBranch> >/dev/null && git branch -D <auditBranch>                       # delete the branch if present
  ```
- **A worktree exists but no PR** → reuse it (resume). First `git fetch <REMOTE> <TARGET>` so the deny gate (step 5) and commit/report detection (step 6) diff against a fresh `<REMOTE>/<TARGET>` — step 3's fetch was skipped on this route, and a stale local ref would mis-classify new paths/commits. Then continue at **step 4**.
- **Fresh** (no PR, no worktree) → continue at **step 3**.

## 3 — Create the worktree

```bash
git fetch <REMOTE> <TARGET>
git worktree add <WT_DIR>/<auditBranch> -b <auditBranch> <REMOTE>/<TARGET>
cd <WT_DIR>/<auditBranch> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>   # only if one is defined; skip otherwise
```

## 4 — Run the security auditor

Dispatch the `supera-security-auditor` agent on the worktree (one pass). It applies safe, gated remediations — CVE fixes (in-range upgrade, scoped override, remove-stale-override) **and** action-pins (unpinned GitHub Actions pinned to their commit SHA) — **leaving the edits in the tree**, and reports the rest. On return, if the tree is dirty, `/audit` makes **two** commits — staging the dependency/CVE remediations separately from the GitHub Actions SHA-pins, dependency commit first — so a `workflow`-scope push rejection (step 6) can drop only the action-pins, never the dependency fixes (commit a set only when it has staged changes):
```bash
git -C <WT_DIR>/<auditBranch> add -A -- . ':!.github/workflows'                       # deps: lockfiles, manifests, overrides — everything except workflow files
git -C <WT_DIR>/<auditBranch> diff --cached --quiet || git -C <WT_DIR>/<auditBranch> commit -m "fix: apply safe dependency remediations"
git -C <WT_DIR>/<auditBranch> add -A -- .github/workflows                             # action-pins: the auditor's only workflow-file edits
git -C <WT_DIR>/<auditBranch> diff --cached --quiet || git -C <WT_DIR>/<auditBranch> commit -m "ci: pin github actions to sha"
```
Parse its JSON receipt (`schema/audit-receipt.schema.json`): `applied[]` (each omits `commit` — the commits above carry them: `pin-action` verdicts ride the action-pin commit, the rest the dependency commit), `findings[]`, `verification`, `degraded[]`, `status`.

Relay any degraded-probe gaps the auditor notes (missing `cargo-audit`, network failure); **never fail the whole audit on a degraded probe** — a degraded probe blocks the auditor's auto-apply, not the run.

## 5 — Deny-path gate (hard)

List every path touched versus the target and match each against `DENY` (skip the gate entirely when `DENY` is empty):

```bash
git -C <WT_DIR>/<auditBranch> diff --name-only <REMOTE>/<TARGET>
```

Any match means a secret or private key entered the tree: **ABORT** — do not push, do not open a PR. Surface the offending paths loudly and tear down the worktree (`git worktree remove`, then delete the branch). This should never happen from an auditor, but the gate is load-bearing. In `NONINTERACTIVE` mode, print the block to the run log and exit `blocked` (see **Non-interactive mode**).

## 6 — Open the PR, or report-only

Read the receipt's `status` (`ok` / `needs-review` / `blocked`). A `blocked` receipt means the auditor could not run — note it in the report/PR Notes, but it does **not** abort the run (only the deny-path gate does). Then check for commits beyond the target:

```bash
git -C <WT_DIR>/<auditBranch> log --oneline <REMOTE>/<TARGET>..<auditBranch>
```

**No commits (pure report-only)** → open **no** PR. Render the report from the receipt's `findings[]` + `degraded[]` (`applied[]` is empty here). **Emit the durable step-summary** (see **Durable step summary** below) on the report-only branch, then tear down the worktree (remove the worktree, delete the branch) and exit.

**Commits present** → push the commits **in order**, then open the PR. Push the dependency-remediation commit first — it must succeed with a plain `GITHUB_TOKEN` — then the action-pin commit on top (it is `HEAD`, committed last in step 4). A `403` / `workflow`-scope rejection on the **second** push is the documented graceful degradation: the dependency fixes already landed, so record the dropped action-pins (`ACTION_PINS_DROPPED`) and carry on — never fail the run on it.
```bash
if git -C <WT_DIR>/<auditBranch> diff-tree --no-commit-id --name-only -r HEAD | grep -q '^\.github/workflows/'; then
  # HEAD is the action-pin commit. Land the dependency history first (skip when action-pins are the only commit).
  if [ "$(git -C <WT_DIR>/<auditBranch> rev-parse HEAD~1)" != "$(git -C <WT_DIR>/<auditBranch> rev-parse <REMOTE>/<TARGET>)" ]; then
    git -C <WT_DIR>/<auditBranch> push <REMOTE> HEAD~1:refs/heads/<auditBranch>           # dependency remediations — must succeed with GITHUB_TOKEN
  fi
  git -C <WT_DIR>/<auditBranch> push <REMOTE> HEAD:refs/heads/<auditBranch> || ACTION_PINS_DROPPED=1   # action-pins — 403 ⇒ no `workflow` scope ⇒ graceful
else
  git -C <WT_DIR>/<auditBranch> push -u <REMOTE> <auditBranch>                            # dependency remediations only — no action-pins to push
fi
```
**If the action-pins were the only fix and that second push was rejected** (`ACTION_PINS_DROPPED` set with no dependency commit pushed), nothing reached the remote: open **no** PR. Surface the dropped action-pins on the run log and in the durable step summary (as the report-only path does), tear down the worktree, and exit — the run still succeeds. Otherwise the dependency commit landed: continue and open the PR, and when `ACTION_PINS_DROPPED` is set add the dropped-action-pins line to the PR body **Notes** (below) and a run-log line.

Label the PR `supera:audit`. Ensure that `supera:audit` label exists first — `gh pr create --label "supera:audit"` hard-fails the whole create with `could not add label: 'supera:audit' not found` when the label was never created in the repo, which on the first audit run leaves the auditor's commits stranded with no PR. Create it idempotently:

```bash
gh label create "supera:audit" --color "5319e7" --description "Opened by supera /audit" 2>/dev/null || true   # idempotent: no-op if it already exists or perms are missing
```

Create the PR assigned to `@me` (NEVER `--reviewer` — GitHub blocks self-review), base `<TARGET>`, title `Dependency audit — <YYYY-MM-DD>` (no conventional-commit prefix), body = the report with the two sections below:

```bash
gh pr create \
  --base <TARGET> \
  --head <auditBranch> \
  --title "Dependency audit — <YYYY-MM-DD>" \
  --body "$(cat <<'EOF'
<PR body below>
EOF
)" \
  --assignee @me \
  --label "supera:audit"
```

Build the PR body **from the receipt** (no prose relay) — `applied[]` → first section, `findings[]` → second, `degraded[]` → Notes:
```
## Applied autonomously
- <applied.verdict> <applied.target> <applied.from→applied.to> — verified by <applied.verifiedBy>

## Needs your call
- <finding.verdict> <finding.target> @ <finding.file>:<finding.line> — <finding.action>

## Notes
- <degraded[] entry>
- GitHub Actions SHA-pins could not be pushed — the checkout `GITHUB_TOKEN` lacks `workflow` scope; set `SUPERA_AUDIT_TOKEN` to land them. The dependency remediations above still landed.   ← only when ACTION_PINS_DROPPED
```
Omit the whole **Notes** section when the receipt's `degraded[]` is empty **and** the action-pins pushed cleanly.

Once the PR exists, **emit the durable step-summary** (see **Durable step summary** below) on the PR-opened branch. Then hand off: invoke `/pr-watch <N>` (append `--non-interactive` when set). Announce: *"Dependency audit PR #<N> opened (`<auditBranch>` → `<TARGET>`). Handing off to `/pr-watch <N>` to drive CI green."*

### Semantic metrics file

At the end of the run — PR-opened or report-only — write `.supera/metrics/run.json` in the audit worktree capturing **how** the audit went: counts and enums only, never paths, prose, or the finding text. Match `schema/metrics-event.schema.json`'s `semantic` object: `files_changed_count` (the count from `git -C <WT_DIR>/<auditBranch> diff --name-only <REMOTE>/<TARGET>`) and `loc_delta` (net lines, from `... diff --numstat <REMOTE>/<TARGET>` summed as added − removed), and — only when the run aborts on the deny-path gate (step 5) — `blocked_reason_category: "other"`. Omit any field you don't have. The telemetry CI emit merges this into the run event and the local SessionEnd hook reads it — both keep the privacy invariant; it is a transient artifact, never staged or committed (the deny gate diffs against the target, so write it after that gate passes).

```bash
mkdir -p <WT_DIR>/<auditBranch>/.supera/metrics
cat > <WT_DIR>/<auditBranch>/.supera/metrics/run.json <<EOF
{"files_changed_count":<count>,"loc_delta":<net>}
EOF
```

### Durable step summary

Keep the local terminal render unchanged — it is the interactive outcome. **Additionally**, when running under GitHub Actions (`$GITHUB_STEP_SUMMARY` is set), append a markdown report of the run's outcome to that file so every headless `/audit` leaves a durable artifact in the run's summary. This is gated on **CI presence**, not `NONINTERACTIVE` — guard it with `[ -n "$GITHUB_STEP_SUMMARY" ]` so local interactive runs are untouched. Both step-6 exit paths emit it: the report-only path before teardown, the PR-opened path after the PR is created. Build it from the receipt fields already parsed (`applied[]`, `findings[]`, `degraded[]`, `status`), reusing the PR-body section structure.

**PR-opened** (commits present):

```bash
[ -n "$GITHUB_STEP_SUMMARY" ] && cat >> "$GITHUB_STEP_SUMMARY" <<EOF
## 🛡️ Dependency audit — <YYYY-MM-DD>

✅ PR #<N> opened (\`<auditBranch>\` → \`<TARGET>\`)

### Applied autonomously
- <applied.verdict> <applied.target> <applied.from→applied.to> — verified by <applied.verifiedBy>

### Needs your call
- <finding.verdict> <finding.target> @ <finding.file>:<finding.line> — <finding.action>

### Notes
- ⚠️ GitHub Actions SHA-pins could not be pushed (no \`workflow\` scope — set \`SUPERA_AUDIT_TOKEN\`); the dependency remediations still landed.   ← only when ACTION_PINS_DROPPED
EOF
```

**Report-only** (no commits):

```bash
[ -n "$GITHUB_STEP_SUMMARY" ] && cat >> "$GITHUB_STEP_SUMMARY" <<EOF
## 🛡️ Dependency audit — <YYYY-MM-DD>

📋 Report-only — no PR opened

Why no PR: <nothing auto-appliable / all findings need your call / clean>

### Needs your call
- <finding.verdict> <finding.target> @ <finding.file>:<finding.line> — <finding.action>

### Notes
- <degraded[] entry>
EOF
```

Omit the **Applied autonomously** / **Needs your call** / **Notes** subsection when its receipt array is empty (mirror the PR-body rule); omit the PR-opened **Notes** line unless `ACTION_PINS_DROPPED` is set. For a clean report-only run with no findings, the heading + `📋 Report-only` line + "Why no PR: clean" suffice.

## Non-interactive mode (`--non-interactive`)

For headless CI runs (e.g. GitHub Actions via `anthropics/claude-code-action`) — a weekly audit cron — where no human is present to answer a prompt. The whole pipeline runs unchanged; only the points that would stop to ask a human behave differently. Interactive is the default; this mode is opt-in via the flag and applies only when `NONINTERACTIVE` is set.

- **Never prompt.** Do not call `AskUserQuestion`. The clear path still flows end to end: the auditor runs, its safe fixes commit, the PR opens, and `/audit` hands off to `/pr-watch --non-interactive`.
- **An ambiguous decision blocks.** Instead of asking, surface the block and exit `blocked` — don't guess past a genuine fork. If a PR already exists for this audit, post the block as a PR comment (`gh pr comment <N> --body "🚫 supera /audit blocked (non-interactive): <detail>"`); before any PR exists, print the block detail to the run output.
- **Stay git/GitHub-native.** supera has no tracker; blocks surface as PR comments or run-log lines, never prompts.
- **The hard gates still block.** A deny-path match (step 5) and any merge-blocker the auditor surfaces still block and exit — they are never waved through in headless mode.
- **Flagged findings signal, don't block.** After the PR opens, any `findings[].verdict == "flag"` (or a `blocked` auditor receipt) is surfaced as a `gh pr comment` plus a run-log line so the cron can alert — the run still succeeds; flags are advisory, not a job failure.
- **Every run leaves a durable summary.** Both step-6 paths write the markdown outcome report to `$GITHUB_STEP_SUMMARY` (step 6, **Durable step summary**) — gated on CI presence, not this flag, so it fires in headless and interactive CI runs alike and is the report-only run's durable artifact when no PR opens.

## Rules

- Date-scoped audit branch `chore-audit-<date>` — idempotent within a day; a same-day re-run routes to the open PR via `/pr-watch`.
- Deny-path match (step 5) is a hard abort — surface the offending paths, tear down, never push.
- Every CI run leaves a durable outcome — both step-6 paths append the markdown report to `$GITHUB_STEP_SUMMARY` (gated on CI presence, guarded by `[ -n "$GITHUB_STEP_SUMMARY" ]`); the local terminal render is unchanged.
- Commit hygiene follows `guidelines/commit-conventions.md` (`/audit` commits the security auditor's edits — dependency remediations first, action-pins second — and pushes them in order so a `workflow`-scope rejection drops only the action-pins).
