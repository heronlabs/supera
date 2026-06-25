---
name: start
description: "Bootstrap a repo for supera: detect its stack, ground install/build/test/lint in the repo's CI (or ask when there's none), and write .claude/supera.json. Run once per repo before /ship. Triggers: 'supera start', 'set up supera here', 'configure supera for this repo'."
allowed-tools: Bash, Read, Glob, Grep, Write, Edit, AskUserQuestion
---

Detect this repository's toolchain and write `.claude/supera.json` so `/ship`, `/pr-watch`, and the security auditor work here. Mostly automatic — you confirm the commands, and supply them directly when the repo has no CI to read.

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

Set `audits.security` to `true` if the repo has a lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`), else `false`. The security auditor runs on demand via `/audit`, `/ship`, and `/pr-watch`.

## 4 — Write the guardrails into the repo's CLAUDE.md

Insert a small, repo-agnostic guardrail block into the target repo's root `CLAUDE.md` so the main thread here follows the same discipline `supera-engineer` carries. The block is marker-delimited so it is idempotent and never clobbers existing content:

````md
<!-- supera:guardrails -->
## Working with this repo (managed by /start — edits between these markers are overwritten on re-run)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file (`package.json`, lockfiles, manifests, CI yaml); preserve the rest. Never regenerate a whole file to add one line.
- **No scope creep.** Build only what was asked; no speculative abstractions, layers, or options. Prefer the simplest working solution.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, and env names can be literal values, not mappings. State which reading you took.
- **Scope a change to where it belongs** — most changes are localized to one area; touch other repos only when the change genuinely cuts across, and then update the related repos too.
<!-- /supera:guardrails -->
````

Apply it like this:
- **No `CLAUDE.md`** → create it containing the block.
- **`CLAUDE.md` exists without the markers** → show the block and confirm (same courtesy as overwriting `supera.json`), then **append** it after the existing content — never modify what is already there.
- **Markers already present** → replace only the text between `<!-- supera:guardrails -->` and `<!-- /supera:guardrails -->`; leave everything else untouched (idempotent re-run).

## 5 — Offer the dependency layers (Dependabot + the audit cron + the Dependabot→pr-watch auto-fix)

Dependency hygiene is layered, and a GitHub-hosted repo should adopt them (the division of labor is canonical in `guidelines/auditor-base.md`). Each layer is **independently opt-in** — offer them separately and accept each on its own merit: Dependabot (5a) stands alone as a complete path, and accepting it never obligates the audit cron (5b) or the auto-fix (5c).

1. **Dependabot — the free, always-on deterministic layer.** Routine version bumps, keeping already-pinned GitHub Actions fresh, and the security-update safety net — no LLM, native write to `.github/workflows/*`. Offer this **first**, framed as recommended.
2. **The `/supera:audit` cron — the reasoning layer.** The workflow supera offers for the audit (since `/pr-watch` and `/ship` run locally and emit no workflow). It runs the security auditor for what Dependabot can't reason about — scoped transitive overrides, CVE verdicts, the initial tag→SHA pin.
3. **The Dependabot→`/supera:pr-watch` auto-fix (5c).** When a Dependabot bump breaks CI, this workflow runs `/supera:pr-watch` on the failed PR so supera-engineer makes the code/tests work with the bumped version — only offered when Dependabot was accepted (5a).

### 5a — Offer Dependabot (recommended)

Offer it only when the repo is GitHub-hosted (a `.github/` dir exists, or `origin` is a GitHub remote — `git remote get-url origin` matches `github.com`); skip silently otherwise.

Ask with `AskUserQuestion` (default = **accept**; recommended): *"Add a `.github/dependabot.yml`? It's the free, always-on layer — Dependabot bumps versions, keeps SHA-pinned Actions fresh, and opens security-update PRs, leaving supera's security auditor to reason about overrides and CVE verdicts."*

If accepted, write `.github/dependabot.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present. Map `package-ecosystem` from the detected `stack`: **pnpm / npm / yarn → `npm`**, **cargo → `cargo`**, **go → `gomod`**. Always include the `github-actions` block. Both the `npm`/`cargo`/`gomod` and `github-actions` blocks run **full version-updates**, each grouped so a week's bumps land in one PR — Dependabot now owns the routine version bumps supera no longer reasons about. For a `pnpm` stack (`npm` ecosystem reads `pnpm-lock.yaml`):

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

For a `go` stack, swap the second block's `package-ecosystem: npm # reads pnpm-lock.yaml` line for `package-ecosystem: gomod` and its `npm:` group key for `gomod:`, keeping the same `directory` / `schedule` / `patterns: ['*']` and the unchanged `github-actions` block.

### 5b — Offer the weekly audit cron

Offer it only when it can do something: the security auditor is enabled (`audits.security === true`), and the repo is GitHub-hosted (same check as 5a). Skip silently when the auditor is not enabled; for a non-GitHub repo, skip with a one-line note (`"Skipping the audit workflow — no GitHub remote detected."`).

When eligible, ask with `AskUserQuestion` (default = decline; opt-in, never forced): *"Emit a weekly `/supera:audit` GitHub Actions cron into `.github/workflows/supera-skill-audit.yml`? It runs the security auditor and opens an audit PR. Requires an `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) repo secret, plus a `SUPERA_AUDIT_TOKEN` (PAT/App token with `workflow` scope) if you want it to push GitHub Actions SHA-pins."*

If declined, do nothing. If accepted, write `.github/workflows/supera-skill-audit.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present. The template (supera installs from the public marketplace — those two values identify the plugin itself, not repo-specific config):

```yaml
# Prerequisites:
#   - `ANTHROPIC_API_KEY` repo secret (or swap it for
#     `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`).
#   - `SUPERA_AUDIT_TOKEN`: a PAT/App token with `contents` + `pull-requests` +
#     `workflow` scope, so the auditor can push GitHub Actions SHA-pins. The
#     default `GITHUB_TOKEN` lacks `workflow` scope and cannot push changes to
#     `.github/workflows/*`. With only it the audit degrades gracefully: /audit
#     lands the dependency remediations (their own commit, pushed first) and
#     opens the PR; only the action-pins (a second commit) are dropped.
name: 'Skill | audit'

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
      # checkout + supera-bot git identity + toolchain (toolchain only — /audit
      # runs install inside the worktree it creates). Swap `stack` for your
      # repo's: pnpm | npm | yarn | cargo | go.
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          fetch-depth: 0
          token: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}

      - uses: ./.github/actions/supera-bootstrap
        with:
          stack: <detected stack>

      - uses: anthropics/claude-code-action@428971d2ecd6e3a7cb0ee0da2a3a8b33fdb3678d # v1.0.157
        id: claude
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}
          plugin_marketplaces: https://github.com/heronlabs/supera.git
          plugins: supera@supera-marketplace
          prompt: /supera:audit --non-interactive
          show_full_output: true
          claude_args: '--allowed-tools Bash,Read,Glob,Grep,Agent,Edit,Write,Skill'

      # Run + semantic telemetry → privacy-safe metrics artifact for the daily
      # rollup (build + validate + budget warning live in the composite action).
      - uses: ./.github/actions/supera-metrics
        if: always()
        with:
          skill: audit
          execution-file: ${{ steps.claude.outputs.execution_file }}
```

This cron references the `./.github/actions/supera-bootstrap` and `./.github/actions/supera-metrics` composite actions, which are NOT part of the plugin — emit them into the consumer repo too (5d, 5e) so the workflow is self-contained. Substitute `<detected stack>` with the `stack` from step 1 (`pnpm` | `npm` | `yarn` | `cargo` | `go`).

After writing it, tell the user to add the `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) repo secret, and — to let the auditor push GitHub Actions SHA-pins — a `SUPERA_AUDIT_TOKEN` (a PAT/App token with `workflow` scope; without it the audit still runs and pins dependencies but cannot push `.github/workflows/*` changes). Then commit the workflow (and any `.github/dependabot.yml` from 5a) alongside `.claude/supera.json`.

### 5d — Emit the supera-bootstrap composite action

The 5b cron (and the `supera-skill-pr-watch.yml` in 5c) reference `uses: ./.github/actions/supera-bootstrap` — a local composite action that sets the `supera-bot` git identity and the per-stack toolchain (the caller checks out first — a local `./` action can't be loaded before checkout). It is **not** part of the plugin, so a `uses:` pointing at the plugin would break; the workflows must be self-contained. **Whenever you emit 5b or 5c, also write `.github/actions/supera-bootstrap/action.yml`**, byte-identical to the template below — **idempotent: if the file already exists, never clobber it**, just report it's already present. The consumer's workflows pass `stack: <detected stack>` to it; the action gates each toolchain step on that input, so one file serves every stack.

```yaml
name: 'supera bootstrap'
description: 'supera-bot git identity and per-stack toolchain setup for supera skill workflows. Toolchain only — never installs dependencies; the caller checks out and installs.'

inputs:
  stack:
    description: 'Toolchain to set up: pnpm | npm | yarn | cargo | go.'
    required: true
  node-version-file:
    description: 'File read by setup-node for the Node version (pnpm/npm/yarn stacks).'
    default: '.node-version'

runs:
  using: composite
  steps:
    # the engineer/auditor commits via raw git, so give it an identity
    # (claude-code-action only auto-configures git in its tag mode, not prompt mode).
    - shell: bash
      run: |
        git config --global user.name 'supera-bot'
        git config --global user.email 'supera-bot@users.noreply.github.com'

    - if: inputs.stack == 'pnpm'
      uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9

    - if: inputs.stack == 'pnpm' || inputs.stack == 'npm' || inputs.stack == 'yarn'
      uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
      with:
        node-version-file: ${{ inputs.node-version-file }}
        cache: ${{ inputs.stack == 'pnpm' && 'pnpm' || inputs.stack }}

    - if: inputs.stack == 'cargo'
      uses: dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8 # stable

    - if: inputs.stack == 'go'
      uses: actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6.5.0
      with:
        go-version-file: go.mod

    - if: inputs.stack == 'go'
      shell: bash
      run: go install golang.org/x/vuln/cmd/govulncheck@v1.4.0
```

### 5e — Emit the supera-metrics composite action

The 5b cron's telemetry step is `uses: ./.github/actions/supera-metrics` — a local composite action that builds the privacy-safe metrics-event (jq only), merges the optional `.supera/metrics/run.json` semantic layer, warns on a per-skill budget overage, and uploads the artifact for the daily rollup. Like supera-bootstrap it is **not** part of the plugin, so **whenever you emit 5b, also write `.github/actions/supera-metrics/action.yml`**, byte-identical to the template below — **idempotent: if the file already exists, never clobber it**, just report it's already present. It takes no per-consumer value (`skill` is passed by the caller workflow), so one file serves every stack and every skill.

```yaml
name: 'supera metrics'
description: 'Build a privacy-safe run-metrics event from the skill run (jq only), merge the optional .supera/metrics/run.json semantic layer, warn on per-skill budget overage, and upload it as an artifact for the daily rollup. Privacy is structural — only the metrics schema known, constrained fields are ever written.'

inputs:
  skill:
    description: 'The supera skill that produced the run: ship | pr-watch | audit | refactor.'
    required: true
  execution-file:
    description: 'Path to the claude-code-action execution file. The caller passes its claude step output (steps.<id>.outputs.execution_file) — a caller-step output that is not visible inside this action.'
    required: true

runs:
  using: composite
  steps:
    - name: 'Build run-metrics event'
      if: always()
      shell: bash
      env:
        EXECUTION_FILE: ${{ inputs.execution-file }}
        REPO: ${{ github.repository }}
        RUN_ID: ${{ github.run_id }}
        RUN_ATTEMPT: ${{ github.run_attempt }}
        SKILL: ${{ inputs.skill }}
      run: |
        set -euo pipefail
        if [ -z "${EXECUTION_FILE:-}" ] || [ ! -s "$EXECUTION_FILE" ]; then
          echo 'No execution file — skipping run-metrics emit.'
          exit 0
        fi
        result=$(jq -c 'map(select(.type == "result")) | last' "$EXECUTION_FILE")
        if [ -z "$result" ] || [ "$result" = 'null' ]; then
          echo 'No result message — skipping run-metrics emit.'
          exit 0
        fi
        model=$(jq -r 'map(select(.type == "system" and .subtype == "init")) | (first.model // "")' "$EXECUTION_FILE")
        stack=$(jq -r '.stack // "unknown"' .claude/supera.json 2>/dev/null || echo unknown)
        jq -n \
          --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          --arg repo "$REPO" \
          --arg skill "$SKILL" \
          --arg model "$model" \
          --arg stack "$stack" \
          --argjson run_id "$RUN_ID" \
          --argjson run_attempt "$RUN_ATTEMPT" \
          --argjson result "$result" \
          '{
            schema_version: "1",
            ts: $ts,
            repo: $repo,
            skill: $skill,
            event: "run",
            outcome: (if $result.subtype == "success" then "success" else "error" end),
            model: (if ($model | test("^claude-[a-z0-9.-]+$")) then $model else "claude-unknown" end),
            stack: (if ($stack | test("^[a-z]+$")) then $stack else "unknown" end),
            run: {
              cost_usd: ($result.total_cost_usd // 0),
              num_turns: ($result.num_turns // 0),
              duration_ms: ($result.duration_ms // 0),
              tokens: {
                input: ($result.usage.input_tokens // 0),
                output: ($result.usage.output_tokens // 0),
                cache_read: ($result.usage.cache_read_input_tokens // 0),
                cache_creation: ($result.usage.cache_creation_input_tokens // 0)
              }
            },
            gh: {run_id: $run_id, run_attempt: $run_attempt}
          }' > metrics-event.json
        if jq -e '
          .schema_version == "1"
          and (.repo | test("^[^/]+/[^/]+$"))
          and (.skill | IN("ship", "pr-watch", "audit", "refactor"))
          and (.outcome | IN("success", "blocked", "needs-review", "error"))
          and (.model | test("^claude-[a-z0-9.-]+$"))
          and (.stack | test("^[a-z]+$"))
          and (.run.cost_usd | type == "number")
          and (.run.tokens.input | type == "number")
          and (.gh.run_id | type == "number")
        ' metrics-event.json > /dev/null 2>&1; then
          echo 'Run-metrics event built and structurally validated.'
        else
          echo '::warning::run-metrics event failed structural validation — dropping it.'
          rm -f metrics-event.json
        fi
        # Phase 2 semantic layer: if the skill wrote .supera/metrics/run.json
        # (counts/enums only — no free text), merge it into the event's
        # `semantic` key. The merge keeps only the known semantic fields, so a
        # stray key can't open a leak, and the result is re-validated.
        run_json=$(find . -path '*/.supera/metrics/run.json' -print -quit 2>/dev/null || true)
        if [ -s metrics-event.json ] && [ -n "$run_json" ] && [ -s "$run_json" ]; then
          merged=$(jq \
            --slurpfile s "$run_json" \
            '. + {semantic: ($s[0] | {
              self_verify_retries, ci_reruns, phases_traversed,
              blocked_reason_category, files_changed_count, loc_delta
            } | with_entries(select(.value != null)))}' \
            metrics-event.json 2>/dev/null || true)
          if [ -n "$merged" ] && echo "$merged" | jq -e '.semantic | length > 0' > /dev/null 2>&1; then
            echo "$merged" > metrics-event.json
            echo 'Merged semantic run.json into the metrics event.'
          fi
        fi
        # Budget gate (warn-only, never fails the job): warn if cost/turns
        # exceed the per-skill soft budget in .claude/supera.json.
        if [ -s metrics-event.json ]; then
          budget=$(jq -c --arg skill "$SKILL" '.metrics.budgets[$skill] // {}' .claude/supera.json 2>/dev/null || echo '{}')
          cost=$(jq -r '.run.cost_usd' metrics-event.json)
          turns=$(jq -r '.run.num_turns' metrics-event.json)
          cost_budget=$(echo "$budget" | jq -r '.cost_usd // empty')
          turns_budget=$(echo "$budget" | jq -r '.turns // empty')
          if [ -n "$cost_budget" ] && jq -n --argjson c "$cost" --argjson b "$cost_budget" -e '$c > $b' > /dev/null 2>&1; then
            echo "::warning::$SKILL run cost \$$cost exceeded the \$$cost_budget budget."
          fi
          if [ -n "$turns_budget" ] && jq -n --argjson t "$turns" --argjson b "$turns_budget" -e '$t > $b' > /dev/null 2>&1; then
            echo "::warning::$SKILL run used $turns turns, over the $turns_budget budget."
          fi
        fi

    - name: 'Upload run-metrics artifact'
      if: always()
      uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
      with:
        name: metrics-${{ github.run_id }}
        path: metrics-event.json
        if-no-files-found: ignore
        retention-days: 90
