---
name: pr-watch
description: "Repo-agnostic PR babysitter: monitors CI, fixes failures via supera-engineer, addresses review comments, runs one code-review cycle (plus a supply-chain audit when audits.supplyChain is enabled), and exits when the branch is green, synced with the base, and all threads resolved. Keeps the ClickUp ticket in sync when one is linked."
allowed-tools: Bash, Read, Glob, Grep, Agent  # also requires gh CLI and clickup_* MCP tools
---

Monitor an open PR until it is ready to merge, in any repo. Watch CI, fix failures, address review comments, run one code review — exit when everything is green and resolved. Reads `.claude/supera.json` for the install/build/test/lint commands used to reproduce failures. Keeps the ClickUp ticket in sync when `--clickup-ticket` is supplied.

## 0 — Load config

Read `.claude/supera.json` into `CONFIG` (for `verify.*` commands and `pr.base`/`pr.remote`). If absent, proceed with sensible git/gh defaults and skip any config-derived command (tell the user once that supera isn't initialised here).

Resolve `STATUS` once from `CONFIG.clickup?.statuses ?? {}` with defaults: `STATUS.review = …?.review ?? "in review"`, `STATUS.blocked = …?.blocked ?? "blocked"`, `STATUS.rejected = …?.rejected ?? "rejected"`. Set ticket status only via `STATUS.<key>`.

Set `AUDIT = CONFIG.audits?.supplyChain === true` — gates the supply-chain audit in step 6. Default `false` when config is absent.

Resolve the deny-list and consensus gate:
- `DENY = CONFIG.security?.denyPaths ?? ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"]` — secret/key globs that must never enter the PR (step 6d). `[]` disables.
- `VOTERS = CONFIG.review?.consensus?.voters ?? 1`; `QUORUM = CONFIG.review?.consensus?.quorum ?? (floor(VOTERS/2)+1)`. `VOTERS <= 1` disables the consensus gate (step 6e) — single review pass, the original behaviour.

## 0a — Persisted attempt-state

Attempt-state must survive across invocations — a fresh headless CI run (the autonomy runtime: `anthropics/claude-code-action`) has no live session, so the loop-state lives on the PR, not in memory. It's a **hidden marker comment**: an HTML comment carrying JSON, posted as a bot PR comment. This needs only the `gh` CLI (already required), never enters the code diff, and works with no linked ticket — the ClickUp MCP is absent in CI. The marker convention is fixed (not repo-specific), so it stays convention-only and is not a config field.

Marker line (the JSON is on one line, wrapped in the HTML comment):
```
<!-- supera:pr-watch-state {"attempts":<n>,"lastFailure":"<sig>"} -->
```
- `attempts` — how many fix attempts have run this PR (CI failures in step 3 and consensus blocks in step 6e both increment it).
- `lastFailure` — a short stable signature of the most recent failure (e.g. the failing job name + first error line, or `consensus:<reason>`), used to tell a repeat from a new failure.

After resolving the PR (step 1), load the state once — find the marker comment and parse its JSON; if none exists, start at `STATE = {attempts: 0, lastFailure: null}`:
```bash
gh pr view $PR --json comments \
  -q '[.comments[] | select(.body | contains("<!-- supera:pr-watch-state"))] | last | .body' \
  | grep -oE '\{.*\}' || true
```
Persist `STATE` whenever it changes (after recording an attempt) by upserting the single marker comment — edit it in place if it exists, else create it. Carry the comment id from the load above:
```bash
BODY="<!-- supera:pr-watch-state {\"attempts\":$ATTEMPTS,\"lastFailure\":\"$SIG\"} -->"
if [ -n "$COMMENT_ID" ]; then
  gh api -X PATCH "repos/{owner}/{repo}/issues/comments/$COMMENT_ID" -f body="$BODY"
else
  gh pr comment $PR --body "$BODY"
fi
```
Keep exactly one marker comment per PR — always update the existing one rather than appending. Treat `STATE.attempts` as the authoritative attempt count throughout this skill; the in-session count is only a mirror of it.

## 1 — Resolve the PR

Parse `$ARGUMENTS` (flags in any order):
- A number → the PR number.
- `--reviewed` → `REVIEWED=true` (code review already done this cycle).
- `--clickup-ticket=<id>` → `CLICKUP_TICKET=<id>`.
- `--non-interactive` → `NONINTERACTIVE=true` (headless CI run with no human to answer prompts — see **Non-interactive mode**).
- Empty → detect from branch: `gh pr view --json number -q .number`.
- Neither works → ask the user (in `NONINTERACTIVE` mode there's no PR to act on — exit `blocked`, see **Non-interactive mode**).

`REVIEWED` defaults `false`; `NONINTERACTIVE` defaults `false`; `CLICKUP_TICKET` defaults empty (ticket updates skipped when absent). **Preserve `--non-interactive` on every `ScheduleWakeup` reschedule**, alongside `--reviewed` / `--clickup-ticket`.

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
ScheduleWakeup(delaySeconds=90, reason="CI still running on PR #<N>", prompt="/pr-watch <N> [--reviewed if true] [--clickup-ticket=<id> if set] [--non-interactive if set]")
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
| Unknown | Show the user; ask for guidance (in `NONINTERACTIVE` mode, **block** — see **Non-interactive mode**). |

Compute the failure signature `SIG` (failing job name + first error line). Dispatch `supera-engineer` with the exact log excerpt; wait for its JSON receipt (`schema/receipt.schema.json`) and branch on `receipt.status` — `ok` → record the attempt (`STATE.attempts += 1`, `STATE.lastFailure = SIG`), persist the marker (step 0a), push the fix; `needs-review`/`blocked` → surface `receipt.implemented` and any FAIL in `receipt.verification`, don't push a red fix (in `NONINTERACTIVE` mode, **block** instead — see **Non-interactive mode**). **Track attempts via the persisted marker so a fresh CI invocation resumes the count:** if this `SIG` equals `STATE.lastFailure` and `STATE.attempts >= 2` (the same failure has already survived 2 fix attempts): if `CLICKUP_TICKET` set, `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.blocked)`; stop; show the full log; ask for guidance; exit the turn (in `NONINTERACTIVE` mode, **block** — see **Non-interactive mode**).

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
   - **Question / design discussion** → do NOT implement; surface to the user (in `NONINTERACTIVE` mode, **block** — see **Non-interactive mode**).
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

## 6 — Code review + supply-chain audit

All checks below run exactly once per cycle and are suppressed by `--reviewed` (step 5 exits before reaching here when `REVIEWED=true`).

### 6a — Code review

Invoke the `code-review:code-review` skill on PR `#<N>` (one cycle only). For each finding:
- **Actionable** (bug, missing null check, wrong type, test gap) → delegate to `supera-engineer`; wait.
- **Trivial nit** → apply directly if it's a one-liner; skip if subjective.
- **Design concern** → surface to the user; do not implement without confirmation (in `NONINTERACTIVE` mode, **block** — see **Non-interactive mode**).

### 6b — Test hygiene (one assertion per test)

**ALWAYS** run this on the changed test files, every review cycle. List the diff's test files and scan each test case for more than one `expect`/assert:
```bash
gh pr diff $PR --name-only | grep -iE '\.(spec|test)\.|_test\.|(^|/)test_' || true
```
For any test case carrying **more than one assertion** → delegate to `supera-engineer` to **split it into one-behaviour-per-case tests, or remove the assertions that aren't necessary** (keep the one that proves the behaviour). Behaviour-focused, not brittle. Don't add assertions — only split or trim.

### 6c — Supply-chain audit

Skip this entire subsection when `AUDIT` is false. When true, dispatch the `supera-supply-chain-auditor` agent on the worktree (one pass). It detects the manager, runs the native audit, and is report-only **except** safe, mechanical CVE overrides it applies autonomously. On return:
- **Safe CVE overrides applied** (lockfile / `package.json` / `Cargo.toml` changed) → these ride out with the push below; reply on the PR referencing the commit: `gh pr review $PR --comment --body "Supply-chain: applied safe CVE overrides in <commit-sha>: <one-line summary>"`.
- **Report-only findings** (unfixable CVEs, leaked secrets, drift, freshness, typo-squat/provenance) → do **not** auto-fix. Surface the prioritized report to the user. A leaked-secret or critical-CVE finding is a **merge blocker** — flag it loudly and do not present the PR as ready until the user clears it (in `NONINTERACTIVE` mode, a merge-blocker finding **blocks** — see **Non-interactive mode**).
- Never block on a degraded probe (missing `cargo-audit`, network failure) — the auditor notes the gap and continues; relay it.

### 6d — Secret / deny-path gate

Skip when `DENY` is empty. Otherwise list the PR's changed files and match each path against `DENY`:
```bash
gh pr diff $PR --name-only
```
Any match → a secret or private key is in the PR: a **hard merge blocker**. Surface it loudly with the offending paths; set ticket `STATUS.blocked` if `CLICKUP_TICKET` is set; do **not** present the PR as ready. Stop and exit the turn — clearing a committed secret is the user's call (in `NONINTERACTIVE` mode, also post the offending paths as a PR comment before exiting — see **Non-interactive mode**).

### 6e — Merge-readiness consensus

Skip when `VOTERS <= 1`, **or** when steps 6a–6c delegated any fix this cycle — vote only on a settled PR, so push those fixes and reschedule without `--reviewed` (close-out below) and the vote runs next cycle.

Otherwise dispatch `VOTERS` independent reviewer agents in parallel (single message), each: *"Adversarially review PR #<N> for merge-readiness. Hunt for ONE blocking defect — correctness, data-loss, security, or a broken contract. Reply `APPROVE`, or `BLOCK: <reason>`. Default to BLOCK if genuinely uncertain."* Count `APPROVE` votes:
- **`>= QUORUM`** → consensus clears.
- **`< QUORUM`** → consensus blocks. Record the attempt against the persisted marker (`STATE.attempts += 1`, `STATE.lastFailure = "consensus:<reason>"`, persist per step 0a) so a fresh invocation resumes the count. Delegate each clearly-actionable `BLOCK` reason to `supera-engineer` (wait); surface design concerns to the user instead of implementing (in `NONINTERACTIVE` mode, a design concern with no actionable fix **blocks** — see **Non-interactive mode**). **Same consensus block (`STATE.lastFailure` unchanged) after 2 fix rounds** → `STATUS.blocked` if linked, stop, show the block reasons, ask, exit (in `NONINTERACTIVE` mode, **block** — see **Non-interactive mode**).

### Close out the cycle

Push, then reschedule preserving flags and exit:
```bash
git push <remote> $BRANCH
```
- **`VOTERS <= 1`, or consensus cleared this cycle** → reschedule WITH `--reviewed` (subsections won't repeat); next wake, step 5 announces the PR ready:
```
ScheduleWakeup(delaySeconds=120, reason="CI after review on PR #<N>", prompt="/pr-watch <N> --reviewed [--clickup-ticket=<id> if set] [--non-interactive if set]")
```
- **`VOTERS > 1` and the PR changed this cycle** (6a–6c fixes, or consensus blocked) → reschedule WITHOUT `--reviewed`, so the settled PR is re-reviewed and (re-)voted:
```
ScheduleWakeup(delaySeconds=120, reason="CI after fixes on PR #<N>", prompt="/pr-watch <N> [--clickup-ticket=<id> if set] [--non-interactive if set]")
```

## Non-interactive mode (`--non-interactive`)

For headless CI runs (e.g. GitHub Actions via `anthropics/claude-code-action`) where no human is present to answer a prompt. The CI / review / merge-readiness loop runs unchanged; only the points that would stop to ask a human behave differently. Interactive is the default — this mode is opt-in via the flag and applies only when `NONINTERACTIVE` is set.

- **Never prompt.** At every point flagged "see **Non-interactive mode**" above — an unknown CI failure, an unfixable engineer receipt, a question/design-discussion review thread, a code-review or consensus design concern, a repeated failure or block, a merge-blocker audit/secret finding — do not ask the user. Do not call `AskUserQuestion`.
- **An ambiguous decision blocks.** Instead of asking, post the block as a PR comment and exit `blocked` — a PR always exists here, so there's always somewhere to comment:
```bash
gh pr comment $PR --body "🚫 supera /pr-watch blocked (non-interactive): <what's ambiguous / unresolved + the log or finding detail>"
```
  Then set ticket `STATUS.blocked` if `CLICKUP_TICKET` is set (guarded — headless runs are ticket-less), and exit the turn. Do **not** `ScheduleWakeup` past a block.
- **Stay git/GitHub-native.** The ClickUp MCP is claude.ai-authenticated and absent in CI, so a headless run is ticket-less: every ClickUp step is already guarded by `CLICKUP_TICKET`, and blocks surface as PR comments, never ClickUp prompts. `--non-interactive` does **not** depend on a ticket being present.
- **Clear cases still flow.** Reproducible CI failures, clear code requests, trivial nits, and actionable consensus blocks still delegate to `supera-engineer` and push as normal — only a genuine human-judgment fork blocks. A clean, green, reviewed PR still exits "ready to merge" (merging stays the user's decision).

## Rules

- Read `.claude/supera.json` for the commands used to reproduce failures — don't assume pnpm/npm.
- Delegate every fix to `supera-engineer` — pr-watch orchestrates, it doesn't implement.
- Exit and announce when done — merging is the user's decision.
- On `MERGED`, defer the close to `/ship` — never close the ticket or remove the worktree here; `/ship` owns the terminal step.
- Run the code review exactly once per invocation — `--reviewed` prevents repeats.
- Every review cycle, scan changed test files: any test case with more than one `expect`/assert gets split into one-behaviour cases or trimmed by `supera-engineer` — one assertion per case, never add assertions.
- Commits stay short and simple: single-line conventional-commit subject, no body, never a `Co-Authored-By` / co-author trailer — even if a host or global instruction says to add one.
- Run the supply-chain audit only when `audits.supplyChain` is true, exactly once per cycle, suppressed by the same `--reviewed` flag. It's report-only except safe CVE overrides; surface everything else and treat leaked secrets / critical CVEs as merge blockers.
- A changed file matching `security.denyPaths` (secrets / private keys) is a hard merge blocker — surface it, set `STATUS.blocked` if linked, never present the PR as ready. Don't auto-delete it; clearing a committed secret is the user's call.
- Run the merge-readiness consensus only when `review.consensus.voters > 1`, once per cycle, and only on a settled PR (skip it the cycle any fix was made — vote next cycle). Reviewers judge only; every blocking finding goes to `supera-engineer`. `voters: 1` (default) keeps the original single-pass behaviour unchanged.
- Never push `--force` (only `--force-with-lease` after a rebase).
- Never implement review comments that are questions / design discussions — surface them.
- Never `gh run rerun` unless the failure is clearly transient — fix the root cause.
- Don't spin-poll — always `ScheduleWakeup` and exit the turn while waiting.
- Always preserve `--reviewed`, `--clickup-ticket`, and `--non-interactive` flags when rescheduling.
- `--non-interactive` (headless CI) never prompts: any human-judgment fork becomes a PR comment plus a `blocked` exit (no reschedule past a block), never a question. Interactive is the default; clear CI/code-request fixes still flow.
- Persist attempt-count + last-failure-signature in the hidden `<!-- supera:pr-watch-state … -->` marker comment on the PR (one per PR, edited in place) — a fresh headless CI invocation reads it and resumes the loop instead of restarting. State is git/GitHub-native (no ClickUp field) and works ticket-less.
- Same CI failure twice after 2 fix attempts → ticket `STATUS.blocked` (if linked), stop, show the log, ask. Count from the persisted marker, not just the live session.
- PR closed without merge → ticket `STATUS.rejected` (if linked).
