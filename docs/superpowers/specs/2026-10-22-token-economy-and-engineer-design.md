# Token economy and engineer refinement — design

Date: 2026-10-22. Scope: the supera plugin (`skills/ship`, `skills/pr-watch`, `agents/supera-engineer`, `schema/`, `hooks/`, `guidelines/`).

## Intent

Supera works: since the 2026-10-07 round (v2.1.7–v2.2.0) the user-facing friction it targeted dropped (facets, ~50 sessions each side: excessive_changes 5→1, misunderstood_request 8→2, wrong_approach 8→3). What hurts now is cost and late bug discovery. Measured on every transcript since 2026-10-07 (15 days, ~90 supera sessions):

| Signal | Value |
|---|---|
| pr-watch wakeups | 472 in 70 loops. 232 carry `ready=` (green, waiting for the user to merge, 30 min cadence), 163 plain (CI running, 20 min), 63 `runners` (self-hosted offline, 30 min), 14 `waits=` (side PR). |
| Cost per wakeup | median 4 assistant turns, each re-reading the full context (~280K tokens, mostly cache reads). Heaviest loops ran 9–13 h. |
| Usage limits | 5 sessions hit the usage limit during pr-watch or a ship fan-out (19 engineers dispatched at once in one session, no receipt collected). |
| Engineer runs | 111 dispatches, 60 sessions. Duration median 8 min, p75 24, p90 48, max 229; 6 over 60 min; one stalled ~2 h in diagnosis until nudged. |
| Engineer receipts | 83 parsed: 81 pass, 2 fail. e2e `skipped` in 71, integration in 26, unit in 16. Bugs attributable to supera surfaced after the receipt passed: in review, in CI e2e, in manual testing. |
| Background Bash | 140 `gh pr checks --watch` watchers launched with `run_in_background` completed and notified the session; median 12 min, max 565 min. Background processes survive for hours and wake the session on exit. |

Two conclusions drive the design. Waiting must stop costing model turns: every wait becomes a background poller that wakes the session once, on a state change. And the engineer's receipt must say what was actually verified, with a bounded review before anything is committed.

## Goals

1. Model turns spent waiting in pr-watch drop by at least 80%: one event per state change instead of a tick every 20–30 min.
2. Nothing runs unbounded: every poller has a timeout, every loop an event cap, every engineer a deadline, and the user is told when a cap is hit.
3. Receipts reflect reality: a layer is `skipped` only when the repo has none; what exists but was not executed is `not_run`, with the reason.
4. Logic bugs are caught before commit by a bounded, diff-only review.
5. Less text re-injected per wake: pr-watch's SKILL.md shrinks and shared rules live in one guideline.

## Non-goals

- Changing who merges. Merging stays the user's action; pr-watch keeps watching after green (the user's standing decision), only far cheaper.
- Infra outside the plugin: self-hosted runner availability, scheduled audit-fix jobs, GitHub-hosted fallbacks.
- Making local e2e a mandatory gate. CI remains the gate; the engineer runs the targeted subset.
- Any config file or repo-specific hardcoding. Everything is still detected from the target repo.

## Anti-goals

- A guard that drops a PR or an engineer silently. Every stop announces itself (or posts a PR comment in non-interactive mode).
- Pollers that hammer the GitHub API. State polls every 300 s or slower; only `gh pr checks --watch` polls faster (30 s) and only while checks run.
- A reviewer that explores the repo. It reads the diff, the plan and the task; it does not open unrelated files or run the suite.
- Shaving tokens by hiding information from the user. Announcements keep the same content, there are just fewer of them.

## Constraints

