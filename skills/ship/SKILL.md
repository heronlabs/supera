---
name: ship
description: "Repo-agnostic task lifecycle orchestrator: ClickUp ticket → worktree → plan → delegate to supera-engineer (code + tests) → self-verified → PR → ticket completed → hand off to /pr-watch. Driven by .claude/supera.json so it works in any repo. Zero-touch path from task to open PR."
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Orchestrate a task from zero to an open PR with a passing quality gate, in **any** repo. Read this repo's `.claude/supera.json` for stack commands, ClickUp list, worktree base, and the tag table. Delegate the actual code + tests to the `supera-engineer` agent. After the PR is open, hand off to `/pr-watch`.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` Offer to run `/supera-init` now. Do not proceed without config.
- `CLICKUP = CONFIG.clickup?.listId` — if null/absent, run **ticket-less**: skip every ClickUp + time-tracking step below and operate on git + GitHub only.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`.

When ClickUp is configured, this skill tracks time on the ticket between steps via `clickup_start_time_tracking` / `clickup_stop_time_tracking`, one labelled entry per phase.

## 1 — Parse arguments

`$ARGUMENTS` may be:
- A free-text task description — e.g. `"add payment retry on timeout"`
- A ClickUp ticket ID + optional extra context — e.g. `"86abc123 also handle nil amounts"`
- Just a ClickUp ticket ID — e.g. `"86abc123"`

If empty, ask for a task description.

Derive a branch slug: lowercase, kebab-case, ≤50 chars, special chars stripped, prefixed by type (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`). Example: `"add payment retry on timeout"` → `feat/add-payment-retry-on-timeout`.

## 2 — ClickUp ticket  *(skip entirely if ticket-less)*

**If a ticket ID was provided:** fetch it for the title + status:
```
clickup_get_task(task_id="<id>")
```
Use the title as the canonical task description (augmented by extra context from `$ARGUMENTS`).

**If no ticket ID:** create one. First resolve the user ID (the `"me"` shorthand is unreliable in `clickup_create_task`):
```
clickup_resolve_assignees(["me"])   → save the returned user ID
```
Then create it on this repo's list, deriving tags from `CONFIG.tags`:
```
clickup_create_task(
  list_id="<CLICKUP>",
  name="<task description>",
  status="Open",
  markdown_description="<body from the ClickUp template below>",
  assignees=["<resolved-user-id>"],
  tags=[ ...matched CONFIG.tags values ]   # omit if none
)
```

Save the task ID — you update it throughout.

**Start time tracking — phase: ticket setup.**
```
clickup_get_current_time_entry()
clickup_stop_time_tracking()                                                   # only if a timer runs on a different task
clickup_start_time_tracking(task_id="<id>", description="ship: ticket setup")
```

## 3 — Create worktree

**Switch time tracking — phase: worktree** *(skip if ticket-less)*:
```
clickup_stop_time_tracking()
clickup_start_time_tracking(task_id="<id>", description="ship: worktree")
```

```bash
git fetch <CONFIG.pr.remote ?? origin> <BASE>
git worktree add <WT_DIR>/<slug> -b <slug> <remote>/<BASE>
```
Then run the post-create step (install) if defined:
```bash
cd <WT_DIR>/<slug> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>
```
Confirm the worktree exists and the install succeeded before continuing. If the worktree already exists for this branch, reuse it (do not error).

## 4 — Plan and delegate

**Switch time tracking — phase: plan** *(skip if ticket-less)*:
```
clickup_stop_time_tracking()
clickup_start_time_tracking(task_id="<id>", description="ship: plan")
```

Form an internal implementation plan. It stays internal — proceed immediately unless the user explicitly said "show me the plan first" or invoked `/plan` before `/ship`.

**Choose the executor:**
- **Default → `supera-engineer`** (one strong agent does code + tests, self-verifies).
- **Escalate → `nelson`** only when the ticket is genuinely multi-component and parallelisable (several independent subsystems, a migration across many sites). `nelson` fans the work out; use it sparingly — solo is the norm.

**Move ticket to in progress** *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", status="in progress")
```

**Switch time tracking — phase: implementation** *(skip if ticket-less)*:
```
clickup_stop_time_tracking()
clickup_start_time_tracking(task_id="<id>", description="ship: implementation")
```

Announce: *"Plan ready. Delegating to `<executor>` in worktree `<WT_DIR>/<slug>`."*

Dispatch the executor with: the full task description, the worktree path, and the path to `.claude/supera.json`. The engineer self-verifies (build/test/lint from config) before returning — **do not run the quality gate yourself; CI is the gate, the engineer is the pre-flight.** Wait for its receipt. If the receipt shows a verification FAIL the engineer couldn't resolve in scope, surface it to the user before pushing.

## 5 — Create the PR

**Switch time tracking — phase: pr open** *(skip if ticket-less)*:
```
clickup_stop_time_tracking()
clickup_start_time_tracking(task_id="<id>", description="ship: pr open")
```

Push the branch:
```bash
git -C <WT_DIR>/<slug> push -u <remote> <slug>
```

**Move ticket to completed** (dev work done, CI now running) *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", status="completed")
```

Derive labels + tags from changed paths against `CONFIG.tags`:
```bash
git -C <WT_DIR>/<slug> diff --name-only <remote>/<BASE>
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

**Stop time tracking** *(skip if ticket-less)* — `/ship` is done; `/pr-watch` does not track time:
```
clickup_stop_time_tracking()
```

Invoke `/pr-watch <PR-number>` — append `--clickup-ticket=<ticket-id>` only when a ticket exists.

Announce: *"PR #<N> is open. <Ticket `completed` (CI running). >Handing off to `/pr-watch <PR-number>`."*

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

| Phase | Status | Time entry | Set by |
|---|---|---|---|
| Ticket created | `open` | `ship: ticket setup` | step 2 |
| Worktree | `open` | `ship: worktree` | step 3 |
| Plan formulated | `open` | `ship: plan` | step 4 |
| Engineer dispatched | `in progress` | `ship: implementation` | step 4 |
| Branch pushed, CI running | `completed` | `ship: pr open` | step 5 |
| Handoff | `completed` | (timer stopped) | step 6 |
| CI passing, ready to review | `in review` | — | /pr-watch |
| PR accepted → merge | `complete` | — | /pr-watch |
| Unexpected blocker | `blocked` | — | /pr-watch |

## Rules

- Read `.claude/supera.json` first — never hardcode commands, list IDs, branches, or tags.
- Ticket-less mode (no `clickup.listId`) is first-class: skip all ClickUp + timer steps, ship purely on git + GitHub.
- Never commit directly to the base branch.
- Always delegate code + tests to `supera-engineer` (or `nelson` for genuinely parallel work) — `/ship` orchestrates, it does not implement.
- The engineer self-verifies as pre-flight; **CI is the quality gate** — do not run a full build/test/lint from the orchestrator before pushing.
- Always `--assignee @me`, never `--reviewer`.
- One running timer per ticket — stop before every start; always stop in step 6.
