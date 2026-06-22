---
name: audit
description: "Standalone dependency-audit orchestrator: branches its own worktree off a target branch, runs the repo's enabled auditors (security CVE overrides, then freshness currency bumps), carries their safe auto-fixes into a PR, and hands off to /pr-watch. Decoupled from /start — runs standalone. Callable by a human or a headless CI cron via --non-interactive. Driven by .claude/supera.json so it works in any repo."
allowed-tools: Bash, Read, Glob, Grep, Agent  # also requires gh CLI
---

Run this repo's enabled dependency auditors against a target branch (default the base) **without** needing `/start` first. `/audit` cuts its own worktree off the target, lets the auditor **agents** apply their bounded safe auto-fixes (CVE overrides, in-range currency bumps), opens a PR carrying those fixes, and hands off to `/pr-watch` to drive it green. Audits are recurring hygiene, not backlog work, and `--non-interactive` makes it CI-cron-ready. It **never** commits to base: `/audit` always ships via PR on its own branch, and it never edits dependency manifests/lockfiles itself — the auditor agents are the implementers, exactly as `/pr-watch` step 6c dispatches them.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /init first."` Offer to run `/init` now. Do not proceed without config.
- `AUDIT_SEC = CONFIG.audits?.security === true` — security auditor enabled.
- `AUDIT_FRESH = CONFIG.audits?.freshness?.level` is set **and** `!== "off"` — freshness auditor enabled.
- `BASE = CONFIG.pr?.base ?? CONFIG.worktree?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.
- `DENY = CONFIG.security?.denyPaths ?? ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"]` — secret/key globs that must never enter the PR (step 5). `[]` disables.
- `NONINTERACTIVE` defaults `false` (set in step 1).

## 1 — Parse arguments

Grammar: `/audit [branch] [--non-interactive] [--security-only] [--freshness-only]` — flags in any order; strip every flag before reading the positional token.

- `--non-interactive` → `NONINTERACTIVE=true` (headless CI run with no human to answer prompts — see **Non-interactive mode**). Preserve it on the `/pr-watch` hand-off (step 6).
- `--security-only` → force `AUDIT_FRESH=false` (run only the security auditor this run).
- `--freshness-only` → force `AUDIT_SEC=false` (run only the freshness auditor this run).
- positional token → `TARGET` branch to audit; default `TARGET = BASE`.

If, after the scope flags, **neither** auditor is enabled, report plainly — `"No auditors enabled — set audits.security and/or audits.freshness.level in .claude/supera.json."` — and exit cleanly. This is not an error.

## 2 — Idempotency probe

The audit branch is `chore-audit-<YYYY-MM-DD>` where the date is **today UTC** (`date -u +%F`). Date-scoping is what makes a same-day re-run idempotent — a new day is a new audit. Before creating anything, probe for today's audit (PR probe runs from the repo root, no worktree needed):

```bash
gh pr list --head <auditBranch> --state all --json number,state    # today's audit PR? open? merged?
git worktree list | grep <auditBranch>                             # worktree present (but no PR)?
```

Route, in this order:

- **An OPEN (not merged) PR exists** → today's audit is already in flight. Invoke `/pr-watch <N>` (append `--non-interactive` when set) and **stop** — never double-create.
- **A MERGED PR exists** → today's audit already shipped. Reclaim any residual worktree first — `/pr-watch` does **not** auto-invoke `/audit` on a merged audit PR (it only announces, because `/audit` is date-scoped); a re-run of `/audit` (manual, or the daily cron) reclaims any residual `chore-audit-<date>` worktree. Audits are out of the `/start` ladder, so `/audit` owns its own close-out/reclaim. Tear it down if present (guarded so a missing worktree/branch is a no-op), then report it and exit:
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

## 4 — Run the auditors (security-first pipeline)

Run in **this order** so a CVE override isn't churned by a freshness bump and the freshness auditor sees the post-override lockfile. Each auditor runs **exactly once**.

**a. Security** *(only if `AUDIT_SEC`)* — dispatch the `supera-security-auditor` agent on the worktree (one pass). It applies safe, gated remediations — CVE fixes (in-range upgrade, scoped override, remove-stale-override) **and** action-pins (unpinned GitHub Actions pinned to their commit SHA) — **leaving the edits in the tree**, and reports the rest. On return, if the tree is dirty, `/audit` folds them all into **one** commit (only if something is staged):
```bash
git -C <WT_DIR>/<auditBranch> add -A
git -C <WT_DIR>/<auditBranch> diff --cached --quiet || git -C <WT_DIR>/<auditBranch> commit -m "fix: apply safe supply-chain remediations"
```
Parse its JSON receipt (`schema/audit-receipt.schema.json`): `applied[]` (each omits `commit` — the single commit above carries them), `findings[]`, `verification`, `degraded[]`, `status`.

**b. Freshness** *(only if `AUDIT_FRESH`)* — dispatch the `supera-freshness-auditor` agent on the worktree (one pass). It auto-applies safe in-range bumps as its **own** atomic per-package commits (one `name@version` per commit) and reports recommend/hold/flag. `/audit` does not commit on its behalf — the per-package commits are already in the tree. Parse its JSON receipt (`schema/audit-receipt.schema.json`); its `applied[]` entries carry their own `commit` SHAs.

