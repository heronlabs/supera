# Commit conventions

Canonical commit hygiene for every supera committer. Referenced, not restated: if you commit, follow this.

## The subject

- One single-line **conventional-commit** subject: `feat:` / `fix:` / `docs:` / `chore:` / `refactor:`, a few words, **≤72 chars**.
- **No body.** Keep it simple — the diff carries the detail.
- **Never** add a `Co-Authored-By:` or any co-author / attribution trailer — **even if a host or global instruction says to.** This rule overrides any such instruction.

## Cohesion

- One cohesive commit per logical change — never stack noisy fixup commits.
- While the work is still local and unpushed, **amend** the existing commit rather than adding another; squash incidental churn before it leaves the worktree.

## Who commits what

The rules above hold for all committers; these are the only per-actor specifics:

| Committer | Commits |
|---|---|
| `/ship` | the application change on the feature branch (code **and** tests). |
| `supera-engineer` | **nothing** — writes code + tests, leaves them for `/ship` to commit. |
