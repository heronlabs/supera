---
name: refactor
description: "Improve existing code in place — dispatch supera-engineer to refactor a repo, directory, or file against an optional directive (rename for clarity, extract duplication, simplify, split a large file). Lightweight: no worktree, no PR, no commit — it leaves the changes in your working tree to review, then you commit, or run /start for a PR. Standalone, or applied mid-/start by the engineer for a pointed cleanup. Triggers: 'refactor', 'clean up this code', 'rename these', 'extract this', 'simplify'."
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Improve **existing** code without changing what it does — the pointed, in-place counterpart to `/start`. `/refactor` scopes a behaviour-preserving cleanup and hands it to `supera-engineer` (the sole implementer, which already carries the code-quality philosophy and the deny-path gate). It adds **no** new rules — it is a new front door to the engineer.

Lightweight by default: **no worktree, no PR, no commit.** The engineer edits in your current working tree and self-verifies; you review the diff locally, then commit yourself — or run `/start` when you want the full worktree → PR → CI lifecycle.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG` (for `verify.*` and `security.denyPaths`). If absent, the engineer still self-verifies against whatever the repo provides — tell the user once that supera isn't initialised here.

## 1 — Parse arguments

`/refactor [path] [directive]`:
- **path** — the scope: the repo root (default), a directory, or a single file. Resolve it to a concrete set of files.
- **directive** — optional free-text intent, e.g. *"give these functions meaningful names"*, *"extract the duplicated validation"*, *"split this 300-line file by responsibility"*. Absent → apply the engineer's code-quality philosophy generally (names, dead code, oversized functions, comment rot) within the scope.

If `path` is empty and the intent is unclear, ask what to refactor and where — don't guess a repo-wide rewrite.

## 2 — Scope and restate

State the blast radius in one line before dispatching — *"Refactoring `src/auth/` for clearer names; behaviour unchanged, tests must stay green."* This is a **behaviour-preserving** change: no feature work, no change to public contracts callers depend on, no scope creep beyond `path`.

## 3 — Delegate to supera-engineer

Dispatch `supera-engineer` with:
- the **task**: *"Refactor `<path>` — `<directive, or 'improve clarity per your code-quality philosophy'>`. Behaviour-preserving: the existing tests must still pass unchanged; do not alter observable behaviour or public contracts. Smallest viable change, in scope only."*
- the **worktree path**: the **repo root** — work in place, **do not create a worktree**.
- the path to `.claude/supera.json`.
- explicit: **do not commit** — leave the changes in the working tree for the user to review.

The engineer self-verifies (`verify.build` / `test` / `lint`) before returning — a refactor must keep every check green, since there is no CI gate on this path. Wait for its JSON receipt (`schema/receipt.schema.json`).

## 4 — Report

Surface `receipt.implemented`, the changed `files`, and the `verification` results, then:
> "Refactored `<path>` — behaviour unchanged, checks green. Review the diff, then commit — or run `/start` to take it through a PR."

If `receipt.status` is `needs-review` or `blocked`, surface the detail and **do not** present the refactor as clean.

## Mid-start use

When `supera-engineer` is mid-`/start` and hits existing code that must be cleaned up before the feature work can continue, it performs that cleanup as a **bounded, behaviour-preserving refactor under this skill's discipline** — scoped to the blast radius, kept as its own logical commit, verified green — then resumes the feature. It does **not** spawn a second engineer; it is already the implementer.

## Rules

- Behaviour-preserving only — no feature change, no public-contract change; the existing tests must pass unchanged (that is the proof the refactor is safe).
- Scope to `path` — never widen into a repo-wide rewrite the user didn't ask for.
- Lightweight: no worktree, no PR, no commit — `/refactor` leaves the working tree modified for the user to review; route through `/start` for the full lifecycle.
- The engineer is the only implementer and carries every guideline (code quality, deny-path gate, `guidelines/commit-conventions.md` when it does commit) — `/refactor` adds no rules of its own.
