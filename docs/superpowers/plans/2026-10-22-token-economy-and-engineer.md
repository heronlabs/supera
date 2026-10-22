# Token Economy and Engineer Refinement Implementation Plan

> **For agentic workers:** This repo ships every change through `/supera:ship`, one PR per part (repo rule, overrides the default execution skills). Each **PR section** below is one `/supera:ship` invocation; its tasks are the engineer's work inside that worktree. The engineer never commits — ship does. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pr-watch wait in background processes instead of model turns, bound every engineer and loop, and make engineer receipts honest and reviewed before commit.

**Architecture:** Deterministic steps move into POSIX scripts under `skills/<skill>/scripts/` and shared `scripts/`, each covered by bats against a fake `gh` on `PATH` and throwaway git repos. SKILL.md files say *what* to run and the contract; the receipt schema stays the source of truth and gains one value; a new diff-only reviewer agent gates ship's commit.

**Tech Stack:** POSIX sh, bats-core, shellcheck, jq, `gh` CLI, Claude Code plugin format (SKILL.md, agent markdown with YAML frontmatter, `hooks.json`).

**Spec:** `docs/superpowers/specs/2026-10-22-token-economy-and-engineer-design.md`

## Global Constraints

- `make lint` (shellcheck on every script and test, `jq empty` on every schema, strict YAML frontmatter) and `make test` (bats) pass in every PR.
- No `$<digit>` token anywhere in a SKILL.md or agent file (Claude Code substitutes skill arguments). `tests/repo-integrity.bats` enforces it and that every `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` path exists and is executable.
- Scripts take every input as an argument; nothing read from shell state. Scripts never parse human-readable git output: `--porcelain`, `rev-parse`, `--json` only.
- Nothing repo-specific hardcoded; no config file; no state file.
- Guidelines are canonical: a rule stated in two documents is a defect.
- Commit subjects per `guidelines/commit-conventions.md` (ship writes them). Never hand-bump `plugin.json` version.
- Tests fake `gh` with a shim directory prepended to `PATH`; the shim reads a scenario directory passed through an environment variable set by the test (the only allowed env use, inside tests).

## Review Focus

1. `wait-for.sh checks` when `gh pr checks --watch --fail-fast` exits non-zero because a check failed: must end `done`, never `error`. Test in PR 1, Task 2.
2. `wait-for.sh merge` on a PR closed without merge: `done:closed`, not an endless poll. Test in PR 1, Task 2.
3. `gh` failing mid-poll (network, auth): `error`, exit 1, after one retry inside the script — never a tight loop. Test in PR 1, Task 2.
4. Receipt with `not_run` on `unit`, `lint` or `build`: ship blocks it; the marker script exits non-zero. Test in PR 2, Task 2.
5. Passthrough containing spaces, colons and `--tick 7`: echoed byte-for-byte on the final line. Test in PR 1, Task 2.

---

## PR 1 — pr-watch waits in the background (spec Part A, A1–A5)

Ship task: *"pr-watch: add pr-state.sh and wait-for.sh pollers, make every wait a background poller with MAX_EVENTS; spec Part A A1–A5 in docs/superpowers/specs/2026-10-22-token-economy-and-engineer-design.md, plan PR 1 in docs/superpowers/plans/2026-10-22-token-economy-and-engineer.md"*. The spec and plan files are untracked in the main checkout; the engineer copies both into the worktree under the same paths so they land in this PR.

### Task 1: `gh` shim for tests

**Files:**
- Create: `tests/gh-shim/gh` (executable)
- Create: `tests/gh-fixtures.bash`
- Test: `tests/gh-shim.bats`

**Interfaces:**
- Produces: `gh_scenario <dir>` (bash helper) — prepends `tests/gh-shim` to `PATH` and exports `GH_SHIM_SCENARIO=<dir>`. The shim resolves a call by joining its non-flag arguments with `_` (`pr view 154 --json state` → `pr_view_154`) and prints `<dir>/<key>.out` (or the Nth file `<key>.<N>.out` on the Nth call, tracked in `<dir>/.calls/<key>`), exiting with the code in `<key>.code` when present, else 0. A missing file prints `gh-shim: no fixture for <key>` to stderr and exits 99.

