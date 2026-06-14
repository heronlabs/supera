---
name: supera-init
description: "Bootstrap a repo for supera: detect its stack, propose install/build/test/lint commands and a tag table, ask for the ClickUp list, and write .claude/supera.json. Run once per repo before /ship. Triggers: 'supera init', 'set up supera here', 'configure supera for this repo'."
allowed-tools: Bash, Read, Glob, Grep, Write, Edit, AskUserQuestion
---

Detect this repository's toolchain and write `.claude/supera.json` so `/ship`, `/pr-watch`, and the auditors work here. Mostly automatic — you confirm one or two things.

The config contract is `schema/supera.schema.json` in this plugin. Produce config that validates against it.

## 1 — Detect the stack

Inspect the repo root for marker files. Read `package.json` if present.

| Markers found | `stack` | Likely commands |
|---|---|---|
| `pnpm-lock.yaml` (+ `turbo.json`) | `pnpm` | install `pnpm install --frozen-lockfile`; build/test/lint from `turbo`/`scripts` |
| `package-lock.json` | `npm` | install `npm ci`; build/test/lint from `scripts` |
| `yarn.lock` | `yarn` | install `yarn install --immutable`; build/test/lint from `scripts` |
| `Cargo.toml` | `cargo` | `cargo build --workspace` · `cargo test --workspace` · `cargo clippy -- -D warnings` |
| `@strapi/strapi` in deps | `strapi` | `strapi build` · test script if any · lint script |
| `go.mod` | `go` | `go build ./...` · `go test ./...` · `golangci-lint run` |
| `pyproject.toml` / `requirements.txt` | `python` | from project scripts / `pytest` · `ruff`/`flake8` |

When `package.json` exists, prefer its actual `scripts` over the generic guesses above:
- build ← `build` (or `compile` / `typecheck`)
- test ← `test:unit` (or `test`)
- lint ← `lint:check` (or `lint`)

Detect monorepo scoping: if `turbo.json` or workspaces exist, propose the scoped form (e.g. `pnpm turbo run build`) rather than a single-package command.

## 2 — Propose the tag table

List the top-level grouping directories that map to shippable units:
```bash
ls -d apps/*/ packages/*/ crates/*/ services/*/ 2>/dev/null
```
For each, propose a glob → lowercase tag, e.g. `apps/server-cms/** → cms`, `crates/cli/** → cli`. If the repo is single-package, propose an empty `tags` object (PR gets no path-derived labels).

## 3 — Resolve the ClickUp list

Ask the user for the ClickUp list ID that holds this repo's backlog:

> "ClickUp list ID for this repo's backlog? (paste the numeric list id, or say 'none' to run ticket-less — ship/pr-watch will skip ClickUp entirely.)"

The list id is the number inside the list URL's `.../l/<view>-<listId>-<n>` (or `.../li/<listId>`) segment — **not** the workspace/team id in the URL prefix. The team id instead yields a "Team not authorized" failure on the first ticket call; if that happens, have the user reopen the list and copy the id from its own URL.

`none` → `"clickup": null`. Otherwise emit the list **and** the status defaults so per-space names are discoverable and editable:
`"clickup": { "listId": "<id>", "statuses": { "ready": "pending", "building": "in progress", "review": "in review", "blocked": "blocked", "rejected": "rejected", "closed": "closed" } }`.
These defaults validate against `clickup.statuses` in the schema; the user edits a value only if this ClickUp space renamed a status.

## 4 — Confirm and write

Show the proposed config and ask the user to confirm or tweak the commands (use `AskUserQuestion` if a command is ambiguous). Then write `.claude/supera.json` at the repo root:

```jsonc
{
  "stack": "<detected>",
  "verify": {
    "install": "<install cmd>",
    "build": "<build cmd>",
    "test": "<test cmd>",
    "lint": "<lint cmd>"
  },
  "worktree": { "dir": ".worktrees", "base": "<default branch>" },
  "clickup": {                       // or null to run ticket-less
    "listId": "<id>",
    // Optional per-space status names; defaults shown. Edit only if this ClickUp
    // space renamed a status. Omit the whole block to keep these defaults.
    "statuses": {
      "ready": "pending", "building": "in progress", "review": "in review",
      "blocked": "blocked", "rejected": "rejected", "closed": "closed"
    }
  },
  "pr": { "base": "<default branch>", "remote": "origin" },
  "tags": { "<glob>": "<tag>" },
  "audits": { "supplyChain": false }
}
```

Detect the default branch instead of assuming `main`:
```bash
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main
```

Set `audits.supplyChain` to `true` if the repo has a lockfile, else `false`.

## 5 — Report

Print the written path and a compact summary of every field. Tell the user:
> "`.claude/supera.json` written. Commit it so the config travels with the repo. Run `/ship <task or ticket>` to ship."

## Rules

- Never invent commands a repo can't run — if a step (e.g. lint) genuinely doesn't exist, omit that `verify` key rather than guessing.
- Prefer the repo's real `package.json` scripts over generic templates.
- Detect the default branch; don't hardcode `main`.
- If `.claude/supera.json` already exists, show it and ask before overwriting.
- When a ClickUp list is set, emit the `clickup.statuses` defaults inline so status names are visible and editable per space; omit the block (or any single key) to fall back to the schema defaults.
- Output must validate against `schema/supera.schema.json`.
