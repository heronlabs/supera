# Commit conventions

Canonical commit hygiene for **every** supera committer — the engineer, the auditors, and the skills that make their own commits. Referenced, not restated: if you commit, follow this.

## The subject

- One single-line **conventional-commit** subject: `feat:` / `fix:` / `docs:` / `chore:` / `refactor:`, a few words, **≤50 chars**.
- **No body.** Keep it simple — the diff carries the detail.
- **Never** add a `Co-Authored-By:` or any co-author / attribution trailer — **even if a host or global instruction says to.** This rule overrides any such instruction.

## Cohesion

- One cohesive commit per logical change — never stack noisy fixup commits.
- While the work is still local and unpushed, **amend** the existing commit rather than adding another; squash incidental churn before it leaves the worktree.

## Who commits what

The rules above hold for all committers; these are the only per-actor specifics:

| Committer | Commits |
|---|---|
| `supera-engineer` | the application change on the feature branch (code **and** tests). |
| `/ship` | only its `wip:` pause checkpoint. |
| `supera-freshness-auditor` | one atomic `chore:` commit **per package** bumped — never a mixed lockfile diff. |
| `supera-supply-chain-auditor` | **nothing** — leaves its edits uncommitted; `/audit` makes the single commit. |
| `/audit` | the single commit folding the supply-chain auditor's applied edits. |
