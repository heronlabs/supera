# CLAUDE.md — supera plugin repo

This repo **is** a Claude Code plugin. It ships skills + an agent that run in *other* repos. Editing here changes behaviour everywhere supera is installed — treat it as load-bearing.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). CD bumps version on merge to main. |
| `.claude-plugin/marketplace.json` | Marketplace entry. CD keeps in sync with `plugin.json`. |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR body template in the plugin root — used as fallback when the user's repo has none. Sections: Description, Motivation, Approach, Checklist, Evidence, Risk, Post-merge. |
| `skills/` | `start`, `ship`, `pr-watch` — each a `SKILL.md`. `ship` creates worktrees, delegates to `supera-engineer`, commits, pushes, opens the PR, then hands off to `pr-watch`. `pr-watch` monitors CI, fixes failures, merges when green, cleans up. |
| `agents/` | `supera-engineer` — the single implementer. Writes code + tests in worktree, self-verifies, returns receipt. Never commits — the orchestrator owns the git lifecycle. |
| `schema/` | `supera.schema.json` — per-repo `.claude/supera.json` contract (**source of truth**). `receipt.schema.json` — engineer → orchestrator JSON handoff. |
| `guidelines/` | `commit-conventions.md` — canonical commit format. Skills and agents reference it; never restate. |

## Core invariants

- **Nothing repo-specific is hardcoded.** Commands, branches, and remotes come from `.claude/supera.json` (read into `CONFIG`). Add new values to `schema/supera.schema.json` first.
- **Skills orchestrate, agents implement.** `/ship` and `/pr-watch` route lifecycle and delegate all application code to `supera-engineer`. Guidelines are canonical — a rule in two documents is a defect.
- **Ship goes end-to-end.** Engineer writes code + tests → ship commits, pushes, opens PR, and hands off to `pr-watch` for CI monitoring. No manual steps between `/ship` and merge (unless verification fails after 3 attempts — then manual review required).
- **Nothing commits to base directly.** Every change via worktree/branch. Only `/ship` commits — on the feature branch. Engineers never commit.
- **PR is the ticket.** Git/GitHub-native — no external tracker. PR body uses the user's template if present, falls back to `.github/PULL_REQUEST_TEMPLATE.md`.
- **CI is the quality gate.** Engineer self-verifies as pre-flight before `/ship` will commit. `pr-watch` re-runs CI, fixes failures, and merges when green.
- **Schema and skills stay in sync.** A field skills read must exist in the schema.
- **No state files.** Context derived from worktree + git branch + GitHub PR. `/ship` re-run in worktree = continuation.

## Releasing

CD runs on merge to `main`: `heronlabs/action-tag-release-build@v5` bumps version from Conventional Commits, syncs `plugin.json` + `marketplace.json` (and creates `package.json` if absent), tags, releases. Consumers pick up on `/plugin update`.

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
