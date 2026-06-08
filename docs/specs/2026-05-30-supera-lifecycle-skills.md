# Supera — lifecycle skills: pause / resume / finish

**Date:** 2026-05-30
**Status:** ⚠️ SUPERSEDED by [`2026-06-07-supera-status-lifecycle.md`](2026-06-07-supera-status-lifecycle.md). This record proposed `/pause`, `/resume`, `/finish` as three separate skills. The redesign folded all three into an idempotent `/ship` (+ `/ship pause`) and **deleted** the standalone skills (shipped v0.4.0, commit `603d924`). Kept for design-history only — do not implement from this doc.

## Problem

Today `/ship` is a one-shot linear pipeline (ticket → worktree → plan → engineer → PR →
ticket `completed` → hand off to `/pr-watch`). Once it returns, the only durable state is
implicit: a worktree, a branch, and a ClickUp status. There is no first-class way to:

1. **Stop mid-flight cleanly** — a half-finished ticket leaves uncommitted work in a worktree
   with no record of what is left to do.
2. **Pick work back up** — resuming means re-reading git by hand to guess where the engineer
   stopped, then manually re-driving the pipeline.
3. **Close out deliberately** — `/pr-watch` silently flips the ticket to `complete` on merge,
   but nothing cleans the worktree, sums the time spent, or records what shipped. The terminal
   step is a side effect, not an owned action.

## Goal

Add a thin **lifecycle layer** over `/ship` so a ticket can be paused, resumed, and finished as
explicit actions — without introducing a new state store. State is **derived from git + ClickUp**;
breadcrumbs ride on a `wip:` checkpoint commit and a ClickUp pause comment. `/ship` becomes the
conductor that acknowledges these controls and routes into them.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | State store | **Derive from git + ClickUp.** No state file. Carriers: `wip:` commit body (`nextUp`) + ClickUp pause comment. |
| 2 | `/resume` routing | Phase detection: `fresh`→restart ship · `scaffolded`/`building`/`built`→continue ship pipeline · `pr-open`→`/pr-watch` · `merged`→suggest `/finish`. |
| 3 | `/finish` gate | **Require merged.** PR not merged → point to `/pr-watch`, exit. No `--force` path. |
| 4 | `/pause` teardown | Keep worktree. Commit + push a `wip:` checkpoint. ClickUp pause comment. Stop timer. |
| 5 | `wip:` commit on resume | `git reset --soft HEAD~1` to un-commit; engineer continues; next push `--force-with-lease`. PR history carries no `wip:` noise. |
| 6 | `/finish` summary | ClickUp comment + terminal (ticket mode); terminal only (ticket-less). |
| 7 | `/pr-watch` merge-terminal | **Defer to `/finish`.** On `MERGED`, `/pr-watch` stops setting `complete`; it announces "merged — run `/finish`". `/finish` owns close + teardown + summary. |
| 8 | Schema | **No change.** All values used (`worktree`, `pr`, `clickup`, `tags`) already exist. |
| 9 | `/pause` ticket status | Leave as-is (`in progress`); comment + stop-timer only. No dedicated `paused` status (statuses are space-defined, like tags). `/resume` re-asserts `in progress`. |

## The phase ladder (shared keystone)

All four skills agree on one canonical lifecycle, detected deterministically from git + ClickUp.
The ladder is **inlined in each skill** (supera invariant: skills are self-contained, no fragile
cross-references), not factored into a shared file.

| Phase | Detected by | Owner action |
|---|---|---|
| `fresh` | no branch **and** no worktree for this task | `/ship` — full pipeline from ticket setup |
| `scaffolded` | worktree + branch exist, 0 commits vs base | `/ship` — from "plan & delegate" |
| `building` | commits exist, **HEAD is a `wip:` commit**, no PR | `/resume` — soft-reset wip, re-delegate engineer with `nextUp` |
| `built` | commits exist, HEAD **not** `wip:`, no PR | `/ship` or `/resume` — open the PR |
| `pr-open` | PR exists, not `MERGED` | → `/pr-watch <N>` |
| `merged` | PR `MERGED` | → `/finish` |

The `wip:` prefix is the resume signal. Its commit body carries `nextUp` (the remaining steps);
in ticket mode the same note is mirrored to the ClickUp pause comment. Distinguishing `building`
from `built` by the `wip:` prefix is what lets `/resume` know whether the engineer must continue
or the work is ready for a PR.

## Skills

### `/pause` — checkpoint, keep worktree

1. Load `CONFIG`. Resolve the branch / worktree and (if any) the linked ticket — from
   `$ARGUMENTS` (ticket id or branch) or from the current worktree.
2. In the worktree: `git add -A`, then commit `wip: <nextUp summary>` with the body listing the
   remaining steps. If the tree is already clean, skip the commit but still proceed.
3. Push the branch: `git push -u <remote> <branch>` (`--force-with-lease` if it was already
   pushed). The work now survives losing the machine.
4. **Ticket mode:** `clickup_create_task_comment` — "⏸ Paused at `<phase>`. Done: `<…>`.
   Next: `<…>`. Branch pushed." Then stop the running timer. Leave status `in progress`.
