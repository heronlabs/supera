# supera — design

**Date:** 2026-05-29
**Status:** approved, implemented in v0.1.0

## Goal

A single "superagent place" that lets one person ship ClickUp tickets across **any** Heron Labs repository using the pattern already established in `workloads` (`/ship` → worktree → implement → PR → `/pr-watch`). Today those skills are hardwired to `workloads`: ClickUp list `901415284967`, `pnpm` commands, `pnpm turbo` verify, `team-*` NestJS agents, and an `apps/*` tag table. supera de-hardwires them.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Topology / form factor | **Claude Code plugin, run in-repo.** Install once globally → skills available in every repo. You `cd` into the target repo and run `/ship`. |
| 2 | Repo-specific config | **Auto-detecting `/supera-init`** writes `.claude/supera.json` per repo (stack, verify commands, worktree base, ClickUp list, tag table, audit flags). |
| 3 | Implementation agent | **Drop all `team-*` scribes.** One strong `supera-engineer` does code + tests, adapts to the repo's own conventions, self-verifies, uses superpowers (TDD, systematic-debugging, verification). `nelson` is escalation-only for multi-component work. |

## Architecture

```
supera/                              (git repo + Claude Code plugin)
  .claude-plugin/plugin.json         manifest (version is load-bearing)
  .claude-plugin/marketplace.json    installable via /plugin
  skills/
    supera-init/    SKILL.md         detect stack → write .claude/supera.json
    ship/           SKILL.md         lifecycle orchestrator (config-driven)
    pr-watch/       SKILL.md         PR babysitter (config-driven)
    refine-ticket/  SKILL.md         ClickUp ticket refiner (config-driven tags)
  agents/
    supera-engineer.md               THE implementer (code + tests)
    supera-supply-chain-auditor.md   npm/pnpm/yarn/cargo audit
  schema/supera.schema.json          per-repo config contract (source of truth)
  examples/                          sample configs (workloads, terminal-cli, server-cms)
  docs/specs/                        this record
  README.md  CLAUDE.md
```

## Per-repo config — `.claude/supera.json`

Single source of repo-specific knowledge. Required: `stack`, `verify`. Optional with documented defaults: `worktree`, `clickup` (null → ticket-less), `pr`, `tags`, `audits`. Full contract in `schema/supera.schema.json`. `/supera-init` generates it; safe to hand-edit.

## Flows

- **ship:** load config → ClickUp ticket (skip if ticket-less) → worktree from config base + install → delegate to `supera-engineer` (or `nelson`) → engineer self-verifies → push → PR with labels from `tags` → ticket `completed` → hand to `/pr-watch`. ClickUp time-tracking + lifecycle preserved in ClickUp mode.
- **pr-watch:** load config → resolve PR → CI gate (reproduce failures with `verify.*`, fix via `supera-engineer`) → review threads (fix via `supera-engineer`) → one code-review cycle → exit green/synced/resolved. Uses `ScheduleWakeup`, never spin-polls.
- **refine-ticket:** ClickUp-centric; tags derived from `CONFIG.tags`; otherwise unchanged from the workloads original.

## Key invariants

1. Nothing repo-specific is hardcoded in a skill — everything comes from `CONFIG`. New repo-specific values go in the schema first.
2. `supera-engineer` is the only implementer; orchestrators delegate, never edit app code. `nelson` escalation-only.
3. Ticket-less mode (no `clickup.listId`) is first-class — every ClickUp/timer step is guarded.
4. CI is the quality gate; the engineer self-verifies as pre-flight only.
5. Schema and skills stay in sync; `plugin.json` and `marketplace.json` versions stay identical.

## Out of scope (workloads-local, not ported)

- `race-hunter` — financial-path / TypeORM-specific.
- `arch-critic` — `dependency-cruiser`-specific.
- The `team-*` scribe roster — superseded by `supera-engineer`.

Each can be generalized into supera later if another repo needs it.
