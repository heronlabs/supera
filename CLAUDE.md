# CLAUDE.md — supera plugin repo

This repo **is** a Claude Code plugin. It ships skills + agents that run in *other* repos. Editing here changes behaviour everywhere supera is installed — treat it as load-bearing.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). Bump `version` on every behavioural change. |
| `.claude-plugin/marketplace.json` | Marketplace entry so the plugin is installable via `/plugin`. Keep `version` in sync with `plugin.json`. |
| `skills/` | `supera-init`, `ship`, `pr-watch`, `refine-ticket`, `audit` — each a `SKILL.md`. `ship` owns the full phase ladder (`fresh→scaffolded→building→built→pr-open→merged`), detected from git + tracker with no state file: re-run `/ship` to resume interrupted work or close out a merged PR, and `/ship pause` to checkpoint mid-flight. `audit` is the standalone auditor orchestrator — it runs the enabled auditors against a branch via its own worktree/PR, decoupled from `/ship`; ticket-less, and CI-cron-ready via `--non-interactive`. |
| `agents/` | `supera-engineer` (the implementer), `supera-supply-chain-auditor`, `supera-freshness-auditor`. |
| `schema/` | `supera.schema.json` — the per-repo `.claude/supera.json` contract (**source of truth**, update before changing what skills read). `receipt.schema.json` — the `supera-engineer`→`ship`/`pr-watch` JSON receipt. `audit-receipt.schema.json` — the auditor receipt. |

## Core invariants — do not break

- **Nothing repo-specific is hardcoded in a skill.** Commands, the tracker board id, branches, remotes, the project tag, and the tracker tool-map come from `.claude/supera.json` (read into `CONFIG` at the top of each skill). Tracker work is expressed as neutral ops (`getTicket`, `setStatus`, …) resolved through `CONFIG.tracker.tools.<op>` — never a hardcoded provider tool name. If you need a new repo-specific value, add it to `schema/supera.schema.json` first, then read it from `CONFIG`.
- **`supera-engineer` is the only implementer.** `/ship` and `/pr-watch` orchestrate and delegate; they never edit application code themselves.
- **Nothing commits to base directly.** Every skill works on a branch/worktree and ships via PR — CI is the gate on every change. There is no direct-to-base fast path.
- **One phase ladder, one owner.** The lifecycle (`fresh→scaffolded→building→built→pr-open→merged`) is derived from git + tracker — **no state file**. `/ship` owns the whole ladder and is idempotent: it resumes interrupted builds, opens the PR, and on a merged PR closes the ticket (status `closed`) + tears down the worktree. `/ship pause` writes the `wip:` checkpoint. `/pr-watch` drives the open PR green and hands merged PRs back to `/ship`. Status names are config-driven (`tracker.statuses` in the schema → `STATUS.<key>` in skills), never hardcoded.
- **Ticket-less is first-class.** Every tracker/timer step is guarded by `tracker.board` being set. New steps that touch the tracker must carry the same guard.
- **CI is the quality gate.** The engineer self-verifies as pre-flight; orchestrators do not run a full build/test/lint before pushing.
- **Schema and skills stay in sync.** A field skills read must exist in the schema with a description and default.

## Conventions

- Skills are config-driven and self-contained — templates are inlined, not cross-referenced via fragile paths.
- Keep `version` in `plugin.json` and `marketplace.json` identical.
- Prefer adding a generalized agent here over copying a workloads-specific one — generalize across ecosystems (detect the manager, then act).

## Releasing a change

1. Edit the skill/agent/schema.
2. Bump `version` in both `plugin.json` and `marketplace.json`.
3. Commit. Consumers pick it up on next `/plugin update`.

<!-- supera:guardrails -->
## Working with this repo (managed by /supera-init — edits between these markers are overwritten on re-init)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file (`package.json`, lockfiles, manifests, CI yaml); preserve the rest. Never regenerate a whole file to add one line.
- **No scope creep.** Build only what was asked; no speculative abstractions, layers, or options. Prefer the simplest working solution.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, and env names can be literal values, not mappings (e.g. `environment: pulumi` may name a GitHub Environment literally called `pulumi`). State which reading you took.
- **Cross-repo changes: update all related repos** unless told otherwise.
- **CI/infra settings live outside code** — GitHub Environment and branch-protection rules are in repo settings, not the yaml.
- **Tracker board/list IDs come from the tracker's own hierarchy** (e.g. workspace → space → folder → list); never the workspace/team id.
<!-- /supera:guardrails -->