5. Keep the worktree. Announce: paused, and `→ /resume <ticket|branch>` to continue.

### `/resume` — phase router back into the pipeline

1. Load `CONFIG`. Parse `$ARGUMENTS`: ticket id, branch, or empty → detect from the current
   branch or the single worktree under `WT_DIR` (ask if ambiguous).
2. Detect the phase via the ladder.
3. Route:
   - `fresh` → "Nothing to resume — run `/ship <task>`."
   - `building` → `git reset --soft HEAD~1` (undo the `wip:` checkpoint), recover `nextUp` from
     the commit body + ticket comment, restart the timer (`resume: implementation`), set ticket
     `in progress`, delegate the remaining work to `supera-engineer`. Next push uses
     `--force-with-lease`. Then continue to the PR step.
   - `scaffolded` / `built` → re-enter `/ship` at the matching step (plan & delegate / open PR).
   - `pr-open` → invoke `/pr-watch <N>` (append `--clickup-ticket=<id>` when a ticket exists).
   - `merged` → suggest `/finish`.

### `/finish` — terminal close (requires merged)

1. Load `CONFIG`. Resolve the branch, its PR, and the linked ticket.
2. **Gate:** the PR must be `MERGED`. If not merged → "PR #<N> not merged yet — run `/pr-watch`
   first." and exit. If there is no PR at all → "Nothing to finish."
3. Build the summary:
   - **Goal** — ticket title (ticket mode) or branch description.
   - **Time** — sum `clickup_get_task_time_entries`; ticket-less → elapsed from first branch
     commit author-date to the merge commit (best-effort).
   - **Files** — `git diff --name-only <base>...<branch>`; plus commit count.
4. **Ticket mode:** post the summary via `clickup_create_task_comment`, set status `complete`,
   ensure the timer is stopped. **Always** print the summary to the terminal.
5. Teardown: `git worktree remove <path>` (`--force` if needed) and delete the local branch.
   Leave the remote branch to GitHub's merge-delete setting.
6. Announce done with the one-line summary.

### `/ship` refinement (acknowledge + orchestrate)

- **Resume check** (new, right after load-config): run phase detection. If an in-progress
  branch / worktree already exists for this task, route to the resume path rather than blindly
  restarting — `/ship` should never double-create a worktree or duplicate work.
- **Lifecycle controls** (new section): name `/pause`, `/resume`, `/finish` and when each
  applies, so the orchestrator documents the full loop.
- **Handoff text** (step 6): after `/pr-watch` reports green/merged, the terminal step is
  `/finish` — `/ship` no longer implies `/pr-watch` closes the ticket.

### `/pr-watch` tweak (defer to `/finish`)

- The `MERGED` branch of the state check **stops setting `complete`**; it announces
  "merged — run `/finish` to close" (still surfacing the ticket link). One small edit; everything
  else in `/pr-watch` is unchanged.

## Invariants preserved

1. **Nothing repo-specific is hardcoded** — the new skills read `CONFIG` (`worktree`, `pr`,
   `clickup`, `tags`); no new repo-specific values, so **no schema change**.
2. **`supera-engineer` stays the only implementer** — `/resume` delegates remaining work to it;
   pause/finish never edit application code.
3. **Ticket-less is first-class** — every ClickUp step (pause comment, status, timer, finish
   comment, time sum) is guarded by `clickup.listId`; git carriers (`wip:` commit, `git diff`)
   work with no ticket.
4. **CI is the quality gate** — `/resume` re-delegates to the engineer (who self-verifies);
   none of the new skills run a full build/test/lint from the orchestrator.
5. **Schema and skills stay in sync** — trivially, since no field is added.
6. **One running timer per ticket** — pause stops it; resume starts a labelled entry; finish
   stops it.

## Deferred

- **Dedicated `paused` ClickUp status** — would need to pre-exist per space (like tags). Skipped;
  pause leaves `in progress` + a comment. Revisit if a space standardizes a paused status.
- **Headless `/finish` and `/resume`** — the autonomy roadmap (`2026-05-30-supera-autonomy-roadmap.md`)
  will define `--non-interactive` semantics; these skills inherit that later, not now.
- **`/finish --force`** (abandon/early close) — explicitly rejected (Decision 3); add only if a
  real abandon-without-merge workflow appears.

## Risks

- **Phase mis-detection** — the ladder leans on the `wip:` prefix and PR state. A hand-made
  commit named `wip:` would be misread as a pause checkpoint. Mitigation: pause owns the `wip:`
  convention; document it; `/resume` shows the detected phase before acting.
- **`--force-with-lease` after resume** — rewrites the pushed `wip:` commit. Safe on a private
  feature branch; never on the base branch (existing invariant holds).
- **Cross-skill coherence** — `/pr-watch` deferring to `/finish` means the terminal `complete`
  now lives in one place; if `/finish` is never run, a merged ticket lingers at `in review`.
  Acceptable: `/pr-watch` tells the user to run `/finish`.
