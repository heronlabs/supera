# 🦸 supera — Claude Code change-shipping toolkit

[![Claude Code plugin][plugin-badge]][plugin-url]
[![License: MIT][license-badge]][license-url]
[![Version][version-badge]][releases-url]

> **Claude Code plugin** for end-to-end change shipping — isolated worktrees, engineer-driven implementation, commit, push, PR creation, and automated CI monitoring until green. Merging stays manual. Zero manual steps from task to a green PR.

`/ship` creates a git worktree, delegates to `supera-engineer` (code + tests + self-verify), commits, pushes, opens the PR, and hands off to `/pr-watch`. `/pr-watch` monitors CI, fixes failures, addresses review comments, and reports when the PR is green and ready — it **never merges**. After you merge, it tears down the worktree. No state files, no labels, no bot markers — context comes from git + GitHub.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Commands](#commands)
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
/ship "add retry with exponential backoff on timeout" # worktree → implement → commit → push → PR → pr-watch
# pr-watch monitors CI, fixes failures, reports ready when green — you merge, it cleans up
```

## Commands

### /ship

```text
/ship "add retry with exponential backoff on timeout"
```

End-to-end automation from task to open PR. Creates an isolated git worktree off the base branch, installs dependencies, delegates implementation to `supera-engineer` (code + tests + self-verify). On verification pass: commits, pushes, opens a PR, and hands off to `pr-watch` for CI monitoring. On verification fail after 3 attempts: leaves changes for manual review.

Uses the repo's PR template if one exists, falls back to supera's own `.github/PULL_REQUEST_TEMPLATE.md` (bundled in the plugin) with Description, Motivation, Approach, Checklist, Evidence, Risk, and Post-merge sections.

**Idempotent.** Re-run in a dirty worktree picks up where the engineer left off. If the worktree already exists for the branch, it reuses it.

### /pr-watch

```text
/pr-watch         # detects PR from current branch
/pr-watch 42      # watch specific PR
/pr-watch --non-interactive  # headless mode — never prompts
```

Monitors an open PR until it is green and ready to merge. Polls CI — on failure, delegates to `supera-engineer` with the log, pushes the fix, and reschedules. Addresses actionable review comments. Syncs with base (rebase on conflict). When every check is green and all threads are resolved, announces ready and exits — **merging is always yours**. Re-run after merging to remove the worktree and delete the local branch.

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
| All green, all threads resolved | Announce ready, exit — user merges. |
| PR merged (by user) | Remove worktree, delete local branch. |

## Configuration

None. Supera is zero-config — everything is detected from the repo itself:

| Value | Detected from |
|---|---|
| Base branch | GitHub default branch (`gh repo view`), fallback `origin/HEAD`. |
| Remote | The sole git remote, or `origin` when several exist. |
| Build / lint commands | Declared scripts (`package.json`), `Makefile` targets, or CI workflows. |
| Test layers | Script names (`test:unit`, `test:integration`, `test:e2e`) or repo test setup. |

A repo with no build, lint, or tests just skips those gates.

## Architecture

Two skills orchestrate, one agent implements. Nothing repo-specific is hardcoded and no config file exists — commands, branches, and remotes are detected from the target repo.

```
skills/
  ship/SKILL.md         # orchestrate — worktree → engineer → verify → commit → push → PR → pr-watch
  pr-watch/SKILL.md     # monitor — CI → fix → review → report ready (never merges) → cleanup
agents/
  supera-engineer.md    # implement — orient → plan → code + tests → self-verify → receipt
schema/
  receipt.schema.json   # engineer → orchestrator JSON handoff (source of truth)
guidelines/
  commit-conventions.md # canonical commit format — referenced, never restated
.github/
  PULL_REQUEST_TEMPLATE.md # PR body template — fallback when user's repo has none
.claude-plugin/
  plugin.json           # manifest — CD bumps version on merge to main
  marketplace.json      # marketplace entry — CD keeps in sync
```

## How it works

**`/ship`** parses the task into a branch slug (`feat-add-retry`), creates a git worktree off the base branch (or detects it's already in one), installs dependencies, and dispatches `supera-engineer` with the task. The engineer writes a plan to `.supera/plan.md` (gitignored), implements code AND tests, runs build → lint → test layers in order, and returns a JSON receipt. If any gate fails, `/ship` loops back to the engineer with the failure output (max 3 attempts). On all gates passing: commits with a conventional-commit message, pushes the branch, opens a PR (using the repo's template or supera's fallback), and hands off to `pr-watch` for CI monitoring.

**`supera-engineer`** orients on the repo's own conventions (reads CLAUDE.md, existing code, test patterns), detects the repo's build/lint/test commands, writes a checkbox plan, implements with surgical edits (never rewrites whole files), and self-verifies: build → lint → test layers in order. Returns a receipt with `pass` / `fail` / `skipped` for each gate. Tool-agnostic — uses whatever the user has installed.

**`/pr-watch`** resolves the PR from args or current branch, polls CI via `gh pr view --json state,mergeable,statusCheckRollup`, classifies failures, delegates fixes to the engineer, addresses review threads, syncs with base, and announces ready when green — it never merges. Once the user has merged, a re-run cleans up the worktree + local branch. Uses `ScheduleWakeup` to wait between polls — never spin-loops.

## Safety

- **Never commits to base.** Every change in a worktree, committed on a feature branch, shipped via PR.
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

- **`/ship` goes end-to-end up to merge** — commits, pushes, opens a PR, and hands off to `pr-watch`. No manual steps between task and a green PR; merging is always yours.
- **`/pr-watch` needs an open PR.** `/ship` creates one automatically, or open one manually for existing branches.
- **`--non-interactive` mode** is for headless CI runs. At every decision point, instead of prompting it posts a blocking comment and exits.
- **Install commands** are detected from lockfiles (`pnpm install --frozen-lockfile`, `npm ci`, `yarn install --immutable`, `cargo fetch`). No hardcoded package manager.
- **CD releases on merge to `main`.** Don't hand-bump `version` — the CD workflow infers the bump from Conventional Commits in the merge commit.

## License

[MIT](LICENSE) © Lucas Lacerda

[plugin-badge]: https://img.shields.io/badge/Claude%20Code-plugin-d97757
[plugin-url]: https://claude.com/claude-code
[license-badge]: https://img.shields.io/badge/License-MIT-blue.svg
[license-url]: ./LICENSE
[version-badge]: https://img.shields.io/github/v/release/heronlabs/supera
[releases-url]: https://github.com/heronlabs/supera/releases
