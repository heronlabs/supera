---
name: ship
description: "Repo-agnostic full-lifecycle orchestrator: ClickUp ticket → worktree → plan → delegate to supera-engineer (code + tests) → self-verified → PR → ticket 'in review' → /pr-watch, and on a merged PR closes the ticket + tears down. Idempotent: re-run to resume interrupted work or close out; `/ship pause` checkpoints mid-flight. Driven by .claude/supera.json so it works in any repo."
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Drive a task through its whole life — zero → open PR → merged → closed — in **any** repo. Read this repo's `.claude/supera.json` for stack commands, ClickUp list, worktree base, status names, and the tag table. Delegate the actual code + tests to the `supera-engineer` agent. `/ship` is **idempotent** and owns the entire phase ladder: a re-run continues from the detected phase (step 1.5) — resuming an interrupted build, opening the PR, or closing out a merged PR. `/ship pause` checkpoints work mid-flight. After the PR is open it hands off to `/pr-watch`.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` Offer to run `/supera-init` now. Do not proceed without config.
- `CLICKUP = CONFIG.clickup?.listId` — if null/absent, run **ticket-less**: skip every ClickUp step below and operate on git + GitHub only.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.
- `STATUS` — resolve once from `CONFIG.clickup?.statuses ?? {}` with defaults:
  `STATUS.building = …?.building ?? "in progress"`,
  `STATUS.review = …?.review ?? "in review"`,
  `STATUS.closed = …?.closed ?? "closed"`.
  Always set ticket status via `STATUS.<key>` — never a hardcoded string.

## 1 — Parse arguments

**Pause sub-command:** if `$ARGUMENTS` begins with `pause` (e.g. `pause`, `pause 86abc`), run the **Pause checkpoint** flow at the end of this skill and stop — do not run the pipeline below.

Otherwise `$ARGUMENTS` may be:
- A free-text task description — e.g. `"add payment retry on timeout"`
- A ClickUp ticket ID + optional extra context — e.g. `"86abc123 also handle nil amounts"`
- Just a ClickUp ticket ID — e.g. `"86abc123"`
- A branch name (resume / close-out an existing ship) — e.g. `"feat-add-payment-retry-on-timeout"`

If empty, ask for a task description.

Derive a branch slug: lowercase, kebab-case, ≤50 chars, special chars stripped, prefixed by type with a **dash, never a slash** (`feat-`, `fix-`, `docs-`, `refactor-`, `chore-`). Example: `"add payment retry on timeout"` → `feat-add-payment-retry-on-timeout`. The slug is used verbatim as both the branch name **and** the worktree folder name, so it must be a single path segment — no `/`. This guarantees one flat folder per worktree (`<WT_DIR>/feat-add-payment-retry-on-timeout`), never a nested `<WT_DIR>/feat/…` subtree.

## 1.5 — Phase routing (idempotency + lifecycle)

Before creating anything, detect whether work for this task already exists — `/ship` must **never** double-create a worktree or duplicate an engineer's work, and a re-run drives the next phase. Detect the branch (the derived slug, or a branch name passed directly) and its state. The PR probe runs from the repo root (no worktree needed); the two `git -C <WT_DIR>/<slug>` probes run **only when the worktree is present**:
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
| `scaffolded` | worktree/branch, **0 commits** vs base | **Resume:** delegate the full implementation (**Resuming interrupted work** below), then continue to step 5. |
| `building` | commits, **HEAD is `wip:`**, no PR | **Resume:** soft-reset the checkpoint, recover `nextUp`, delegate the remainder (**Resuming interrupted work** below), then continue to step 5. |
| `built` | commits, HEAD not `wip:`, no PR | Skip steps 2–4; jump straight to **step 5** (open the PR). |
| `pr-open` | PR exists, not merged | Invoke `/pr-watch <N>` (+ `--clickup-ticket=<id>` if a ticket is linked). Stop. |
| `merged` | PR merged | Run **Closing out a merged PR** below. Stop. |

Fresh tasks fall straight through — this guard only fires when prior work is detected.

## 2 — ClickUp ticket  *(skip entirely if ticket-less)*

**If a ticket ID was provided:** fetch it for the title + status:
```
clickup_get_task(task_id="<id>")
```
Use the title as the canonical task description (augmented by extra context from `$ARGUMENTS`).

