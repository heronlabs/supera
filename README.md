# supera

A repo-agnostic **ticket-shipping superagent** for Claude Code. Install once; ship tickets on any repository with the same pattern — tracker ticket → worktree → implement + test → PR → babysit CI → done.

The orchestration lives here. Anything repo-specific (build/test/lint commands, tracker board, branch) lives in a tiny per-repo `.claude/supera.json`, so the **same** skills work across pnpm, npm, cargo, Strapi, Go, Python, and more. A tracker is optional and provider-agnostic — bring your own ClickUp, Jira, Linear, or any MCP via a neutral tool-map, or run ticket-less and let the PR be the ticket.

## What's inside

| Skill | What it does |
|---|---|
| `/supera-init` | Detect a repo's stack and write its `.claude/supera.json`. Run once per repo. |
| `/ship [task or ticket ID]` | Full lifecycle: tracker ticket → worktree → delegate to `supera-engineer` → PR → ticket in review → hand off to `/pr-watch`; re-run to close out (ticket → closed, worktree torn down). Idempotent — also owns `pause`/resume. |
| `/refine-ticket [ticket ID]` | Reformat a draft tracker ticket to the concise template; fill priority/due date and set it `ready`. |
| `/pr-watch [PR#]` | Babysit a PR: monitor CI, fix failures, resolve review threads, one code-review cycle — exit when green, synced, resolved. |
| `/audit [branch]` | Run the enabled dependency auditors on a branch, carry their safe auto-fixes into a PR, hand off to `/pr-watch`. Ticket-less; CI-cron-ready via `--non-interactive`. |

| Agent | Role |
|---|---|
| `supera-engineer` | **The problem-solver.** One strong agent that implements code **and** tests in the worktree, adapts to the repo's own conventions, and self-verifies before returning. Uses superpowers (TDD, systematic-debugging, verification). Replaces all per-stack scribes. |
| `supera-supply-chain-auditor` | Cross-ecosystem supply-chain audit (npm/pnpm/yarn/cargo): CVEs, missing/stale overrides, typo-squats, provenance gaps, leaked secrets. Report-only + safe CVE overrides. |
| `supera-freshness-auditor` | Cross-ecosystem dependency **currency** (not security): direct deps behind their latest in-range version, version drift across workspace members. Report-only + safe in-range bumps. Gated by `audits.freshness`. |

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
/ship 86abc123               # ship a tracker ticket, or:
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
  "tracker": {                                 // or null → ticket-less, the PR is the ticket
    "provider": "clickup",                     // informational hint; tool selection comes from tools
    "board": "901415284967",                   // ClickUp list id, Jira project key, etc.
    "tools": {                                 // each neutral op → a concrete MCP tool on your server
      "getTicket": "clickup_get_task", "createTicket": "clickup_create_task",
      "setStatus": "clickup_update_task", "updateFields": "clickup_update_task",
      "comment": "clickup_create_comment", "deleteTicket": "clickup_delete_task"
    }
  },
  "pr": { "base": "main", "remote": "origin" },
  "audits": { "supplyChain": true }
}
```

Set `tracker` to `null` to run **ticket-less** — `/ship` and `/pr-watch` skip all tracker updates and operate purely on git + GitHub, with the PR standing in for the ticket. Time spent is derived from git (first commit → merge).

## Prerequisites

- A **tracker MCP** configured with your provider's tools — ClickUp, Jira, Linear, or any MCP server (only needed in ticket mode; map each op in `tracker.tools`).
- **`gh` CLI** installed + authenticated (`gh auth login`) — all GitHub work goes through the CLI.
- **superpowers** plugin (optional) — when present, the engineer uses its TDD / debugging / verification skills; without it, the engineer applies the same discipline inline.
