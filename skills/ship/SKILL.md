---
name: ship
description: Implement a task in an isolated worktree — create worktree, delegate to supera-engineer (code + tests), self-verify, leave changes for review. Idempotent: re-run in a dirty worktree continues where it left off.
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Implement a task in an isolated git worktree. Delegate all code + tests to `supera-engineer`. Changes stay in the working tree for user review — no push, no PR.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /start first."` and stop.
- `BASE = CONFIG.baseBranch`
- `WT_DIR = ".worktrees"`
- `REMOTE = CONFIG.remote`

## 1 — Parse task

`$ARGUMENTS` is a free-text task description. If empty, ask for one.

Derive a branch slug: lowercase, kebab-case, ≤50 chars, prefixed by type with a dash (`feat-`, `fix-`, `docs-`, `refactor-`, `chore-`). Example: `"add payment retry"` → `feat-add-payment-retry`.

## 2 — Detect context

Check if we're already in a supera worktree:

```bash
git worktree list | grep "$(pwd)"
pwd
```

**Already in a worktree** → continue implementing in place. The worktree is the workspace. Skip step 3.

**Not in a worktree** → proceed to step 3.

## 3 — Create worktree

```bash
git fetch $REMOTE $BASE
git worktree add $WT_DIR/$SLUG -b $SLUG $REMOTE/$BASE
cd $WT_DIR/$SLUG
```

If the worktree already exists for this branch, reuse it (don't error). If the branch already exists on remote but worktree is missing:

```bash
git fetch $REMOTE $SLUG
git worktree add $WT_DIR/$SLUG $SLUG
cd $WT_DIR/$SLUG
```

Install dependencies after creating/entering the worktree:
```bash
# Detect install command from lockfile
pnpm install --frozen-lockfile  # or npm ci, yarn install --immutable, cargo fetch
```

## 4 — Plan and delegate

Announce: *"Delegating to supera-engineer in worktree `$WT_DIR/$SLUG`."*

Dispatch `supera-engineer` with: the task description, the worktree path, and the path to `.claude/supera.json`. The engineer writes a plan to `.supera/plan.md`, implements code + tests, self-verifies, and returns a receipt.

Wait for its JSON receipt. Parse it:
- **All verification `pass`** → done. Surface the summary and files changed.
- **Any `fail`** → delegate back to engineer with the failure output (max 3 loops). If still failing after 3, surface the failure.

## 5 — Done

Report what was implemented, files changed, and verification results. Changes are in the worktree — user reviews, commits, pushes, opens PR.

To watch the PR through CI: `/pr-watch` from the worktree.

## Rules

- Read `.claude/supera.json` first — never hardcode commands or branches.
- Never remove `BASE` or its worktree.
- **Idempotent** — re-run in a dirty worktree picks up where engineer left off. No state tracking needed.
- Never commit to base directly.
- Commit hygiene follows `guidelines/commit-conventions.md`.
