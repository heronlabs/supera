---
name: pr-watch
description: Monitor one or more open PRs until merged — watch CI, fix failures via supera-engineer, address review comments, report when ready, keep watching until the user merges, then clean up. Never merges — merging is always the user's action. Repo-agnostic — detects commands from the repo itself.
argument-hint: "<PR> [<PR>...] [--non-interactive]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, Monitor, ScheduleWakeup
---

Monitor open PRs until they are merged. Watch CI, fix failures, address review comments. When green and approved, report ready — **never merge** — and keep watching until the user merges, then clean up.

## 0 — Detect repo context

No config file — everything is derived from git + GitHub:
- `REMOTE`: the sole git remote, or `origin` when several exist.
- `REPO_ROOT` (main checkout) and `WT_DIR`:
  ```bash
  COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
  REPO_ROOT=$(dirname "$COMMON")
  WT_DIR="$REPO_ROOT/.worktrees"
  ```
- `BASE` / `BRANCH`: per PR, from the PR itself (step 1).

Human-readable git output may be rewritten by shell hooks; don't parse it. Decide from `git rev-parse`, `git for-each-ref`, exit codes, and `$(git status --porcelain)` tests.

## Delegation

Code fixes go to `supera-engineer`: dispatch with `subagent_type: "supera:supera-engineer"` only. **Do NOT use `isolation: "worktree"` and do NOT pass `name:`** — pr-watch already owns the worktree, and a named Agent call is launched as a teammate, which under `teammateMode: "tmux"` (or `"auto"` in a tmux or iTerm2 terminal) opens a second pane and splits the user's screen. The receipt arrives as the Agent tool's result; wait for it.

pr-watch edits directly only trivial fixes: lint/format, typos, conflict markers, mechanical few-line fixes. Anything touching logic or tests goes to the engineer.

After every fix, verify there are changes (`git status --porcelain` includes untracked new files; `.supera/` is excluded):
```bash
[ -z "$(git status --porcelain --untracked-files=all --no-renames | cut -c4- | grep -v '^\.supera/')" ] && echo "EMPTY_DIFF"
```
On `EMPTY_DIFF`, **check `receipt.notes` before delegating back** — never enter a delegation loop on an empty diff:
- **Notes legitimately explain the empty diff** (no code change needed — e.g., flaky test, CI-side config, already fixed on the branch) → do NOT re-delegate. Act on the notes (e.g., re-run CI) or block.
- **Notes are empty or claim a fix was made** → the engineer idled. Re-delegate **once**, with the failure and the explicit instruction to make changes (counts toward the 3-attempt max). Empty again → stop delegating — fix directly or block.

Do NOT commit empty changes. With changes: commit, then `git push $REMOTE $BRANCH`. Receipt still `fail` after 3 attempts on the same failure → block.

**Block** = surface the reason to the user (in `NONINTERACTIVE`, post a comment — see below) and drop that PR from the watch list; the other PRs keep being watched.

## 1 — Resolve the PRs

Parse `$ARGUMENTS`:
- One or more PR tokens, `<N>` or `<N>:<flags>` → the watch list.
- `--non-interactive` → `NONINTERACTIVE=true` (headless, no prompts).
- `--tick <n>` → `TICK=n` (loop wakeup counter; default `0` when absent).
- No PR token → detect from current branch: `gh pr view --json number -q .number`.
- Neither works → ask the user (in `NONINTERACTIVE` mode, exit — nothing to act on).

