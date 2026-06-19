---
name: start
description: "Repo-agnostic full-lifecycle orchestrator: task → worktree → plan → delegate to supera-engineer (code + tests) → self-verified → PR → /pr-watch, and on a merged PR tears down. Idempotent: re-run to resume interrupted work or close out; `/start pause` checkpoints mid-flight. Driven by .claude/supera.json so it works in any repo."
allowed-tools: Bash, Read, Glob, Grep, Agent  # also requires the gh CLI
---

Drive a task through its whole life — zero → open PR → merged → closed — in **any** repo. Read this repo's `.claude/supera.json` for stack commands and worktree base. Delegate the code + tests to the `supera-engineer` agent. `/start` is **idempotent** and owns the entire phase ladder: a re-run continues from the detected phase (step 1.5) — resuming an interrupted build, opening the PR, or closing out a merged PR. `/start pause` checkpoints mid-flight. After the PR is open it hands off to `/pr-watch`. The PR is the unit of work — there is no separate ticket.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /init first."` Offer to run `/init` now. Do not proceed without config.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.

## 1 — Parse arguments

**`--non-interactive` flag:** set `NONINTERACTIVE=true` if `$ARGUMENTS` contains `--non-interactive` (strip it before parsing the rest); else `false`. This is the headless mode for CI runs with no human to answer prompts — see **Non-interactive mode** below. Interactive (`false`) is the default. Preserve the flag when handing off to `/pr-watch` (step 5).

**Pause sub-command:** if `$ARGUMENTS` begins with `pause` (e.g. `pause`, `pause feat-add-payment-retry`), run the **Pause checkpoint** flow at the end of this skill and stop — do not run the pipeline below.

Otherwise `$ARGUMENTS` may be:
- A free-text task description — e.g. `"add payment retry on timeout"`
- A branch name (resume / close-out an existing run) — e.g. `"feat-add-payment-retry-on-timeout"`