- [ ] **Step 1: Write failing tests** in `tests/gh-shim.bats`: `shim replays <key>.out and exit code`, `shim serves .1.out then .2.out on consecutive calls`, `shim exits 99 on missing fixture`.
- [ ] **Step 2: Run `bats tests/gh-shim.bats`** — expected: FAIL, shim not found.
- [ ] **Step 3: Implement** `tests/gh-shim/gh` (POSIX sh) and `gh_scenario` in `tests/gh-fixtures.bash`.
- [ ] **Step 4: Run `bats tests/gh-shim.bats`** — expected: PASS. `make lint` — expected: clean.

### Task 2: `wait-for.sh`

**Files:**
- Create: `skills/pr-watch/scripts/wait-for.sh`
- Test: `tests/wait-for.bats`, fixtures under `tests/fixtures/gh/wait-for/<scenario>/`

**Interfaces:**
- Produces: `wait-for.sh <mode> <PR> <timeout-sec> [<poll-sec>] [<passthrough>]`; modes `checks|queue|merge|change`; final stdout line `WAIT <mode> <PR> <status>[:<reason>] [<passthrough>]`; exit 0 `done`, 2 `timeout`, 1 `error`. Reasons: `checks` → `finished|failed|no-ci|no-checks`; `merge` → `merged|closed`; `queue` → `started`; `change` → `updated`. Default `poll-sec` 300 (`checks` settle phase 60, max 10 min). Missing `timeout-sec` → usage on stderr, exit 64. `checks` runs `${CLAUDE_SKILL_DIR}/scripts/has-pr-ci.sh` logic through the sibling script (`"$(dirname "$0")/has-pr-ci.sh"`), then polls `gh pr view <PR> --json statusCheckRollup` until non-empty, then `gh pr checks <PR> --watch --fail-fast --interval 30`. Every `gh` failure is retried once after `poll-sec`; a second consecutive failure ends `error`.

- [ ] **Step 1: Write failing tests** (poll-sec `1`, timeout `3`, shim scenarios): `merge: done:merged when state becomes MERGED on 2nd poll`; `merge: done:closed on CLOSED`; `merge: timeout exit 2 when state stays OPEN`; `queue: done:started when queued list empties`; `change: done:updated when updatedAt differs`; `checks: done:failed when gh pr checks exits 8` (fixture `.code` = 8); `checks: done:no-ci when has-pr-ci reports NO_PR_CI`; `checks: done:no-checks after settle phase with empty rollup` (settle max passed as the timeout for the test); `error exit 1 after two consecutive gh failures`; `passthrough echoed verbatim` with passthrough `/pr-watch 154:waits=160 160 --tick 7`; `usage exit 64 without timeout`.
- [ ] **Step 2: Run `bats tests/wait-for.bats`** — expected: FAIL, script missing.
- [ ] **Step 3: Implement** `skills/pr-watch/scripts/wait-for.sh` per the interface; `chmod +x`.
- [ ] **Step 4: Run `bats tests/wait-for.bats` and `make lint`** — expected: PASS, clean.

### Task 3: `pr-state.sh`

**Files:**
- Create: `skills/pr-watch/scripts/pr-state.sh`
- Test: `tests/pr-state.bats`, fixtures under `tests/fixtures/gh/pr-state/<scenario>/`

