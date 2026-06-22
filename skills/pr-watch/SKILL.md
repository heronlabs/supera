---
name: pr-watch
description: "Repo-agnostic PR babysitter: monitors CI, fixes failures via supera-engineer, addresses review comments, runs one code-review cycle (plus a security audit when audits.security is enabled), and exits when the branch is green, synced with the base, and all threads resolved."
allowed-tools: Bash, Read, Glob, Grep, Agent, Workflow  # also requires the gh CLI
---

Monitor an open PR until it is ready to merge, in any repo. Watch CI, fix failures, address review comments, run one code review — exit when everything is green and resolved. Reads `.claude/supera.json` for the install/build/test/lint commands used to reproduce failures.

`/pr-watch` **monitors without blocking**: at every wait (CI running, a re-run after a fix) it reschedules via `ScheduleWakeup` and exits the turn, then resumes on the next wake — it never spins inline. It is one half of an intentional round-trip — `/start` opens the PR and hands here; `/pr-watch` drives it green and hands the merged PR back to `/start` to close out.

## 0 — Load config

Read `.claude/supera.json` into `CONFIG` (for `verify.*` commands and `pr.base`/`pr.remote`). If absent, proceed with sensible git/gh defaults and skip any config-derived command (tell the user once that supera isn't initialised here).

Set `AUDIT = CONFIG.audits?.security === true` — gates the security audit in step 6. Default `false` when config is absent.

Resolve the deny-list and consensus gate:
- `DENY = CONFIG.security?.denyPaths ?? ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"]` — secret/key globs that must never enter the PR (step 6d). `[]` disables.
- `VOTERS = CONFIG.review?.consensus?.voters ?? 1`; `QUORUM = CONFIG.review?.consensus?.quorum ?? (floor(VOTERS/2)+1)`. `VOTERS <= 1` disables the consensus gate (step 6e) — single review pass, the original behaviour.
- `LENSES = CONFIG.review?.lenses ?? []` — the specialist review lenses fanned out in step 6a; empty (the default) keeps the single code-review pass.

## 0a — Persisted attempt-state

Attempt-state must survive across invocations — a fresh headless CI run (the autonomy runtime: `anthropics/claude-code-action`) has no live session, so the loop-state lives on the PR, not in memory. It's a **hidden marker comment**: an HTML comment carrying JSON, posted as a bot PR comment. This needs only the `gh` CLI (already required), never enters the code diff, and survives a fresh headless session with no live memory. The marker convention is fixed (not repo-specific), so it stays convention-only and is not a config field.

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

**Terminal block signal.** When the loop gives up — the same CI failure survives 2 fix attempts (step 3), the same consensus block recurs after 2 rounds (step 6e), or a deny-path/secret hits the PR (step 6d) — post a visible PR comment prefixed `🚫 supera blocked:` carrying a hidden `<!-- supera:blocked <reason> -->` marker, then stop and exit the turn. This comment is the escalation endpoint — supera has no tracker, so the block lives on the PR: durable, visible to the human, and detectable by a re-run so it doesn't re-loop an already-blocked PR. In interactive mode also surface the reason and ask the user; in `NONINTERACTIVE` mode the comment is the only surface.

## 1 — Resolve the PR

Parse `$ARGUMENTS` (flags in any order):
- A number → the PR number.
- `--reviewed` → `REVIEWED=true` (code review already done this cycle).
- `--non-interactive` → `NONINTERACTIVE=true` (headless CI run with no human to answer prompts — see **Non-interactive mode**).
- Empty → detect from branch: `gh pr view --json number -q .number`.
- Neither works → ask the user (in `NONINTERACTIVE` mode there's no PR to act on — exit `blocked`, see **Non-interactive mode**).

`REVIEWED` defaults `false`; `NONINTERACTIVE` defaults `false`. **Preserve `--non-interactive` on every `ScheduleWakeup` reschedule**, alongside `--reviewed`.

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
- `MERGED` → **do not close here** — the originating skill owns the close, teardown, and summary; pr-watch never tears down itself, it auto-hands-off to the owning skill, which owns teardown. Detect the owner by label:
```bash
gh pr view $PR --json labels -q '.labels[].name'
```
   - Carries the `supera:audit` label → invoke `/audit` (its merged reclaim path, which reclaims the audit worktree).
   - Otherwise → invoke `/start <branch>` (routes to the `merged` phase → close-out).
   Preserve `--non-interactive` on the handoff when set. Announce: *"PR #<N> is merged — handing off to `/start <branch>` to close out and clean up (or `/audit` if this is a `supera:audit` PR)."* Then invoke the owning skill and exit.
- `CLOSED` (not merged) → surface that the PR was closed without merging; announce; exit. (Tearing down an abandoned branch is a manual `git worktree remove`.)
- Otherwise continue with `statusCheckRollup` (step 3) and `reviewThreads` (step 4).

## 3 — CI gate

### Running or queued
Don't wait inline. Reschedule preserving flags, then exit the turn:
```
ScheduleWakeup(delaySeconds=90, reason="CI still running on PR #<N>", prompt="/pr-watch <N> [--reviewed if true] [--non-interactive if set]")
```

### Passed
Proceed to step 4.

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

Compute the failure signature `SIG` (failing job name + first error line). Dispatch `supera-engineer` with the exact log excerpt; wait for its JSON receipt (`schema/receipt.schema.json`) and branch on `receipt.status` — `ok` → record the attempt (`STATE.attempts += 1`, `STATE.lastFailure = SIG`), persist the marker (step 0a), push the fix; `needs-review`/`blocked` → surface `receipt.implemented` and any FAIL in `receipt.verification`, don't push a red fix (in `NONINTERACTIVE` mode, **block** instead — see **Non-interactive mode**). **Track attempts via the persisted marker so a fresh CI invocation resumes the count:** if this `SIG` equals `STATE.lastFailure` and `STATE.attempts >= 2` (the same failure has already survived 2 fix attempts): post the **terminal block signal** (§0a) with the failing-job detail, show the full log, and exit the turn (interactive: also ask for guidance).

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

## 6 — Code review + security audit

All checks below run exactly once per cycle and are suppressed by `--reviewed` (step 5 exits before reaching here when `REVIEWED=true`).

### 6a — Code review

Invoke the `code-review:code-review` skill on PR `#<N>` (one cycle only). For each finding:
- **Actionable** (bug, missing null check, wrong type, test gap) → delegate to `supera-engineer`; wait.
- **Trivial nit** → apply directly if it's a one-liner; skip if subjective.
- **Design concern** → surface to the user; do not implement without confirmation (in `NONINTERACTIVE` mode, **block** — see **Non-interactive mode**).

#### Extra lenses (opt-in, default off)

When `LENSES` is non-empty, fan the configured specialist lenses out **in parallel via the Workflow primitive**, alongside the base code-review pass above, for more review signal per cycle. Each lens maps to its read-only `pr-review-toolkit` reviewer agent:

| `LENSES` key | reviewer agent |
|---|---|
| `silent-failures` | `pr-review-toolkit:silent-failure-hunter` |
| `type-design` | `pr-review-toolkit:type-design-analyzer` |
| `test-coverage` | `pr-review-toolkit:pr-test-analyzer` |

Each lens **posts its findings as PR comments and returns them; nothing is edited by a lens.** Invoke the following script via the `Workflow` tool with args `{ pr: <N>, lenses: LENSES }`:

```js
export const meta = {
  name: 'pr-review-lenses',
  description: 'Fan out PR review across the configured specialist lenses',
  phases: [{ title: 'Lenses' }],
}
const AGENTS = {
  'silent-failures': 'pr-review-toolkit:silent-failure-hunter',
  'type-design': 'pr-review-toolkit:type-design-analyzer',
  'test-coverage': 'pr-review-toolkit:pr-test-analyzer',
}
const FINDING = { type: 'object', additionalProperties: false,
  properties: {
    file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string' },
    kind: { type: 'string', enum: ['actionable', 'nit', 'design'] }, detail: { type: 'string' },
  }, required: ['kind', 'detail'] }
const SCHEMA = { type: 'object', additionalProperties: false,
  properties: { findings: { type: 'array', items: FINDING } }, required: ['findings'] }
const results = await parallel((args.lenses ?? []).map(k => () =>
  agent(`Review PR #${args.pr} through your specialist lens. Post each finding as a PR comment, then return them.`,
        { label: k, agentType: AGENTS[k], schema: SCHEMA })))