```

### 5c — Offer the Dependabot→pr-watch auto-fix (recommended)

Offer it only when **all three** hold: Dependabot was accepted in **5a**, a CI workflow was **detected in step 2**, and the repo is GitHub-hosted (same check as 5a). Skip silently otherwise.

When eligible, ask with `AskUserQuestion` (default = **accept**; recommended): *"Emit a `.github/workflows/supera-skill-pr-watch.yml`? When a Dependabot bump breaks CI, it runs `/supera:pr-watch` on the failed PR so supera-engineer makes the code/tests work with the bumped version. Requires the same `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) and `SUPERA_AUDIT_TOKEN` secrets as 5b."*

If declined, do nothing. If accepted, write `.github/workflows/supera-skill-pr-watch.yml` — **idempotent: if the file already exists, never clobber it**, just report it's already present.

This template fires on the **consumer's** CI completing, so `workflow_run.workflows` must carry the CI workflow `name` detected in step 2 — substitute it in for `<CI WORKFLOW NAME>` below. Because that name is per-repo, this template is **deliberately NOT part of the validate.ts byte-identical drift guard** (unlike 5a/5b/5d). Fill `<CI WORKFLOW NAME>` with the detected CI workflow's `name:` value verbatim — but **strip any `[`/`]`**: `workflow_run.workflows` is glob-matched, so square brackets break trigger parsing and the watcher dies at startup before its `if:` ever runs (the pipe `|` and other characters are safe). If the detected CI name has brackets, drop them here and in the CI workflow's own `name:`.