**Interfaces:**
- Produces: `pr-state.sh <PR>` prints exactly these `key=value` lines, in this order: `state`, `headSha`, `mergeStateStatus`, `mergeable`, `reviewDecision`, `checksTotal`, `checksSuccess`, `checksFailure`, `checksPending`, `checksSkipped`, `failing` (comma-separated `name:runId`, empty allowed), `queuedOver10m` (comma-separated workflow names), `queuedSelfHosted` (`true|false`: any of those workflows' `runs-on` in `.github/workflows/` is not `ubuntu-*`/`windows-*`/`macos-*`), `unresolvedThreads`, `hasPrCi` (`true|false` via sibling `has-pr-ci.sh`), `lastActivityAgeSec` (now minus max of `createdAt` and last commit date). Exit 1 with `pr-state: gh failed: <subcommand>` on stderr when any `gh` call fails. Run from the worktree root.

- [ ] **Step 1: Write failing tests**: `prints all 16 keys in order for a green PR`; `counts failing checks and lists name:runId`; `flags queuedOver10m and queuedSelfHosted from a self-hosted workflow`; `unresolvedThreads counts root comments only`; `hasPrCi=false in a repo without pull_request workflows`; `exit 1 when gh pr view fails`.
- [ ] **Step 2: Run `bats tests/pr-state.bats`** — expected: FAIL.
- [ ] **Step 3: Implement** `skills/pr-watch/scripts/pr-state.sh`; `chmod +x`.
- [ ] **Step 4: Run `bats tests/pr-state.bats` and `make lint`** — expected: PASS, clean.

### Task 4: pr-watch SKILL.md uses the pollers

**Files:**
- Modify: `skills/pr-watch/SKILL.md` (sections *1 — Resolve the PRs* tick paragraph, **Waiting**, *2 — Check CI*, *4*, *5*, **Rules**)
- Modify: `tests/repo-integrity.bats` only if the new paths need registering (it discovers `${CLAUDE_SKILL_DIR}` paths from the text; verify, don't duplicate)

**Interfaces:**
- Consumes: `wait-for.sh` and `pr-state.sh` contracts from Tasks 2–3.

- [ ] **Step 1: Replace the Waiting table** with the A3 mapping: each wait row → `"${CLAUDE_SKILL_DIR}/scripts/wait-for.sh" <mode> "$PR" <timeout> 300 "/pr-watch <list> --tick <N+1> [--non-interactive]"` launched with Bash `run_in_background`; timeouts `checks` 28800, `queue` 14400, `change` 28800, `merge` `$((READY_HOURS*3600))`; `waits=<M>` → `merge` on M. State "no `ScheduleWakeup` while a poller for that PR is alive; re-use a live poller". `UNKNOWN` mergeability keeps `ScheduleWakeup` 60 s. Fallback without `run_in_background`: `ScheduleWakeup` with today's delays doubled, capped 3600.
- [ ] **Step 2: Replace the per-tick `gh` calls in step 2** with one `pr-state.sh "$PR"` call and refer to its keys (`checksFailure`, `failing`, `queuedOver10m`, `queuedSelfHosted`, `hasPrCi`, `lastActivityAgeSec` replaces the `createdAt/commits` jq).
- [ ] **Step 3: Rename `MAX_TICKS` to `MAX_EVENTS = 30`**: every poller notification and fallback wakeup counts; `--tick` carries it; a poller exiting `timeout` is never relaunched — announce and drop the PR; `error` relaunches once, a second `error` blocks.
- [ ] **Step 4: Run `make test` and `make lint`** — expected: PASS (repo-integrity finds both new scripts executable; no `$<digit>` tokens).
- [ ] **Step 5: Read the diff of SKILL.md once more** against spec A3–A5 and tick off each sentence.

---

## PR 2 — honest receipts and engineer refinement (spec B3, C1–C5)

Ship task: *"receipt not_run value, engineer bounded diagnosis and targeted tests, ship acceptance and PR-body marker; spec B3 and C1–C5, plan PR 2"*.

### Task 1: schema and hook accept `not_run`

**Files:**
- Modify: `schema/receipt.schema.json` (verification enum and description)
- Create: `tests/fixtures/receipt/valid-not-run.md`, `tests/fixtures/receipt/bad-value.md`
- Test: `tests/validate-receipt.bats`

**Interfaces:**
- Produces: verification values `pass | fail | skipped | not_run`; description text: "`skipped`: the repo has no such layer. `not_run`: the layer exists but was not executed — say why in `notes`."

- [ ] **Step 1: Add fixtures and failing tests**: `accepts not_run as a verification value` (fixture with `"e2e": "not_run"` and a notes reason → hook exits 0, no block), `blocks an unknown verification value` (fixture with `"unit": "later"` → block JSON names the enum including `not_run`).
- [ ] **Step 2: Run `bats tests/validate-receipt.bats`** — expected: the new tests FAIL.
- [ ] **Step 3: Edit the enum and description** in `schema/receipt.schema.json`.
- [ ] **Step 4: Run `bats tests/validate-receipt.bats` and `make lint`** — expected: PASS, `jq empty` clean.

### Task 2: `not-run-marker.sh`

**Files:**
- Create: `skills/ship/scripts/not-run-marker.sh`
- Test: `tests/not-run-marker.bats`

**Interfaces:**
- Produces: `not-run-marker.sh <receipt-json-file>`; prints `<!-- supera: not_run=<lane>[,<lane>] -->` (lanes sorted, from verification keys valued `not_run`) or nothing when none; exits 3 with `not_run on <key> is not accepted: run it or report fail` on stderr when `build`, `lint` or `unit` is `not_run`; exits 1 on unreadable JSON.

- [ ] **Step 1: Write failing tests**: `prints sorted marker for e2e and integration`, `prints nothing when no not_run`, `exit 3 for not_run on unit`, `exit 3 for not_run on lint`, `exit 1 on malformed receipt`.
- [ ] **Step 2: Run `bats tests/not-run-marker.bats`** — expected: FAIL.
- [ ] **Step 3: Implement** with `jq`; `chmod +x`.
- [ ] **Step 4: Run tests and `make lint`** — expected: PASS.

### Task 3: `not-run-lanes.sh` for pr-watch

**Files:**
- Create: `skills/pr-watch/scripts/not-run-lanes.sh`
- Test: `tests/not-run-lanes.bats` (uses `gh_scenario` from PR 1)

**Interfaces:**
- Produces: `not-run-lanes.sh <PR>`; reads `gh pr view <PR> --json body -q .body`; prints the lanes one per line from the last `<!-- supera: not_run=... -->` in the body; prints nothing when absent; exit 1 when `gh` fails.

- [ ] **Step 1: Write failing tests**: `prints e2e and integration from marker`, `prints nothing without marker`, `uses the last marker when two exist`, `exit 1 when gh fails`.
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement**; `chmod +x`.
- [ ] **Step 4: Run tests and `make lint`** — expected: PASS.

### Task 4: engineer agent text (C1–C5, honest values)

**Files:**
- Modify: `agents/supera-engineer.md` (Process steps 1, 4, 5; Receipt bullets; Rules)

- [ ] **Step 1: Process step 1 (Orient)** → spec C2: read `CLAUDE.md`, the `## Files` entries, their neighbours and tests; no repo-wide reads; files over 300 lines via grep or the user's code-navigation tools.
- [ ] **Step 2: Process step 4 (Verify)** → spec C3: build, lint, unit always when present; integration/e2e as the subset intersecting `## Files` (test file location, package, or the runner's filter flag); `not_run` with reason when no subset can be selected or it would exceed 15 minutes; `skipped` only when the repo has no such layer.
- [ ] **Step 3: Process step 5 (Fix)** → spec C1: same error twice on a gate → stop, `fail`, decisive log excerpt in `notes`; a suite over 15 minutes is re-run at most once.
- [ ] **Step 4: Add a step 6 (Self-check)** → spec C4: map each requirement of the task to where the diff satisfies it; unmet or deferred items go in `notes`.
- [ ] **Step 5: Receipt section**: value list becomes `pass`, `fail`, `skipped`, `not_run` with the one-line meanings from Task 1; add rule **Answer the nudge** (spec C5): on "return the receipt now", return immediately with real values.
- [ ] **Step 6: Run `make lint`** — expected: frontmatter still valid; `make test` — expected: repo-integrity passes (no `$<digit>`).

### Task 5: ship acceptance and marker

**Files:**
- Modify: `skills/ship/SKILL.md` (step 4 receipt parsing, step 7 PR body table and `gh pr create`)
- Modify: `skills/pr-watch/SKILL.md` (step 2 *CI failed* → *Pre-existing or unrelated?*)

**Interfaces:**
- Consumes: `not-run-marker.sh` (Task 2), `not-run-lanes.sh` (Task 3).

- [ ] **Step 1: Ship step 4**: after parsing the receipt run `"${CLAUDE_SKILL_DIR}/scripts/not-run-marker.sh" <receipt file>`; exit 3 is treated exactly like a `fail` gate (back to the engineer with the stderr message, counts toward the 3 loops); stdout, when non-empty, is `MARKER`.
- [ ] **Step 2: Ship step 7**: Checklist rows for `not_run` keys stay `[ ]`; Evidence lists them as "not run locally: <notes reason>"; append `MARKER` as the last line of `.supera/pr-template.md` in both template branches.
- [ ] **Step 3: pr-watch step 2**: before comparing with base, run `not-run-lanes.sh "$PR"`; a failing job whose name or workflow matches a listed lane is classified as caused by the PR (delegate to the engineer), never as pre-existing.
- [ ] **Step 4: Run `make test` and `make lint`** — expected: PASS.

---

## PR 3 — engineer deadline and the delegation guideline (spec B1, A6 dedupe)

Ship task: *"shared deadline.sh, guidelines/delegation.md with the engineer deadline rule, ship and pr-watch reference it; spec B1 and the dedupe half of A6, plan PR 3"*.

### Task 1: `deadline.sh`

**Files:**
- Create: `scripts/deadline.sh`
- Test: `tests/deadline.bats`

**Interfaces:**
- Produces: `deadline.sh <seconds> [<passthrough>]` sleeps `<seconds>` then prints `ENGINEER_DEADLINE <seconds> [<passthrough>]`, exit 0. Non-integer or missing seconds → usage on stderr, exit 64. (Seconds, not minutes, so tests run in one second; the skills pass `3600`.)

- [ ] **Step 1: Write failing tests**: `prints ENGINEER_DEADLINE 1 after one second`, `echoes passthrough verbatim`, `exit 64 without seconds`.
- [ ] **Step 2: Run** — expected: FAIL. **Step 3: Implement**; `chmod +x`. **Step 4: Run tests and `make lint`** — expected: PASS.

### Task 2: `guidelines/delegation.md`

**Files:**
- Create: `guidelines/delegation.md`
- Modify: `CLAUDE.md` (*Agent delegation rules* → one paragraph pointing at the guideline; Layout table rows for `guidelines/` and `hooks/`)
- Modify: `skills/ship/SKILL.md` (step 4 delegation paragraph and 4a empty-diff rules → reference), `skills/pr-watch/SKILL.md` (**Delegation** section → reference); both add `SendMessage` to `allowed-tools`
- Modify: `README.md` (one line under *Architecture* for `hooks/validate-receipt.sh`, one under *Safety* for the deadline)

**Interfaces:**
- Produces: the single home of: dispatch form (`subagent_type: "supera:supera-engineer"`, no `isolation`, no `name:`), receipt-is-a-claim verification (`changed-files.sh` vs `receipt.filesChanged` vs plan `## Files`), empty-diff rule (notes → stop / idled → re-delegate once), trivial-fix boundary, and the new **Deadline** rule: launch `"${CLAUDE_PLUGIN_ROOT}/scripts/deadline.sh" 3600 "<re-invocation>"` in the background right after dispatch; capture the agent id from the Agent tool result (internal, never shown to the user); on `ENGINEER_DEADLINE` with no receipt → one `SendMessage` to that id with the exact text *"Stop and return the receipt now with the current state; mark unverified gates `not_run`."*; a second deadline without a receipt → surface the stall and stop waiting; receipt first → the fired deadline is a no-op.

- [ ] **Step 1: Write the guideline** with those sections, moving (not copying) the text from the three documents.
- [ ] **Step 2: Replace each moved block** with one sentence referencing `${CLAUDE_PLUGIN_ROOT}/guidelines/delegation.md`; add the deadline launch line to ship step 4 and pr-watch **Delegation**.
- [ ] **Step 3: Grep for duplicates**: `grep -n "isolation\|name:\|porcelain" CLAUDE.md skills/*/SKILL.md` — expected: each rule appears once, in the guideline.
- [ ] **Step 4: Run `make test` and `make lint`** — expected: PASS (repo-integrity resolves the guideline path and `scripts/deadline.sh`).

---

## PR 4 — review gate before commit (spec B2)

Ship task: *"supera-reviewer agent, review.schema.json, review-scope.sh and the ship review gate before commit; spec B2, plan PR 4"*.

### Task 1: `review-scope.sh`

**Files:**
- Create: `skills/ship/scripts/review-scope.sh`
- Test: `tests/review-scope.bats` (uses `git-fixtures.bash`)

**Interfaces:**
- Produces: `review-scope.sh <remote/base>` run from the worktree root; counts changed lines as `git diff --numstat <remote/base>` added+deleted plus every line of untracked files from `git ls-files --others --exclude-standard` (minus `.supera/`); prints `SKIP:docs-only` when every changed or untracked path ends in `.md`, `SKIP:small <n>` when `n <= 20`, else `REVIEW <n>`. Exit 0 always; exit 1 only when not inside a git worktree.

- [ ] **Step 1: Write failing tests**: `SKIP:docs-only for README-only change`, `SKIP:small 12 for a 12-line change`, `REVIEW 21 counts untracked file lines`, `.supera/ is ignored`, `exit 1 outside a repo`.
- [ ] **Step 2: Run** — expected: FAIL. **Step 3: Implement**; `chmod +x`. **Step 4: Run tests and `make lint`** — expected: PASS.

### Task 2: reviewer agent and schema

**Files:**
- Create: `agents/supera-reviewer.md` (frontmatter: `name: supera-reviewer`, `description`, `tools: Read, Grep, Bash`, `model: sonnet`)
- Create: `schema/review.schema.json`

**Interfaces:**
- Produces: final message = JSON matching the schema: `{"findings": [{"severity": "blocker|important|minor", "file": "<path>", "line": <int>, "problem": "<one sentence>", "fix": "<one sentence>"}]}`; `findings` may be empty. Input the orchestrator passes: task text, path to `.supera/plan.md`, base ref; the agent reads `git diff <base>` and untracked file contents only. On a re-check it receives the previous findings and the engineer's rebuttals (`receipt.notes`) and returns only findings still open.

- [ ] **Step 1: Write `schema/review.schema.json`** (`additionalProperties: false`, `required: ["findings"]`, severity enum, `line` integer ≥ 1).
- [ ] **Step 2: Write the agent**: scope (diff, plan, task only; no suite runs, no unrelated files), what to look for (logic errors, unhandled edge cases, missing or hollow tests, scope drift from `## Files` / `## Out of scope`), severity definitions (`blocker`: wrong behaviour or data loss on a stated requirement; `important`: likely bug or missing test on a changed path; `minor`: everything else), re-check behaviour, output contract.
- [ ] **Step 3: Run `make lint`** — expected: frontmatter valid, `jq empty` clean on the new schema. `make test` — expected: PASS.

### Task 3: ship review gate

**Files:**
- Modify: `skills/ship/SKILL.md` (new step *4b — Review* between 4a and 5; step 7 Evidence row)

**Interfaces:**
- Consumes: `review-scope.sh` (Task 1), reviewer contract (Task 2).

- [ ] **Step 1: Write step 4b**: run `"${CLAUDE_SKILL_DIR}/scripts/review-scope.sh" "$REMOTE/$BASE"`; on `SKIP:*` record the reason for Evidence and continue; on `REVIEW` dispatch `subagent_type: "supera:supera-reviewer"` (no `isolation`, no `name:`) with the task, `.supera/plan.md`, `$REMOTE/$BASE`; parse findings; `blocker`/`important` → one loop to the engineer with the findings (counts toward the 3 loops; the engineer may rebut in `receipt.notes`), then one re-check passing the rebuttals; a `blocker` still open → stop like a failed gate, surface the findings, commit nothing; an `important` still open → continue; `minor` → Evidence.
- [ ] **Step 2: Step 7 Evidence**: add "Review: <skipped reason | n findings, open important: …, minor: …>".
- [ ] **Step 3: Run `make test` and `make lint`** — expected: PASS.

---

## PR 5 — skill diet, docs and the non-PR guard (spec A6 rest, B4)

Ship task: *"pr-watch SKILL.md under 150 lines, docs for hooks and guideline, ship refuses non-PR tasks; spec A6 remainder and B4, plan PR 5"*.

### Task 1: pr-watch diet

**Files:**
- Modify: `skills/pr-watch/SKILL.md`
- Modify: `tests/repo-integrity.bats`

- [ ] **Step 1: Add a failing test** to `tests/repo-integrity.bats`: `pr-watch SKILL.md stays at or under 150 lines` (`wc -l < skills/pr-watch/SKILL.md` ≤ 150).
- [ ] **Step 2: Run `bats tests/repo-integrity.bats`** — expected: FAIL on the new test.
- [ ] **Step 3: Cut** everything `pr-state.sh` and `wait-for.sh` now decide (classification inputs, queue detection, no-checks logic, the old Waiting delays), keep the flags table to the flags still carried (`waits=`, `runners`, `ready=`, `unknown=`), keep every announcement's content, keep the Rules list. No `$<digit>` tokens.
- [ ] **Step 4: Run `make test` and `make lint`** — expected: PASS.

### Task 2: ship refuses non-PR work

**Files:**
- Modify: `skills/ship/SKILL.md` (step *1 — Parse task*)
- Modify: `README.md` (*/ship* section, one line)

- [ ] **Step 1: Add to step 1**: when `TASK` describes work that changes no repo file (running a command once, downloading or inspecting something, deploying), announce *"This task changes no repo files — ship is not the tool; do it directly."* and stop before step 2. A task that is ambiguous proceeds.
- [ ] **Step 2: README line** under */ship*: "Refuses tasks that change no repo files."
- [ ] **Step 3: Run `make test` and `make lint`** — expected: PASS.

---

## Follow-up outside this repo

- `heronlabs/CLAUDE.md` (root workspace): cap parallel `/supera:ship` fan-out at 4 concurrent ships; the 2026-10-22 session dispatched 19 at once and hit the usage limit before any receipt.
