---
name: pr-watch
description: "Repo-agnostic PR babysitter: monitors CI, fixes failures via supera-engineer, addresses review comments, runs one code-review cycle, and exits when the branch is green, synced with the base, and all threads resolved. Keeps the ClickUp ticket in sync when one is linked."
allowed-tools: Bash, Read, Glob, Grep, Agent  # also requires gh CLI and clickup_* MCP tools
---

Monitor an open PR until it is ready to merge, in any repo. Watch CI, fix failures, address review comments, run one code review — exit when everything is green and resolved. Reads `.claude/supera.json` for the install/build/test/lint commands used to reproduce failures. Keeps the ClickUp ticket in sync when `--clickup-ticket` is supplied.

## 0 — Load config

Read `.claude/supera.json` into `CONFIG` (for `verify.*` commands and `pr.base`/`pr.remote`). If absent, proceed with sensible git/gh defaults and skip any config-derived command (tell the user once that supera isn't initialised here).

Resolve `STATUS` once from `CONFIG.clickup?.statuses ?? {}` with defaults: `STATUS.review = …?.review ?? "in review"`, `STATUS.blocked = …?.blocked ?? "blocked"`, `STATUS.rejected = …?.rejected ?? "rejected"`. Set ticket status only via `STATUS.<key>`.

## 1 — Resolve the PR

Parse `$ARGUMENTS` (flags in any order):
- A number → the PR number.
- `--reviewed` → `REVIEWED=true` (code review already done this cycle).
- `--clickup-ticket=<id>` → `CLICKUP_TICKET=<id>`.
- Empty → detect from branch: `gh pr view --json number -q .number`.
- Neither works → ask the user.

`REVIEWED` defaults `false`; `CLICKUP_TICKET` defaults empty (ticket updates skipped when absent).

```bash
PR=<number>
BRANCH=$(gh pr view $PR --json headRefName -q .headRefName)
BASE=${CONFIG.pr.base:-$(gh pr view $PR --json baseRefName -q .baseRefName)}
```

## 2 — Check current state

```bash
gh pr view $PR --json number,title,state,mergeable,reviewThreads,statusCheckRollup,headRefName,baseRefName
```
Parse `state`:
- `MERGED` → **do not close here** — `/ship` owns the close + teardown + summary. Announce: *"PR #<N> is merged — run `/ship <branch>` to close the ticket, summarise, and clean up the worktree."* Exit.
- `CLOSED` (not merged) → if `CLICKUP_TICKET` set, `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.rejected)`; surface it; announce; exit.
- Otherwise continue with `statusCheckRollup` (step 3) and `reviewThreads` (step 4).

## 3 — CI gate

### Running or queued
Don't wait inline. Reschedule preserving flags, then exit the turn:
```
ScheduleWakeup(delaySeconds=90, reason="CI still running on PR #<N>", prompt="/pr-watch <N> [--reviewed if true] [--clickup-ticket=<id> if set]")
```

### Passed
If `CLICKUP_TICKET` set, assert the ticket is at `STATUS.review` — `/ship` already set it at push, so only update if it drifted: `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.review)`. Proceed to step 4.

### Failed
Identify and read the failing job:
```bash
RUN_ID=$(gh run list --branch $BRANCH --limit 1 --json databaseId -q '.[0].databaseId')
gh run view $RUN_ID --json jobs -q '.jobs[] | select(.conclusion=="failure") | {name:.name, steps:[.steps[]|select(.conclusion=="failure")]}'
gh run view $RUN_ID --log-failed
```

Classify and fix:
| Failure | Action |
|---|---|
| Build / typecheck / test / lint error | Delegate to `supera-engineer` with the exact log excerpt + the relevant `CONFIG.verify.*` command to reproduce locally. |
| Install / lockfile drift | Run `CONFIG.verify.install` in the worktree, commit the updated lockfile. |
| Migration / runtime error | Delegate to `supera-engineer` with the full stack trace. |
| Clearly transient (network, runner OOM) | Note it; a re-run is acceptable here only. |
| Unknown | Show the user; ask for guidance. |

Dispatch `supera-engineer` with the exact log excerpt; wait for the fix. **Track attempts — if the same failure repeats after 2 fix attempts:** if `CLICKUP_TICKET` set, `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.blocked)`; stop; show the full log; ask for guidance; exit the turn.

After a fix:
```bash
git push <CONFIG.pr.remote:-origin> $BRANCH
```
Reschedule (preserve flags) and exit:
```
ScheduleWakeup(delaySeconds=120, reason="CI re-run after fix on PR #<N>", prompt="/pr-watch <N> [flags]")
```

## 4 — Review comments

```bash
gh pr view $PR --json reviewThreads -q '[.reviewThreads[] | select(.isResolved==false)]'
```
For each unresolved thread:
1. Read `path`, `line`, `body`.
2. Classify:
   - **Clear code request** (rename, extract, null check, add test) → delegate to `supera-engineer` with the file + the request.
   - **Question / design discussion** → do NOT implement; surface to the user.
3. After implementing, push first, then reply referencing the pushed commit:
```bash
git push <remote> $BRANCH
gh pr review $PR --comment --body "Addressed in <commit-sha>: <one-line summary>"
```
Reschedule (preserve flags) and exit:
```
ScheduleWakeup(delaySeconds=120, reason="CI after addressing review on PR #<N>", prompt="/pr-watch <N> [flags]")
```

## 5 — Done check

Ready for the review cycle when all three hold:
- Every `statusCheckRollup` check is `SUCCESS` or `SKIPPED`.
- Zero unresolved `reviewThreads`.
- `mergeable` is `MERGEABLE` (not `CONFLICTING`).

**`REVIEWED=true`** → announce *"PR #<N> is green, reviewed, all threads resolved — ready to merge."* Exit.
**`REVIEWED=false`** → proceed to step 6.

**Merge conflicts** (`mergeable == CONFLICTING`):
```bash
git fetch <remote> $BASE
git rebase <remote>/$BASE
```
Delegate conflict resolution to `supera-engineer` with the conflicting file list. Push `--force-with-lease`. Reschedule (preserve flags) and exit.

## 6 — Code review

Invoke the `code-review:code-review` skill on PR `#<N>` (one cycle only). For each finding:
- **Actionable** (bug, missing null check, wrong type, test gap) → delegate to `supera-engineer`; wait.
- **Trivial nit** → apply directly if it's a one-liner; skip if subjective.
- **Design concern** → surface to the user; do not implement without confirmation.

After actionable findings are addressed, push and reschedule with `--reviewed` (so review doesn't repeat), then exit:
```bash
git push <remote> $BRANCH
```
```
ScheduleWakeup(delaySeconds=120, reason="CI after code-review fixes on PR #<N>", prompt="/pr-watch <N> --reviewed [--clickup-ticket=<id> if set]")
```

## Rules

- Read `.claude/supera.json` for the commands used to reproduce failures — don't assume pnpm/npm.
- Delegate every fix to `supera-engineer` — pr-watch orchestrates, it doesn't implement.
- Exit and announce when done — merging is the user's decision.
- On `MERGED`, defer the close to `/ship` — never close the ticket or remove the worktree here; `/ship` owns the terminal step.
- Run the code review exactly once per invocation — `--reviewed` prevents repeats.
- Never push `--force` (only `--force-with-lease` after a rebase).
- Never implement review comments that are questions / design discussions — surface them.
- Never `gh run rerun` unless the failure is clearly transient — fix the root cause.
- Don't spin-poll — always `ScheduleWakeup` and exit the turn while waiting.
- Always preserve `--reviewed` and `--clickup-ticket` flags when rescheduling.
- Same CI failure twice after 2 fix attempts → ticket `STATUS.blocked` (if linked), stop, show the log, ask.
- PR closed without merge → ticket `STATUS.rejected` (if linked).
