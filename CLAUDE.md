# CLAUDE.md — supera plugin repo

This repo **is** a Claude Code plugin. It ships skills + an agent that run in *other* repos. Editing here changes behaviour everywhere supera is installed — treat it as load-bearing.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). CD bumps version on merge to main. |
| `.claude-plugin/marketplace.json` | Marketplace entry. CD keeps in sync with `plugin.json`. |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR body template in the plugin root — used as fallback when the user's repo has none. Sections: Description, Motivation, Approach, Checklist, Evidence, Risk, Post-merge. |
| `.github/workflows/` | `continuous-integration.yml` — PR CI, `make lint` + `make test` on GitHub-hosted `ubuntu-24.04`. `continuous-deployment.yml` — release on merge to main. |
| `skills/` | `ship`, `pr-watch` — each a `SKILL.md`. `ship` creates worktrees, delegates to `supera-engineer`, commits, pushes, opens the PR, then hands off to `pr-watch`. `pr-watch` monitors CI, fixes failures, reports ready when green — **never merges**; cleans up after the user merges. Each skill's deterministic git steps live in `skills/<skill>/scripts/`, called as `${CLAUDE_SKILL_DIR}/scripts/<name>.sh` — SKILL.md says *what* to run and the contract (args → output/exit code), the script holds *how*. |
| `scripts/` | Scripts shared by the skills and the agent — `changed-files.sh` (changed paths incl. untracked, minus `.supera/`), `deadline.sh` (sleeps, then prints `ENGINEER_DEADLINE` — the engineer deadline the skills launch in the background). Called as `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh`. Scripts take every input as an argument: shell state doesn't persist between Bash calls. |
| `agents/` | `supera-engineer` — the single implementer. Writes code + tests in worktree, self-verifies, returns receipt. Never commits — the orchestrator owns the git lifecycle. |
| `tests/` | bats — one file per script group, run against throwaway git repos (bare remote + clone + linked worktrees + squash merges); `git-fixtures.bash` holds the shared setup. `repo-integrity.bats` checks that every `${CLAUDE_SKILL_DIR}`/`${CLAUDE_PLUGIN_ROOT}` path exists (scripts executable) and that no SKILL.md or agent contains a `$<digit>` token — Claude Code replaces those with skill arguments. |
| `Makefile` | `make lint` — shellcheck on every script and test, `jq empty` on the schema, strict-YAML parse of every SKILL.md/agent frontmatter. `make test` — bats. |
| `schema/` | `receipt.schema.json` — engineer → orchestrator JSON handoff (**source of truth**). |
| `hooks/` | `hooks.json` registers `validate-receipt.sh` on `SubagentStop` for `supera-engineer` — validates the receipt in the agent's final message against `schema/receipt.schema.json`; when missing or invalid, blocks the stop once so the engineer returns a corrected receipt (one retry). |
| `guidelines/` | `commit-conventions.md` — canonical commit format. `delegation.md` — how skills dispatch `supera-engineer`, bound it with a deadline, verify its receipt, and where their own direct fixes stop. Skills and agents reference them; never restate. |

## Core invariants

- **Nothing repo-specific is hardcoded, and no config file exists.** Commands, branches, and remotes are detected from the target repo itself (declared scripts, Makefile, CI workflows, git remotes, GitHub default branch).
- **Skills orchestrate, agents implement.** `/ship` and `/pr-watch` route lifecycle and delegate application code to `supera-engineer`; what they fix directly is bounded by `guidelines/delegation.md`. Guidelines are canonical — a rule in two documents is a defect.
- **Ship goes end-to-end up to merge.** Engineer writes code + tests → ship commits, pushes, opens PR, and hands off to `pr-watch` for CI monitoring. No manual steps between `/ship` and a green PR (unless verification fails after 3 attempts — then manual review required). **Merging is always the user's action.**
- **Nothing commits to base directly.** Every change via worktree/branch. Only `/ship` commits — on the feature branch. Engineers never commit.
- **PR is the ticket.** Git/GitHub-native — no external tracker. PR body uses the user's template if present, falls back to `.github/PULL_REQUEST_TEMPLATE.md`.
- **CI is the quality gate.** Engineer self-verifies as pre-flight before `/ship` will commit. `pr-watch` re-runs CI, fixes failures, and reports ready when green — the user merges.
- **Receipt schema and skills stay in sync.** A receipt field skills read must exist in `schema/receipt.schema.json`.
- **No state files.** Context derived from worktree + git branch + GitHub PR. `/ship` re-run in worktree = continuation.

## Agent delegation rules

How `/ship` and `/pr-watch` dispatch `supera-engineer` (dispatch form, agent id), bound it with a deadline, verify its receipt against the actual changes and the plan, handle an empty diff, and where their own direct fixes stop is defined once in `guidelines/delegation.md`. Follow it whenever you delegate — in this repo too.

## Releasing

CD runs on merge to `main`: `heronlabs/action-tag-release-build@v7` bumps version from Conventional Commits, syncs `plugin.json` + `marketplace.json` (and creates `package.json` if absent), tags, releases. Consumers pick up on `/plugin update`.

1. Edit skill/agent/schema, open PR.
2. **Don't hand-bump `version`** — CD owns it. Bump inferred from merge commit: `feat:` → minor, breaking change (`!`) → major, else patch.
3. Merge. CD handles the rest.

<!-- supera:guardrails -->
## Working with this repo

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file; preserve the rest.
- **No scope creep.** Build only what was asked; no speculative abstractions.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, env names can be literal values.
- **Scope a change to where it belongs** — most changes are localized to one area.
<!-- /supera:guardrails -->