**If no ticket ID:** create one on this repo's list, deriving tags from `CONFIG.tags`. Let ClickUp assign the list's default initial status (`open`) — do not name it:
```
clickup_create_task(
  list_id="<CLICKUP>",
  name="<task description>",
  markdown_description="<body from the ClickUp template below>",
  tags=[ ...matched CONFIG.tags values ]   # omit if none
)
```

Save the task ID — you update it throughout. No assignee (single-developer project).

## 3 — Create worktree

```bash
git fetch <REMOTE> <BASE>
git worktree add <WT_DIR>/<slug> -b <slug> <REMOTE>/<BASE>
```
Then run the post-create step (install) if defined:
```bash
cd <WT_DIR>/<slug> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>
```
Confirm the worktree exists and the install succeeded before continuing. If the worktree already exists for this branch, reuse it (do not error).

## 4 — Plan and delegate

Form an internal implementation plan. It stays internal — proceed immediately unless the user explicitly said "show me the plan first" or invoked `/plan` before `/ship`.

**Choose the executor:**
- **Default → `supera-engineer`** (one strong agent does code + tests, self-verifies).
- **Escalate → `nelson`** only when the ticket is genuinely multi-component and parallelisable (several independent subsystems, a migration across many sites). `nelson` fans the work out; use it sparingly — solo is the norm.

**Move ticket to building** *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", status=STATUS.building)
```

Announce: *"Plan ready. Delegating to `<executor>` in worktree `<WT_DIR>/<slug>`."* If the task hinges on a term with two plausible readings — a literal name vs. a mapping, an unfamiliar proper noun, a config key that could mean two things — add one line stating the reading you're shipping (e.g. *"reading `environment pulumi` as the literal GitHub environment named `pulumi`, not a per-stack map"*). This is a visible-by-default check, not a gate: proceed unless the fork is genuinely expensive to undo — that case is the engineer's `superpowers:brainstorming` step, not a blocking question here.

Dispatch the executor with: the full task description, the worktree path, and the path to `.claude/supera.json`. The engineer self-verifies (build/test/lint from config) before returning — **do not run the quality gate yourself; CI is the gate, the engineer is the pre-flight.** Wait for its receipt. If the receipt shows a verification FAIL the engineer couldn't resolve in scope, surface it to the user before pushing.

## 5 — Create the PR

Push the branch:
```bash
git -C <WT_DIR>/<slug> push -u <REMOTE> <slug>
```

**Move ticket to in review** — PR open, CI running, awaiting review *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", status=STATUS.review)
```

Derive labels + tags from changed paths against `CONFIG.tags`:
```bash
git -C <WT_DIR>/<slug> diff --name-only <REMOTE>/<BASE>
```
Every `CONFIG.tags` glob matching at least one changed file contributes its tag — used as both the GitHub `--label` and (best-effort) the ClickUp tag. A PR can carry several. Apply ClickUp tags *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", tags=[ ...matched tags ])
```
ClickUp tags must pre-exist in the space — if a tag call fails, continue (best-effort).

Write the PR body (template below), then create the PR assigned to `@me` so it lands in the user's review queue. Do **not** add `--reviewer` (GitHub blocks self-review; the gh-CLI user is the author):
```bash
gh pr create \
  --base <BASE> \
  --title "<short human summary, <70 chars, no conventional-commit prefix>" \
  --body "$(cat <<'EOF'
<body below>
EOF
)" \
  --assignee @me \
  --label "<tag1>" --label "<tag2>"
