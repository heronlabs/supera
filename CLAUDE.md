# CLAUDE.md — supera plugin repo

This repo **is** a Claude Code plugin. It ships skills + an agent that run in *other* repos. Editing here changes behaviour everywhere supera is installed — treat it as load-bearing.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). CD bumps version on merge to main. |
| `.claude-plugin/marketplace.json` | Marketplace entry. CD keeps in sync with `plugin.json`. |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR body template in the plugin root — used as fallback when the user's repo has none. Sections: Description, Motivation, Approach, Checklist, Evidence, Risk, Post-merge. |
| `skills/` | `ship`, `pr-watch` — each a `SKILL.md`. `ship` creates worktrees, delegates to `supera-engineer`, commits, pushes, opens the PR, then hands off to `pr-watch`. `pr-watch` monitors CI, fixes failures, reports ready when green — **never merges**; cleans up after the user merges. |
| `agents/` | `supera-engineer` — the single implementer. Writes code + tests in worktree, self-verifies, returns receipt. Never commits — the orchestrator owns the git lifecycle. |
| `schema/` | `receipt.schema.json` — engineer → orchestrator JSON handoff (**source of truth**). |
| `guidelines/` | `commit-conventions.md` — canonical commit format. Skills and agents reference it; never restate. |

## Core invariants

- **Nothing repo-specific is hardcoded, and no config file exists.** Commands, branches, and remotes are detected from the target repo itself (declared scripts, Makefile, CI workflows, git remotes, GitHub default branch).
- **Skills orchestrate, agents implement.** `/ship` and `/pr-watch` route lifecycle and delegate all application code to `supera-engineer`. Guidelines are canonical — a rule in two documents is a defect.
- **Ship goes end-to-end up to merge.** Engineer writes code + tests → ship commits, pushes, opens PR, and hands off to `pr-watch` for CI monitoring. No manual steps between `/ship` and a green PR (unless verification fails after 3 attempts — then manual review required). **Merging is always the user's action.**
- **Nothing commits to base directly.** Every change via worktree/branch. Only `/ship` commits — on the feature branch. Engineers never commit.
- **PR is the ticket.** Git/GitHub-native — no external tracker. PR body uses the user's template if present, falls back to `.github/PULL_REQUEST_TEMPLATE.md`.
- **CI is the quality gate.** Engineer self-verifies as pre-flight before `/ship` will commit. `pr-watch` re-runs CI, fixes failures, and reports ready when green — the user merges.
- **Receipt schema and skills stay in sync.** A receipt field skills read must exist in `schema/receipt.schema.json`.
- **No state files.** Context derived from worktree + git branch + GitHub PR. `/ship` re-run in worktree = continuation.

## Agent delegation rules

- **Verify agent output before trusting it.** After any subagent (especially `supera-engineer`) returns, run `git diff --stat` to confirm changes were actually made. If the agent reports completion but no diff exists, apply the edits directly — do not re-delegate. The report's #1 friction: agents claiming completion with zero changes.
- **Confirm worktree context before edits.** Run `pwd` and verify you're in the intended worktree (`.worktrees/<branch>`) before any Edit or Write operation. Editing the main repo instead of the worktree is a silent defect that requires reverts.
- **Engineer receipt is a claim, not a fact.** Cross-check `receipt.filesChanged` against `git diff --name-only`. An empty or mismatched receipt means the engineer idled — treat as verification failure, loop back.
- **Pre-flight before push.** Run the detected build and lint commands in the worktree before pushing. Don't rely solely on the engineer's self-reported verification — 27 incidents of buggy code in the report came from pushing without local validation.
- **Delegation uses the current worktree.** Never pass `isolation: "worktree"` when dispatching an agent that should work in the ship/pr-watch worktree. Ship already owns the worktree — isolation creates a separate one where changes are invisible to the commit step.

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
