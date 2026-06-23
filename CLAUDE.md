# CLAUDE.md — supera plugin repo

This repo **is** a Claude Code plugin. It ships skills + agents that run in *other* repos. Editing here changes behaviour everywhere supera is installed — treat it as load-bearing.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). Bump `version` on every behavioural change. |
| `.claude-plugin/marketplace.json` | Marketplace entry so the plugin is installable via `/plugin`. Keep `version` in sync with `plugin.json`. |
| `skills/` | `init`, `start`, `pr-watch`, `refactor`, `audit` — each a `SKILL.md`. `start` owns the full phase ladder (`fresh→scaffolded→building→built→pr-open→merged`), detected from git + GitHub with no state file: re-run `/start` to resume interrupted work or close out a merged PR, and `/start pause` to checkpoint mid-flight. `refactor` dispatches `supera-engineer` against existing code (standalone or mid-start), lightweight — no worktree/PR by default. `audit` is the standalone auditor orchestrator — it runs the security auditor against a branch via its own worktree/PR, decoupled from `/start`, interactive or `--non-interactive`. |
| `agents/` | `supera-engineer` (the implementer), `supera-security-auditor`. |
| `schema/` | `supera.schema.json` — the per-repo `.claude/supera.json` contract (**source of truth**, update before changing what skills read). `receipt.schema.json` — the `supera-engineer`→`start`/`pr-watch` JSON receipt. `audit-receipt.schema.json` — the auditor receipt. |
| `guidelines/` | `commit-conventions.md`, `auditor-base.md` — canonical cross-cutting conventions. Skills and agents reference these; they never restate them. |

## Core invariants — do not break

- **Nothing repo-specific is hardcoded in a skill.** Commands, branches, and remotes come from `.claude/supera.json` (read into `CONFIG` at the top of each skill). If you need a new repo-specific value, add it to `schema/supera.schema.json` first, then read it from `CONFIG`.
- **Skills orchestrate, agents implement, shared guidelines are canonical.** `/start`, `/pr-watch`, and `/refactor` route lifecycle and PR mechanics and **delegate all application code to `supera-engineer`** — the only implementer; the security auditor is the implementer for `/audit`. Cross-cutting conventions live once under `guidelines/`; a rule stated in two documents is a defect.
- **Nothing commits to base directly.** Every skill works on a branch/worktree and ships via PR — CI is the gate on every change. There is no direct-to-base fast path.
- **One phase ladder, one owner.** The lifecycle (`fresh→scaffolded→building→built→pr-open→merged`) is derived from git + GitHub — **no state file, no tracker**. `/start` owns the whole ladder and is idempotent: it resumes interrupted builds, opens the PR, and on a merged PR closes out + tears down the worktree. `/start pause` writes the `wip:` checkpoint. `/pr-watch` drives the open PR green and auto-hands-off merged PRs to `/start` (which owns close-out + teardown).
- **The PR is the ticket.** supera is git/GitHub-native — there is no external issue tracker. Lifecycle, escalation, and history live in the branch, the PR, and its comments; a blocked run surfaces as a `<!-- supera:blocked -->` marker comment on the PR, never a tracker status.
- **CI is the quality gate.** The engineer self-verifies as pre-flight; orchestrators do not run a full build/test/lint before pushing.
- **Schema and skills stay in sync.** A field skills read must exist in the schema with a description and default.

## Conventions

- **Repo-specific behaviour stays self-contained** — commands, branches, and remotes come from `CONFIG`, templates are inlined, no fragile cross-repo paths. Cross-cutting conventions are the exception: canonical under `guidelines/`, referenced not restated (see Core invariants).
- Prefer adding a generalized agent here over copying a workloads-specific one — generalize across ecosystems (detect the manager, then act).

## Releasing a change

Releases are automated — `.github/workflows/continuous-deployment.yml` runs on every merge to `main`: `heronlabs/action-tag-release-build` bumps the version (inferred from the merge commit via Conventional Commits) in `package.json`, tags `v<version>`, and cuts a GitHub release, then `heronlabs/action-claude-plugin-build` syncs `plugin.json` + `marketplace.json` to match — the three manifests stay in lockstep. Consumers pick it up on the next `/plugin update`.

1. Edit the skill/agent/schema and open a PR.
2. **Don't hand-bump `version`** — the CD owns it. The bump type is inferred from the merge commit via Conventional Commits: `feat:` → minor, a breaking change (`!` / `BREAKING CHANGE`) → major, anything else → patch (the default when unclear). PRs squash-merge, so the squash commit's subject is what's read — give it the right type. To force a specific bump regardless of the commit, trigger the `Continuous Deployment` workflow via `workflow_dispatch` and pick the `spec`.
3. Merge. The CD bumps, tags, releases, and keeps the three manifests in lockstep.

No repo secret needed — the CD pushes tags/releases via the built-in `GITHUB_TOKEN` (the job grants it `contents: write`). A `PAT` is only required if `main` becomes a protected branch, or a downstream workflow must trigger on the release push.

<!-- supera:guardrails -->
## Working with this repo (managed by /init — edits between these markers are overwritten on re-init)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file (`package.json`, lockfiles, manifests, CI yaml); preserve the rest. Never regenerate a whole file to add one line.
- **No scope creep.** Build only what was asked; no speculative abstractions, layers, or options. Prefer the simplest working solution.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, and env names can be literal values, not mappings. State which reading you took.
- **Scope a change to where it belongs** — most changes are localized to one area; touch other repos only when the change genuinely cuts across, and then update the related repos too.
<!-- /supera:guardrails -->