- Core invariants in `CLAUDE.md`: deterministic steps live in `skills/<skill>/scripts/` with bats coverage; `make lint` (shellcheck, strict YAML frontmatter) and `make test` pass; no `$<digit>` tokens in SKILL.md or agent text; `schema/` is the source of truth for every receipt field skills read; guidelines are canonical, never restated.
- Shell hooks rewrite human-readable git output. Scripts consume `--porcelain`, `rev-parse`, `--json` only.
- `ScheduleWakeup` clamps delays to [60, 3600] s. Bash `run_in_background` processes survive for hours and deliver a completion notification (measured above). Scripts take every input as an argument: shell state doesn't persist between Bash calls.
- Agent dispatch is asynchronous: the Agent tool returns at once with an agent id, and the receipt arrives later as a task notification. A `SendMessage` to that id reaches a running engineer (verified 2026-10-19: a status nudge sent 2 h 12 min after dispatch produced the receipt 22 min later). The agent id is internal metadata: used by the skill, never shown to the user.
- Task notifications wake an idle session with no wakeup pending. Verified 2026-10-22 in the session that produced this design, for an agent and for a background Bash command (`sleep 75` launched with `run_in_background`, turn ended, nothing scheduled, completion notification woke the session).
- Ships through `/supera:ship`, one PR per part. CD bumps the version from the merge commit. A skill invoked from a running session may load its old content: test each new version in a fresh session.
- Agent frontmatter may set `model:`; the receipt hook matcher is `^supera:supera-engineer$`.

## Decisions

### Part A — pr-watch waits in the background

**A1. One state call per PR.** `skills/pr-watch/scripts/pr-state.sh <PR>` gathers everything steps 2–5 need and prints compact `key=value` lines: `state`, `headSha`, `mergeStateStatus`, `mergeable`, `reviewDecision`, check counts (`checksTotal`, `checksSuccess`, `checksFailure`, `checksPending`, `checksSkipped`), failing check names with run ids, workflows queued over 10 min and whether their `runs-on` targets self-hosted labels, `unresolvedThreads`, `hasPrCi` (reusing `has-pr-ci.sh`), `lastActivityAgeSec`. It replaces the three to six separate `gh` calls a tick makes today. Exit 0 with data, 1 on `gh` error.

**A2. One poller script, four modes.** `skills/pr-watch/scripts/wait-for.sh <mode> <PR> <timeout-sec> [<poll-sec>] [<passthrough>]`, meant to run in the background:

| Mode | Exits when | Default poll | Timeout the skill passes |
|---|---|---|---|
| `checks` | checks have appeared on the head sha and `gh pr checks <PR> --watch --fail-fast` has returned (finished, or one failed) | settle phase: 60 s until the first check appears, at most 10 min; then gh's own 30 s | 8 h |
| `queue` | no run for the PR head sha is `queued` any more (runners picked the jobs up) | 300 s | 4 h |
| `merge` | PR `state` is `MERGED` or `CLOSED` | 300 s | `READY_HOURS` (8 h) |
| `change` | PR `updatedAt` differs from the value at start (review, approval, push, label) | 300 s | 8 h |

`checks` on a PR whose repo has no `pull_request` workflow (`has-pr-ci.sh` → `NO_PR_CI`) exits `done` at once with reason `no-ci`; a settle phase that ends with still no checks exits `done` with reason `no-checks`, and the skill applies today's "no checks reported" rule. The final line is `WAIT <mode> <PR> done|timeout|error[:<reason>] [<passthrough>]`; exit 0 on `done`, 2 on `timeout`, 1 on `error`. The timeout argument is mandatory; the script refuses to run without one. `passthrough` is an opaque string echoed verbatim on the final line: the skill passes its own full re-invocation (`/pr-watch <PR>[:flags] ... --tick <N>`) so every wake is self-describing even after context compaction, with no state file. *(My call: a settle phase inside `checks`, timeouts per mode, pass-through on the final line.)*

**A3. Waiting model.** When Bash `run_in_background` is available, each row of today's **Waiting** table becomes one background `wait-for.sh` launch and **no `ScheduleWakeup` is scheduled while a poller for that PR is alive**. The poller's completion notification is the next tick. One poller per PR; a tick re-uses a live one instead of starting another. Mapping: CI running, just pushed, after a fix or a re-run → `checks`; queued on offline runners → `queue`; awaiting review → `change`; green and awaiting merge → `merge`; `waits=<M>` → `merge` on M. Mergeability `UNKNOWN` is the one wait that stays on `ScheduleWakeup` (60 s, bounded by `unknown=<n>` as today). A poller that exits `timeout` is never relaunched: the loop announces the cap and drops that PR, in every mode, the way the ready phase does today. When `run_in_background` is not available, fall back to `ScheduleWakeup` with today's delays doubled and capped at 3600 s. *(My call: timeout always means announce and drop; `UNKNOWN` stays on the scheduler.)*

