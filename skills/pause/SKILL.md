---
name: pause
description: "Checkpoint an in-flight ship: commit and push any work-in-progress as a wip: checkpoint, leave a note of what's left, comment the ClickUp ticket, stop the timer, and keep the worktree so /resume can pick up instantly. Use when you need to stop mid-ticket and hand off cleanly to a later session."
allowed-tools: Bash, Read  # also requires clickup_* MCP tools
---

Stop work on a ticket cleanly so a later `/resume` (or a different session) can continue without guessing. Commit and push the work-in-progress as a `wip:` checkpoint, record what's left, sync the ClickUp ticket, and **keep** the worktree. No state file — git carries the work, the ticket comment is the human mirror.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` and stop.
- `CLICKUP = CONFIG.clickup?.listId` — if null/absent, run **ticket-less**: skip every ClickUp + time-tracking step below. The `wip:` commit body is then the *only* breadcrumb, so make it complete.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.

## 1 — Resolve the work in progress

Parse `$ARGUMENTS`: a ClickUp ticket id, a branch name, or empty.

- **Empty** → detect from context: the current branch (`git branch --show-current`), or the single branch worktree under `WT_DIR`. If more than one candidate worktree exists, list them and ask which to pause.
- **Branch / ticket id** → resolve to the matching worktree path + branch.

Find the linked ticket id *(skip if ticket-less)*: from `$ARGUMENTS`, else scan the branch's PR / recent commits for a ClickUp id. If none is found, treat as ticket-less for this run.

Confirm you have: `WT_PATH`, `BRANCH`, and (optionally) `TICKET`.

## 2 — Capture what's left (`nextUp`)

Summarise, in one or two lines, **what is done** and **what remains** on this ticket. This is the payload `/resume` reads back, so be concrete: name the next file/step, not "continue work". Keep it short — it becomes the `wip:` commit subject + body.

## 3 — Commit the checkpoint

In the worktree:
```bash
git -C <WT_PATH> add -A
git -C <WT_PATH> status --porcelain      # check if anything is staged
```
- **Changes present** → commit a checkpoint:
```bash
git -C <WT_PATH> commit -m "wip: <nextUp one-liner>" -m "<remaining steps, one per line>"
```
- **Tree already clean** → skip the commit (nothing to checkpoint), but still continue. The branch state itself is the checkpoint.

The `wip:` prefix is load-bearing: `/resume` uses it to detect that work is incomplete and to soft-reset before continuing. Never name a real commit `wip:`.

## 4 — Push so the work survives

```bash
git -C <WT_PATH> push -u <REMOTE> <BRANCH>
```
If the branch was already pushed and the checkpoint rewrote history (rare for pause — it only adds a commit), use `--force-with-lease`. Pushing means the work survives losing the machine; resume can even recreate the worktree from the remote if needed.

## 5 — Sync the ticket  *(skip entirely if ticket-less)*

Comment the pause so it's visible in ClickUp:
```
clickup_create_task_comment(
  task_id="<TICKET>",
  comment_text="⏸ Paused. Done: <…>. Next: <nextUp>. Branch `<BRANCH>` pushed — resume with /resume <TICKET>."
)
```
Stop the running timer (leave the status as `in progress` — pause is not a blocker, and `/resume` re-asserts it):
```
clickup_get_current_time_entry()
clickup_stop_time_tracking()
```

## 6 — Report

Announce: *"Paused `<BRANCH>` at the implementation phase. WIP committed + pushed, worktree kept. Resume with `/resume <TICKET or BRANCH>`."* List: `wip-commit` (sha or "tree clean"), `pushed`, `ticket-comment` / `timer-stopped` (ticket mode only).

## Rules

- Read `.claude/supera.json` first — never hardcode commands, list IDs, branches, or remotes.
- Ticket-less mode (no `clickup.listId`) is first-class: skip all ClickUp + timer steps; the `wip:` commit body is the sole breadcrumb — make it complete.
- **Keep the worktree** — pause never removes it; that's `/finish`'s job. resume reuses it.
- The `wip:` prefix is reserved for pause checkpoints — `/resume` keys off it. Don't use it for real commits.
- Always push (so work survives) — `--force-with-lease` only if the push rewrites history, never `--force`.
- Leave the ticket `in progress` and stop the timer — pause is a clean stop, not a `blocked`.
- One running timer per ticket — always stop it here.
