---
name: fast-ship
description: "The fast path for small changes: ship straight to the base branch with no worktree, no PR, and no ticket. Loads .claude/supera.json, guards that you're on a clean base branch, delegates the edit to supera-engineer (verify skipped for speed), then commits and pushes to base. Use for typo fixes, version bumps, tiny tweaks — anything that doesn't merit the full /ship lifecycle. Triggers: 'fast ship', 'ship this small thing', 'quick ship to main'."
allowed-tools: Bash, Read, Glob, Grep, Agent
---

The deliberate fast path opposite of `/ship`. For a **small** change that doesn't merit a worktree, a PR, or a ticket — ship it straight to the base branch. No phase ladder, no `/pause` / `/resume` / `/pr-watch` / `/finish`; this skill runs start to finish in one shot.

`fast-ship` is the **one** skill allowed to commit directly to the base branch — every other skill is forbidden to. Treat that power with care: there is no PR and no CI gate to catch a mistake, so the guards in step 2 are load-bearing.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` Offer to run `/supera-init` now. Do not proceed without config.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `REMOTE = CONFIG.pr?.remote ?? "origin"`.

`fast-ship` is **always ticket-less** — it never touches ClickUp or time tracking, even when `CONFIG.clickup.listId` is set. A change worth tracking on a ticket is a change worth a `/ship`.

## 1 — Parse arguments

`$ARGUMENTS` is a free-text description of the small change — e.g. `"fix typo in README install step"`. If empty, ask for one. Do **not** accept a ClickUp ticket ID here; ticketed work goes through `/ship`.

## 2 — Preflight guard

This is the safety net that replaces the worktree + PR + CI. Run all three checks before touching anything; stop on the first failure.

```bash
git branch --show-current                    # must equal BASE
git status --porcelain                       # must be empty (no unrelated changes)
```

- **Wrong branch** → stop: *"fast-ship runs on `<BASE>`; you're on `<current>`. Switch to `<BASE>`, or use `/ship` for branch work."* Never auto-switch — the user may have uncommitted context.
- **Dirty tree** → stop: *"Working tree has uncommitted changes — fast-ship won't sweep them into the ship. Commit, stash, or clean them first."* The ship must contain only the engineer's change, nothing else.
- **Clean + on base** → fast-forward to the latest base so the commit lands on top of it:
  ```bash
  git fetch <REMOTE> <BASE>
  git pull --ff-only <REMOTE> <BASE>
  ```
  If the fast-forward fails (local base diverged), stop and tell the user to reconcile — do not merge or rebase automatically.

## 3 — Delegate to supera-engineer

The engineer is still the only implementer — `fast-ship` orchestrates, it does not edit code itself.

Dispatch `supera-engineer` with:
- the task description from step 1,
- the **repo root** as the working directory (this is the main checkout, **not** a worktree),
- the path to `.claude/supera.json`,
- an explicit instruction: **skip the self-verify build/test/lint suite — this is a fast ship, speed over the gate.** Make the change (and its tests if the change clearly warrants them), then return.

Wait for the engineer's receipt. If it reports it could not make the change, surface that and stop — nothing to commit.

## 4 — Commit

Everything in the working tree now is the engineer's change (step 2 guaranteed the tree started clean). Stage and commit with a single-line conventional-commit subject — a few words, no body, no co-author trailer:

```bash
git add -A
git commit -m "<type>: <short summary, few words, ≤50 chars>"
```

`<type>` is the conventional-commit prefix matching the change (`fix`, `docs`, `chore`, `feat`, `refactor`). Subject only — no body, no `Co-Authored-By`.

## 5 — Push to base

This is outward-facing and lands on the shared base branch immediately — that is the point of the command, and the user opted in by running it.

```bash
git push <REMOTE> <BASE>
```

If the push is rejected (someone pushed in the meantime), `git pull --ff-only <REMOTE> <BASE>` and retry once. If it still fails, stop and report — do not force-push.

## 6 — Announce

Print a one-line receipt: *"Fast-shipped to `<BASE>`: `<commit-sha>` — `<n>` file(s) changed, pushed."* Done — there is no follow-up lifecycle.

## Rules

- Read `.claude/supera.json` first — never hardcode commands, branches, or remotes.
- **Small changes only.** No worktree, no PR, no ticket, no CI. Anything bigger than a quick fix belongs in `/ship`.
- **The guards are the gate.** On base + clean tree + fast-forwardable, or stop. Never auto-switch branches and never force-push.
- Always delegate the edit to `supera-engineer` — `fast-ship` orchestrates, it does not implement.
- This is the **only** skill permitted to commit directly to the base branch.
