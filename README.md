# supera

A repo-agnostic **ticket-shipping superagent** for Claude Code. Install once; ship tickets on any repository with the same pattern — ClickUp ticket → worktree → implement + test → PR → babysit CI → done.

The orchestration lives here. Anything repo-specific (build/test/lint commands, ClickUp list, branch, project tag) lives in a tiny per-repo `.claude/supera.json`, so the **same** skills work across pnpm, npm, cargo, Strapi, Go, Python, and more.

## What's inside

| Skill | What it does |
|---|---|
| `/supera-init` | Detect a repo's stack and write its `.claude/supera.json`. Run once per repo. |
| `/ship [task or ticket ID]` | Full lifecycle: ClickUp ticket → worktree → delegate to `supera-engineer` → PR → ticket in review → hand off to `/pr-watch`; re-run to close out (ticket → closed, worktree torn down). Idempotent — also owns `pause`/resume. || `/refine-ticket [ticket ID]` | Reformat a draft ClickUp ticket to the concise template; fill project tag/priority/due date and set it `ready`. |
| `/pr-watch [PR#]` | Babysit a PR: monitor CI, fix failures, resolve review threads, one code-review cycle — exit when green, synced, resolved. |

| Agent | Role |
|---|---|
| `supera-engineer` | **The problem-solver.** One strong agent that implements code **and** tests in the worktree, adapts to the repo's own conventions, and self-verifies before returning. Uses superpowers (TDD, systematic-debugging, verification). Replaces all per-stack scribes. |
| `supera-supply-chain-auditor` | Cross-ecosystem supply-chain audit (npm/pnpm/yarn/cargo): CVEs, freshness, drift, typo-squats, leaked secrets. Report-only + safe CVE overrides. |

For genuinely multi-component tickets, `/ship` escalates to **`nelson`** for parallel fan-out; solo `supera-engineer` is the default.

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
/ship 86abc123               # ship a ClickUp ticket, or:
/ship "add retry on timeout" # ship from a free-text task
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
  "clickup": { "listId": "901415284967" },   // null → run ticket-less (git + GitHub only)
  "pr": { "base": "main", "remote": "origin" },
  "tags": { "crates/cli/**": "cli" },
  "audits": { "supplyChain": true }
}
```

Set `clickup` to `null` to run **ticket-less** — `/ship` and `/pr-watch` then skip all ClickUp status updates and operate purely on git + GitHub. Time spent is derived from git (first commit → merge), not a time-tracking API.

## Prerequisites

- **ClickUp MCP** configured globally with a valid API token (only needed for ClickUp mode).
- **GitHub MCP** authenticated, and **`gh` CLI** installed + authenticated (`gh auth login`).
- **superpowers** plugin (optional) — when present, the engineer uses its TDD / debugging / verification skills; without it, the engineer applies the same discipline inline.
- **nelson** plugin (only for multi-component escalation).

## Not ported (workloads-local)

`race-hunter` (financial-path / TypeORM-specific) and `arch-critic` (dependency-cruiser-specific) stay in the `workloads` repo. Add generalized versions here later if another repo needs them.
