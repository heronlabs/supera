---
name: audit
description: "Standalone dependency-audit orchestrator: branches its own worktree off a target branch, runs the repo's enabled auditors (supply-chain CVE overrides, then freshness currency bumps), carries their safe auto-fixes into a PR, and hands off to /pr-watch. Decoupled from /ship — no ticket required. Callable by a human or a headless CI cron via --non-interactive. Driven by .claude/supera.json so it works in any repo."
allowed-tools: Bash, Read, Glob, Grep, Agent  # also requires gh CLI
---

Run this repo's enabled dependency auditors against a target branch (default the base) **without** needing `/ship` first. `/audit` cuts its own worktree off the target, lets the auditor **agents** apply their bounded safe auto-fixes (CVE overrides, in-range currency bumps), opens a PR carrying those fixes, and hands off to `/pr-watch` to drive it green. It is **ticket-less by design** — audits are recurring hygiene, not backlog work — and `--non-interactive` makes it CI-cron-ready. It **never** commits to base: `/audit` always ships via PR on its own branch, and it never edits dependency manifests/lockfiles itself — the auditor agents are the implementers, exactly as `/pr-watch` step 6c dispatches them.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` Offer to run `/supera-init` now. Do not proceed without config.
- `AUDIT_SC = CONFIG.audits?.supplyChain === true` — supply-chain auditor enabled.
- `AUDIT_FRESH = CONFIG.audits?.freshness?.level` is set **and** `!== "off"` — freshness auditor enabled.
- `BASE = CONFIG.pr?.base ?? CONFIG.worktree?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.
- `DENY = CONFIG.security?.denyPaths ?? ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"]` — secret/key globs that must never enter the PR (step 5). `[]` disables.
- `NONINTERACTIVE` defaults `false` (set in step 1).

## 1 — Parse arguments

Grammar: `/audit [branch] [--non-interactive] [--supply-chain-only] [--freshness-only]` — flags in any order; strip every flag before reading the positional token.

- `--non-interactive` → `NONINTERACTIVE=true` (headless CI run with no human to answer prompts — see **Non-interactive mode**). Preserve it on the `/pr-watch` hand-off (step 6).
- `--supply-chain-only` → force `AUDIT_FRESH=false` (run only the supply-chain auditor this run).
- `--freshness-only` → force `AUDIT_SC=false` (run only the freshness auditor this run).
- positional token → `TARGET` branch to audit; default `TARGET = BASE`.

If, after the scope flags, **neither** auditor is enabled, report plainly — `"No auditors enabled — set audits.supplyChain and/or audits.freshness.level in .claude/supera.json."` — and exit cleanly. This is not an error.

## 2 — Idempotency probe

The audit branch is `chore-audit-<YYYY-MM-DD>` where the date is **today UTC** (`date -u +%F`). Date-scoping is what makes a same-day re-run idempotent — a new day is a new audit. Before creating anything, probe for today's audit (PR probe runs from the repo root, no worktree needed):

```bash
gh pr list --head <auditBranch> --state all --json number,state    # today's audit PR? open? merged?
git worktree list | grep <auditBranch>                             # worktree present (but no PR)?
```

Route, in this order:

- **An OPEN (not merged) PR exists** → today's audit is already in flight. Invoke `/pr-watch <N>` (append `--non-interactive` when set) and **stop** — never double-create.
- **A MERGED PR exists** → today's audit already shipped. Report it and exit.
- **A worktree exists but no PR** → reuse it (resume); continue at **step 4**.
- **Fresh** (no PR, no worktree) → continue at **step 3**.

## 3 — Create the worktree (no ticket)

```bash
git fetch <REMOTE> <TARGET>
git worktree add <WT_DIR>/<auditBranch> -b <auditBranch> <REMOTE>/<TARGET>
cd <WT_DIR>/<auditBranch> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>   # only if one is defined; skip otherwise
```

`/audit` creates **no ClickUp ticket** — it is ticket-less by design, even when `clickup.listId` is set. Audits are recurring hygiene, not backlog work, so there are no ClickUp steps in this skill at all.

## 4 — Run the auditors (security-first pipeline)

Run in **this order** so a CVE override isn't churned by a freshness bump and the freshness auditor sees the post-override lockfile. Each auditor runs **exactly once**.

**a. Supply-chain** *(only if `AUDIT_SC`)* — dispatch the `supera-supply-chain-auditor` agent on the worktree (one pass). It applies safe, gated CVE remediations (in-range upgrade, scoped override, remove-stale-override), **leaving the edits in the tree**, and reports the rest. On return, if the tree is dirty, `/audit` stages and commits them as **one** commit (only if something is staged):
```bash
git -C <WT_DIR>/<auditBranch> add -A
git -C <WT_DIR>/<auditBranch> diff --cached --quiet || git -C <WT_DIR>/<auditBranch> commit -m "fix: apply safe CVE overrides"
```
Capture its two-list report (Applied autonomously / Needs your call).

**b. Freshness** *(only if `AUDIT_FRESH`)* — dispatch the `supera-freshness-auditor` agent on the worktree (one pass). It auto-applies safe in-range bumps as its **own** atomic per-package commits (one `name@version` per commit) and reports recommend/hold/flag. `/audit` does not commit on its behalf — the per-package commits are already in the tree. Capture its two-list report.