supera-engineer runs the repo's **verify commands inside this workflow**, so the toolchain must be installed before `claude-code-action` (otherwise the run burns turns failing to find `pnpm`/`node` and never pushes a fix). The `actions/checkout` + `./.github/actions/supera-bootstrap` steps (5d) check out the branch and set up the toolchain (git identity + per-stack tools); unlike 5b, pr-watch then installs at the workflow root (`pnpm install --frozen-lockfile` for a pnpm stack — swap it for your stack's equivalent, e.g. `npm ci`, `cargo fetch`).

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
name: 'Skill | pr-watch'

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
      contains(fromJSON('["failure","timed_out"]'), github.event.workflow_run.conclusion) &&
      github.event.workflow_run.actor.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      # checkout + supera-bot git identity + toolchain (toolchain only). Swap
      # `stack` for your repo's: pnpm | npm | yarn | cargo | go.
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ github.event.workflow_run.head_branch }}
          fetch-depth: 0
          token: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}

      - uses: ./.github/actions/supera-bootstrap
        with:
          stack: <detected stack>

      # pr-watch (unlike the audit cron) installs at the workflow root so the
      # auto-fix step has the deps already resolved (swap for your stack's
      # equivalent — npm ci, cargo, etc.).
      - run: pnpm install --frozen-lockfile

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
          allowed_bots: '*' # job-level `if:` already gates to dependabot[bot]; '*' avoids the brittle 'dependabot' vs 'dependabot[bot]' login mismatch
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.SUPERA_AUDIT_TOKEN || secrets.GITHUB_TOKEN }}
          plugin_marketplaces: https://github.com/heronlabs/supera.git
          plugins: supera@supera-marketplace
          prompt: |
            A Dependabot pull request (#${{ steps.pr.outputs.number }}) has a failing CI run.
            Drive it green using the supera pr-watch skill — run the command below. This is a headless run with no human present, so never stop to ask; surface any block as a PR comment.
            /supera:pr-watch ${{ steps.pr.outputs.number }} --non-interactive
          show_full_output: true
          claude_args: '--allowed-tools Bash,Read,Glob,Grep,Agent,Edit,Write,Skill'
```

After writing it, tell the user the same two secrets cover it (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` + `SUPERA_AUDIT_TOKEN`). Then commit it alongside the other 5a/5b files.

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

