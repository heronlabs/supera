# supera

A repo-agnostic **change-shipping superagent** for Claude Code. Install once; ship changes on any repository with the same pattern — task → worktree → implement + test → PR → babysit CI → done. **The PR is the unit of work** — there is no external tracker.

The orchestration lives here. Anything repo-specific (build/test/lint commands, branch, remote) lives in a tiny per-repo `.claude/supera.json`, so the **same** skills work across pnpm, npm, cargo, Strapi, Go, Python, and more.

## What's inside

| Skill | What it does |
|---|---|
| `/supera-init` | Detect a repo's stack and write its `.claude/supera.json`. Run once per repo. |
| `/ship [task]` | Full lifecycle: task → worktree → delegate to `supera-engineer` → PR → hand off to `/pr-watch`; re-run to close out (worktree torn down on merge). Idempotent — also owns `pause`/resume. |
| `/refactor [path] [directive]` | Dispatch `supera-engineer` against existing code (whole repo, dir, or file). Lightweight — improves in place, no worktree/PR by default. Standalone, or mid-`/ship`. |
| `/pr-watch [PR#]` | Babysit a PR: monitor CI, fix failures, resolve review threads, one code-review cycle — exit when green, synced, resolved. |
| `/audit [branch]` | Run the enabled dependency auditors on a branch, carry their safe auto-fixes into a PR, hand off to `/pr-watch`. CI-cron-ready via `--non-interactive`. |

| Agent | Role |
|---|---|
| `supera-engineer` | **The problem-solver.** One strong agent that implements code **and** tests in the worktree, adapts to the repo's own conventions, and self-verifies before returning. Uses superpowers (TDD, systematic-debugging, verification). Replaces all per-stack scribes. |
| `supera-supply-chain-auditor` | Cross-ecosystem supply-chain audit (npm/pnpm/yarn/cargo): CVEs, missing/stale overrides, typo-squats, provenance gaps, leaked secrets. Report-only + safe CVE overrides. |
| `supera-freshness-auditor` | Cross-ecosystem dependency **currency** (not security): direct deps behind their latest in-range version, version drift across workspace members. Report-only + safe in-range bumps. Gated by `audits.freshness`. |

## How it's organized

Three layers, one rule — **single source of truth**:

- **Skills orchestrate** (`/ship`, `/pr-watch`, `/refactor`, `/audit`, `/supera-init`) — lifecycle, phase routing, PR mechanics. They delegate; they don't implement.
- **Agents implement** (`supera-engineer`, the two auditors) — the engineer writes code and tests; the auditors analyse and apply bounded fixes. They own the *how*.
- **Shared guidelines are canonical** (`guidelines/`) — cross-cutting conventions (commit hygiene, auditor mechanics) live once and are referenced, never restated.

## Install

```bash
# add this repo as a plugin marketplace, then install the plugin
/plugin marketplace add heronlabs/supera
/plugin install supera@supera-marketplace
```
(Or point your marketplace at the local path while developing.)

## Use it on a repo

```bash
cd ~/Workfolder/heronlabs/<any-repo>
/supera-init                 # one time — detects stack, writes .claude/supera.json
/ship "add retry on timeout" # ship from a task description
```

Commit `.claude/supera.json` so the config travels with the repo.

## Per-repo config

`.claude/supera.json` — see `schema/supera.schema.json` for the full contract. Minimal:

```jsonc
{
  "stack": "cargo",
  "verify": {
    "install": "cargo fetch",
    "build": "cargo build --workspace",
    "test": "cargo test --workspace",
    "lint": "cargo clippy -- -D warnings"
  },
  "worktree": { "dir": ".worktrees", "base": "main" },
  "pr": { "base": "main", "remote": "origin" },
  "audits": { "supplyChain": true }
}
```

The PR is the unit of work — `/ship` and `/pr-watch` operate purely on git + GitHub. Time spent is derived from git (first commit → merge).

## Prerequisites

- **`gh` CLI** installed + authenticated (`gh auth login`) — all GitHub work goes through the CLI.
- **superpowers** plugin (optional) — when present, the engineer uses its TDD / debugging / verification skills; without it, the engineer applies the same discipline inline.
