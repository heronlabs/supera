---
name: init
description: "Bootstrap a repo for supera: detect its stack, ground install/build/test/lint in the repo's CI (or ask when there's none), and write .claude/supera.json. Run once per repo before /start. Triggers: 'supera init', 'set up supera here', 'configure supera for this repo'."
allowed-tools: Bash, Read, Glob, Grep, Write, Edit, AskUserQuestion
---

Detect this repository's toolchain and write `.claude/supera.json` so `/start`, `/pr-watch`, and the security auditor work here. Mostly automatic — you confirm the commands, and supply them directly when the repo has no CI to read.

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

The `audits.security` auto-detect (lockfile presence) is independent of any prompt — keep it as below. Then write `.claude/supera.json` at the repo root:

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
  // security is auto-detected from lockfile presence.
  "audits": { "security": false }
  // Optional pr-watch rigor surfaces, off by default — uncomment to opt in.
  // "review": { "consensus": { "voters": 1 }, "lenses": [] },   // voters:1 disables the merge-readiness gate (default); lenses [] = no extra PR-review specialists ("silent-failures" | "type-design" | "test-coverage")
  // "security": { "denyPaths": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"] }
}
```

Detect the default branch instead of assuming `main`:
```bash
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main
```

Set `audits.security` to `true` if the repo has a lockfile, else `false`. The security auditor runs on demand via `/audit`, `/start`, and `/pr-watch`.

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

## 5 — Offer the dependency layers (Dependabot + the audit cron + the Dependabot→pr-watch auto-fix)

Dependency hygiene is layered, and a GitHub-hosted repo should adopt them (the division of labor is canonical in `guidelines/auditor-base.md`):

1. **Dependabot — the free, always-on deterministic layer.** Routine version bumps, keeping already-pinned GitHub Actions fresh, and the security-update safety net — no LLM, native write to `.github/workflows/*`. Offer this **first**, framed as recommended.
2. **The `/supera:audit` cron — the reasoning layer.** The workflow supera offers for the audit (since `/pr-watch` and `/start` run locally and emit no workflow). It runs the security auditor for what Dependabot can't reason about — scoped transitive overrides, CVE verdicts, the initial tag→SHA pin.
3. **The Dependabot→`/supera:pr-watch` auto-fix (5c).** When a Dependabot bump breaks CI, this workflow runs `/supera:pr-watch` on the failed PR so supera-engineer makes the code/tests work with the bumped version — only offered when Dependabot was accepted (5a).

### 5a — Offer Dependabot (recommended)

Offer it only when the repo is GitHub-hosted (a `.github/` dir exists, or `origin` is a GitHub remote — `git remote get-url origin` matches `github.com`); skip silently otherwise.

Ask with `AskUserQuestion` (default = **accept**; recommended): *"Add a `.github/dependabot.yml`? It's the free, always-on layer — Dependabot bumps versions, keeps SHA-pinned Actions fresh, and opens security-update PRs, leaving supera's security auditor to reason about overrides and CVE verdicts."*

If accepted, write `.github/dependabot.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present. Map `package-ecosystem` from the detected `stack`: **pnpm / npm / yarn → `npm`**, **cargo → `cargo`**. Always include the `github-actions` block. Both the `npm`/`cargo` and `github-actions` blocks run **full version-updates**, each grouped so a week's bumps land in one PR — Dependabot now owns the routine version bumps supera no longer reasons about. For a `pnpm` stack (`npm` ecosystem reads `pnpm-lock.yaml`):

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
    groups:
      npm:
        patterns: ['*']
```

For a `cargo` stack, swap the second block's `package-ecosystem: npm # reads pnpm-lock.yaml` line for `package-ecosystem: cargo` and its `npm:` group key for `cargo:`, keeping the same `directory` / `schedule` / `patterns: ['*']` and the unchanged `github-actions` block.

### 5b — Offer the weekly audit cron

Offer it only when it can do something: the security auditor is enabled (`audits.security === true`), and the repo is GitHub-hosted (same check as 5a). Skip silently when the auditor is not enabled; for a non-GitHub repo, skip with a one-line note (`"Skipping the audit workflow — no GitHub remote detected."`).

When eligible, ask with `AskUserQuestion` (default = decline; opt-in, never forced): *"Emit a weekly `/supera:audit` GitHub Actions cron into `.github/workflows/supera-audit-weekly.yml`? It runs the security auditor and opens an audit PR. Requires an `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) repo secret, plus a `SUPERA_AUDIT_TOKEN` (PAT/App token with `workflow` scope) if you want it to push GitHub Actions SHA-pins."*

If declined, do nothing. If accepted, write `.github/workflows/supera-audit-weekly.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present. The template (supera installs from the public marketplace — those two values identify the plugin itself, not repo-specific config):

```yaml
# Prerequisites:
#   - `ANTHROPIC_API_KEY` repo secret (or swap it for
#     `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`).
#   - `SUPERA_AUDIT_TOKEN`: a PAT/App token with `contents` + `pull-requests` +
#     `workflow` scope, so the auditor can push GitHub Actions SHA-pins. The
#     default `GITHUB_TOKEN` lacks `workflow` scope and cannot push changes to
#     `.github/workflows/*` — with only it, the audit still runs and pins
#     dependencies, but action-pins cannot be pushed.
name: '[ Audit ] | Weekly'

on:
  schedule:
    - cron: '0 6 * * 1'
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

### 5c — Offer the Dependabot→pr-watch auto-fix (recommended)

Offer it only when **all three** hold: Dependabot was accepted in **5a**, a CI workflow was **detected in step 2**, and the repo is GitHub-hosted (same check as 5a). Skip silently otherwise.

When eligible, ask with `AskUserQuestion` (default = **accept**; recommended): *"Emit a `.github/workflows/supera-dependabot-pr-watch.yml`? When a Dependabot bump breaks CI, it runs `/supera:pr-watch` on the failed PR so supera-engineer makes the code/tests work with the bumped version. Requires the same `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) and `SUPERA_AUDIT_TOKEN` secrets as 5b."*

If declined, do nothing. If accepted, write `.github/workflows/supera-dependabot-pr-watch.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present.

This template fires on the **consumer's** CI completing, so `workflow_run.workflows` must carry the CI workflow `name` detected in step 2 — substitute it in for `<CI WORKFLOW NAME>` below. Because that name is per-repo, this template is **deliberately NOT part of the validate.ts byte-identical drift guard** (unlike 5a/5b). Fill `<CI WORKFLOW NAME>` with the detected CI workflow's `name:` value verbatim:

```yaml
# Prerequisites:
#   - `ANTHROPIC_API_KEY` repo secret (or swap it for
#     `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`).
#   - `SUPERA_AUDIT_TOKEN`: a PAT/App token with `contents` + `pull-requests`
#     scope so supera can push the fix and reply on the PR; add `workflow` scope
#     only if a fix may touch `.github/workflows/*`. The default `GITHUB_TOKEN`
#     works for non-workflow fixes.
#
# Security note: this runs the bumped dependency's tests with repo secrets in
# scope — an accepted risk for auto-fixing a Dependabot bump. Keep the
# `SUPERA_AUDIT_TOKEN` minimally scoped. It fires only on a FAILED CI run of a
# Dependabot pull_request.
name: '[ Dependabot ] | PR Watch'

on:
  workflow_run:
    workflows: ['<CI WORKFLOW NAME>'] # the consumer's CI workflow name (step-2 detected)
    types: [completed]

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: false

jobs:
  pr-watch:
    name: 'Auto-fix Dependabot bump'
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.conclusion == 'failure' &&
      github.event.workflow_run.actor.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
        with:
          ref: ${{ github.event.workflow_run.head_branch }}
          token: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}

      - id: pr
        env:
          GH_TOKEN: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}
          HEAD_BRANCH: ${{ github.event.workflow_run.head_branch }}
        run: |
          NUMBER=$(gh pr list --head "$HEAD_BRANCH" --state open --json number -q '.[0].number')
          if [ -z "$NUMBER" ]; then
            echo "No open PR for $HEAD_BRANCH — nothing to watch."
            echo "number=" >> "$GITHUB_OUTPUT"
          else
            echo "number=$NUMBER" >> "$GITHUB_OUTPUT"
          fi

      - if: steps.pr.outputs.number != ''
        uses: anthropics/claude-code-action@2fee15510437d71399d9139ed60433470484a8fb # v1.0.153
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}
          plugin_marketplaces: https://github.com/heronlabs/supera.git
          plugins: supera@supera-marketplace
          prompt: /supera:pr-watch ${{ steps.pr.outputs.number }} --non-interactive
          claude_args: '--allowed-tools Bash,Read,Glob,Grep,Agent,Edit,Write'
```

After writing it, tell the user the same two secrets cover it (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` + `SUPERA_AUDIT_TOKEN`). Then commit it alongside the other 5a/5b files.

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
- All three are opt-in via `AskUserQuestion` and only offered on a GitHub-hosted repo. Dependabot (5a) defaults to **accept** (recommended); the audit cron (5b) defaults to **decline** and is only offered when the security auditor is enabled; the Dependabot→pr-watch auto-fix (5c) defaults to **accept** (recommended) and is only offered when 5a was accepted and a CI workflow was detected in step 2.
- Idempotent — never clobber an existing `.github/dependabot.yml`, `.github/workflows/supera-audit-weekly.yml`, or `.github/workflows/supera-dependabot-pr-watch.yml`; report it's already present instead.
- `package-ecosystem` maps from the detected `stack` (pnpm/npm/yarn → `npm`, cargo → `cargo`); always include the `github-actions` block.
- The 5c template is per-repo parameterized (`workflow_run.workflows` carries the consumer's CI workflow `name`), so it's NOT in the validate.ts byte-identical drift guard — substitute the step-2 detected CI workflow name.
- Each file's existence is the state; no `.claude/supera.json` field tracks any of them.
