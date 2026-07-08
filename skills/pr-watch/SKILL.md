---
name: pr-watch
description: Monitor an open PR until ready to merge — watch CI, fix failures via supera-engineer, address review comments, merge when green, then clean up worktree. Repo-agnostic: reads .claude/supera.json for commands.
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Monitor an open PR until it is ready to merge. Watch CI, fix failures, address review comments. When green and approved, merge and clean up.

## 0 — Load config

Read `.claude/supera.json` into `CONFIG`. If absent, proceed with sensible git/gh defaults.
- `MERGE_METHOD = CONFIG.mergeMethod`
- `BASE = CONFIG.baseBranch`
- `REMOTE = CONFIG.remote`

## 1 — Resolve the PR

Parse `$ARGUMENTS`:
- A number → the PR number.
- `--non-interactive` → `NONINTERACTIVE=true` (headless, no prompts).
- Empty → detect from current branch: `gh pr view --json number -q .number`.
- Neither works → ask the user (in `NONINTERACTIVE` mode, exit — nothing to act on).

```bash
PR=<number>
BRANCH=$(gh pr view $PR --json headRefName -q .headRefName)
BASE=$(gh pr view $PR --json baseRefName -q .baseRefName)
```

## 2 — Check CI

```bash
gh pr view $PR --json state,mergeable,statusCheckRollup,reviewThreads
```

Parse `state`:
- **`MERGED`** → clean up and exit (step 7).
- **`CLOSED`** (not merged) → announce abandoned and exit.

### CI running or queued
Wait. Reschedule:
```
ScheduleWakeup(delaySeconds=90, reason="CI running on PR #<N>", prompt="/pr-watch <N> [--non-interactive if set]")
```

### CI failed
Identify the failing job:
```bash
RUN_ID=$(gh run list --branch $BRANCH --limit 1 --json databaseId -q '.[0].databaseId')
gh run view $RUN_ID --log-failed
```

Classify:
| Failure | Action |
|---|---|
| Build / typecheck / test / lint | Delegate to `supera-engineer` with the log excerpt + CONFIG commands. |
| Lockfile drift | Run install in worktree, commit updated lockfile. |
| Transient (network, OOM) | Re-run is acceptable. |
| Unknown | Ask user (in `NONINTERACTIVE`, block — post comment, exit). |

Dispatch `supera-engineer` with the failure log. Wait for receipt. If `ok`, commit + push. If `fail` after 2 attempts on the same failure → block (post comment, exit).

After fix:
```bash
git push $REMOTE $BRANCH
```
Reschedule and exit:
```
ScheduleWakeup(delaySeconds=120, reason="CI re-run after fix on PR #<N>", prompt="/pr-watch <N> [flags]")
```

### CI passed
Proceed to step 3.

## 3 — Review comments

```bash
gh pr view $PR --json reviewThreads -q '[.reviewThreads[] | select(.isResolved==false)]'
```

For each unresolved thread:
- **Clear code request** (rename, extract, null check, add test) → delegate to `supera-engineer`, push, reply:
  ```bash
  gh pr review $PR --comment --body "Addressed in <sha>: <summary>"
  ```
- **Question / design discussion** → surface to user (in `NONINTERACTIVE`, block — post comment, exit).

After fixes, reschedule:
```
ScheduleWakeup(delaySeconds=120, reason="CI after review fixes on PR #<N>", prompt="/pr-watch <N> [flags]")
```

## 4 — Sync with base

```bash
gh pr view $PR --json mergeable -q .mergeable
```

- **`CONFLICTING`** → rebase, delegate conflicts to engineer, `git push --force-with-lease $REMOTE $BRANCH`. Reschedule.
- **`UNKNOWN`** → wait briefly, reschedule.

## 5 — Done check

Ready when:
- Every CI check is `SUCCESS` or `SKIPPED`
- Zero unresolved review threads
- `mergeable` is `MERGEABLE`

If ready, announce: *"PR #<N> is green and all threads resolved — ready to merge."*

## 6 — Merge

If the user confirms merge (or `NONINTERACTIVE` is false and all gates green):

```bash
gh pr merge $PR --$MERGE_METHOD
```

## 7 — Clean up

After merge:
```bash
# Find and remove worktree
WT_PATH=$(git worktree list | grep "$BRANCH" | awk '{print $1}')
[ -n "$WT_PATH" ] && git worktree remove "$WT_PATH" --force 2>/dev/null

# Delete local branch
[ "$BRANCH" != "$BASE" ] && git branch -D "$BRANCH" 2>/dev/null
```

Announce: *"PR #<N> merged. Worktree removed, branch `$BRANCH` deleted."*

## Non-interactive mode (`--non-interactive`)

Headless CI runs. Never prompt. At every decision point flagged above:
- Instead of asking, post a block comment and exit:
  ```bash
  gh pr comment $PR --body "Blocked (non-interactive): <reason>"
  ```
- CI failures, clear code requests, merge conflicts still delegate to engineer and push as normal.
- A clean, green PR still announces ready — merging stays the user's decision.

## Rules

- Read `.claude/supera.json` for commands — don't assume pnpm/npm.
- **Don't spin-poll** — `ScheduleWakeup` and exit at every wait.
- Never push `--force` — only `--force-with-lease` after rebase.
- Never remove `BASE` or its worktree.
- Commit hygiene follows `guidelines/commit-conventions.md`.