```
Save the PR number. Link it on the ticket *(skip if ticket-less)*:
```
clickup_create_task_comment(task_id="<id>", comment_text="PR #<N> opened: <PR URL>")
```

## 6 — Hand off to /pr-watch

Invoke `/pr-watch <PR-number>` — append `--clickup-ticket=<ticket-id>` only when a ticket exists.

Announce: *"PR #<N> is open. <Ticket in review (CI running). >Handing off to `/pr-watch <PR-number>`. Once it reports the PR merged, re-run `/ship <slug>` to close the ticket and clean up."*

---

## Resuming interrupted work (phases `scaffolded` / `building`)

Reached from step 1.5 when a worktree/branch exists but no PR. `/ship` continues the build, then falls through to step 5 to open the PR — it never restarts from scratch.

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
Also read the latest `⏸ Paused` ClickUp comment *(ticket mode)* for `nextUp`.

**Re-delegate the remainder.** Move the ticket to building and dispatch the engineer *(skip the ClickUp line if ticket-less)*:
```
clickup_update_task(task_id="<id>", status=STATUS.building)
```
Dispatch `supera-engineer` with: the task description (ticket title + recovered `nextUp`), the worktree path, and the path to `.claude/supera.json`. For `building`, lead with `nextUp` so the engineer continues exactly where pause stopped — don't redo finished work. The engineer self-verifies before returning (**CI is the gate; don't run the full build/test/lint here**). Wait for its receipt; surface any unresolved FAIL before continuing.

Then fall through to **step 5** to open the PR. If a soft-reset rewrote an already-pushed `wip:` commit, push with `--force-with-lease` (never `--force`).

---

## Pause checkpoint (`/ship pause`)

Reached from step 1 when `$ARGUMENTS` begins with `pause`. Stop work cleanly so a later `/ship <slug>` resumes without guessing. No state file — git carries the work; the ticket comment is the human mirror.

1. **Resolve the WIP.** Parse the rest of `$ARGUMENTS` (ticket id, branch, or empty). Empty → the current branch or the single worktree under `WT_DIR` (ambiguous → list and ask). Resolve `WT_PATH`, `BRANCH`, and (ticket mode) `TICKET`.
2. **Capture `nextUp`.** In one or two concrete lines, what is done and what remains — name the next file/step, not "continue work". This becomes the `wip:` commit subject + body and the payload a resume reads back.
3. **Commit the checkpoint:**
```bash
git -C <WT_PATH> add -A
git -C <WT_PATH> status --porcelain      # anything staged?
```
   - Changes present → `git -C <WT_PATH> commit -m "wip: <nextUp one-liner>" -m "<remaining steps, one per line>"`.
   - Tree already clean → skip the commit; the branch state itself is the checkpoint.
   The `wip:` prefix is load-bearing: the resume path keys off it to soft-reset before continuing. Never name a real commit `wip:`.
4. **Push so the work survives:** `git -C <WT_PATH> push -u <REMOTE> <BRANCH>` (`--force-with-lease` only if it rewrote history).
5. **Sync the ticket** *(skip if ticket-less)* — comment the pause; leave the status `STATUS.building` (pause is not a blocker):
```
clickup_create_task_comment(task_id="<TICKET>", comment_text="⏸ Paused. Done: <…>. Next: <nextUp>. Branch `<BRANCH>` pushed — resume with /ship <BRANCH>.")
```
6. **Report:** *"Paused `<BRANCH>`. WIP committed + pushed, worktree kept. Resume with `/ship <BRANCH>`."* List `wip-commit` (sha or "tree clean"), `pushed`, `ticket-comment` (ticket mode only). Stop.

---

## Closing out a merged PR (phase `merged`)

Reached from step 1.5 when the PR is `MERGED`. Record what shipped, close the ticket, tear down the workspace. Only merged work is closed here — abandoning unmerged work is a manual `gh pr close` + `git worktree remove`. **The worktree may already be gone** (close-out partially ran, or it was paused/removed on another machine), so build the summary from `gh` — which works from the repo root — not from `git -C <WT_PATH>`.

1. **Build the summary — all from the merged PR (no live worktree needed):**
   - **Goal** — the ticket title *(ticket mode)*, else the branch slug as a one-line intent.
   - **Files, commit count, first-commit time, merge time:**
```bash
gh pr view <N> --json files   -q '.files[].path'              # changed files
gh pr view <N> --json commits -q '.commits | length'         # commit count
gh pr view <N> --json commits -q '.commits[0].committedDate' # first commit time (PR commits are oldest-first)
gh pr view <N> --json mergedAt -q .mergedAt                   # merge time
```
   **Time spent** = first-commit time → merge time (no ClickUp time-tracking API).
   Format:
```
✅ Shipped: <goal>
   PR #<N> merged · <X commits> · ⏱ ~<T> (<first hh:mm> → merged <hh:mm>)
   Files (<count>):
     - <path>
     - <path>