**A4. Ready phase stays, at one turn.** Ready still means "keep watching, clean up after the user merges". With `merge` mode that costs one background process and one wake, instead of up to 16 ticks of 4 turns. `READY_HOURS = 8` is unchanged; on `timeout` the loop announces the stop as it does today. *(My call: keep the user's "ready ≠ exit" decision since it is now nearly free.)*

**A5. Guards.** `MAX_TICKS` becomes `MAX_EVENTS = 30`: every poller notification and every fallback wakeup counts; `--tick` keeps carrying the counter. A poller that exits `error` is relaunched once; a second `error` blocks the PR with the reason. Two pollers never run for the same PR. A loop with an empty list exits without scheduling anything, as today.

**A6. Skill text diet.** Tick logic that `pr-state.sh` now decides (classification inputs, queue detection, no-checks detection) leaves SKILL.md; the flags table shrinks to the flags that remain. The delegation rules duplicated across `CLAUDE.md`, ship and pr-watch move to `guidelines/delegation.md`, referenced from all three (the pending wave 2 of the 2026-10-07 backlog). The hook gets its row in `CLAUDE.md`'s layout table and a README mention. Target: pr-watch SKILL.md at or under 150 lines (from 276).

### Part B — ship guards and review gate

**B1. Engineer deadline.** Right after dispatching an engineer, the orchestrator launches `scripts/deadline.sh <minutes> [<passthrough>]` in the background; it sleeps and prints `ENGINEER_DEADLINE <minutes> [<passthrough>]`. Default 60 minutes *(my call: p90 was 48)*. When it fires and no receipt has arrived, the orchestrator sends the engineer one `SendMessage`: "Stop and return the receipt now with the current state; mark unverified gates `not_run`." A second deadline without a receipt → surface the stall to the user and stop waiting for that engineer. When the receipt arrives first, the fired deadline is a no-op. The script is shared (`scripts/`, not a skill's folder) and the rule lives in `guidelines/delegation.md`, because pr-watch's fix loops dispatch engineers too; the measured 2 h stall was one of them. Ship and pr-watch add `SendMessage` to `allowed-tools`.

**B2. Review gate before commit.** New agent `agents/supera-reviewer.md` (tools: Read, Grep, Bash; `model: sonnet` *(my call: the review is bounded and diff-only; cheaper model is enough)*). Input: the task, `.supera/plan.md`, and the full change (`git diff $REMOTE/$BASE` plus the content of untracked files from `git ls-files --others --exclude-standard`). It checks the diff against the task and the plan for logic errors, unhandled edge cases, missing or hollow tests, and scope drift. Output: JSON matching a new `schema/review.schema.json`: `{"findings": [{"severity": "blocker|important|minor", "file", "line", "problem", "fix"}]}`. Ship runs it once after step 4a passes. `blocker`/`important` findings go back to the engineer in one loop (counts toward the 3-loop max); the engineer may rebut a finding in `receipt.notes`. The reviewer then re-checks only those findings once, reading the rebuttals, and may withdraw a finding. A `blocker` still open after the re-check stops ship like a failed gate after 3 loops: nothing is committed, the findings are surfaced for manual review. An `important` still open is committed and listed as an open finding under Evidence in the PR body; `minor` findings are listed there too. Skip the review when the change touches only `*.md` files or changes 20 lines or fewer *(my call, including the blocker/important split)*.

**B3. Verification honesty.** `schema/receipt.schema.json` adds `not_run` to the verification enum: the repo has that layer, the engineer did not execute it, and `notes` says why. `skipped` now strictly means the repo has no such layer. Ship's acceptance: `fail` blocks (as today); `not_run` on `build`, `lint` or `unit` blocks, treated like `fail`; `not_run` on `integration`, `e2e` or other long layers is accepted, recorded in the PR's Checklist (`[ ]`) and Evidence, and pr-watch treats a later CI failure in those lanes as caused by the PR, never as pre-existing. Ship records the lanes machine-readably in the PR body, as an HTML comment appended at the very end regardless of template: `<!-- supera: not_run=e2e,integration -->`. pr-watch reads it with `gh pr view --json body`; no marker means no `not_run` lane. *(My call: the marker is the ship→pr-watch contract.)* `hooks/validate-receipt.sh` validates against the updated schema; fixtures under `tests/fixtures/receipt/` cover `not_run` and the invalid-value case. Schema, hook, engineer text and ship acceptance ship in the same PR so they never drift.

**B4. Ship refuses non-PR work.** Step 1: when the task description produces no change to repo files (a one-off command, a download, a deploy, an inspection), ship says ship is not the tool, suggests doing it directly, and stops before creating a worktree.

### Part C — engineer refinement

**C1. Bounded diagnosis.** A gate that fails twice with the same error stops the loop: the engineer records `fail`, puts the decisive log excerpt in `notes` and returns. A suite that takes longer than 15 minutes is never re-run more than once. The existing "try up to 2 times" becomes this explicit rule.

**C2. Orientation diet.** Read `CLAUDE.md`, the files listed under `## Files`, their immediate neighbours and their tests. No repo-wide reads. For files over 300 lines, locate symbols with grep or code-navigation tools (whatever the user has installed) instead of reading the whole file.

**C3. Targeted tests, honest values.** Build, lint and unit run always when the repo has them. For integration and e2e, run the subset whose paths or packages intersect `## Files` (by test file location, package, or the runner's filter flag). When no subset can be selected, or the subset would exceed 15 minutes, set `not_run` with the reason. Never `skipped` for a layer the repo has.

**C4. Self-check before the receipt.** Re-read the diff against the task statement: each requirement maps to where it is satisfied; anything unmet or deferred goes in `notes`. Same context, no extra agent.

**C5. Answer the nudge.** On the orchestrator's "return the receipt now", return immediately with real values: `not_run` for what was not executed, `fail` for what failed, never `pass` by assumption.

### Out of scope here, follow up elsewhere

- Root `heronlabs/CLAUDE.md`: cap parallel `/supera:ship` fan-out (the 19-engineer session). Suggested cap: 4 concurrent ships.
- Runner availability and audit-fix automation.

## Left to the builder

- Exact `gh` queries and JSON fields in `pr-state.sh` and `wait-for.sh`; how bats fakes `gh` (a PATH shim that replays canned JSON is the expected pattern); a POSIX timeout around the blocking `gh --watch`.
- Deciding at the skill level whether `run_in_background` exists (from the tool list in the session); the scripts do not detect it.
- Announcement wording, as long as the content matches today's.
- The reviewer prompt and `schema/review.schema.json` details; the reviewer is the only agent without a SubagentStop hook unless the builder finds one cheap to add.
- How ship passes the base ref and task to the reviewer (same way it does for the engineer), and how the 20-line skip is counted.
- Where the delegation guideline documents capturing the agent id from the Agent tool result.

## Rollout

One PR per part, through `/supera:ship`, in this order:

1. Part A (A1–A5): biggest savings. The idle-wake premise was checked on 2026-10-22 (see Constraints); no further check needed before this PR.
2. B3 + C1–C5 together: schema, hook, engineer text and ship acceptance in one PR.
3. B1 (deadline) with `guidelines/delegation.md` (the dedupe part of A6), since the deadline rule is the guideline's first shared entry.
4. B2 (reviewer).
5. Rest of A6 + B4: skill diet, docs, non-PR guard.

Test each new version in a fresh session before relying on it. After two weeks, re-measure on the transcripts.

## Success metrics

| Metric | Today (2026-10-07 → 10-22) | Target |
|---|---|---|
| pr-watch wakeups + events per loop | 472 / 70 ≈ 6.7 | ≤ 3 |
| Assistant turns per event | median 4 | ≤ 2 |
| Engineer runs over 60 min without a nudge | 6 of 111 | 0 |
| e2e/integration `skipped` where the repo has the suite | 71 / 83 receipts | 0 (`pass` or `not_run` with reason) |
| Sessions hitting the usage limit inside pr-watch or ship | 5 | 0 |
| pr-watch SKILL.md length | 276 lines | ≤ 150 |