If this session already has a pending pr-watch wakeup (a `ScheduleWakeup` whose prompt hasn't fired yet), merge its PR tokens and flags into the list — one loop watches every PR, and the next `ScheduleWakeup` replaces the pending one.

Per-PR flags (comma-separated after `:`) carry state across wakeups — no state files:

| Flag | Meaning |
|---|---|
| `unknown=<n>` | consecutive `UNKNOWN` mergeability checks (step 4) |
| `waits=<M>` | blocked by a failure that PR #M fixes (step 2) |
| `runners` | runners-offline announcement already made (step 2) |
| `ready=<epoch>` | ready announced at that time (`date +%s`), awaiting merge (step 5) |

Example: `/pr-watch 93:waits=94 94 --tick 4`.

**Tick:** for each PR in the list, ensure its worktree (below), then run steps 2–6. Each PR ends with a delay from **Waiting**, updated flags, or *drop* (merged and cleaned up, closed, blocked, or ready cap hit). Then:
- List empty → `cd "$REPO_ROOT"` and exit without rescheduling.
- Otherwise schedule **one** wakeup with the shortest delay any PR needs, carrying every remaining PR with its flags:
  ```
  ScheduleWakeup(delaySeconds=<shortest>, reason="<short status per PR>", prompt="/pr-watch <N>[:flags] [<M>[:flags] ...] --tick <TICK+1> [--non-interactive]")
  ```
  Keep `--tick <TICK>` unbumped when every remaining PR has `ready=` — that phase is bounded by `READY_HOURS` (step 5).

**Stop condition:** `MAX_TICKS = 30`. If `TICK >= MAX_TICKS`, stop watching — do NOT reschedule. Announce: *"pr-watch stopped after $MAX_TICKS checks — <PR #N: current state, one per PR>. Re-run `/pr-watch <N> [<M> ...]` to resume watching."* (in `NONINTERACTIVE` mode, post that as a comment on each PR).

**Ensure worktree** (per PR):
```bash
PR=<number>
BRANCH=$(gh pr view $PR --json headRefName -q .headRefName)
BASE=$(gh pr view $PR --json baseRefName -q .baseRefName)
```
Skip the rest when `gh pr view $PR --json state -q .state` is `MERGED` or `CLOSED` — go straight to step 2.
```bash
# git-dir differs from the common dir only inside a linked worktree
if [ "$(git rev-parse --path-format=absolute --git-dir)" = "$COMMON" ] || [ "$(git branch --show-current)" != "$BRANCH" ]; then
  [ -d "$WT_DIR/$BRANCH" ] || { git fetch "$REMOTE" "$BRANCH" && git worktree add "$WT_DIR/$BRANCH" "$BRANCH"; }
  cd "$WT_DIR/$BRANCH"
fi
[ "$(git branch --show-current)" = "$BRANCH" ] || echo "WRONG_CHECKOUT"
```
`WRONG_CHECKOUT` → block.

## Waiting

Each PR's delay feeds the tick's single `ScheduleWakeup`:

| Awaiting | Delay |
|---|---|
| CI running, watcher started (below) | 1200 s fallback |
| CI running, no watcher tool | 270 s |
| CI not started yet / just pushed | 120 s |
| Mergeability `UNKNOWN` | 60 s |
| Review | 1200 s |
| Offline runners, side PR not in the list, merge | 1800 s |

**Watcher:** when the Monitor tool or Bash `run_in_background` is available and the PR has pending checks, start one watcher per PR (reuse one still running from an earlier pass):
```bash
gh pr checks $PR --watch --fail-fast --interval 30 >/dev/null 2>&1; echo "PR #$PR checks done (exit $?)"
```
Run it with Monitor (deadline: the tool's maximum) or Bash `run_in_background`. When a watcher reports, run a full tick immediately; its `ScheduleWakeup` replaces the pending fallback — don't cancel it separately. With no checks reported, `gh pr checks` exits at once — see **No checks reported** (step 2).

## 2 — Check CI

```bash
gh pr view $PR --json state,mergeable,statusCheckRollup,reviews,reviewDecision
HEAD_SHA=$(gh pr view $PR --json headRefOid -q .headRefOid)
```

Parse `state`:
- **`MERGED`** → clean up (step 6), drop.
- **`CLOSED`** (not merged) → announce abandoned, drop.

**`waits=<M>` set** → check only the fix PR: `gh pr view <M> --json state -q .state`:
- `MERGED` → rebase onto base (step 4, `BEHIND`), remove `waits`, wait 120 s.
- `CLOSED` → remove `waits`, block (the fix PR was closed unmerged).
- `OPEN` → skip the rest of this PR's tick; it waits on #M (#M's own delay when it is in the list, else 1800 s).

### No checks reported
Decide whether CI exists for this PR:
```bash
[ -z "$(grep -rlsE '(^|[[:space:],[])pull_request(_target)?([[:space:]]*:|[],[:space:]]|$)' .github/workflows)" ] && echo "NO_PR_CI"
gh pr view $PR --json createdAt,commits --jq '[.createdAt, .commits[-1].committedDate] | map(fromdateiso8601) | max | now - . > 600'
```
`NO_PR_CI` (no workflow triggers on `pull_request`/`pull_request_target`), or `true` (PR created / head committed over 10 min ago and still no checks) → CI is **none**: proceed to step 3 as if passed. Otherwise wait 120 s.

### CI running or queued
Check for runs stuck in the queue for more than 10 minutes:
```bash
gh run list --commit "$HEAD_SHA" --status queued --json workflowName,createdAt --jq '.[] | select(now - (.createdAt | fromdateiso8601) > 600) | .workflowName'
```
Output, and those workflows' `runs-on` (in `.github/workflows/`) targets self-hosted labels (`self-hosted`, or anything other than GitHub-hosted `ubuntu-*` / `windows-*` / `macos-*`) → **runners unavailable**. Without the `runners` flag: tell the user once that the runners look offline (in `NONINTERACTIVE`, one PR comment) and add `runners`. Wait 1800 s; don't repeat the announcement. Remove `runners` once jobs start.

Otherwise wait for CI (watcher + fallback, see **Waiting**).

### CI failed
Identify the failing runs on the PR head:
```bash
gh run list --commit "$HEAD_SHA" --json databaseId,workflowName,conclusion,attempt --jq '.[] | select(.conclusion == "failure")'
gh run view $RUN_ID --log-failed
```
A failing check with no workflow run (external status) → classify from its `detailsUrl`.

**Pre-existing or unrelated?** Compare with the base branch's latest run of the same workflow:
```bash
gh run list --branch "$BASE" --workflow "$WORKFLOW" --limit 1 --json conclusion,databaseId
gh run view $BASE_RUN_ID --json jobs --jq '.jobs[] | select(.conclusion == "failure") | .name'
```
No base run → compare the failing file/package with `gh pr diff $PR --name-only`.

Classify:
| Failure | Action |
|---|---|
| Build / typecheck / test / lint caused by the PR | Delegate to `supera-engineer` with the log excerpt — it detects the repo's own commands (trivial lint/format → fix directly). |
| Lockfile drift | Run install in worktree, commit updated lockfile. |
| Pre-existing or unrelated — same job fails on base, or a dependency-audit advisory unrelated to the PR diff | **Never fix inline in this PR** — side PR (below). |
| OOM (exit 137), run `attempt` 1 | Re-run: `gh run rerun $RUN_ID --failed`. |
| OOM again (`attempt` ≥ 2) | Not transient — delegate to `supera-engineer` with the hint to reduce build parallelism. |
| Transient (network) | Re-run: `gh run rerun $RUN_ID --failed`. |
| Unknown | Block. |

**Side PR** for a pre-existing or unrelated failure:
1. Search for an existing fix: `gh pr list --state open --search "<package, advisory ID, or job name>" --json number,title,headRefName`. Found #M → add `waits=<M>` to this PR.
2. None → `cd "$REPO_ROOT"` and invoke the `ship` skill with: *"fix <failure> on `$BASE` — side PR for #<N>, in a new worktree from `$BASE`; don't touch branch `$BRANCH`"*. Ship's final hand-off to pr-watch is this loop: add the side PR to the watch list (no separate watch) and add `waits=<side PR>` to this PR.

Fixes follow **Delegation** (empty-diff check, commit, push); after a push or re-run, wait 120 s.

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
- **Clear code request** (rename, extract, null check, add test) → per **Delegation** (trivial → fix directly, else `supera-engineer`; empty-diff check; commit + push), then reply:
```bash
SHA=$(git rev-parse HEAD)
gh pr review $PR --comment --body "Addressed in $SHA: <summary>"
```
- **Question / design discussion** → block.

After fixes → wait 120 s.

## 4 — Sync with base

```bash
gh pr view $PR --json mergeStateStatus,mergeable -q '{mergeStateStatus: .mergeStateStatus, mergeable: .mergeable}'
```

- `mergeStateStatus` values: `CLEAN` (no conflicts), `DIRTY` (conflicts), `UNKNOWN`, `BLOCKED`, `BEHIND`, `UNSTABLE`, `HAS_HOOKS`
- `mergeable` values: `MERGEABLE`, `CONFLICTING`, `UNKNOWN` (older gh versions may only have this field)

- **`DIRTY` or `CONFLICTING`** → rebase onto base, resolve conflicts (bare conflict markers → fix directly; logic → `supera-engineer`), push, wait 120 s:
  ```bash
  git fetch $REMOTE $BASE
  git rebase $REMOTE/$BASE
  # if conflicts: resolve per Delegation, then git add + git rebase --continue
  git push --force-with-lease $REMOTE $BRANCH
  ```
- **`BEHIND`** → branch is behind base. Rebase, push, wait 120 s:
  ```bash
  git fetch $REMOTE $BASE
  git rebase $REMOTE/$BASE
  git push --force-with-lease $REMOTE $BRANCH
  ```
- **`UNKNOWN`** → GitHub is still computing mergeability; it normally resolves in seconds. Bounded retry via the PR's `unknown=<n>` flag (absent = `0`):
  - `n >= 3` → stop retrying — block. Status stuck at `UNKNOWN` this long means GitHub can't compute it — a human needs to look.
  - Otherwise set `unknown=<n+1>` and wait 60 s.
  Every other path removes `unknown`, so the counter resets once the status resolves.
- **`BLOCKED`** → `reviewDecision` is `REVIEW_REQUIRED` or `CHANGES_REQUESTED` → continue to step 5 (review wait). Otherwise block.

## 5 — Done check

Ready when:
- Every CI check is `SUCCESS` or `SKIPPED` (or CI is none, step 2)
- Zero unresolved review threads
- `mergeStateStatus` is `CLEAN` (or `mergeable` is `MERGEABLE`)
- `reviewDecision` is `APPROVED` (or no review required: empty/null string)
  - If `reviewDecision` is `REVIEW_REQUIRED` or `CHANGES_REQUESTED` → wait 1200 s.

A fix, rebase, failing check, or new review while `ready` is set → remove `ready`; it is announced again once ready.

**Ready ≠ exit.** Keep watching until the PR is merged or closed (step 2), with `READY_HOURS = 8`:
- No `ready` flag → announce once: *"PR #<N> is green and all threads resolved — ready to merge. I'll keep watching and clean up after you merge it."* (in `NONINTERACTIVE`, post it as a PR comment). Add `ready=$(date +%s)`, wait 1800 s.
- `ready` set, under `READY_HOURS` since it → wait 1800 s silently.
- `ready` set, `READY_HOURS` reached → drop: *"PR #<N> is still unmerged after $READY_HOURS h — pr-watch stopped. After merging, run `/pr-watch <N>` to clean up."* (in `NONINTERACTIVE`, post as a PR comment).

**pr-watch never merges.** Not on green, not on approval, not when asked to "finish the PR", not even when the user explicitly asks — merging is always the user's action, performed by the user.

## 6 — Clean up

Runs only when the PR is observed as `MERGED` (step 2). Starts and ends at the repo root:
```bash
cd "$REPO_ROOT"
git worktree prune
WT_PATH=$(git for-each-ref --format='%(worktreepath)' "refs/heads/$BRANCH")
[ -n "$WT_PATH" ] && [ "$WT_PATH" != "$REPO_ROOT" ] && git worktree remove --force "$WT_PATH"
# Squash merges leave the branch unmerged locally — -D, safe because the PR is MERGED
[ "$BRANCH" != "$BASE" ] && git show-ref --verify --quiet "refs/heads/$BRANCH" && git branch -D "$BRANCH"
git ls-remote --exit-code "$REMOTE" "refs/heads/$BRANCH" >/dev/null && git push "$REMOTE" --delete "$BRANCH"
# Fast-forward local base only when the main checkout is on it and clean — never reset or force
if [ "$(git branch --show-current)" = "$BASE" ] && [ -z "$(git status --porcelain)" ]; then
  git fetch "$REMOTE" "$BASE" && git merge --ff-only "$REMOTE/$BASE"
fi
```

Then, for every watched PR with `waits=<N>`: ensure its worktree (step 1), rebase (step 4, `BEHIND`), remove that flag. `cd "$REPO_ROOT"` again.

Announce what was done: *"PR #<N> merged. Worktree removed, branch `$BRANCH` deleted locally and on `$REMOTE`, `$BASE` fast-forwarded."*

## Non-interactive mode (`--non-interactive`)

Headless CI runs. Never prompt. At every block:
- Instead of asking, post a block comment and drop the PR:
  ```bash
  gh pr comment $PR --body "Blocked (non-interactive): <reason>"
  ```
- CI failures, clear code requests, merge conflicts still delegate to engineer and push as normal.
- A clean, green PR posts one ready comment and keeps being watched until merged, closed, or `READY_HOURS` — merging stays the user's decision.

## Rules

- **Never merge the PR.** No `gh pr merge`, ever — not even when asked. Report ready and keep watching.
- Detect commands from the repo (declared scripts, Makefile, CI workflows) — don't assume pnpm/npm.
- **Don't spin-poll** — wait through a watcher or `ScheduleWakeup` (**Waiting**), never `sleep` in the foreground.
- **One loop** — every watched PR rides the same single `ScheduleWakeup`.
- **Bounded watch** — `MAX_TICKS` (30) for active handling, `READY_HOURS` (8) per PR awaiting merge; announce and stop instead of rescheduling. The user resumes with a fresh `/pr-watch <N>`.
- Never fix a pre-existing or unrelated failure inline in the feature PR — side PR (step 2).
- Never push `--force` — only `--force-with-lease` after rebase.
- Never remove `BASE` or its worktree; never reset or force-update local `BASE`.
- Commit hygiene follows `${CLAUDE_PLUGIN_ROOT}/guidelines/commit-conventions.md`.
