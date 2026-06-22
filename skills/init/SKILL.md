---
name: init
description: "Bootstrap a repo for supera: detect its stack, ground install/build/test/lint in the repo's CI (or ask when there's none), and write .claude/supera.json. Run once per repo before /start. Triggers: 'supera init', 'set up supera here', 'configure supera for this repo'."
allowed-tools: Bash, Read, Glob, Grep, Write, Edit, AskUserQuestion
---

Detect this repository's toolchain and write `.claude/supera.json` so `/start`, `/pr-watch`, and the auditors work here. Mostly automatic — you confirm the commands, and supply them directly when the repo has no CI to read.

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

Then offer the **freshness auditor** opt-in in one `AskUserQuestion` (default = off): dependency-currency auto-bumps run on demand via `/audit`, `/start`, and `/pr-watch`. When chosen, emit `"audits": { "security": <detected>, "freshness": { "level": "patch", "minReleaseAgeDays": 7 } }`; when declined, emit `audits.freshness` inline at its default `{ "level": "off" }` so it stays discoverable and editable.

The `audits.security` auto-detect (lockfile presence) is independent of this prompt — keep it as below. Then write `.claude/supera.json` at the repo root:

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
  // security is auto-detected from lockfile presence. freshness is emitted at its
  // default "off" so it's discoverable — flip level to "patch"/"minor" to enable
  // on-demand currency auto-bumps (via /audit, /start, /pr-watch).
  "audits": { "security": false, "freshness": { "level": "off" } }
  // Optional pr-watch rigor surfaces, off by default — uncomment to opt in.
  // "review": { "consensus": { "voters": 1 }, "lenses": [] },   // voters:1 disables the merge-readiness gate (default); lenses [] = no extra PR-review specialists ("silent-failures" | "type-design" | "test-coverage")
  // "security": { "denyPaths": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"] }
}
```

Detect the default branch instead of assuming `main`:
```bash
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main
```

Set `audits.security` to `true` if the repo has a lockfile, else `false`. Emit `audits.freshness` inline at its default `{ "level": "off" }` when the user declines the freshness opt-in (step-3 prompt), so the field is discoverable and editable; set it to `{ "level": "patch", "minReleaseAgeDays": 7 }` when they accept. Both auditors run on demand via `/audit`, `/start`, and `/pr-watch`.

## 4 — Write the guardrails into the repo's CLAUDE.md

Insert a small, repo-agnostic guardrail block into the target repo's root `CLAUDE.md` so the main thread here follows the same discipline `supera-engineer` carries. The block is marker-delimited so it is idempotent and never clobbers existing content:

````md
<!-- supera:guardrails -->
## Working with this repo (managed by /init — edits between these markers are overwritten on re-init)

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

## 5 — Offer the two dependency layers (Dependabot + the audit cron)

Dependency hygiene is two layers, and a GitHub-hosted repo should adopt **both** (the division of labor is canonical in `guidelines/auditor-base.md`):

1. **Dependabot — the free, always-on deterministic layer.** Routine version bumps, keeping already-pinned GitHub Actions fresh, and the security-update safety net — no LLM, native write to `.github/workflows/*`. Offer this **first**, framed as recommended.
2. **The `/supera:audit` cron — the reasoning layer.** The one workflow supera offers (since `/pr-watch` and `/start` run locally and emit no workflow). It runs the enabled auditors for what Dependabot can't reason about — scoped transitive overrides, CVE verdicts, the initial tag→SHA pin.

### 5a — Offer Dependabot (recommended)

Offer it only when the repo is GitHub-hosted (a `.github/` dir exists, or `origin` is a GitHub remote — `git remote get-url origin` matches `github.com`); skip silently otherwise.

Ask with `AskUserQuestion` (default = **accept**; recommended): *"Add a `.github/dependabot.yml`? It's the free, always-on layer — Dependabot bumps versions, keeps SHA-pinned Actions fresh, and opens security-update PRs, leaving supera's auditors to reason about overrides and CVE verdicts."*

If accepted, write `.github/dependabot.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present. Map `package-ecosystem` from the detected `stack`: **pnpm / npm / yarn → `npm`**, **cargo → `cargo`**. Always include the `github-actions` block. The `npm`/`cargo` ecosystem block is **security-updates only** (`open-pull-requests-limit: 0` — no version-bump churn, since the freshness auditor is the reasoning layer); `github-actions` gets full version-updates so already-pinned Actions stay fresh. For a `pnpm` stack (`npm` ecosystem reads `pnpm-lock.yaml`):

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: '/'
    schedule:
      interval: weekly
    groups:
      actions:
        patterns: ['*']
  - package-ecosystem: npm # reads pnpm-lock.yaml
    directory: '/'
    schedule:
      interval: weekly
    open-pull-requests-limit: 0 # security-updates only — no version-bump churn
```

For a `cargo` stack, swap the second block's `package-ecosystem: npm # reads pnpm-lock.yaml` line for `package-ecosystem: cargo`, keeping the same `directory` / `schedule` / `open-pull-requests-limit: 0` and the unchanged `github-actions` block.

### 5b — Offer the daily audit cron

Offer it only when it can do something: at least one auditor is enabled (`audits.security === true` **OR** `audits.freshness.level !== "off"`), and the repo is GitHub-hosted (same check as 5a). Skip silently when no auditor is enabled; for a non-GitHub repo, skip with a one-line note (`"Skipping the audit workflow — no GitHub remote detected."`).

When eligible, ask with `AskUserQuestion` (default = decline; opt-in, never forced): *"Emit a daily `/supera:audit` GitHub Actions cron into `.github/workflows/supera-audit-daily.yml`? It runs the enabled auditors and opens an audit PR. Requires an `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) repo secret, plus a `SUPERA_AUDIT_TOKEN` (PAT/App token with `workflow` scope) if you want it to push GitHub Actions SHA-pins."*

If declined, do nothing. If accepted, write `.github/workflows/supera-audit-daily.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present. The template (supera installs from the public marketplace — those two values identify the plugin itself, not repo-specific config):

```yaml
# Prerequisites:
#   - `ANTHROPIC_API_KEY` repo secret (or swap it for
#     `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`).
#   - `SUPERA_AUDIT_TOKEN`: a PAT/App token with `contents` + `pull-requests` +
#     `workflow` scope, so the auditor can push GitHub Actions SHA-pins. The
#     default `GITHUB_TOKEN` lacks `workflow` scope and cannot push changes to
#     `.github/workflows/*` — with only it, the audit still runs and pins
#     dependencies, but action-pins cannot be pushed.
name: '[ Audit ] | Daily'

on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false

jobs:
  audit:
    name: 'Dependency audit'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6

      - uses: anthropics/claude-code-action@2fee15510437d71399d9139ed60433470484a8fb # v1.0.153
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}
          plugin_marketplaces: https://github.com/heronlabs/supera.git
          plugins: supera@supera-marketplace
          prompt: /supera:audit --non-interactive
          claude_args: '--allowed-tools Bash,Read,Glob,Grep,Agent,Edit,Write'
```

After writing it, tell the user to add the `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) repo secret, and — to let the auditor push GitHub Actions SHA-pins — a `SUPERA_AUDIT_TOKEN` (a PAT/App token with `workflow` scope; without it the audit still runs and pins dependencies but cannot push `.github/workflows/*` changes). Then commit the workflow (and any `.github/dependabot.yml` from 5a) alongside `.claude/supera.json`.

## 6 — Report

Print the written path and a compact summary of every field. Tell the user:
> "`.claude/supera.json` written. Commit it so the config travels with the repo. Run `/start <task>` to ship."

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

**Dependency layers (step 5)**
- Both are opt-in via `AskUserQuestion` and only offered on a GitHub-hosted repo. Dependabot (5a) defaults to **accept** (recommended); the audit cron (5b) defaults to **decline** and is only offered when an auditor is enabled.
- Idempotent — never clobber an existing `.github/dependabot.yml` or `.github/workflows/supera-audit-daily.yml`; report it's already present instead.
- `package-ecosystem` maps from the detected `stack` (pnpm/npm/yarn → `npm`, cargo → `cargo`); always include the `github-actions` block.
- Each file's existence is the state; no `.claude/supera.json` field tracks either.
