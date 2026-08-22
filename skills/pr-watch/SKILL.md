---
name: pr-watch
description: Monitor an open PR until it is green and ready to merge — watch CI, fix failures via supera-engineer, address review comments, report when ready. Never merges — merging is always the user's action. Repo-agnostic: detects commands from the repo itself.
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Monitor an open PR until it is ready to merge. Watch CI, fix failures, address review comments. When green and approved, report ready — **never merge**. Clean up after the user has merged.

## 0 — Detect repo context

No config file — everything is derived from git + GitHub:
- `REMOTE`: the sole git remote, or `origin` when several exist.
- `BASE` / `BRANCH`: from the PR itself (step 1).

## 1 — Resolve the PR

Parse `$ARGUMENTS`:
- A number → the PR number.
- `--non-interactive` → `NONINTERACTIVE=true` (headless, no prompts).
- `--tick <n>` → `TICK=n` (wakeup counter; default `0` when absent).
- `--unknown <n>` → `UNKNOWN_COUNT=n` (consecutive `UNKNOWN` mergeability checks; default `0` when absent — see step 4).
- Empty → detect from current branch: `gh pr view --json number -q .number`.
- Neither works → ask the user (in `NONINTERACTIVE` mode, exit — nothing to act on).

**Stop condition:** `MAX_TICKS = 20`. If `TICK >= MAX_TICKS`, stop watching — do NOT reschedule. Announce: *"pr-watch stopped after $MAX_TICKS checks — PR #<N> is still <current state>. Re-run `/pr-watch <N>` to resume watching."* (in `NONINTERACTIVE` mode, post that as a PR comment). Every `ScheduleWakeup` below passes `--tick <TICK+1>` so the counter survives across wakeups — no state files.

```bash
PR=<number>
BRANCH=$(gh pr view $PR --json headRefName -q .headRefName)
BASE=$(gh pr view $PR --json baseRefName -q .baseRefName)
```

**Ensure worktree:** pr-watch needs to be in the branch's worktree. Detect and enter:
```bash
# Check if already in the right worktree
WT_DIR=".worktrees"
if ! git worktree list | grep -qF "$(pwd)" || [ "$(git branch --show-current)" != "$BRANCH" ]; then
  # Try to find existing worktree for this branch
  WT_PATH=$(git worktree list | grep -F "[$BRANCH]" | awk '{print $1}')
  if [ -n "$WT_PATH" ] && [ -d "$WT_PATH" ]; then
    cd "$WT_PATH"
  elif [ -d "$WT_DIR/$BRANCH" ]; then
    cd "$WT_DIR/$BRANCH"
  else
    # No worktree found — create one
    mkdir -p "$WT_DIR"
    git worktree add "$WT_DIR/$BRANCH" "$BRANCH"
    cd "$WT_DIR/$BRANCH"
  fi
fi
```

## 2 — Check CI

```bash
gh pr view $PR --json state,mergeable,statusCheckRollup,reviews,reviewDecision
```

Parse `state`:
- **`MERGED`** → clean up and exit (step 6).
- **`CLOSED`** (not merged) → announce abandoned and exit.

### CI running or queued
Wait. Reschedule:
```
ScheduleWakeup(delaySeconds=90, reason="CI running on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> [--non-interactive if set]")
```

### CI failed
Identify the failing job:
```bash
RUN_ID=$(gh run list --branch $BRANCH --limit 1 --json databaseId -q '.[0].databaseId')
[ "$RUN_ID" = "null" ] || [ -z "$RUN_ID" ] && echo "NO_RUNS"
[ "$RUN_ID" != "null" ] && [ -n "$RUN_ID" ] && gh run view $RUN_ID --log-failed
```

If `NO_RUNS`: CI hasn't started yet. Reschedule and exit:
```
ScheduleWakeup(delaySeconds=120, reason="CI not started yet on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> [flags]")
```

Classify:
| Failure | Action |
|---|---|
| Build / typecheck / test / lint | Delegate to `supera-engineer` with the log excerpt — it detects the repo's own commands. |
| Lockfile drift | Run install in worktree, commit updated lockfile. |
| Transient (network, OOM) | Re-run: `gh run rerun $RUN_ID`. |
| Unknown | Ask user (in `NONINTERACTIVE`, block — post comment, exit). |

