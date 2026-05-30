---
name: resume
description: "Pick up an interrupted ship and keep working: detect where the ticket stopped (from git + ClickUp, no state file), undo any wip: checkpoint, re-delegate the remaining work to supera-engineer, then continue to PR / pr-watch / finish. Use after /pause, or whenever a ship didn't run to completion."
allowed-tools: Bash, Read, Glob, Grep, Agent  # also requires gh CLI and clickup_* MCP tools
---

Continue a ticket that `/ship` started but didn't finish. There is **no state file** — `/resume` reconstructs the phase from git + ClickUp, undoes any `wip:` checkpoint left by `/pause`, hands the remaining work back to `supera-engineer`, and routes the rest of the lifecycle to the skill that owns it. `/resume` owns *continuing implementation*; `/ship` owns *opening the PR*; `/pr-watch` and `/finish` own the post-PR tail.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` and stop.
- `CLICKUP = CONFIG.clickup?.listId` — null/absent → **ticket-less**: skip ClickUp + timer steps; reconstruct `nextUp` from the `wip:` commit body alone.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.

## 1 — Resolve what to resume

Parse `$ARGUMENTS`: a ClickUp ticket id, a branch name, or empty.

- **Empty** → detect from the current branch, or the single branch worktree under `WT_DIR`. Ambiguous (multiple worktrees) → list them and ask.
- Resolve to `WT_PATH`, `BRANCH`, and (ticket mode) `TICKET`.
- If neither a branch nor a worktree exists for the argument, treat the phase as `fresh`.

If the worktree is missing but the branch exists on the remote (e.g. paused on another machine), recreate it:
```bash
git fetch <REMOTE> <BRANCH>
git worktree add <WT_DIR>/<slug> <BRANCH>
cd <WT_DIR>/<slug> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>
```

## 2 — Detect the phase

Reconstruct the lifecycle phase deterministically (the shared ladder):

```bash
git -C <WT_PATH> log --oneline <REMOTE>/<BASE>..<BRANCH>     # commits beyond base?
git -C <WT_PATH> log -1 --pretty=%s                          # is HEAD a 'wip:' commit?
gh pr list --head <BRANCH> --state all --json number,state   # PR? merged?
```

| Phase | Signal | What `/resume` does |
|---|---|---|
| `fresh` | no branch & no worktree | Tell the user to run `/ship` — nothing to resume. |
| `scaffolded` | worktree+branch, **0 commits** vs base | Delegate the full implementation to `supera-engineer`, then hand to `/ship` for the PR. |
| `building` | commits, **HEAD is `wip:`**, no PR | Soft-reset the checkpoint, recover `nextUp`, delegate the remainder, then hand to `/ship` for the PR. |
| `built` | commits, HEAD not `wip:`, no PR | Hand straight to `/ship` — the code is done, only the PR is missing. |
| `pr-open` | PR exists, not `MERGED` | Invoke `/pr-watch <N>`. |
| `merged` | PR `MERGED` | Suggest `/finish`. |

Announce the detected phase before acting (e.g. *"Resuming `<BRANCH>` — phase `building`."*) so a mis-detection is visible.

## 3 — Act on the phase

### `fresh`
Stop: *"Nothing to resume for `<arg>` — run `/ship <task or ticket>` to start."*

### `building` — undo the checkpoint first
The `wip:` HEAD is a pause checkpoint, not real history. Un-commit it so the engineer continues from clean staged state:
```bash
git -C <WT_PATH> reset --soft HEAD~1
```
Recover `nextUp`: the body of the `wip:` commit (`git -C <WT_PATH> show -s --format=%b HEAD@{1}`), plus the latest `⏸ Paused` ClickUp comment *(ticket mode)*. Then fall through to delegation.

### `scaffolded` / `building` — re-delegate the remainder
*(skip ClickUp lines if ticket-less)*
```
clickup_start_time_tracking(task_id="<TICKET>", description="resume: implementation")
clickup_update_task(task_id="<TICKET>", status="in progress")
```
Dispatch `supera-engineer` with: the task description (ticket title + `nextUp`), the worktree path, and the path to `.claude/supera.json`. For `building`, lead with the recovered `nextUp` so the engineer continues exactly where pause stopped — don't re-do finished work. The engineer self-verifies before returning (**CI is the gate; don't run the full build/test/lint here**). Wait for its receipt; surface any unresolved FAIL before continuing.

After the engineer returns, push (use `--force-with-lease` if the soft-reset rewrote a pushed `wip:` commit):
```bash
git -C <WT_PATH> push <REMOTE> <BRANCH>            # add --force-with-lease only after a wip soft-reset
```
Then hand to `/ship` to open the PR (next case).

### `built` — open the PR
Stop time tracking *(ticket mode)* and invoke `/ship <BRANCH>`. `/ship`'s resume-check detects the `built` phase (commits, no PR) and jumps straight to opening the PR + handing off to `/pr-watch` — no re-planning, no re-implementation.

### `pr-open`
The work is past `/ship`'s scope. Invoke `/pr-watch <N>` (append `--clickup-ticket=<TICKET>` when a ticket exists). Stop here.

### `merged`
Announce: *"PR #<N> is merged — run `/finish <TICKET or BRANCH>` to close the ticket, summarise, and clean up."* Stop.

## Rules

- Read `.claude/supera.json` first — never hardcode commands, list IDs, branches, or remotes.
- Ticket-less mode is first-class: skip all ClickUp + timer steps; reconstruct `nextUp` from the `wip:` commit body.
- **`/resume` continues implementation; `/ship` opens the PR.** For any pre-PR phase, after the engineer is done, hand to `/ship` rather than duplicating its PR step.
- Always delegate code + tests to `supera-engineer` — `/resume` orchestrates, it does not implement.
- The engineer self-verifies as pre-flight; **CI is the quality gate** — don't run a full build/test/lint from the orchestrator.
- A `wip:` HEAD is always soft-reset before continuing, then pushed `--force-with-lease` (never `--force`).
- Announce the detected phase before acting, so a mis-detection is caught.
- Never restart from scratch when a worktree/branch already exists — continue from the detected phase.
