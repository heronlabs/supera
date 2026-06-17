---
name: supera-init
description: "Bootstrap a repo for supera: detect its stack, propose install/build/test/lint commands and the project tag, ask for the tracker (provider + board), and write .claude/supera.json. Run once per repo before /ship. Triggers: 'supera init', 'set up supera here', 'configure supera for this repo'."
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

## 2 — Resolve the project tag

Derive one lowercase project tag — the repo/project name — that `/ship` and `/refine-ticket` stamp on every tracker ticket so a shared board can be filtered per-repo. Take it from the repo directory name, or from `package.json` `name` with any `@scope/` prefix stripped:
```bash
basename "$(git rev-parse --show-toplevel)"
```
Lowercase it (e.g. `Server-CMS` → `server-cms`). This becomes `tracker.projectTag`. When the repo runs ticket-less (`tracker` is `null`), there is no tag to apply.

## 3 — Resolve the tracker

**Migrate first.** If `.claude/supera.json` already exists with a legacy `clickup` block (pre-tracker config, re-init), convert it to `tracker` and skip the questions below: `board ← clickup.listId`, `provider ← "clickup"`, keep `projectTag` + `statuses` verbatim, and fill the ClickUp `tools` preset (below). Report the migration in step 9 (`tracker-migrated: clickup → tracker`).

Otherwise resolve a fresh tracker. If a tracker MCP server is connected, detect it and use its identity to pick the `provider` hint and tool preset; if you can't detect one, ask. Ask the user for the provider + board:

> "Which issue tracker, and the board/list id that holds this repo's backlog? (e.g. `clickup 901415284967`, `jira ENG`, or say 'none' to run ticket-less — ship/pr-watch/refine skip the tracker entirely.)"

The board is the container new tickets are created in — a ClickUp **list id**, a Jira **project key**, a Linear **team/project id**, etc. It comes from the tracker's own hierarchy (e.g. ClickUp workspace → space → folder → list; copy the list's own id from the list URL's `.../l/<view>-<listId>-<n>` or `.../li/<listId>` segment) — **not** the workspace/team id in the URL prefix, which yields an authorization failure on the first ticket call.

`none` → `"tracker": null` (no `projectTag`, no `tools`). Otherwise emit `provider`, `board`, the project tag from step 2, the status defaults (so per-tracker names are discoverable and editable), **and** a `tools` map from the preset matching the provider:

