---
name: supera-init
description: "Bootstrap a repo for supera: detect its stack, ground install/build/test/lint in the repo's CI (or ask when there's none), and write .claude/supera.json. Run once per repo before /ship. Triggers: 'supera init', 'set up supera here', 'configure supera for this repo'."
allowed-tools: Bash, Read, Glob, Grep, Write, Edit, AskUserQuestion
---

Detect this repository's toolchain and write `.claude/supera.json` so `/ship`, `/pr-watch`, and the auditors work here. Mostly automatic — you confirm the commands, and supply them directly when the repo has no CI to read.

The config contract is `schema/supera.schema.json` in this plugin. Produce config that validates against it.

## 1 — Detect the stack

Inspect the repo root for marker files; `package.json`, when present, also names the stack. Set `stack` from the markers.

| Markers found | `stack` | Candidate commands |
|---|---|---|
| `pnpm-lock.yaml` (+ `turbo.json`) | `pnpm` | install `pnpm install --frozen-lockfile`; build/test/lint from `turbo`/`scripts` |
| `package-lock.json` | `npm` | install `npm ci`; build/test/lint from `scripts` |
| `yarn.lock` | `yarn` | install `yarn install --immutable`; build/test/lint from `scripts` |
| `Cargo.toml` | `cargo` | `cargo build --workspace` · `cargo test --workspace` · `cargo clippy -- -D warnings` |
| `@strapi/strapi` in deps | `strapi` | `strapi build` · test script if any · lint script |
| `go.mod` | `go` | `go build ./...` · `go test ./...` · `golangci-lint run` |
| `pyproject.toml` / `requirements.txt` | `python` | from project scripts / `pytest` · `ruff`/`flake8` |

The build/test/lint entries above are **candidates only** — §2 grounds them in the repo's real commands before anything is written.

## 2 — Resolve build / test / lint

Ground each command in what the repo actually runs, in this order:

1. **CI pipeline** — inspect `.github/workflows/*.yml` (GitHub Actions) and `.gitlab-ci.yml` (GitLab CI). Read the pipeline and lift the exact build/test/lint invocations it runs.
2. **Declared scripts** — no CI, but `package.json` declares scripts: read them (build ← `build` / `compile` / `typecheck`, test ← `test:unit` / `test`, lint ← `lint:check` / `lint`) and show them to confirm.
3. **Ask** — no CI and nothing declared to read (early-stage repos, fresh non-JS projects): converse with the user instead of guessing. Seed the question with §1's candidates so they confirm or correct rather than start blank:

  > "No CI here, so I can't read the real commands. What builds, tests, and lints this repo? (e.g. `cargo build --workspace`, `cargo test --workspace`, `cargo clippy -- -D warnings` — or say which steps don't exist yet.)"

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

Set `audits.supplyChain` to `true` if the repo has a lockfile, else `false`. Emit `audits.freshness` inline at its default `{ "level": "off" }` when the user declines the freshness opt-in (step-3 prompt), so the field is discoverable and editable; set it to `{ "level": "patch", "minReleaseAgeDays": 7 }` when they accept. Both auditors run on demand via `/audit`, `/ship`, and `/pr-watch`.

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
> "`.claude/supera.json` written. Commit it so the config travels with the repo. Run `/ship <task>` to ship."

## Rules

**Stack detection**
- The install command is fixed by the lockfile — take it as-is; don't ask the user to confirm it.
- For a monorepo (`turbo.json` / workspaces), scope commands to the workspace (e.g. `pnpm turbo run build`), never a single package.

**Verify commands**
- A command CI runs is ground truth — it outranks a declared script or a canonical default.
- With no CI, never write a blind guess: confirm a declared `package.json` script, or ask the user and take their answer as truth.
- Omit a `verify` key for any step the repo doesn't have — never invent one.

**Writing the config**
- Detect the default branch; never hardcode `main`.
- If `.claude/supera.json` already exists, show it and ask before overwriting.