return { findings: results.filter(Boolean).flatMap(r => r.findings ?? []) }
```

After the fan-out, **merge the returned lens findings with the base code-review findings and route the union by the SAME rules above** (actionable → `supera-engineer`; trivial one-liner nit → apply directly; design concern → surface / block in `NONINTERACTIVE`), deduping obvious overlaps. Note plainly: the lens set is bounded by the schema enum so per-PR cost stays capped; **every fix still goes through `supera-engineer`** (lenses are read-only signal); lenses **never replace CI** — CI stays the quality gate.

If the `Workflow` primitive is unavailable in the runtime, dispatch the same lens agents as parallel `Agent` calls in a single message — the parallel fan-out is the requirement, `Workflow` is the preferred vehicle.

### 6b — Test hygiene (one assertion per test)

**ALWAYS** run this on the changed test files, every review cycle. List the diff's test files and scan each test case for more than one `expect`/assert:
```bash
gh pr diff $PR --name-only | grep -iE '\.(spec|test)\.|_test\.|(^|/)test_' || true
```
For any test case carrying **more than one assertion** → delegate to `supera-engineer` to bring it to its **one-assertion-per-test standard** (split into one-behaviour-per-case, or trim to the assert that proves the behaviour). Don't add assertions — only split or trim.

### 6c — Security audit

Skip this entire subsection when `AUDIT` is false. When true, dispatch the `supera-security-auditor` agent on the worktree (one pass). It detects the manager, runs the native audit, and is report-only **except** safe, mechanical supply-chain remediations it applies autonomously — CVE overrides **and** GitHub Actions SHA-pins. On return:
- **Safe remediations applied** (lockfile / `package.json` / `Cargo.toml` / `.github/workflows/*` — any tracked edit the auditor left) → these ride out with the push below; reply on the PR referencing the commit: `gh pr review $PR --comment --body "Security: applied safe supply-chain remediations in <commit-sha>: <one-line summary>"`.
- **Report-only findings** (unfixable CVEs, leaked secrets, drift, freshness, typo-squat/provenance) → do **not** auto-fix. Surface the prioritized report to the user. A leaked-secret or critical-CVE finding is a **merge blocker** — flag it loudly and do not present the PR as ready until the user clears it (in `NONINTERACTIVE` mode, a merge-blocker finding **blocks** — see **Non-interactive mode**).
- Never block on a degraded probe (missing `cargo-audit`, network failure) — the auditor notes the gap and continues; relay it.

### 6d — Secret / deny-path gate

Skip when `DENY` is empty. Otherwise list the PR's changed files and match each path against `DENY`:
```bash
gh pr diff $PR --name-only
```
Any match → a secret or private key is in the PR: a **hard merge blocker**. Surface it loudly; do **not** present the PR as ready. Post the **terminal block signal** (§0a) with the offending paths and exit the turn — clearing a committed secret is the user's call.

### 6e — Merge-readiness consensus

Skip when `VOTERS <= 1`, **or** when steps 6a–6c delegated any fix this cycle — vote only on a settled PR, so push those fixes and reschedule without `--reviewed` (close-out below) and the vote runs next cycle.

Otherwise dispatch `VOTERS` independent reviewer agents in parallel (single message), each: *"Adversarially review PR #<N> for merge-readiness. Hunt for ONE blocking defect — correctness, data-loss, security, or a broken contract. Reply `APPROVE`, or `BLOCK: <reason>`. Default to BLOCK if genuinely uncertain."* Count `APPROVE` votes:
- **`>= QUORUM`** → consensus clears.
- **`< QUORUM`** → consensus blocks. Record the attempt against the persisted marker (`STATE.attempts += 1`, `STATE.lastFailure = "consensus:<reason>"`, persist per step 0a) so a fresh invocation resumes the count. Delegate each clearly-actionable `BLOCK` reason to `supera-engineer` (wait); surface design concerns to the user instead of implementing (in `NONINTERACTIVE` mode, a design concern with no actionable fix **blocks** — see **Non-interactive mode**). **Same consensus block (`STATE.lastFailure` unchanged) after 2 fix rounds** → post the **terminal block signal** (§0a) with the block reasons and exit (interactive: also ask).

### Close out the cycle

Push, then reschedule preserving flags and exit:
```bash
git push <remote> $BRANCH
```
- **`VOTERS <= 1`, or consensus cleared this cycle** → reschedule WITH `--reviewed` (subsections won't repeat); next wake, step 5 announces the PR ready:
```
ScheduleWakeup(delaySeconds=120, reason="CI after review on PR #<N>", prompt="/pr-watch <N> --reviewed [--non-interactive if set]")
```
- **`VOTERS > 1` and the PR changed this cycle** (6a–6c fixes, or consensus blocked) → reschedule WITHOUT `--reviewed`, so the settled PR is re-reviewed and (re-)voted:
```
ScheduleWakeup(delaySeconds=120, reason="CI after fixes on PR #<N>", prompt="/pr-watch <N> [--non-interactive if set]")
```

## Non-interactive mode (`--non-interactive`)

For headless CI runs (e.g. GitHub Actions via `anthropics/claude-code-action`) where no human is present to answer a prompt. The CI / review / merge-readiness loop runs unchanged; only the points that would stop to ask a human behave differently. Interactive is the default — this mode is opt-in via the flag and applies only when `NONINTERACTIVE` is set.

- **Never prompt.** At every point flagged "see **Non-interactive mode**" above — an unknown CI failure, an unfixable engineer receipt, a question/design-discussion review thread, a code-review or consensus design concern, a repeated failure or block, a merge-blocker audit/secret finding — do not ask the user. Do not call `AskUserQuestion`.
- **An ambiguous decision blocks.** Instead of asking, post the block as a PR comment and exit `blocked` — a PR always exists here, so there's always somewhere to comment:
```bash
gh pr comment $PR --body "🚫 supera /pr-watch blocked (non-interactive): <what's ambiguous / unresolved + the log or finding detail>"
```
  This is the **terminal block signal** (§0a). Then exit the turn — do **not** `ScheduleWakeup` past a block.
- **Stay git/GitHub-native.** supera has no tracker; a block surfaces as the `<!-- supera:blocked -->` PR comment (§0a), never a tracker write. `--non-interactive` changes only the prompt points, never the pipeline.
- **Clear cases still flow.** Reproducible CI failures, clear code requests, trivial nits, and actionable consensus blocks still delegate to `supera-engineer` and push as normal — only a genuine human-judgment fork blocks. A clean, green, reviewed PR still exits "ready to merge" (merging stays the user's decision).

## Rules

- Read `.claude/supera.json` for the commands used to reproduce failures — don't assume pnpm/npm.
- **Don't spin-poll** — at every wait, `ScheduleWakeup` and exit the turn; preserve `--reviewed` and `--non-interactive` on every reschedule.
- On `MERGED`, auto-hand-off to the owning skill (`/start`, or `/audit` for a `supera:audit` PR) — never close out or remove the worktree here; the owning skill owns the terminal step.
- Exit and announce when the PR is green, synced, and all threads resolved — merging is the user's decision.
- Never push `--force` — only `--force-with-lease` after a rebase.
- A **terminal block** posts the `<!-- supera:blocked -->` PR comment and stops (§0a) — that comment is the escalation signal; supera has no tracker.
- Commit hygiene follows `guidelines/commit-conventions.md`.