Dispatch `supera-engineer` with the failure log. **Do NOT use `isolation: "worktree"`** — pr-watch already works in the ship's worktree. Use `subagent_type: "supera:supera-engineer"` only. Wait for receipt.

**SendMessage guard:** Before the subagent sends structured messages back to the orchestrator (e.g., its JSON receipt), it must load the SendMessage tool schema into its prompt by calling `ToolSearch` with `query: "select: SendMessage"`. Without this, typed parameters may be rejected with `InputValidationError`.

**Verify engineer made changes before committing:**
```bash
git diff --stat
```
If the diff is empty, the engineer made zero changes. **Check `receipt.notes` before delegating back** — never enter a delegation loop on an empty diff:

- **Notes legitimately explain the empty diff** (no code change needed — e.g., flaky test, CI-side config, already fixed on the branch) → do NOT re-delegate. Act on the notes (e.g., re-run CI) or surface to the user (in `NONINTERACTIVE`, post comment, exit).
- **Notes are empty or claim a fix was made** → the engineer idled. Re-delegate **once**, with the failure log and the explicit instruction to make changes (counts toward the 3-attempt max). If the diff is empty again, stop delegating — fix directly or block (post comment, exit).

Do NOT commit empty changes.

If receipt is `ok` and diff is non-empty, pr-watch commits and pushes the fix. If `fail` after 3 attempts on the same failure → block (post comment, exit).

After fix:
```bash
git push $REMOTE $BRANCH
```
Reschedule and exit:
```
ScheduleWakeup(delaySeconds=120, reason="CI re-run after fix on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> [flags]")
```

### CI passed
Proceed to step 3.

## 3 — Review comments

Check for unresolved review threads:
```bash
# Fetch PR review comments via API (thread-level resolution)
gh api "repos/{owner}/{repo}/pulls/$PR/comments" --jq '.[] | select(.in_reply_to_id == null) | {id: .id, path: .path, line: .line, body: .body}' 2>/dev/null || echo "NO_COMMENTS"
```

Also check the PR's top-level review state:
```bash
gh pr view $PR --json reviews --jq '[.reviews[] | select(.state != "APPROVED") | {author: .author.login, state: .state, body: .body}]'
```

For each unresolved thread:
- **Clear code request** (rename, extract, null check, add test) → delegate to `supera-engineer` (no worktree isolation). **SendMessage guard:** before the subagent communicates its receipt, instruct it to load SendMessage's schema via `ToolSearch` with `query: "select: SendMessage"`. Verify with `git diff --stat` after agent returns. If the diff is empty, apply the same empty-diff check as step 2 — `receipt.notes` first, at most one re-delegate. If non-empty, pr-watch commits + pushes the fix, then reply:
```bash
SHA=$(git rev-parse HEAD)
gh pr review $PR --comment --body "Addressed in $SHA: <summary>"
```
- **Question / design discussion** → surface to user (in `NONINTERACTIVE`, block — post comment, exit).

After fixes, reschedule:
```
ScheduleWakeup(delaySeconds=120, reason="CI after review fixes on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> [flags]")
```

## 4 — Sync with base

```bash
gh pr view $PR --json mergeStateStatus,mergeable -q '{mergeStateStatus: .mergeStateStatus, mergeable: .mergeable}'
```

- `mergeStateStatus` values: `CLEAN` (no conflicts), `DIRTY` (conflicts), `UNKNOWN`, `BLOCKED`, `BEHIND`, `UNSTABLE`, `HAS_HOOKS`
- `mergeable` values: `MERGEABLE`, `CONFLICTING`, `UNKNOWN` (older gh versions may only have this field)

- **`DIRTY` or `CONFLICTING`** → rebase onto base, delegate conflicts to engineer, push, reschedule:
  ```bash
  git fetch $REMOTE $BASE
  git rebase $REMOTE/$BASE
  # if conflicts: delegate conflicted files to supera-engineer
  git push --force-with-lease $REMOTE $BRANCH
  ```
  ```
  ScheduleWakeup(delaySeconds=120, reason="CI after rebase on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> [flags]")
  ```