```
2. **Close the ticket** *(skip if ticket-less)* — post the summary as a comment, then set closed:
```
clickup_create_task_comment(task_id="<TICKET>", comment_text="<summary block>")
clickup_update_task(task_id="<TICKET>", status=STATUS.closed)
```
3. **Tear down the workspace** (silently — no confirm; each step is guarded so a missing worktree/branch is a no-op, not an error):
```bash
[ "<BRANCH>" != "<BASE>" ] && git worktree list | grep -q "<WT_DIR>/<slug>" && git worktree remove <WT_PATH>   # --force only if it refuses on an unclean tree
[ "<BRANCH>" != "<BASE>" ] && git rev-parse --verify --quiet <BRANCH> >/dev/null && git branch -D <BRANCH>      # never delete BASE; delete the feature branch if present
```
   Leave the remote branch alone (GitHub deletes it on merge if configured). **Never** remove `BASE` or its worktree.
4. **Report:** print the summary to the terminal (ticket-less prints only) and confirm: *"Ticket closed, worktree removed, branch `<BRANCH>` deleted locally."* The lifecycle is closed.

---

## Lifecycle controls

`/ship` owns the whole ladder. Only `/pr-watch` lives outside it — `/ship` routes to it, never duplicates it. `/ship pause` is a sub-command, not a separate skill.

| Control | When | Owns |
|---|---|---|
| `/ship pause <ticket\|branch>` | Need to stop mid-ticket | Commits + pushes a `wip:` checkpoint, comments the ticket, **keeps** the worktree. |
| `/ship <branch>` (re-run, `building`/`scaffolded`) | A ship didn't finish | Detects the phase, undoes a `wip:` checkpoint, re-delegates the remainder to `supera-engineer`, opens the PR. |
| `/pr-watch <N>` | PR is open | Drives CI green + review threads to resolution. Hands merged PRs back to `/ship`. |
| `/ship <branch>` (re-run, `merged`) | PR is merged | Posts the summary (goal · time · files), sets the ticket `closed`, removes the worktree + local branch. The terminal step. |

The phase ladder in step 1.5 is the shared contract: `fresh → scaffolded → building → built → pr-open → merged`. Every skill detects it the same way (git + ClickUp, no state file).

---

## ClickUp ticket body template

```
## Context
<1–2 sentences: what's broken / missing and why now>

## Outcome
- <observable change 1>
- <observable change 2>

## Out of scope
- <related but deferred>          ← omit section if empty

## Notes
- <link or fact>                   ← omit section if empty
```

## GitHub PR body template

```
## Summary
<one paragraph: what changed and why — for a reviewer who hasn't seen the ticket>

## Changes
- <concrete change per area>

## Test plan
- [ ] <verification step the reviewer can run or check>

## Notes
<ClickUp link if a ticket exists: [ClickUp #<id>](https://app.clickup.com/t/<id>)>
<load-bearing decisions or known follow-ups — omit if none>
```

## Ticket lifecycle reference  *(ClickUp mode only)*

| Phase | Status | Set by |
|---|---|---|
| Refined, ready to ship | `STATUS.ready` (`pending`) | `/refine-ticket` |
| Engineer dispatched | `STATUS.building` (`in progress`) | `/ship` step 4 |
| Branch pushed, PR open, CI + review | `STATUS.review` (`in review`) | `/ship` step 5 |
| Paused mid-ticket | `STATUS.building` (unchanged) | `/ship pause` |
| Unexpected blocker / repeat CI fail | `STATUS.blocked` (`blocked`) | `/pr-watch` |
| PR closed without merge | `STATUS.rejected` (`rejected`) | `/pr-watch` |
| PR merged → closed out | `STATUS.closed` (`closed`) | `/ship` (merged path) |

Human-only verdicts `completed` / `accepted` are never set by a skill — mark them by hand if you want that nuance in the log.

## Rules

- Read `.claude/supera.json` first — never hardcode commands, list IDs, branches, tags, or **status names** (always `STATUS.<key>`).
- Ticket-less mode (no `clickup.listId`) is first-class: skip all ClickUp steps, ship purely on git + GitHub. Derive close-out time from git commit timestamps.
- Never commit directly to the base branch. Never remove `BASE` or its worktree.
- **Idempotent + full-lifecycle:** run the step 1.5 phase routing first — never double-create a worktree or duplicate work; continue from the detected phase (resume / open PR / close out). Only `/pr-watch` lives outside `/ship`; never duplicate it.
- Always delegate code + tests to `supera-engineer` (or `nelson` for genuinely parallel work) — `/ship` orchestrates, it does not implement.
- The engineer self-verifies as pre-flight; **CI is the quality gate** — do not run a full build/test/lint from the orchestrator before pushing.
- Always `--assignee @me`, never `--reviewer`. No ClickUp assignee, no ClickUp time-tracking.
- A `wip:` HEAD is always soft-reset before resuming, then pushed `--force-with-lease` (never `--force`).