If empty, ask for a task description (in `NONINTERACTIVE` mode there's nothing to ship and no PR to comment on — exit `blocked`, see **Non-interactive mode**).

Derive a branch slug: lowercase, kebab-case, ≤50 chars, special chars stripped, prefixed by type with a **dash, never a slash** (`feat-`, `fix-`, `docs-`, `refactor-`, `chore-`). Example: `"add payment retry on timeout"` → `feat-add-payment-retry-on-timeout`. The slug is used verbatim as both the branch name **and** the worktree folder name, so it must be a single path segment — no `/`. This guarantees one flat folder per worktree (`<WT_DIR>/feat-add-payment-retry-on-timeout`), never a nested `<WT_DIR>/feat/…` subtree.

## 1.5 — Phase routing (idempotency + lifecycle)

Before creating anything, detect whether work for this task already exists — `/start` must **never** double-create a worktree or duplicate work, and a re-run drives the next phase. Detect the branch (the derived slug, or a branch name passed directly) and its state. The PR probe runs from the repo root (no worktree needed); the two `git -C <WT_DIR>/<slug>` probes run **only when the worktree is present**:
```bash
gh pr list --head <slug> --state all --json number,state     # PR? merged? (repo-root, always safe)
git worktree list | grep <slug>                              # worktree present? gates the next two:
git -C <WT_DIR>/<slug> log --oneline <REMOTE>/<BASE>..<slug> # commits beyond base?
git -C <WT_DIR>/<slug> log -1 --pretty=%s                    # is HEAD a 'wip:' checkpoint?
```
If a PR exists, route by the PR state **first** (`pr-open` / `merged`) — those phases don't need a live worktree, so a removed worktree never blocks close-out. The build phases (`scaffolded` / `building` / `built`) require the worktree probes; if a PR is absent and the worktree is gone, treat it as `fresh`. Route by phase (the shared lifecycle ladder). **Announce the detected phase before acting** so a mis-detection is visible:

| Phase | Signal | Action |
|---|---|---|
| `fresh` | no branch, no worktree | Fall through to step 2 (normal pipeline). |
| `scaffolded` | worktree/branch, **0 commits** vs base | **Resume:** delegate the full implementation (**Resuming interrupted work** below), then continue to step 4. |
| `building` | commits, **HEAD is `wip:`**, no PR | **Resume:** soft-reset the checkpoint, recover `nextUp`, delegate the remainder (**Resuming interrupted work** below), then continue to step 4. |
| `built` | commits, HEAD not `wip:`, no PR | Skip steps 2–3; jump straight to **step 4** (open the PR). |
| `pr-open` | PR exists, not merged | Invoke `/pr-watch <N>`. Stop. |
| `merged` | PR merged | Run **Closing out a merged PR** below. Stop. |

## 2 — Create worktree

```bash
git fetch <REMOTE> <BASE>
git worktree add <WT_DIR>/<slug> -b <slug> <REMOTE>/<BASE>
```
Then run the post-create step (install) if defined:
```bash
cd <WT_DIR>/<slug> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>
```
Confirm the worktree exists and the install succeeded before continuing. If the worktree already exists for this branch, reuse it (do not error).

## 3 — Plan and delegate

Form an internal implementation plan. It stays internal — proceed immediately unless the user explicitly said "show me the plan first" or invoked `/plan` before `/start`.

The executor is always `supera-engineer` (one strong agent does code + tests, self-verifies) — the sole implementer; `/start` orchestrates, it never edits application code itself.

Announce: *"Plan ready. Delegating to `supera-engineer` in worktree `<WT_DIR>/<slug>`."* If the task hinges on a term with two plausible readings — a literal name vs. a mapping, an unfamiliar proper noun, a config key that could mean two things — add one line stating the reading you're shipping (e.g. *"reading `environment pulumi` as the literal GitHub environment named `pulumi`, not a per-stack map"*). This is a visible-by-default check, not a gate: proceed unless the fork is genuinely expensive to undo — that case is the engineer's `superpowers:brainstorming` step, not a blocking question here.

Dispatch `supera-engineer` with: the full task description, the worktree path, and the path to `.claude/supera.json`. The engineer self-verifies (build/test/lint from config) before returning — **do not run the quality gate yourself; CI is the gate, the engineer is the pre-flight.** Wait for its receipt — a JSON object matching `schema/receipt.schema.json`. Parse it and branch on `receipt.status`: `ok` → continue to step 4; `needs-review` or `blocked` → surface `receipt.implemented`, any FAIL in `receipt.verification`, and `receipt.outOfScope` to the user before pushing (in `NONINTERACTIVE` mode no PR exists yet to comment on — print the receipt detail and exit `blocked`, see **Non-interactive mode**).

## 4 — Create the PR

Push the branch:
```bash
git -C <WT_DIR>/<slug> push -u <REMOTE> <slug>
```

Write the PR body (template below), then create the PR assigned to `@me` so it lands in the user's review queue. Do **not** add `--reviewer` (GitHub blocks self-review; the gh-CLI user is the author):
```bash
gh pr create \
   --base <BASE> \
   --title "<short human summary, <70 chars, no conventional-commit prefix>" \
   --body "$(cat <<'EOF'
<body below>
EOF
)" \
   --assignee @me
```
Save the PR number.

## 5 — Hand off to /pr-watch

Invoke `/pr-watch <PR-number>` — append `--non-interactive` when `NONINTERACTIVE` is set (so the headless run stays prompt-free through the PR cycle).

Announce: *"PR #<N> is open. Handing off to `/pr-watch <PR-number>`. Once it reports the PR merged, re-run `/start <slug>` to close out and clean up."*

---

## Non-interactive mode (`--non-interactive`)

For headless CI runs (e.g. GitHub Actions via `anthropics/claude-code-action`) where no human is present to answer a prompt. The whole pipeline runs unchanged; only the prompt points behave differently. Interactive is the default — this mode is opt-in via the flag and applies only when `NONINTERACTIVE` is set.

- **Never prompt.** Skip every step that would ask the user a question or wait for a decision (the points flagged "see **Non-interactive mode**" above). Do not call `AskUserQuestion`.
- **An ambiguous decision blocks.** When the interactive flow would stop to ask, instead surface the block as a comment and exit `blocked` — don't guess past a genuine fork:
   - If a PR already exists for this work (phase `pr-open`/`built`-then-pushed), post the block as a PR comment: `gh pr comment <N> --body "🚫 supera /start blocked (non-interactive): <what's ambiguous + the receipt/verification detail>"`.
   - Before any PR exists, print the block detail to the run output (there's nothing to comment on yet).
- **Stay git/GitHub-native.** A blocked decision surfaces as a PR/issue comment, never a tracker prompt — supera has no tracker. `--non-interactive` changes only the prompt points, never the pipeline.
- The non-prompt steps (phase routing, worktree, delegate, push, PR, hand-off) are unchanged — a clean run still opens the PR and hands off to `/pr-watch --non-interactive`.

---

## Resuming interrupted work (phases `scaffolded` / `building`)

Reached from step 1.5 when a worktree/branch exists but no PR. `/start` continues the build, then falls through to step 4 to open the PR — it never restarts from scratch.

If the worktree is missing but the branch exists on the remote (paused on another machine), recreate it first:
```bash
git fetch <REMOTE> <slug>
git worktree add <WT_DIR>/<slug> <slug>
cd <WT_DIR>/<slug> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>
```

**`building` — undo the checkpoint first.** A `wip:` HEAD is a pause checkpoint, not real history. Un-commit it so the engineer continues from clean staged state, and recover `nextUp`:
```bash
git -C <WT_DIR>/<slug> show -s --format=%b HEAD     # read nextUp from the wip: body BEFORE resetting
git -C <WT_DIR>/<slug> reset --soft HEAD~1
```

**Re-delegate the remainder.** Dispatch `supera-engineer` with: the task description (the branch intent + recovered `nextUp`), the worktree path, and the path to `.claude/supera.json`. For `building`, lead with `nextUp` so the engineer continues exactly where pause stopped — don't redo finished work. The engineer self-verifies before returning (**CI is the gate; don't run the full build/test/lint here**). Wait for its JSON receipt (`schema/receipt.schema.json`); branch on `receipt.status` — `ok` continues, `needs-review`/`blocked` surfaces `receipt.implemented` and any FAIL in `receipt.verification` to the user before continuing (in `NONINTERACTIVE` mode, exit `blocked` instead — see **Non-interactive mode**).

Then fall through to **step 4** to open the PR. If a soft-reset rewrote an already-pushed `wip:` commit, push with `--force-with-lease` (never `--force`).

---

## Pause checkpoint (`/start pause`)

Reached from step 1 when `$ARGUMENTS` begins with `pause`. Stop work cleanly so a later `/start <slug>` resumes without guessing. No state file — git carries the work.

1. **Resolve the WIP.** Parse the rest of `$ARGUMENTS` (a branch, or empty). Empty → the current branch or the single worktree under `WT_DIR` (ambiguous → list and ask; in `NONINTERACTIVE` mode there's no PR for a checkpoint to comment on — print the candidate worktrees and exit `blocked`, see **Non-interactive mode**). Resolve `WT_PATH` and `BRANCH`.
2. **Capture `nextUp`.** In one or two concrete lines, what is done and what remains — name the next file/step, not "continue work". This becomes the `wip:` commit subject + body and the payload a resume reads back.
3. **Commit the checkpoint:**
```bash
git -C <WT_PATH> add -A
git -C <WT_PATH> status --porcelain      # anything staged?
```
   - Changes present → `git -C <WT_PATH> commit -m "wip: <nextUp one-liner>" -m "<remaining steps, one per line>"`.
   - Tree already clean → skip the commit; the branch state itself is the checkpoint.
   The `wip:` prefix is load-bearing: the resume path keys off it to soft-reset before continuing. Never name a real commit `wip:`. Commit per `guidelines/commit-conventions.md`; the body carries the remaining steps.
4. **Push so the work survives:** `git -C <WT_PATH> push -u <REMOTE> <BRANCH>` (`--force-with-lease` only if it rewrote history).
5. **Report:** *"Paused `<BRANCH>`. WIP committed + pushed, worktree kept. Resume with `/start <BRANCH>`."* List `wip-commit` (sha or "tree clean") and `pushed`. Stop.

---

## Closing out a merged PR (phase `merged`)

Reached from step 1.5 when the PR is `MERGED`. Record what shipped and tear down the workspace. Only merged work is closed here — abandoning unmerged work is a manual `gh pr close` + `git worktree remove`. **The worktree may already be gone** (close-out partially ran, or it was paused/removed on another machine), so build the summary from `gh` — which works from the repo root — not from `git -C <WT_PATH>`.

1. **Build the summary — all from the merged PR (no live worktree needed):**
   - **Goal** — the branch slug as a one-line intent.
   - **Files, commit count, first-commit time, merge time:**
```bash
gh pr view <N> --json files   -q '.files[].path'              # changed files
gh pr view <N> --json commits -q '.commits | length'         # commit count
gh pr view <N> --json commits -q '.commits[0].committedDate' # first commit time (PR commits are oldest-first)
gh pr view <N> --json mergedAt -q .mergedAt                   # merge time
```
   **Time spent** = first-commit time → merge time (derived from git).
   Format:
```
✅ Shipped: <goal>
   PR #<N> merged · <X commits> · ⏱ ~<T> (<first hh:mm> → merged <hh:mm>)
   Files (<count>):
      - <path>
      - <path>
```
2. **Tear down the workspace** (silently — no confirm; each step is guarded so a missing worktree/branch is a no-op, not an error):
```bash
[ "<BRANCH>" != "<BASE>" ] && git worktree list | grep -q "<WT_DIR>/<slug>" && git worktree remove <WT_PATH>   # --force only if it refuses on an unclean tree
[ "<BRANCH>" != "<BASE>" ] && git rev-parse --verify --quiet <BRANCH> >/dev/null && git branch -D <BRANCH>      # never delete BASE; delete the feature branch if present
```
   Leave the remote branch alone (GitHub deletes it on merge if configured). **Never** remove `BASE` or its worktree.
3. **Report:** print the summary to the terminal and confirm: *"Worktree removed, branch `<BRANCH>` deleted locally."* The lifecycle is closed.

---

## Lifecycle controls

`/start` owns the whole ladder. Only `/pr-watch` lives outside it — `/start` routes to it, never duplicates it. `/start pause` is a sub-command, not a separate skill.

| Control | When | Owns |
|---|---|---|
| `/start pause <branch>` | Need to stop mid-build | Commits + pushes a `wip:` checkpoint, **keeps** the worktree. |
| `/start <branch>` (re-run, `building`/`scaffolded`) | A run didn't finish | Detects the phase, undoes a `wip:` checkpoint, re-delegates the remainder to `supera-engineer`, opens the PR. |
| `/pr-watch <N>` | PR is open | Drives CI green + review threads to resolution. Hands merged PRs back to `/start`. |
| `/start <branch>` (re-run, `merged`) | PR is merged | Posts the summary (goal · time · files), removes the worktree + local branch. The terminal step. |

The phase ladder in step 1.5 is the shared contract: `fresh → scaffolded → building → built → pr-open → merged`. Every skill detects it the same way (git + GitHub, no state file).

---

## GitHub PR body template

```
## Summary
<one paragraph: what changed and why — written for a reviewer seeing this cold>

## Changes
- <concrete change per area>

## Out of scope
- <related but deferred>          ← omit section if empty

## Test plan
- [ ] <verification step the reviewer can run or check>

## Notes
<load-bearing decisions or known follow-ups — omit if none>
```

## Rules

- Read `.claude/supera.json` first — never hardcode commands, branches, or remotes.
- Never remove `BASE` or its worktree.
- **Idempotent:** run the step 1.5 phase routing before creating anything — never double-create a worktree or duplicate work.
- Commit hygiene follows `guidelines/commit-conventions.md`; `/start`'s only self-commit is the `wip:` pause checkpoint.