- **`BEHIND`** → branch is behind base. Rebase or merge base in:
  ```bash
  git fetch $REMOTE $BASE
  git rebase $REMOTE/$BASE
  git push --force-with-lease $REMOTE $BRANCH
  ```
  ```
  ScheduleWakeup(delaySeconds=120, reason="CI after rebase on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> [flags]")
  ```
- **`UNKNOWN`** → GitHub is still computing mergeability; it normally resolves in seconds. Bounded retry via an `--unknown <n>` counter (parsed like `--tick`, default `0`):
  - `UNKNOWN_COUNT >= 3` → stop retrying — treat like `BLOCKED`: surface to user (in `NONINTERACTIVE`, post comment, exit). Status stuck at `UNKNOWN` this long means GitHub can't compute it — a human needs to look.
  - Otherwise wait 60 s, reschedule with the counter bumped:
  ```
  ScheduleWakeup(delaySeconds=60, reason="mergeable status unknown on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> --unknown <UNKNOWN_COUNT+1> [flags]")
  ```
  Every other reschedule path omits `--unknown`, so the counter resets to 0 once the status resolves.
- **`BLOCKED`** → surface to user (in `NONINTERACTIVE`, block — post comment, exit).

## 5 — Done check

Ready when:
- Every CI check is `SUCCESS` or `SKIPPED`
- Zero unresolved review threads
- `mergeStateStatus` is `CLEAN` (or `mergeable` is `MERGEABLE`)
- `reviewDecision` is `APPROVED` (or no review required: empty/null string)
  - If `reviewDecision` is `REVIEW_REQUIRED` or `CHANGES_REQUESTED` → wait, reschedule:
    ```
    ScheduleWakeup(delaySeconds=120, reason="Waiting for review on PR #<N>", prompt="/pr-watch <N> --tick <TICK+1> [flags]")
    ```

If ready, announce and exit: *"PR #<N> is green and all threads resolved — ready to merge. Merge it when you're ready, then re-run `/pr-watch <N>` to clean up the worktree."*

**pr-watch never merges.** Not on green, not on approval, not when asked to "finish the PR" — merging is always the user's action, performed by the user. In `NONINTERACTIVE` mode: announce ready, post a comment, exit.

## 6 — Clean up

Runs only when the PR is observed as `MERGED` (step 2):
```bash
# Save repo root from git common directory (resolves to main repo, not worktree)
REPO_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)

# Find and remove worktree
WT_PATH=$(git worktree list | grep -F "$BRANCH" | awk '{print $1}')
[ -n "$WT_PATH" ] && git worktree remove "$WT_PATH" --force

# Delete local branch (only if it matches headRefName exactly)
[ "$BRANCH" != "$BASE" ] && git branch -d "$BRANCH" 2>/dev/null || true

# Cd back to repo root so shell is not in a deleted directory
cd "$REPO_ROOT"
```

Announce: *"PR #<N> merged. Worktree removed, branch `$BRANCH` deleted."*

## Non-interactive mode (`--non-interactive`)

Headless CI runs. Never prompt. At every decision point flagged above:
- Instead of asking, post a block comment and exit:
  ```bash
  gh pr comment $PR --body "Blocked (non-interactive): <reason>"
  ```
- CI failures, clear code requests, merge conflicts still delegate to engineer and push as normal.
- A clean, green PR announces ready and exits — merging stays the user's decision.

## Rules

- **Never merge the PR.** No `gh pr merge`, ever — report ready and stop.
- Detect commands from the repo (declared scripts, Makefile, CI workflows) — don't assume pnpm/npm.
- **Don't spin-poll** — `ScheduleWakeup` and exit at every wait.
- **Bounded watch** — every reschedule passes `--tick <TICK+1>`; at `MAX_TICKS` (20) announce and stop instead of rescheduling. The user resumes with a fresh `/pr-watch <N>`.
- Never push `--force` — only `--force-with-lease` after rebase.
- Never remove `BASE` or its worktree.
- Commit hygiene follows `guidelines/commit-conventions.md`.
