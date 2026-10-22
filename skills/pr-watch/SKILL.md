---
name: pr-watch
description: Monitor one or more open PRs until merged — watch CI, fix failures via supera-engineer, address review comments, report when ready, keep watching until the user merges, then clean up. Never merges — merging is always the user's action. Repo-agnostic — detects commands from the repo itself.
argument-hint: "<PR> [<PR>...] [--non-interactive]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, Monitor, ScheduleWakeup, SendMessage
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

Code fixes go to `supera-engineer`; the dispatch form, the agent id, the deadline, the receipt checks, the empty-diff rule and the trivial-fix boundary follow `${CLAUDE_PLUGIN_ROOT}/guidelines/delegation.md`. Right after each dispatch, launch the deadline with Bash `run_in_background` — its `ENGINEER_DEADLINE` notification is not an event, so the passthrough carries `--tick <TICK>` unchanged:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/deadline.sh" 3600 "/pr-watch <N>[:flags] [<M>[:flags] ...] --tick <TICK> [--non-interactive]"
```

After every fix, verify there are changes per the guideline (on an empty diff, "stop" means block; a re-delegation counts toward the 3-attempt max). With changes: commit, then `git push $REMOTE $BRANCH`. Receipt still `fail` after 3 attempts on the same failure → block.

**Block** = surface the reason to the user (in `NONINTERACTIVE`, post a comment — see below) and drop that PR from the watch list; the other PRs keep being watched.

## 1 — Resolve the PRs

Parse `$ARGUMENTS`:
- One or more PR tokens, `<N>` or `<N>:<flags>` → the watch list.
- `--non-interactive` → `NONINTERACTIVE=true` (headless, no prompts).
- `--tick <n>` → `TICK=n` (event counter — poller notifications and fallback wakeups; default `0` when absent).
- No PR token → detect from current branch: `gh pr view --json number -q .number`.
- Neither works → ask the user (in `NONINTERACTIVE` mode, exit — nothing to act on).

If this session already has a pending pr-watch wakeup (a `ScheduleWakeup` whose prompt hasn't fired yet) or a live poller (**Waiting**), merge its PR tokens and flags into the list — one loop watches every PR; the next `ScheduleWakeup` replaces the pending one, a live poller is re-used.

Per-PR flags (comma-separated after `:`) carry state across wakeups — no state files:

| Flag | Meaning |
|---|---|
| `unknown=<n>` | consecutive `UNKNOWN` mergeability checks (step 4) |
| `waits=<M>` | blocked by a failure that PR #M fixes (step 2) |
| `runners` | runners-offline announcement already made (step 2) |
| `ready=<epoch>` | ready announced at that time (`date +%s`), awaiting merge (step 5) |

Example: `/pr-watch 93:waits=94 94 --tick 4`.

**Tick:** for each PR in the list, ensure its worktree (below), then run steps 2–6. Each PR ends with a wait from **Waiting** (a background poller, or a `ScheduleWakeup` delay for `UNKNOWN` and in the fallback), updated flags, or *drop* (merged and cleaned up, closed, blocked, or a poller timeout). Then:
- List empty → `cd "$REPO_ROOT"` and exit without launching or scheduling anything.
- Every remaining PR has a live poller → end the turn; the next poller notification is the next tick.
- Otherwise schedule **one** wakeup with the shortest delay any PR without a poller needs, carrying every remaining PR with its flags:
  ```
  ScheduleWakeup(delaySeconds=<shortest>, reason="<short status per PR>", prompt="/pr-watch <N>[:flags] [<M>[:flags] ...] --tick <TICK+1> [--non-interactive]")
  ```

**Stop condition:** `MAX_EVENTS = 30`. Every poller notification and every fallback wakeup is an event; `--tick` carries the count. If `TICK >= MAX_EVENTS`, stop watching — launch and schedule nothing. Announce: *"pr-watch stopped after $MAX_EVENTS events — <PR #N: current state, one per PR>. Re-run `/pr-watch <N> [<M> ...]` to resume watching."* (in `NONINTERACTIVE` mode, post that as a comment on each PR).

**Ensure worktree** (per PR):
```bash
PR=<number>
BRANCH=$(gh pr view $PR --json headRefName -q .headRefName)
BASE=$(gh pr view $PR --json baseRefName -q .baseRefName)
```
Skip the rest when `gh pr view $PR --json state -q .state` is `MERGED` or `CLOSED` — go straight to step 2.
```bash
WT=$("${CLAUDE_SKILL_DIR}/scripts/ensure-worktree.sh" "$WT_DIR" "$REMOTE" "$BRANCH") && cd "$WT" && pwd
```
Args: `WT_DIR REMOTE BRANCH`. Stays in the current linked worktree when it is on `BRANCH`; otherwise uses `$WT_DIR/$BRANCH`, fetching `BRANCH` and adding the worktree when the directory is missing. Prints that checkout's root, or prints `WRONG_CHECKOUT` (stderr) and exits 1 when it isn't on `BRANCH`.
`WRONG_CHECKOUT` → block.

## Waiting

Every wait is one `wait-for.sh` poller per PR, launched with Bash `run_in_background` from the worktree root:
```bash
"${CLAUDE_SKILL_DIR}/scripts/wait-for.sh" <mode> "$PR" <timeout> <poll> "/pr-watch <N>[:flags] [<M>[:flags] ...] --tick <TICK+1> [--non-interactive]"
```
Args: `MODE PR TIMEOUT_SEC [POLL_SEC] [PASSTHROUGH]`. Polls `gh` every `POLL_SEC` until the state change of its mode and prints one final line, `WAIT <mode> <PR> done|timeout|error[:<reason>] <passthrough>` — exit 0 on `done`, 2 on `timeout`, 1 on `error` (`gh` failed twice in a row). `done` reasons: `checks` → `finished|failed|no-ci|no-checks` (`no-ci`: no workflow triggers on `pull_request`; `no-checks`: none appeared within 10 min of polling), `queue` → `started`, `merge` → `merged|closed`, `change` → `updated`. `checks` runs `gh pr checks --watch --fail-fast` once checks have appeared. The passthrough is this loop's own re-invocation, so every wake is self-describing — no state file.

| Awaiting | Mode | Timeout | Poll | Fallback delay |
|---|---|---|---|---|
| CI running, just pushed, after a fix or a re-run | `checks` | 28800 | 60 | 240 s just pushed, 540 s while CI runs |
| Queued on offline runners (step 2) | `queue` | 14400 | 300 | 3600 s |
| Review — `REVIEW_REQUIRED`, `CHANGES_REQUESTED` (step 5) | `change` | 28800 | 300 | 2400 s |
| Green, awaiting merge — `ready=` (step 5) | `merge` | `READY_HOURS` × 3600, minus the time since `ready=` | 300 | 3600 s |
| `waits=<M>` (step 2) | `merge` on #M — re-use #M's own poller when it is in the list | 28800 | 300 | 3600 s |
| Mergeability `UNKNOWN` (step 4) | `ScheduleWakeup` 60 s, always | — | — | 60 s |

- **One poller per PR.** A tick re-uses the poller still running for that PR instead of launching another, and never schedules a `ScheduleWakeup` while one is alive. The poller's completion notification is the next tick: run its passthrough line.
- **`done`** → tick that PR now.
- **`timeout`** → never relaunch: announce the cap and drop the PR, whatever the mode — *"PR #<N> is still <awaiting> after <timeout in h> h — pr-watch stopped. Re-run `/pr-watch <N>` to resume watching."*, with step 5's wording for a ready PR (in `NONINTERACTIVE`, post it as a PR comment).
- **`error`** → relaunch once, same mode and timeout; a second `error` → block, quoting the reason.
- **Fallback.** Bash `run_in_background` not in this session's tool list → `ScheduleWakeup` with the last column's delay, one wakeup for the whole list (step 1).

## 2 — Check CI

```bash
"${CLAUDE_SKILL_DIR}/scripts/pr-state.sh" "$PR"
```
Run from the worktree root. Args: `PR`. One call gathers this tick's inputs and prints `key=value` lines, in this order: `state`, `headSha`, `mergeStateStatus`, `mergeable`, `reviewDecision`, `checksTotal`, `checksSuccess`, `checksFailure`, `checksPending`, `checksSkipped`, `failing` (`name:runId`, comma-separated — an empty run id is an external status), `queuedOver10m` (workflows queued over 10 min), `queuedSelfHosted` (`true` when a `runs-on` of those workflows in `.github/workflows/` is not GitHub-hosted `ubuntu-*` / `windows-*` / `macos-*`), `unresolvedThreads` (root review comments), `hasPrCi` (a workflow triggers on `pull_request`/`pull_request_target`), `lastActivityAgeSec` (since the PR was created or its head last committed, whichever is later). Exit 1 with `pr-state: gh failed: <subcommand>` on stderr → run it once more; failing again → block with that message.

Parse `state`:
- **`MERGED`** → clean up (step 6), drop.
- **`CLOSED`** (not merged) → announce abandoned, drop.

**`waits=<M>` set** → check only the fix PR: `gh pr view <M> --json state -q .state`:
- `MERGED` → rebase onto base (step 4, `BEHIND`), remove `waits`, wait `checks`.
- `CLOSED` → remove `waits`, block (the fix PR was closed unmerged).
- `OPEN` → skip the rest of this PR's tick; it waits on #M — `merge` on #M (**Waiting**).

### No checks reported
`checksTotal` is `0`. `hasPrCi=false`, or `lastActivityAgeSec` over 600 (PR created / head committed over 10 min ago and still no checks) → CI is **none**: proceed to step 3 as if passed. Otherwise wait `checks` — its settle phase ends `done:no-checks` after 10 min, and the next tick lands here with `lastActivityAgeSec` over 600.

### CI running or queued
`checksPending` is above `0`. `queuedOver10m` non-empty and `queuedSelfHosted=true` → **runners unavailable**. Without the `runners` flag: tell the user once that the runners look offline (in `NONINTERACTIVE`, one PR comment) and add `runners`. Wait `queue`; don't repeat the announcement. Remove `runners` once jobs start.

Otherwise wait `checks`.

### CI failed
`checksFailure` is above `0`. For each `name:runId` in `failing`:
```bash
gh run view $RUN_ID --log-failed
```
An empty run id is an external status → classify from its `detailsUrl` (`gh pr view $PR --json statusCheckRollup`).

**Not run locally?** Ship records in the PR body the layers the engineer did not run before the commit:
```bash
"${CLAUDE_SKILL_DIR}/scripts/not-run-lanes.sh" "$PR"
```
Args: `PR`. Prints the lanes of the last `<!-- supera: not_run=... -->` marker in the PR body, one per line (`e2e`, `integration`, …), nothing when there is none. Exit 1 with `not-run-lanes: gh failed: pr view` on stderr → run it once more; failing again → block with that message. A failing job whose name or workflow matches a listed lane is **caused by the PR**: delegate to `supera-engineer` with the log excerpt — never classify it as pre-existing, and skip the base comparison below for it.

**Pre-existing or unrelated?** Compare the remaining failures with the base branch's latest run of the same workflow:
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
| OOM (exit 137), run `attempt` 1 (`gh run view $RUN_ID --json attempt`) | Re-run: `gh run rerun $RUN_ID --failed`. |
| OOM again (`attempt` ≥ 2) | Not transient — delegate to `supera-engineer` with the hint to reduce build parallelism. |
| Transient (network) | Re-run: `gh run rerun $RUN_ID --failed`. |
| Unknown | Block. |

**Side PR** for a pre-existing or unrelated failure:
1. Search for an existing fix: `gh pr list --state open --search "<package, advisory ID, or job name>" --json number,title,headRefName`. Found #M → add `waits=<M>` to this PR.
2. None → `cd "$REPO_ROOT"` and invoke the `ship` skill with: *"fix <failure> on `$BASE` — side PR for #<N>, in a new worktree from `$BASE`; don't touch branch `$BRANCH`"*. Ship's final hand-off to pr-watch is this loop: add the side PR to the watch list (no separate watch) and add `waits=<side PR>` to this PR.

Fixes follow **Delegation** (empty-diff check, commit, push); after a push or re-run, wait `checks`.

### CI passed
`checksFailure` and `checksPending` are both `0` → proceed to step 3.

## 3 — Review comments

`unresolvedThreads` (step 2) above `0` → fetch the threads:
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

After fixes → wait `checks`.

## 4 — Sync with base

From `mergeStateStatus` and `mergeable` (step 2):

- `mergeStateStatus` values: `CLEAN` (no conflicts), `DIRTY` (conflicts), `UNKNOWN`, `BLOCKED`, `BEHIND`, `UNSTABLE`, `HAS_HOOKS`
- `mergeable` values: `MERGEABLE`, `CONFLICTING`, `UNKNOWN` (older gh versions may only have this field)

- **`DIRTY` or `CONFLICTING`** → rebase onto base, resolve conflicts (bare conflict markers → fix directly; logic → `supera-engineer`), push, wait `checks`:
  ```bash
  git fetch $REMOTE $BASE
  git rebase $REMOTE/$BASE
  # if conflicts: resolve per Delegation, then git add + git rebase --continue
  git push --force-with-lease $REMOTE $BRANCH
  ```
- **`BEHIND`** → branch is behind base. Rebase, push, wait `checks`:
  ```bash
  git fetch $REMOTE $BASE
  git rebase $REMOTE/$BASE
  git push --force-with-lease $REMOTE $BRANCH
  ```
- **`UNKNOWN`** → GitHub is still computing mergeability; it normally resolves in seconds. Bounded retry via the PR's `unknown=<n>` flag (absent = `0`):
  - `n >= 3` → stop retrying — block. Status stuck at `UNKNOWN` this long means GitHub can't compute it — a human needs to look.
  - Otherwise set `unknown=<n+1>` and wait 60 s — `ScheduleWakeup`, the one wait that never uses a poller (**Waiting**).
  Every other path removes `unknown`, so the counter resets once the status resolves.
- **`BLOCKED`** → `reviewDecision` is `REVIEW_REQUIRED` or `CHANGES_REQUESTED` → continue to step 5 (review wait). Otherwise block.

## 5 — Done check

Ready when:
- Every CI check is `SUCCESS` or `SKIPPED` (or CI is none, step 2)
- Zero unresolved review threads
- `mergeStateStatus` is `CLEAN` (or `mergeable` is `MERGEABLE`)
- `reviewDecision` is `APPROVED` (or no review required: empty/null string)
  - If `reviewDecision` is `REVIEW_REQUIRED` or `CHANGES_REQUESTED` → wait `change`.

A fix, rebase, failing check, or new review while `ready` is set → remove `ready`; it is announced again once ready.

**Ready ≠ exit.** Keep watching until the PR is merged or closed (step 2), with `READY_HOURS = 8`:
- No `ready` flag → announce once: *"PR #<N> is green and all threads resolved — ready to merge. I'll keep watching and clean up after you merge it."* (in `NONINTERACTIVE`, post it as a PR comment). Add `ready=$(date +%s)`, wait `merge`.
- `ready` set, under `READY_HOURS` since it → wait `merge` silently (re-using the live poller).
- `ready` set, `READY_HOURS` reached (the `merge` poller's `timeout`) → drop: *"PR #<N> is still unmerged after $READY_HOURS h — pr-watch stopped. After merging, run `/pr-watch <N>` to clean up."* (in `NONINTERACTIVE`, post as a PR comment).

**pr-watch never merges.** Not on green, not on approval, not when asked to "finish the PR", not even when the user explicitly asks — merging is always the user's action, performed by the user.

## 6 — Clean up

Runs only when the PR is observed as `MERGED` (step 2). Starts and ends at the repo root:
```bash
cd "$REPO_ROOT" && "${CLAUDE_SKILL_DIR}/scripts/cleanup.sh" "$REMOTE" "$BASE" "$BRANCH"
```
Args: `REMOTE BASE BRANCH`. Prunes, removes exactly `BRANCH`'s worktree (never the main checkout), deletes `BRANCH` with `-D` (squash merges leave it unmerged locally — safe because the PR is MERGED) and on `REMOTE` when it is still there, then fast-forwards local `BASE` only when the main checkout is on it and clean — never resets or forces. Idempotent; refuses `BRANCH` = `BASE`. Non-zero exit → surface git's message.

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
- **Don't spin-poll** — wait through a background `wait-for.sh` poller or `ScheduleWakeup` (**Waiting**), never `sleep` in the foreground.
- **One loop** — every poller's passthrough and the single fallback `ScheduleWakeup` carry the whole watch list; one poller per PR, never two.
- **Bounded watch** — `MAX_EVENTS` (30) per loop, a timeout on every poller, `READY_HOURS` (8) per PR awaiting merge; announce and stop instead of relaunching or rescheduling. The user resumes with a fresh `/pr-watch <N>`.
- Never fix a pre-existing or unrelated failure inline in the feature PR — side PR (step 2).
- Never push `--force` — only `--force-with-lease` after rebase.
- Never remove `BASE` or its worktree; never reset or force-update local `BASE`.
- Commit hygiene follows `${CLAUDE_PLUGIN_ROOT}/guidelines/commit-conventions.md`.