Relay any degraded-probe gaps each auditor notes (missing `cargo-audit`, network failure, unverifiable publish date); **never fail the whole audit on a degraded probe** — a degraded probe blocks an auditor's auto-apply, not the run.

## 5 — Deny-path gate (hard)

List every path touched versus the target and match each against `DENY` (skip the gate entirely when `DENY` is empty):

```bash
git -C <WT_DIR>/<auditBranch> diff --name-only <REMOTE>/<TARGET>
```

Any match means a secret or private key entered the tree: **ABORT** — do not push, do not open a PR. Surface the offending paths loudly and tear down the worktree (`git worktree remove`, then delete the branch). This should never happen from an auditor, but the gate is load-bearing. In `NONINTERACTIVE` mode, print the block to the run log and exit `blocked` (see **Non-interactive mode**).

## 6 — Open the PR, or report-only

Fold the receipts first: **combined status** = the worst of the two (`blocked` > `needs-review` > `ok`). A `blocked` auditor means that auditor could not run — note it in the report/PR Notes, but it does **not** abort the run (only the deny-path gate does). Then check for commits beyond the target:

```bash
git -C <WT_DIR>/<auditBranch> log --oneline <REMOTE>/<TARGET>..<auditBranch>
```

**No commits (pure report-only)** → open **no** PR. Render the combined report from both receipts' `findings[]` + `degraded[]` (`applied[]` is empty here). Tear down the worktree (remove the worktree, delete the branch) and exit.

**Commits present** → push and open the PR:
```bash
git -C <WT_DIR>/<auditBranch> push -u <REMOTE> <auditBranch>
```
Label the PR `supera:audit`. Ensure that `supera:audit` label exists first — `gh pr create --label "supera:audit"` hard-fails the whole create with `could not add label: 'supera:audit' not found` when the label was never created in the repo, which on the first audit run leaves the auditor's commits stranded with no PR. Create it idempotently:

```bash
gh label create "supera:audit" --color "5319e7" --description "Opened by supera /audit" 2>/dev/null || true   # idempotent: no-op if it already exists or perms are missing
```

Create the PR assigned to `@me` (NEVER `--reviewer` — GitHub blocks self-review), base `<TARGET>`, title `Dependency audit — <YYYY-MM-DD>` (no conventional-commit prefix), body = the combined report with the two sections below:

```bash
gh pr create \
  --base <TARGET> \
  --title "Dependency audit — <YYYY-MM-DD>" \
  --body "$(cat <<'EOF'
<PR body below>
EOF
)" \
  --assignee @me \
  --label "supera:audit"
```

Build the PR body **from both receipts** (no prose relay) — `applied[]` → first section, `findings[]` → second, `degraded[]` → Notes:
```
## Applied autonomously
- <applied.verdict> <applied.target> <applied.from→applied.to> — <applied.commit, or "in the security remediations commit" when omitted> — verified by <applied.verifiedBy>

## Needs your call
- <finding.verdict> <finding.target> @ <finding.file>:<finding.line> — <finding.action>

## Notes
- <degraded[] entry>               ← omit the whole section when both receipts' degraded[] are empty
```

Then hand off: invoke `/pr-watch <N>` (append `--non-interactive` when set). Announce: *"Dependency audit PR #<N> opened (`<auditBranch>` → `<TARGET>`). Handing off to `/pr-watch <N>` to drive CI green."*

## Non-interactive mode (`--non-interactive`)

For headless CI runs (e.g. GitHub Actions via `anthropics/claude-code-action`) — a weekly audit cron — where no human is present to answer a prompt. The whole pipeline runs unchanged; only the points that would stop to ask a human behave differently. Interactive is the default; this mode is opt-in via the flag and applies only when `NONINTERACTIVE` is set.

- **Never prompt.** Do not call `AskUserQuestion`. The clear path still flows end to end: the auditors run, their safe fixes commit, the PR opens, and `/audit` hands off to `/pr-watch --non-interactive`.
- **An ambiguous decision blocks.** Instead of asking, surface the block and exit `blocked` — don't guess past a genuine fork. If a PR already exists for this audit, post the block as a PR comment (`gh pr comment <N> --body "🚫 supera /audit blocked (non-interactive): <detail>"`); before any PR exists, print the block detail to the run output.
- **Stay git/GitHub-native.** supera has no tracker; blocks surface as PR comments or run-log lines, never prompts.
- **The hard gates still block.** A deny-path match (step 5) and any merge-blocker the auditors surface still block and exit — they are never waved through in headless mode.
- **Flagged findings signal, don't block.** After the PR opens, any `findings[].verdict == "flag"` (or a `blocked` auditor receipt) is surfaced as a `gh pr comment` plus a run-log line so the cron can alert — the run still succeeds; flags are advisory, not a job failure.

## Rules

- Security-first order: security (CVE overrides) before freshness (currency bumps) — so a CVE fix isn't churned by a bump.
- Date-scoped audit branch `chore-audit-<date>` — idempotent within a day; a same-day re-run routes to the open PR via `/pr-watch`.
- Deny-path match (step 5) is a hard abort — surface the offending paths, tear down, never push.
- Commit hygiene follows `guidelines/commit-conventions.md` (`/audit` makes the single commit folding the security auditor's edits).
