---
name: supera-init
description: "Bootstrap a repo for supera: detect its stack, propose install/build/test/lint commands, ask for an optional tracker (provider + board), and write .claude/supera.json. Run once per repo before /ship. Triggers: 'supera init', 'set up supera here', 'configure supera for this repo'."
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

**Prefer the CI pipeline's real commands.** Inspect existing CI config — `.github/workflows/*.yml` (GitHub Actions) and `.gitlab-ci.yml` (GitLab CI) — and extract the build/test/lint commands those pipelines actually run. A command CI already runs beats a generic guess, so use it to ground the proposed `verify.*` (this only informs the proposal — no config field records it).

## 2 — Resolve the tracker

A tracker is **optional**. If one is connected, use it; if not, supera runs **ticket-less** — the PR itself is the ticket, and `/ship`, `/pr-watch`, and `/refine-ticket` operate purely on git + GitHub.

If a tracker MCP server is connected, detect it and use its identity to pick the `provider` hint and tool preset; if you can't detect one, ask. Ask the user for the provider + board:

> "Which issue tracker, and the board/list id that holds this repo's backlog? (e.g. `clickup 901415284967`, `jira ENG`, or say 'none' to run ticket-less — the PR is the ticket.)"

The board is the container new tickets are created in — a ClickUp **list id**, a Jira **project key**, a Linear **team/project id**, etc. It comes from the tracker's own hierarchy (e.g. ClickUp workspace → space → folder → list; copy the list's own id from the list URL's `.../l/<view>-<listId>-<n>` or `.../li/<listId>` segment) — **not** the workspace/team id in the URL prefix, which yields an authorization failure on the first ticket call.

`none` → `"tracker": null` (no `tools`). Otherwise emit `provider`, `board`, the status defaults (so per-tracker names are discoverable and editable), **and** a `tools` map from the preset matching the provider:

