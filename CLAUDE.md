# CLAUDE.md — supera plugin repo

This repo **is** a Claude Code plugin. It ships skills + agents that run in *other* repos. Editing here changes behaviour everywhere supera is installed — treat it as load-bearing.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). Bump `version` on every behavioural change. |
| `.claude-plugin/marketplace.json` | Marketplace entry so the plugin is installable via `/plugin`. Keep `version` in sync with `plugin.json`. |
| `skills/` | `supera-init`, `ship`, `fast-ship`, `pr-watch`, `refine-ticket` — each a `SKILL.md`. `ship` owns the full phase ladder (`fresh→scaffolded→building→built→pr-open→merged`), detected from git + ClickUp with no state file: re-run `/ship` to resume interrupted work or close out a merged PR, and `/ship pause` to checkpoint mid-flight. `fast-ship` is the no-worktree/no-PR/no-ticket fast path — it ships small changes straight to base and sits outside the ladder. |
| `agents/` | `supera-engineer` (the implementer), `supera-supply-chain-auditor`. |
| `schema/supera.schema.json` | The per-repo `.claude/supera.json` contract. **Source of truth** — update it before changing what skills read. |
| `examples/` | Sample `.claude/supera.json` files per stack. |
| `docs/` | **[`docs/README.md`](docs/README.md) is the index + single source of truth** for plan/spec status — read it first. `docs/specs/` = design records (what/why); `docs/plans/` = implementation plans (how). A feature pairs one spec + one plan; the index maps them and marks shipped/superseded/deferred. |

## Core invariants — do not break

- **Nothing repo-specific is hardcoded in a skill.** Commands, ClickUp list IDs, branches, remotes, and tags come from `.claude/supera.json` (read into `CONFIG` at the top of each skill). If you need a new repo-specific value, add it to `schema/supera.schema.json` first, then read it from `CONFIG`.
- **`supera-engineer` is the only implementer.** `/ship`, `/fast-ship`, and `/pr-watch` orchestrate and delegate; they never edit application code themselves. `nelson` is escalation-only for multi-component work.
- **Only `/fast-ship` may commit to base.** Every other skill works on a branch/worktree and ships via PR; `/fast-ship` is the single, deliberate exception for small changes — guarded by an on-base + clean-tree + fast-forward check, with the engineer's verify skipped for speed. No CI gate, so those guards are load-bearing.
- **One phase ladder, one owner.** The lifecycle (`fresh→scaffolded→building→built→pr-open→merged`) is derived from git + ClickUp — **no state file**. `/ship` owns the whole ladder and is idempotent: it resumes interrupted builds, opens the PR, and on a merged PR closes the ticket (status `closed`) + tears down the worktree. `/ship pause` writes the `wip:` checkpoint. `/pr-watch` drives the open PR green and hands merged PRs back to `/ship`. Status names are config-driven (`clickup.statuses` in the schema → `STATUS.<key>` in skills), never hardcoded.
- **Ticket-less is first-class.** Every ClickUp/timer step is guarded by `clickup.listId` being set. New steps that touch ClickUp must carry the same guard.
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
