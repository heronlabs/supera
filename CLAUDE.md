# CLAUDE.md — supera plugin repo

This repo **is** a Claude Code plugin. It ships skills + an agent that run in *other* repos. Editing here changes behaviour everywhere supera is installed — treat it as load-bearing.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). CD bumps version on merge to main. |
| `.claude-plugin/marketplace.json` | Marketplace entry. CD keeps in sync with `plugin.json`. |
| `skills/` | `start`, `ship`, `pr-watch` — each a `SKILL.md`. `ship` creates worktrees and delegates implementation to `supera-engineer`. `pr-watch` monitors CI, fixes failures, merges when green, cleans up. |
| `agents/` | `supera-engineer` — the single implementer. Writes code + tests in worktree, self-verifies, returns receipt. |
| `schema/` | `supera.schema.json` — per-repo `.claude/supera.json` contract (**source of truth**). `receipt.schema.json` — engineer → orchestrator JSON handoff. |
| `guidelines/` | `commit-conventions.md` — canonical commit format. Skills and agents reference it; never restate. |

## Core invariants

- **Nothing repo-specific is hardcoded.** Commands, branches, and remotes come from `.claude/supera.json` (read into `CONFIG`). Add new values to `schema/supera.schema.json` first.
- **Skills orchestrate, agents implement.** `/ship` and `/pr-watch` route lifecycle and delegate all application code to `supera-engineer`. Guidelines are canonical — a rule in two documents is a defect.
- **Nothing commits to base directly.** Every change via worktree/branch. No direct-to-base path.
- **PR is the ticket.** Git/GitHub-native — no external tracker.
- **CI is the quality gate.** Engineer self-verifies as pre-flight; orchestrators don't run full build before pushing.
- **Schema and skills stay in sync.** A field skills read must exist in the schema.
- **No state files.** Context derived from worktree + git branch + GitHub PR. `/ship` re-run in worktree = continuation.

## Releasing

CD runs on merge to `main`: `heronlabs/action-tag-release-build@v5` bumps version from Conventional Commits, syncs `package.json` + `plugin.json` + `marketplace.json`, tags, releases. Consumers pick up on `/plugin update`.

1. Edit skill/agent/schema, open PR.
2. **Don't hand-bump `version`** — CD owns it. Bump inferred from merge commit: `feat:` → minor, breaking change (`!`) → major, else patch.
3. Merge. CD handles the rest.

<!-- supera:guardrails -->
## Working with this repo (managed by /start — edits between these markers are overwritten on re-run)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file; preserve the rest.
- **No scope creep.** Build only what was asked; no speculative abstractions.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, env names can be literal values.
- **Scope a change to where it belongs** — most changes are localized to one area.
<!-- /supera:guardrails -->