- **ClickUp** (`provider: "clickup"`): `getTicket: clickup_get_task`, `createTicket: clickup_create_task`, `setStatus: clickup_update_task`, `updateFields: clickup_update_task`, `comment: clickup_create_comment`, `deleteTicket: clickup_delete_task`.
- **Jira** (`provider: "jira"`, **TEMPLATE** — confirm each name against the installed Jira MCP server's real tool names): `getTicket: jira_get_issue`, `createTicket: jira_create_issue`, `setStatus: jira_transition_issue` (a status transition), `updateFields: jira_update_issue`, `comment: jira_add_comment`, `deleteTicket: jira_delete_issue`.

For any other provider, ask the user for each op's tool name (or leave a best-effort op out — `comment`/`updateFields`/`deleteTicket` are optional and skills guard on their presence). The status defaults validate against `tracker.statuses` in the schema; the user edits a value only if this tracker renamed a status.

## 3 — Confirm and write

Show the proposed config and ask the user to confirm or tweak the commands (use `AskUserQuestion` if a command is ambiguous).

Then offer the **freshness auditor** opt-in in one `AskUserQuestion` (default = off): dependency-currency auto-bumps run on demand via `/audit`, `/ship`, and `/pr-watch`. When chosen, emit `"audits": { "supplyChain": <detected>, "freshness": { "level": "patch", "minReleaseAgeDays": 7 } }`; when declined, emit `audits.freshness` inline at its default `{ "level": "off" }` so it stays discoverable and editable.

The `audits.supplyChain` auto-detect (lockfile presence) is independent of this prompt — keep it as below. Then write `.claude/supera.json` at the repo root:

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
  "tracker": {                       // or null to run ticket-less (the PR is the ticket)
    "provider": "<clickup | jira | linear | …>",   // informational hint; tool selection comes from tools below
    "board": "<id>",                 // ClickUp list id, Jira project key, etc.
    // Optional per-tracker status names; defaults shown. Edit only if this tracker
    // renamed a status. Omit the whole block to keep these defaults.
    "statuses": {
      "ready": "pending", "building": "in progress", "review": "in review",
      "blocked": "blocked", "rejected": "rejected", "closed": "closed"
    },
    // Each neutral op → a concrete MCP tool on the connected server. Omit a best-effort
    // op (comment/updateFields/deleteTicket) the provider lacks; skills guard on presence.
    // ClickUp preset shown.
    "tools": {
      "getTicket": "clickup_get_task", "createTicket": "clickup_create_task",
      "setStatus": "clickup_update_task", "updateFields": "clickup_update_task",
      "comment": "clickup_create_comment", "deleteTicket": "clickup_delete_task"
    }
  },
  "pr": { "base": "<default branch>", "remote": "origin" },
  // supplyChain is auto-detected from lockfile presence. freshness is emitted at its
  // default "off" so it's discoverable — flip level to "patch"/"minor" to enable
  // on-demand currency auto-bumps (via /audit, /ship, /pr-watch).
  "audits": { "supplyChain": false, "freshness": { "level": "off" } }
  // Optional pr-watch rigor surfaces, off by default — uncomment to opt in.
  // "review": { "consensus": { "voters": 1 }, "lenses": [] },   // voters:1 disables the merge-readiness gate (default); lenses [] = no extra PR-review specialists ("silent-failures" | "type-design" | "test-coverage")
  // "security": { "denyPaths": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"] }
}
```

Detect the default branch instead of assuming `main`:
```bash
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main
```

Set `audits.supplyChain` to `true` if the repo has a lockfile, else `false`. Emit `audits.freshness` inline at its default `{ "level": "off" }` when the user declines the freshness opt-in (step-3 prompt), so the field is discoverable and editable; set it to `{ "level": "patch", "minReleaseAgeDays": 7 }` when they accept. Both auditors run on demand via `/audit`, `/ship`, and `/pr-watch` — supera emits no CI workflows.

## 4 — Write the guardrails into the repo's CLAUDE.md

Insert a small, repo-agnostic guardrail block into the target repo's root `CLAUDE.md` so the main thread here follows the same discipline `supera-engineer` carries. The block is marker-delimited so it is idempotent and never clobbers existing content:

````md
<!-- supera:guardrails -->
## Working with this repo (managed by /supera-init — edits between these markers are overwritten on re-init)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file (`package.json`, lockfiles, manifests, CI yaml); preserve the rest. Never regenerate a whole file to add one line.
- **No scope creep.** Build only what was asked; no speculative abstractions, layers, or options. Prefer the simplest working solution.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, and env names can be literal values, not mappings. State which reading you took.
- **Scope a change to where it belongs** — most changes are localized to one area; touch other repos only when the change genuinely cuts across, and then update the related repos too.
<!-- /supera:guardrails -->
````

Apply it like this:
- **No `CLAUDE.md`** → create it containing the block.
- **`CLAUDE.md` exists without the markers** → show the block and confirm (same courtesy as overwriting `supera.json`), then **append** it after the existing content — never modify what is already there.
- **Markers already present** → replace only the text between `<!-- supera:guardrails -->` and `<!-- /supera:guardrails -->`; leave everything else untouched (idempotent re-init).

## 5 — Local-first note

/pr-watch and /ship run locally (interactive, or `--non-interactive`); CI emission is deferred until tested. supera writes no `.github/workflows/*.yml`.

## 6 — Report

Print the written path and a compact summary of every field. Tell the user:
> "`.claude/supera.json` written. Commit it so the config travels with the repo. Run `/ship <task or ticket>` to ship."

## Rules

- Never invent commands a repo can't run — if a step (e.g. lint) genuinely doesn't exist, omit that `verify` key rather than guessing.
- Prefer the repo's real `package.json` scripts over generic templates.
- Detect the default branch; don't hardcode `main`.
- If `.claude/supera.json` already exists, show it and ask before overwriting.
- A tracker is optional. When set, emit `tracker.provider` + `tracker.board` and a `tracker.tools` map from the provider preset (ClickUp/Jira presets in step 2; ask per-op for any other provider, best-effort ops optional). `none` → `"tracker": null` (ticket-less, the PR is the ticket).
- When a tracker is set, emit the `tracker.statuses` defaults inline so status names are visible and editable per tracker; omit the block (or any single key) to fall back to the schema defaults.
- Prefer the CI pipeline's real build/test/lint commands (`.github/workflows/*.yml`, `.gitlab-ci.yml`) over generic guesses when grounding `verify.*`.
- Output must validate against `schema/supera.schema.json`.
- The CLAUDE.md guardrail block is marker-delimited and idempotent: create or refresh only between the `<!-- supera:guardrails -->` markers, never touch content outside them.
- supera emits no CI workflows — /ship and /pr-watch run locally (interactive or `--non-interactive`); headless CI emission is deferred.