- **ClickUp** (`provider: "clickup"`): `getTicket: clickup_get_task`, `createTicket: clickup_create_task`, `setStatus: clickup_update_task`, `updateFields: clickup_update_task`, `comment: clickup_create_comment`, `addTag: clickup_add_tag_to_task`, `deleteTicket: clickup_delete_task`.
- **Jira** (`provider: "jira"`, **TEMPLATE** — confirm each name against the installed Jira MCP server's real tool names): `getTicket: jira_get_issue`, `createTicket: jira_create_issue`, `setStatus: jira_transition_issue` (a status transition), `updateFields: jira_update_issue`, `comment: jira_add_comment`, `deleteTicket: jira_delete_issue`; **`addTag` omitted** (Jira applies labels via `updateFields`).

For any other provider, ask the user for each op's tool name (or leave an op out — every `tools` op is individually optional; skills guard on its presence). The status defaults validate against `tracker.statuses` in the schema; the user edits a value only if this tracker renamed a status. `projectTag` is applied best-effort; omit/null it to skip tagging.

## 4 — Confirm and write

Show the proposed config and ask the user to confirm or tweak the commands (use `AskUserQuestion` if a command is ambiguous).

Then offer the optional automation surfaces in **one** `AskUserQuestion` (default = none, leave everything off). Cover three independent opt-ins:
- **Freshness auditor** — dependency currency auto-bumps. When chosen, emit `"audits": { "supplyChain": <detected>, "freshness": { "level": "patch", "minReleaseAgeDays": 7 } }`. When declined, emit `audits.freshness` inline at its default `{ "level": "off" }` (see the template) so it stays discoverable and editable.
- **Headless pr-watch** — drive open PRs to green off-laptop. When chosen, emit `"automation": { "prWatch": { "pullRequest": true } }` (step 7 then emits the workflow); declined → omit the `prWatch` sub-block.
- **Ship-from-issue** — headless `/ship` from a `supera:ship`-labelled issue. When chosen, emit `"automation": { "ship": { "issueLabel": true } }` (step 8 then emits the workflow); declined → omit the `ship` sub-block.

The `audits.supplyChain` auto-detect (lockfile presence) and the `automation.audit` cron emission are independent of this prompt — keep them as below. Then write `.claude/supera.json` at the repo root:

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
  "tracker": {                       // or null to run ticket-less
    "provider": "<clickup | jira | linear | …>",   // informational hint; tool selection comes from tools below
    "board": "<id>",                 // ClickUp list id, Jira project key, etc.
    "projectTag": "<resolved project tag>",   // step 2; omit/null when ticket-less
    // Optional per-tracker status names; defaults shown. Edit only if this tracker
    // renamed a status. Omit the whole block to keep these defaults.
    "statuses": {
      "ready": "pending", "building": "in progress", "review": "in review",
      "blocked": "blocked", "rejected": "rejected", "closed": "closed"
    },
    // Each neutral op → a concrete MCP tool on the connected server. Omit an op the
    // provider folds into another (skills guard on presence). ClickUp preset shown.
    "tools": {
      "getTicket": "clickup_get_task", "createTicket": "clickup_create_task",
      "setStatus": "clickup_update_task", "updateFields": "clickup_update_task",
      "comment": "clickup_create_comment", "addTag": "clickup_add_tag_to_task",
      "deleteTicket": "clickup_delete_task"
    }
  },
  "pr": { "base": "<default branch>", "remote": "origin" },
  // supplyChain is auto-detected from lockfile presence. freshness is emitted at its
  // default "off" so it's discoverable — flip level to "patch"/"minor" (and re-run
  // /supera-init to (re)emit the audit workflow) to enable currency auto-bumps.
  "audits": { "supplyChain": false, "freshness": { "level": "off" } },
  // ci.provider is written whenever ANY auditor is enabled (supplyChain OR
  // freshness.level != "off"); the ci.audit subkey is added ONLY when supplyChain is
  // true (its native commands are supply-chain specific). Omit the whole ci block when
  // no auditor is enabled.
  "ci": { "provider": "github", "audit": { "<manager>": "<audit cmd>" } },  // only when an auditor is enabled — see below
  // automation.audit is emitted when ANY auditor is enabled — it turns on the
  // cron / dispatch / label triggers the audit workflow (step 6) reads.
  // prWatch / ship are emitted only when opted in (the step-4 prompt) — steps 7 / 8.
  "automation": { "audit": { "schedule": true, "dispatch": true, "label": false } },  // only when an auditor is enabled — see below
  // Optional pr-watch rigor surfaces, off by default — uncomment to opt in.
  // "review": { "consensus": { "voters": 1 } },   // voters:1 disables the merge-readiness gate (default)
  // "security": { "denyPaths": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", "**/*.keystore"] }
}
```

Detect the default branch instead of assuming `main`:
```bash
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main
```

Set `audits.supplyChain` to `true` if the repo has a lockfile, else `false`. Emit `audits.freshness` inline at its default `{ "level": "off" }` when the user declines the freshness opt-in (step-4 prompt), so the field is discoverable and editable; set it to `{ "level": "patch", "minReleaseAgeDays": 7 }` when they accept. Enabling freshness by hand-editing `level` to `patch`/`minor` later requires re-running `/supera-init` to (re)emit the audit workflow.

Write `ci.provider` (`"github"`) whenever **any** auditor is enabled — `audits.supplyChain` is `true` **or** `audits.freshness.level` is set and not `"off"` — so when freshness (or supplyChain) is enabled the audit cron is emitted, including a freshness-only repo. Add the `ci.audit` subkey **only** when `supplyChain` is `true` — its native audit commands are supply-chain specific and unused by the freshness path; include only the manager(s) the repo actually uses (the schema's default command per manager — e.g. `pnpm` → `pnpm audit --json`). Likewise emit the `automation.audit` block whenever any auditor is enabled, defaulting it to weekly `schedule` + `dispatch` on, `label` off (the cheap, predictable cadence — the user flips `label` on to allow `supera:audit`-labelled runs). When **no** auditor is enabled, omit the whole `ci` block and `automation.audit`.

## 5 — Write the guardrails into the repo's CLAUDE.md

Insert a small, repo-agnostic guardrail block into the target repo's root `CLAUDE.md` so the main thread here follows the same discipline `supera-engineer` carries. The block is marker-delimited so it is idempotent and never clobbers existing content:

````md
<!-- supera:guardrails -->
## Working with this repo (managed by /supera-init — edits between these markers are overwritten on re-init)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file (`package.json`, lockfiles, manifests, CI yaml); preserve the rest. Never regenerate a whole file to add one line.
- **No scope creep.** Build only what was asked; no speculative abstractions, layers, or options. Prefer the simplest working solution.
- **Ambiguous literals: flag, don't guess.** Config keys, IDs, and env names can be literal values, not mappings (e.g. `environment: pulumi` may name a GitHub Environment literally called `pulumi`). State which reading you took.
- **Cross-repo changes: update all related repos** unless told otherwise.
- **CI/infra settings live outside code** — GitHub Environment and branch-protection rules are in repo settings, not the yaml.
- **Tracker board/list IDs come from the tracker's own hierarchy** (e.g. workspace → space → folder → list); never the workspace/team id.
<!-- /supera:guardrails -->
````

Apply it like this:
- **No `CLAUDE.md`** → create it containing the block.
- **`CLAUDE.md` exists without the markers** → show the block and confirm (same courtesy as overwriting `supera.json`), then **append** it after the existing content — never modify what is already there.
- **Markers already present** → replace only the text between `<!-- supera:guardrails -->` and `<!-- /supera:guardrails -->`; leave everything else untouched (idempotent re-init).
- **Drop the tracker line entirely when `tracker` is `null`** (ticket-less repos) — that gotcha only applies when this repo uses a tracker.

## 6 — Emit the dependency audit workflow (only when an auditor is enabled and a trigger is on)

Skip this whole step unless `CONFIG.ci.provider` is `github`, **at least one auditor** is enabled (`CONFIG.audits.supplyChain === true` **or** `CONFIG.audits.freshness?.level` is set and `!== "off"`), **and at least one** `CONFIG.automation.audit` trigger (`schedule` / `dispatch` / `label`) is true — no workflow, the capability stays off until the repo opts in. If no trigger flag is on, skip (a workflow with no `on:` triggers is meaningless). It only applies to GitHub: skip (and tell the user once) if `CONFIG.ci.provider` is set to anything other than `github` — currently the only supported provider.

When enabled, write `.github/workflows/supera-audit.yml` so `/audit --non-interactive` runs off-laptop on a schedule. The job is **agentic** — Claude runs the `/audit` orchestrator headless via the official `anthropics/claude-code-action`, which runs every enabled auditor (supply-chain CVE overrides, then freshness currency bumps — security-first), carries their safe auto-fixes into a PR, and hands off to `/pr-watch`. The auditor agents detect the package manager themselves. Cost is bounded to `schedule` / label / `workflow_dispatch` only — **never** a per-PR hot path.

Build the file from `CONFIG`, hardcoding nothing repo-specific:
- **Triggers** come from `CONFIG.automation.audit` — emit a `schedule:` block (`cron: "0 6 * * 1"`, weekly Monday 06:00 UTC) only when `…schedule` is true; emit `workflow_dispatch:` only when `…dispatch` is true; emit the `pull_request: { types: [labeled] }` trigger only when `…label` is true. If a flag is false, omit that trigger entirely. When `label` is on, guard the job with `if: github.event_name != 'pull_request' || github.event.label.name == 'supera:audit'` so only the `supera:audit` label fires it.
- The workflow declares the `ANTHROPIC_API_KEY` secret and `contents: write`, `pull-requests: write`, `issues: write` permissions — `/audit` creates the `supera:audit` repo label (an Issues-API resource) before opening the PR, so the label scope is required even though it files no separate issue.

This repo stays git/GitHub-native and **ticket-less**: the tracker MCP may be absent in CI, so the workflow opens a PR and never touches the tracker.

Emit this template, substituting the trigger blocks per the flags above (the example shows all three triggers + the `supera:audit` label guard; drop whichever the config disables):

````yaml
name: supera dependency audit

# Agentic dependency audit — runs /audit --non-interactive headless.
# /audit runs every enabled auditor (supply-chain then freshness, security-first),
# carries safe fixes into a PR, and hands off to /pr-watch.
# Cron / manual / label only; never a per-PR hot path (cost discipline).
on:
  schedule:
    - cron: "0 6 * * 1"        # weekly, Mondays 06:00 UTC — only if automation.audit.schedule
  workflow_dispatch:            # only if automation.audit.dispatch
  pull_request:                 # only if automation.audit.label
    types: [labeled]

permissions:
  contents: write               # push the audit branch
  pull-requests: write          # open the audit PR
  issues: write                 # create the supera:audit repo label

jobs:
  audit:
    # label guard — drop this `if` when automation.audit.label is false
    if: github.event_name != 'pull_request' || github.event.label.name == 'supera:audit'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Run /audit --non-interactive on this repository.
            Run every enabled auditor (supply-chain then freshness,
            security-first), carry their safe auto-fixes into a pull
            request, and hand off to /pr-watch to drive it green.
            Report all findings in the PR body; file no separate issue.
            Stay git/GitHub-native and ticket-less — do not touch the tracker.
````

Write it only if the path is absent; if `.github/workflows/supera-audit.yml` already exists, show the proposed content and confirm before overwriting (same courtesy as `supera.json`). Don't touch any other workflow in `.github/workflows/`.

## 7 — Emit the pr-watch workflow (only when an `automation.prWatch.*` trigger is on)

Skip this whole step unless `CONFIG.ci.provider` is `github` **and** at least one `CONFIG.automation.prWatch.*` flag is true — no workflow, the capability stays off until the repo opts in. (Tell the user once if `CONFIG.ci.provider` is set to anything other than `github` — currently the only supported provider.)

When enabled, write `.github/workflows/supera-pr-watch.yml` so `/pr-watch` runs off-laptop on every PR event instead of dying when the terminal closes. The job is **agentic** — Claude runs `/pr-watch --non-interactive` headless via the official `anthropics/claude-code-action`, resolving the PR number from the event payload: it drives CI to green via `supera-engineer`, addresses review threads, and exits when the branch is green and synced. GitHub events replace the interactive run's `ScheduleWakeup` — `--non-interactive` is load-bearing (no human in CI to answer a prompt; any human-judgment fork becomes a PR comment plus a `blocked` exit). Interactive `/pr-watch` is unchanged and stays for local use — this is purely additive.

Build the file from `CONFIG`, hardcoding nothing repo-specific:
- **Triggers** come from `CONFIG.automation.prWatch` — emit a `pull_request: { types: [opened, synchronize, reopened] }` block only when `…pullRequest` is true; emit a `check_suite: { types: [completed] }` block only when `…checkSuite` is true. If a flag is false, omit that trigger entirely.
- The workflow declares the `ANTHROPIC_API_KEY` secret and `contents: write`, `pull-requests: write`, `issues: write`, `checks: read`, `statuses: read` permissions (pr-watch needs to push fixes, comment on / update the PR, and read CI status).

This repo stays git/GitHub-native and **ticket-less**: the tracker MCP may be absent in CI, so the headless run drives the PR to green and never touches the tracker.

Emit this template, substituting the trigger blocks per the flags above (the example shows both triggers; drop whichever the config disables):

````yaml
name: supera pr-watch

# Agentic PR babysitter — runs /pr-watch --non-interactive headless.
# GitHub events replace the interactive run's ScheduleWakeup.
on:
  pull_request:                 # only if automation.prWatch.pullRequest
    types: [opened, synchronize, reopened]
  check_suite:                  # only if automation.prWatch.checkSuite
    types: [completed]

permissions:
  contents: write               # push fixes to the PR branch
  pull-requests: write          # comment on / update the PR
  issues: write                 # file follow-ups
  checks: read                  # read check results
  statuses: read                # read commit statuses

jobs:
  pr-watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Run /pr-watch --non-interactive on PR
            #${{ github.event.pull_request.number || github.event.check_suite.pull_requests[0].number }}.
            Drive the PR to green: reproduce and fix CI failures via
            supera-engineer, address actionable review threads, and exit when
            the branch is green and synced with its base. Never prompt — post
            any human-judgment fork as a PR comment and exit blocked.
            Stay git/GitHub-native — do not touch the tracker.
````

Write it only if the path is absent; if `.github/workflows/supera-pr-watch.yml` already exists, show the proposed content and confirm before overwriting (same courtesy as `supera.json`). Don't touch any other workflow in `.github/workflows/`.

## 8 — Emit the ship-from-issue workflow (only when `automation.ship.issueLabel` is true)

Skip this whole step when `CONFIG.automation.ship.issueLabel` is `false` — no workflow, the capability stays off until the repo opts in. It also only applies to GitHub: skip (and tell the user once) if `CONFIG.ci.provider` is set to anything other than `github` — currently the only supported provider.

When enabled, write `.github/workflows/supera-ship.yml` so `/ship` runs off-laptop with **zero terminal** — labeling a GitHub issue `supera:ship` kicks off a headless build that ends in an open PR. The job is **agentic** — Claude runs `/ship` non-interactively via the official `anthropics/claude-code-action`, using the issue title + body as the task description; `supera-engineer` stays the only implementer, the workflow just orchestrates. Cost is bounded to the `supera:ship` label only — **never** a per-PR hot path. It is independent of the audit workflow (separate file): emitting one never touches the other.

This repo stays git/GitHub-native and **ticket-less**: the tracker MCP may be absent in CI, so the workflow opens a PR off the issue and never touches the tracker.

The trigger is fixed (`issues: { types: [labeled] }`) and the label guard (`supera:ship`) is hardcoded, so nothing repo-specific is substituted — emit this template verbatim:

````yaml
name: supera ship from issue

# Agentic headless ship — runs /ship when an issue is labeled 'supera:ship'.
# Label only; never a per-PR hot path (cost discipline).
on:
  issues:
    types: [labeled]

permissions:
  contents: write               # push the feature branch
  pull-requests: write          # open the PR
  issues: write                 # comment the PR link back on the issue

jobs:
  ship:
    # label guard — only the 'supera:ship' label fires the headless build
    if: github.event.label.name == 'supera:ship'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Run /ship headless (non-interactive) for the following task,
            taken from the GitHub issue that was labeled 'supera:ship':

            Title: ${{ github.event.issue.title }}

            ${{ github.event.issue.body }}

            Cut a feature branch, delegate the implementation to
            supera-engineer (code + tests, self-verified), and open a
            pull request. Comment the PR link back on the issue.
            Stay git/GitHub-native and ticket-less — do not touch the tracker.
````

Write it only if the path is absent; if `.github/workflows/supera-ship.yml` already exists, show the proposed content and confirm before overwriting (same courtesy as `supera.json`). Don't touch any other workflow in `.github/workflows/`.

## 9 — Report

Print the written path and a compact summary of every field. Tell the user:
> "`.claude/supera.json` written. Commit it so the config travels with the repo. Run `/ship <task or ticket>` to ship."

## Rules

- Never invent commands a repo can't run — if a step (e.g. lint) genuinely doesn't exist, omit that `verify` key rather than guessing.
- Prefer the repo's real `package.json` scripts over generic templates.
- Detect the default branch; don't hardcode `main`.
- If `.claude/supera.json` already exists, show it and ask before overwriting.
- When a tracker is set, emit `tracker.provider` + `tracker.board` and a `tracker.tools` map from the provider preset (ClickUp/Jira presets in step 3; ask per-op for any other provider, each op individually optional).
- When a tracker is set, emit `tracker.projectTag` (the lowercase project name from step 2) so `/ship` and `/refine-ticket` can stamp every ticket; omit/null it to skip tagging, and drop it entirely when `tracker` is null.
- When a tracker is set, emit the `tracker.statuses` defaults inline so status names are visible and editable per tracker; omit the block (or any single key) to fall back to the schema defaults.
- On re-init, migrate a legacy `clickup` block to `tracker` (board←listId, provider←"clickup", keep projectTag + statuses, fill the ClickUp tools preset) and report it.
- Output must validate against `schema/supera.schema.json`.
- The CLAUDE.md guardrail block is marker-delimited and idempotent: create or refresh only between the `<!-- supera:guardrails -->` markers, never touch content outside them, and drop the tracker line when `tracker` is null.
- Emit `.github/workflows/supera-audit.yml` only when `ci.provider` is `github`, at least one auditor is enabled (`audits.supplyChain` is true **or** `audits.freshness.level` is set and not `off`), and at least one `automation.audit` trigger (`schedule`/`dispatch`/`label`) is true; build its triggers from `automation.audit` — hardcode nothing. The job is agentic — Claude runs `/audit --non-interactive` headless (every enabled auditor → PR → `/pr-watch`; cron / dispatch / label only, never per-PR), declares the `ANTHROPIC_API_KEY` secret with `contents`/`pull-requests`/`issues: write` (the label scope creates the `supera:audit` repo label, an Issues-API resource, even though it files no separate issue), and stays ticket-less. Don't overwrite an existing workflow without confirming; never touch other workflow files.
- Emit `.github/workflows/supera-pr-watch.yml` only when `ci.provider` is `github` and at least one `automation.prWatch.*` flag is true; build its triggers from `automation.prWatch` (`pullRequest` → `pull_request`, `checkSuite` → `check_suite`) — hardcode nothing, omit a trigger whose flag is false. The job is agentic — Claude runs `/pr-watch --non-interactive` headless (GitHub events replace `ScheduleWakeup`), declares the `ANTHROPIC_API_KEY` secret with `contents`/`pull-requests`/`issues: write` + `checks`/`statuses: read`, and stays ticket-less. Interactive `/pr-watch` is unchanged (additive). Don't overwrite an existing workflow without confirming; never touch other workflow files.
- Emit `.github/workflows/supera-ship.yml` only when `automation.ship.issueLabel` is true and `ci.provider` is `github`. The job is agentic — it runs `/ship` headless from a `supera:ship`-labeled issue (`issues: [labeled]`, guarded so only that label fires it, never per-PR), with `supera-engineer` the only implementer; declares the `ANTHROPIC_API_KEY` secret with `contents`/`pull-requests`/`issues: write`, and stays git/GitHub-native and ticket-less. Independent of the audit workflow (separate file). Don't overwrite an existing workflow without confirming; never touch other workflow files.
