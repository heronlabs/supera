---
name: finish
description: "Close out a merged ticket: verify the PR is merged, post a summary (goal, time spent, files changed) to ClickUp + terminal, set the ticket complete, then tear down the worktree and local branch. The deliberate end of the ship lifecycle — run after /pr-watch reports the PR merged."
allowed-tools: Bash, Read  # also requires gh CLI and clickup_* MCP tools
---

The terminal step of the ship lifecycle. Confirm the PR merged, record what shipped (goal, time, files), close the ticket, and clean the workspace. Owns the `complete` status and the worktree teardown — `/pr-watch` no longer does either; it hands here.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` and stop.
- `CLICKUP = CONFIG.clickup?.listId` — null/absent → **ticket-less**: skip every ClickUp step; print the summary to the terminal only.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.

## 1 — Resolve the ticket / branch / PR

Parse `$ARGUMENTS`: a ClickUp ticket id, a branch name, or empty.

- **Empty** → detect from the current branch or the single worktree under `WT_DIR`.
- Resolve `BRANCH`, `WT_PATH` (if a worktree exists), and (ticket mode) `TICKET`.
- Find the PR:
```bash
gh pr list --head <BRANCH> --state all --json number,state,mergedAt,mergeCommit
```

## 2 — Gate: the PR must be merged

- **No PR found** → *"No PR for `<BRANCH>` — nothing to finish. Run `/ship` or `/resume` first."* Stop.
- **PR open / not merged** → *"PR #<N> isn't merged yet — run `/pr-watch <N>` to drive it green, then `/finish`."* Stop. Do **not** close the ticket or remove the worktree.
- **PR merged** → continue.

There is no force path — `/finish` only closes merged work (per design). Abandoning unmerged work is a manual `gh pr close` + `git worktree remove`, deliberately not automated here.

## 3 — Build the summary

- **Goal** — the ticket title *(ticket mode)*, else a one-line description of the branch's intent.
- **Time spent** *(ticket mode)* — sum the durations from:
```
clickup_get_task_time_entries(task_id="<TICKET>")
```
  Ticket-less → best-effort elapsed: first branch commit author-date → merge commit date:
```bash
git -C <WT_PATH> log --reverse --format=%aI <REMOTE>/<BASE>..<BRANCH> | head -1   # first commit time
gh pr view <N> --json mergedAt -q .mergedAt                                       # merge time
```
- **Files changed + commit count**:
```bash
git -C <WT_PATH> diff --name-only <REMOTE>/<BASE>...<BRANCH>
git -C <WT_PATH> rev-list --count <REMOTE>/<BASE>..<BRANCH>
```

Format the summary:
```
✅ Shipped: <goal>
   PR #<N> merged · <X commits> · <T time spent>
   Files (<count>):
     - <path>
     - <path>
```

## 4 — Close the ticket  *(skip entirely if ticket-less)*

Post the summary, set the ticket complete, ensure the timer is stopped:
```
clickup_create_task_comment(task_id="<TICKET>", comment_text="<summary block>")
clickup_update_task(task_id="<TICKET>", status="complete")
clickup_get_current_time_entry()
clickup_stop_time_tracking()                  # only if a timer is still running on this ticket
```

## 5 — Tear down the workspace

Always print the summary to the terminal (ticket mode too). Then clean up:
```bash
git worktree remove <WT_PATH>                 # add --force only if it refuses on an unclean tree
git branch -D <BRANCH>                          # delete the local branch
```
Leave the remote branch alone — GitHub deletes it on merge if the repo is configured to; otherwise it's harmless. Never delete `BASE`.

## 6 — Report

Print the summary block and confirm teardown: *"Ticket complete, worktree removed, branch `<BRANCH>` deleted locally."* End — the lifecycle is closed.

## Rules

- Read `.claude/supera.json` first — never hardcode commands, list IDs, branches, or remotes.
- **Require merged** — refuse to close the ticket or remove the worktree until the PR is `MERGED`; point unmerged work back to `/pr-watch`. No `--force`.
- Ticket-less mode is first-class: skip all ClickUp steps; print the summary to the terminal; derive time from commit timestamps.
- `/finish` owns the `complete` status and the teardown — `/pr-watch` defers both here.
- Never remove the base branch or its worktree. Only the feature branch + its worktree.
- Always emit the summary (goal · time · files) — it's the durable record of what shipped.