**Dependency layers (step 5)**
- All three are **independent and opt-in** via `AskUserQuestion` and only offered on a GitHub-hosted repo. Dependabot (5a) defaults to **accept** (recommended) and **stands alone — a complete path on its own**; the audit cron (5b) defaults to **decline** and is only offered when the security auditor is enabled; the Dependabot→pr-watch auto-fix (5c) defaults to **accept** (recommended) and is only offered when 5a was accepted and a CI workflow was detected in step 2. Accepting 5a never obligates 5b or 5c.
- Idempotent — never clobber an existing `.github/dependabot.yml`, `.github/workflows/supera-skill-audit.yml`, `.github/workflows/supera-skill-pr-watch.yml`, `.github/actions/supera-bootstrap/action.yml`, or `.github/actions/supera-metrics/action.yml`; report it's already present instead.
- `package-ecosystem` maps from the detected `stack` (pnpm/npm/yarn → `npm`, cargo → `cargo`, go → `gomod`); always include the `github-actions` block.
- The 5c template is per-repo parameterized (`workflow_run.workflows` carries the consumer's CI workflow `name`), so it's NOT in the validate.ts byte-identical drift guard — substitute the step-2 detected CI workflow name.
- Each file's existence is the state; no `.claude/supera.json` field tracks any of them.
