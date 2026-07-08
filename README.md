# 🦸 supera — Claude Code change-shipping toolkit

[![Claude Code plugin][plugin-badge]][plugin-url]
[![License: MIT][license-badge]][license-url]
[![Version][version-badge]][releases-url]

> **Claude Code plugin** to ship changes across any repository — isolated worktree environments, engineer-driven implementation, PR monitoring through merge + cleanup.

The PR is the unit of work. `/ship` creates a git worktree, delegates to `supera-engineer` (code + tests + self-verify), and leaves changes for review. `/pr-watch` monitors CI, fixes failures, addresses review comments, merges when green, then tears down the worktree. No state files, no labels, no bot markers — context comes from git + GitHub.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Commands](#commands)
  - [/start](#start)
  - [/ship](#ship)
  - [/pr-watch](#pr-watch)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Safety](#safety)
- [Requirements](#requirements)
- [Notes](#notes)
- [License](#license)

## Install

```text
/plugin marketplace add heronlabs/supera
/plugin install supera@supera-marketplace
```

## Quickstart

```text
cd your-repo
/start                                               # once per repo — detects stack, writes config
/ship "add retry with exponential backoff on timeout" # creates worktree, implements, verifies
# review changes, commit, push, open PR
/pr-watch                                            # monitor CI → fix → merge → cleanup
```

## Commands

### /start

Bootstrap a repo for supera. Detects the toolchain (pnpm, npm, yarn, cargo, go), lifts build/test/lint commands from CI or `package.json` scripts, detects test layers (`unit`, `integration`, `e2e`), writes `.claude/supera.json`, and inserts guardrails into `CLAUDE.md`. Safe to re-run — existing config is shown before overwriting.

### /ship

```text
/ship "add retry with exponential backoff on timeout"
```

Creates an isolated git worktree off the base branch, installs dependencies, delegates implementation to `supera-engineer` (code + tests + self-verify), and leaves changes in the worktree for review. No push, no PR — you own the commit.

**Idempotent.** Re-run in a dirty worktree picks up where the engineer left off. If the worktree already exists for the branch, it reuses it.

### /pr-watch

```text
/pr-watch         # detects PR from current branch
/pr-watch 42      # watch specific PR
/pr-watch --non-interactive  # headless mode — never prompts
```

Monitors an open PR until merge. Polls CI — on failure, delegates to `supera-engineer` with the log, pushes the fix, and reschedules. Addresses actionable review comments. Syncs with base (rebase on conflict). Merges when every check is green and all threads are resolved. Removes the worktree and deletes the local branch after merge.

| Scenario | Behavior |
|---|---|
| CI running / queued | Wait 90 s, reschedule. |
| CI failed — code error | Delegate to `supera-engineer`, push fix, reschedule. |
| CI failed — lockfile drift | Run install, commit updated lockfile, push, reschedule. |
| CI failed — transient (network, OOM) | Re-run acceptable. |
| CI failed — unknown | Surface to user (non-interactive: post comment, exit). |
| Review — clear code request | Delegate to engineer, push, reply to thread. |
| Review — design question | Surface to user (non-interactive: post comment, exit). |
| Base diverged — conflict | Rebase, delegate conflicts to engineer, force-with-lease push. |
| All green, all threads resolved | Merge (user confirms in interactive mode). |
| PR merged | Remove worktree, delete local branch. |

## Configuration

`.claude/supera.json` — written by `/start`, read by every skill. Safe to hand-edit.

```jsonc
{
  "baseBranch": "main",
  "remote": "origin",
  "buildCommand": "pnpm build",
  "lintCommand": "pnpm lint",
  "testCommands": {
    "unit": "pnpm test:unit",
    "integration": "pnpm test:integration",
    "e2e": "pnpm test:e2e"
  },
  "mergeMethod": "squash"
}
```

| Key | Type | Description | Default |
|---|---|---|---|
| `baseBranch` | string | Branch worktrees branch off, PRs target. | `main` |
| `remote` | string | Git remote name. | `origin` |
| `buildCommand` | string | Shell command to build / typecheck. | — |
| `lintCommand` | string | Shell command to lint. | — |
| `testCommands` | object | Test commands keyed by layer. `/start` only emits keys the repo has. | `{}` |
| `mergeMethod` | string | PR merge method: `merge`, `squash`, or `rebase`. | `squash` |

Every key is optional — omit commands the repo doesn't have.

## Architecture

Three skills orchestrate, one agent implements. Nothing repo-specific is hardcoded — commands, branches, and remotes come from `.claude/supera.json`.

```
skills/
  start/SKILL.md        # bootstrap — detect stack, write config, insert guardrails
  ship/SKILL.md         # orchestrate — worktree → engineer → verify → done
  pr-watch/SKILL.md     # monitor — CI → fix → review → merge → cleanup
agents/
  supera-engineer.md    # implement — orient → plan → code + tests → self-verify → receipt
schema/
  supera.schema.json    # per-repo config contract (source of truth)
  receipt.schema.json   # engineer → orchestrator JSON handoff
guidelines/
  commit-conventions.md # canonical commit format — referenced, never restated
.claude-plugin/
  plugin.json           # manifest — CD bumps version on merge to main
  marketplace.json      # marketplace entry — CD keeps in sync
```

## How it works

**`/start`** inspects the repo root for marker files (`pnpm-lock.yaml`, `package-lock.json`, `Cargo.toml`, `go.mod`), identifies the package manager, lifts commands from CI workflows or declared scripts, detects test layers from script names, and writes `.claude/supera.json`. Also inserts a guardrails block into `CLAUDE.md` — idempotent via marker comments.

**`/ship`** parses the task into a branch slug (`feat-add-retry`), creates a git worktree off the base branch (or detects it's already in one), installs dependencies, and dispatches `supera-engineer` with the task + config path. The engineer writes a plan to `.supera/plan.md` (gitignored), implements code AND tests, runs build → lint → test layers in order, and returns a JSON receipt. If any gate fails, `/ship` loops back to the engineer with the failure output (max 3 attempts).

**`supera-engineer`** orients on the repo's own conventions (reads CLAUDE.md, existing code, test patterns), writes a checkbox plan, implements with surgical edits (never rewrites whole files), and self-verifies: `buildCommand` → `lintCommand` → `testCommands` in layer order. Returns a receipt with `pass` / `fail` / `skipped` for each gate. Tool-agnostic — uses whatever the user has installed.

**`/pr-watch`** resolves the PR from args or current branch, polls CI via `gh pr view --json state,mergeable,statusCheckRollup`, classifies failures, delegates fixes to the engineer, addresses review threads, syncs with base, merges when green, and cleans up the worktree + local branch. Uses `ScheduleWakeup` to wait between polls — never spin-loops.

## Safety

- **Never commits to base.** Every change in a worktree, shipped via PR.
- **Self-verifies before handing back.** Engineer runs build → lint → test layers.
- **Plans stay local.** `.supera/` is gitignored — plans never leak into commits.
- **No secrets in worktrees.** Worktrees are transient; `.worktrees/` is gitignored.
- **Force-with-lease only.** `/pr-watch` never runs bare `--force` — only `--force-with-lease` after rebase.
- **Idempotent by design.** Re-running `/ship` or `/pr-watch` picks up where it left off — no state files to corrupt.

## Requirements

- **[Claude Code](https://claude.com/claude-code)** with plugin support
- **`gh` CLI** installed and authenticated (`gh auth login`)
- Target repo with a GitHub remote

## Notes

- **`/ship` does not push or open a PR.** Changes stay in the worktree. You review, commit, push, and open the PR.
- **`/pr-watch` needs an open PR.** If no PR exists for the branch, open one first — supera doesn't create PRs.
- **`--non-interactive` mode** is for headless CI runs. At every decision point, instead of prompting it posts a blocking comment and exits.
- **Install commands** are detected from lockfiles (`pnpm install --frozen-lockfile`, `npm ci`, `yarn install --immutable`, `cargo fetch`). No hardcoded package manager.
- **CD releases on merge to `main`.** Don't hand-bump `version` — the CD workflow infers the bump from Conventional Commits in the merge commit.

## License

[MIT](LICENSE) © Lucas Lacerda

[plugin-badge]: https://img.shields.io/badge/Claude%20Code-plugin-d97757
[plugin-url]: https://claude.com/claude-code
[license-badge]: https://img.shields.io/badge/License-MIT-blue.svg
[license-url]: ./LICENSE
[version-badge]: https://img.shields.io/badge/version-1.0.3-44cc11
[releases-url]: https://github.com/heronlabs/supera/releases
