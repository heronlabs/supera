# supera

![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)

**Repo-agnostic change-shipping toolkit for [Claude Code](https://claude.com/claude-code).** Isolated worktree environments, engineer-driven implementation, PR monitoring through merge + cleanup.

> **task → worktree → implement + test → verify → PR → monitor CI → merge → cleanup**

## Install

```text
/plugin marketplace add heronlabs/supera
/plugin install supera@supera-marketplace
```

## Quickstart

```bash
cd your-repo
```

```text
/start          # once per repo — detects stack, writes .claude/supera.json
/ship "add retry on timeout"   # creates worktree, implements, verifies
# review changes, commit, push, open PR
/pr-watch       # monitor CI, fix failures, address reviews, merge, cleanup
```

## Commands

| Command | What it does |
|---|---|
| `/start` | Bootstrap a repo — detect stack, write `.claude/supera.json`. Once per repo. |
| `/ship` | Implement a task in isolated worktree. Delegates to `supera-engineer`. Changes stay local — you review, commit, push, open PR. Idempotent. |
| `/pr-watch` | Monitor open PR — watch CI, fix failures, address reviews, merge when green, clean up worktree. |

## How it works

**`/ship`** creates a git worktree off the base branch, delegates implementation to `supera-engineer` (code + tests + self-verify), and leaves changes for review. Re-running in the same worktree continues where it left off.

**`/pr-watch`** watches an open PR: polls CI, delegates failures to the engineer, addresses review threads, syncs with base, merges when green, then removes the worktree and deletes the local branch.

**No state files.** Context comes from worktree + git branch + GitHub PR. No phase tracker, no labels, no bot markers.

## Configuration — `.claude/supera.json`

Written by `/start`. Safe to hand-edit.

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

| Key | Meaning |
|---|---|
| `baseBranch` | Branch worktrees branch off, PRs target. Default `main`. |
| `remote` | Git remote. Default `origin`. |
| `buildCommand` | Build / typecheck command. |
| `lintCommand` | Lint command. |
| `testCommands` | Test commands keyed by layer. `/start` only emits keys the repo has. |
| `mergeMethod` | `merge`, `squash`, or `rebase`. Default `squash`. |

## Requirements

- **[Claude Code](https://claude.com/claude-code)** with plugin support
- **`gh` CLI** installed and authenticated (`gh auth login`)
- Target repo with a GitHub remote

## Safety

- **Never commits to base.** Every change in a worktree, shipped via PR.
- **Self-verifies before handing back.** Engineer runs build → lint → test layers.
- **No secrets in worktrees.** `.supera/` is gitignored.

## License

[MIT](LICENSE) © Lucas Lacerda
