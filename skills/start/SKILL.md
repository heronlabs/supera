---
name: start
description: Bootstrap a repo for supera — detect its stack, ground build/test/lint commands, write .claude/supera.json. Run once per repo.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit, AskUserQuestion
---

Detect this repository's toolchain and write `.claude/supera.json` so `/ship` and `/pr-watch` work here. Mostly automatic — you confirm the commands, supply them directly when the repo has no CI.

The config contract is `schema/supera.schema.json` in this plugin. Produce config that validates against it.

## 1 — Detect the stack

Inspect the repo root for marker files. Identify the package manager and default commands:

| Markers found | Manager | Candidate commands |
|---|---|---|
| `pnpm-lock.yaml` | `pnpm` | `pnpm build`, `pnpm lint`, `pnpm test` |
| `package-lock.json` | `npm` | `npm run build`, `npm run lint`, `npm test` |
| `yarn.lock` | `yarn` | `yarn build`, `yarn lint`, `yarn test` |
| `Cargo.toml` | `cargo` | `cargo build`, `cargo clippy`, `cargo test` |
| `go.mod` | `go` | `go build ./...`, `golangci-lint run`, `go test ./...` |

## 2 — Resolve build / test / lint

Ground each command in what the repo actually runs:

1. **CI pipeline** — inspect `.github/workflows/*.yml`. Lift the exact build/test/lint invocations CI runs.
2. **Declared scripts** — no CI, but `package.json` has scripts: read them (build ← `build`/`compile`, test ← `test:unit`/`test`, lint ← `lint:check`/`lint`) and confirm.
3. **Ask** — no CI, nothing declared: ask the user. Seed with §1's candidates.

```bash
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main
```

## 3 — Detect test layers

Scan `package.json` scripts (or equivalent) for test layering:
- `test:unit` → `{"unit": "<manager> test:unit"}`
- `test:integration` → add `"integration": "<manager> test:integration"`
- `test:e2e` → add `"e2e": "<manager> test:e2e"`
- Single `test` → `{"unit": "<manager> test"}`

Only emit keys the repo actually has. Don't invent layers.

For non-JS stacks: `cargo test` → `{"unit": "cargo test"}`, `go test ./...` → `{"unit": "go test ./..."}`.

## 4 — Confirm and write

Show the proposed config and ask the user to confirm or tweak. Then write `.claude/supera.json`:

```jsonc
{
  "baseBranch": "<detected>",
  "remote": "origin",
  "buildCommand": "<build cmd>",
  "lintCommand": "<lint cmd>",
  "testCommands": {
    "unit": "<unit cmd>",
    "integration": "<integration cmd>",
    "e2e": "<e2e cmd>"
  },
  "mergeMethod": "squash"
}
```

Omit any command the repo doesn't have.

## 5 — Write guardrails into CLAUDE.md

Insert a marker-delimited block into the repo's root `CLAUDE.md`:

```md
<!-- supera:guardrails -->
## Working with this repo (managed by /start — edits between these markers are overwritten on re-run)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file; preserve the rest.
- **No scope creep.** Build only what was asked; no speculative abstractions.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, env names can be literal values.
- **Scope a change to where it belongs** — most changes are localized to one area.
<!-- /supera:guardrails -->
```

- No `CLAUDE.md` → create it containing the block.
- `CLAUDE.md` exists without markers → append after existing content.
- Markers already present → replace only between markers (idempotent).

## 6 — Report

Print the written path and a compact summary. Tell the user:
"> `.claude/supera.json` written. Commit it so the config travels with the repo. Run `/ship <task>` to ship."

## Rules

- Detect the default branch; never hardcode `main`.
- If `.claude/supera.json` already exists, show it and ask before overwriting.
- Omit any command the repo doesn't have — never invent one.
- A command CI runs is ground truth — it outranks a declared script.
