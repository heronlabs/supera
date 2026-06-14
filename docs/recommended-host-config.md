# Recommended host config

Personal, out-of-repo setup that complements supera. `supera-init` already writes the
guardrail block into each repo's `CLAUDE.md` (see the engineer-rewrite spec); the items
here apply the same discipline machine-wide and add editor-side ergonomics. Apply them on
your own machine — they are **not** part of the plugin.

## 1. Global guardrails — `~/.claude/CLAUDE.md`

Append this block (don't rewrite the file — it already `@`-includes other files):

```md
## Working defaults

- **Edit, don't rewrite** config/generated files — change only the needed entry; preserve the rest.
- **No scope creep** — build only what was asked; no speculative abstractions; flag-and-proceed-small instead of expanding silently.
- **Ambiguous literals: flag, don't guess** — config keys, IDs, env names can be literal values, not mappings (e.g. `environment: pulumi` may name a GitHub Environment called `pulumi`).
- **Cross-repo changes: update all related repos** (e.g. heronlabs ↔ cloud-iac-heronlabs) unless told otherwise.
- **CI/infra settings live outside code** — GitHub Environment and branch-protection rules are in repo settings, not the yaml.
- **ClickUp list IDs come from the hierarchy** (workspace → space → folder → list); never the team/workspace ID.
```

## 2. Auto-format on edit — `.claude/settings.json` (per repo)

Format and lint-fix the moment Claude writes a file, so the main thread's direct edits never
bounce off CI for formatting. Stack-specific, so it lives per repo, not in the plugin. For a
pnpm/TypeScript repo:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write",
  "hooks": [ { "type": "command", "command": "pnpm -s lint --fix && pnpm -s format" } ] } ] } }
```

Notes: it runs after every `Edit`/`Write`; swap the command for the repo's stack (`cargo fmt`,
`go fmt ./...`, etc.). The `supera-engineer` already self-formats before returning, so the win
here is on your own direct edits.

## 3. Context7 MCP (optional)

An MCP server that serves current library docs to the main thread — useful when you're working
with a fast-moving dependency. Install per Context7's README. It is deliberately **not** wired
into `supera-engineer`: the usage report showed no stale-API friction, and coupling the agent's
pinned tool allowlist to an environment-dependent MCP adds fragility for speculative benefit.