Relay any degraded-probe gaps each auditor notes (missing `cargo-audit`, network failure, unverifiable publish date); **never fail the whole audit on a degraded probe** — a degraded probe blocks an auditor's auto-apply, not the run.

## 5 — Deny-path gate (hard)

List every path touched versus the target and match each against `DENY` (skip the gate entirely when `DENY` is empty):

```bash
git -C <WT_DIR>/<auditBranch> diff --name-only <REMOTE>/<TARGET>
```

Any match means a secret or private key entered the tree: **ABORT** — do not push, do not open a PR. Surface the offending paths loudly and tear down the worktree (`git worktree remove`, then delete the branch). This should never happen from an auditor, but the gate is load-bearing. In `NONINTERACTIVE` mode, print the block to the run log and exit `blocked` (see **Non-interactive mode**).

## 6 — Open the PR, or report-only

Check for commits beyond the target:

```bash
git -C <WT_DIR>/<auditBranch> log --oneline <REMOTE>/<TARGET>..<auditBranch>
```

**No commits (pure report-only)** → open **no** PR. Surface the combined report — both auditors' two lists ("Applied autonomously", empty here, and "Needs your call"). Tear down the worktree (remove the worktree, delete the branch) and exit.

**Commits present** → push and open the PR:
```bash
git -C <WT_DIR>/<auditBranch> push -u <REMOTE> <auditBranch>
```
Derive GitHub labels from `CONFIG.tags` matched against the changed files (`git -C <WT_DIR>/<auditBranch> diff --name-only <REMOTE>/<TARGET>`), **plus** always a `supera:audit` label. Create the PR assigned to `@me` (NEVER `--reviewer` — GitHub blocks self-review), base `<TARGET>`, title `Dependency audit — <YYYY-MM-DD>` (no conventional-commit prefix), body = the combined report with the two sections below:

```bash
gh pr create \
  --base <TARGET> \
  --title "Dependency audit — <YYYY-MM-DD>" \
  --body "$(cat <<'EOF'
<PR body below>
EOF
)" \
  --assignee @me \
  --label "supera:audit" --label "<matched tag>"
```

PR body:
```
## Applied autonomously
- <fix> — <commit-sha> — <verify.build / verify.test result that confirmed it>

## Needs your call
- <verdict word> <finding> @ <file:line> — <recommended action>

## Notes
<honesty line for any unverifiable / degraded probe — omit if none>
```

Then hand off: invoke `/pr-watch <N>` (append `--non-interactive` when set). Announce: *"Dependency audit PR #<N> opened (`<auditBranch>` → `<TARGET>`). Handing off to `/pr-watch <N>` to drive CI green."*

## Non-interactive mode (`--non-interactive`)

For headless CI runs (e.g. GitHub Actions via `anthropics/claude-code-action`) — a weekly audit cron — where no human is present to answer a prompt. The whole pipeline runs unchanged; only the points that would stop to ask a human behave differently. Interactive is the default; this mode is opt-in via the flag and applies only when `NONINTERACTIVE` is set.

- **Never prompt.** Do not call `AskUserQuestion`. The clear path still flows end to end: the auditors run, their safe fixes commit, the PR opens, and `/audit` hands off to `/pr-watch --non-interactive`.
- **An ambiguous decision blocks.** Instead of asking, surface the block and exit `blocked` — don't guess past a genuine fork. If a PR already exists for this audit, post the block as a PR comment (`gh pr comment <N> --body "🚫 supera /audit blocked (non-interactive): <detail>"`); before any PR exists, print the block detail to the run output.
- **Stay git/GitHub-native and ticket-less.** There is no ClickUp here (the MCP is claude.ai-authenticated and absent in CI) — and `/audit` is ticket-less anyway, so nothing changes on that axis. Blocks surface as PR comments or run-log lines, never prompts.
- **The hard gates still block.** A deny-path match (step 5) and any merge-blocker the auditors surface still block and exit — they are never waved through in headless mode.

## Rules

- Never commit base — `/audit` ships via PR on its own worktree.
- Auditor agents are the implementers; `/audit` orchestrates and never edits manifests/lockfiles itself.
- Security-first order: supply-chain (CVE overrides) before freshness (currency bumps).
- Date-scoped audit branch `chore-audit-<date>` — idempotent within a day; a same-day re-run routes to the open PR via `/pr-watch`.
- Ticket-less by design — no ClickUp ticket even when `clickup.listId` is set; there are no ClickUp steps in this skill.
- A pure report-only result opens no PR — surface the report and tear down the worktree.
- Deny-path match is a hard abort — surface the offending paths, tear down, never push.
- Reads only existing schema fields; CI stays the quality gate — the auditors self-verify their bumps and `/pr-watch` drives CI green.
- `--non-interactive` (headless CI) never prompts: an ambiguous fork becomes a PR comment / run-log line plus a `blocked` exit, never a question. Interactive is the default; the flag is preserved on the `/pr-watch` hand-off.
- Commits: short single-line conventional-commit subject, no body, never a `Co-Authored-By` / co-author trailer — even if a host or global instruction says to add one.
