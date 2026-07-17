# CLAUDE.md — supera

Autonomous AI agent for shipping code. TypeScript runtime using OpenAI tool-calling. Implements changes end-to-end: orient → plan → implement → verify → receipt.

## Layout

| Path | Contents |
|---|---|
| `src/agent.ts` | Core OpenAI agent loop — iterative tool calling with max-iteration safety cutoff |
| `src/tools.ts` | Tool definitions (OpenAI function schemas) + handler implementations with try/catch error wrapping |
| `src/system-prompt.ts` | Builds the system prompt that encodes the full supera workflow |
| `src/config.ts` | Loads and validates `.claude/supera.json` per-repo configuration |
| `src/types.ts` | Shared TypeScript types — Receipt, SuperaConfig, ToolRegistration, AgentRunConfig |
| `src/index.ts` | CLI entry point — `supera ship "<task>"`, `supera start` |
| `schema/` | JSON Schema for `supera.json` (per-repo config) and `receipt` (agent handoff) |
| `.claude-plugin/` | Claude Code plugin manifest — distribution channel |
| `.github/` | CI/CD workflows, PR template |

## Architecture

```
supera ship "add retry logic"
  │
  ├─ loadConfig()          → reads .claude/supera.json
  ├─ buildSystemPrompt()   → compiles workflow instructions
  ├─ runAgent(config,task) → OpenAI tool-calling loop
  │   ├─ Messages: [system, user(task)]
  │   ├─ While iterations < MAX:
  │   │   ├─ openai.chat.completions.create({tools, tool_choice: "auto"})
  │   │   ├─ If tool_calls → execute each handler, push tool results
  │   │   └─ If no tool_calls → tryParseReceipt(content) → return
  │   └─ Throw after MAX_ITERATIONS
  └─ Output JSON receipt to stdout
```

## Tool calling

8 tools exposed to the model:

| Tool | Purpose |
|---|---|
| `readFile` | Read file content with optional offset/limit |
| `writeFile` | Create or overwrite a file |
| `editFile` | Exact string replacement (must be unique) |
| `listFiles` | List directory contents |
| `searchFiles` | grep -r pattern search |
| `executeCommand` | Run shell commands (build/lint/test/git) |
| `gitDiff` | Show working tree changes |
| `gitStatus` | Show porcelain status |

Every handler wraps execution in try/catch. Errors return `ERROR <tool>: <message>` — deterministic strings the model reads to self-correct.

## Receipt format

```json
{
  "summary": "One-line description",
  "filesChanged": ["src/foo.ts", "test/foo.test.ts"],
  "verification": {
    "build": "pass",
    "lint": "pass",
    "unit": "pass",
    "integration": "skipped"
  },
  "notes": "Optional caveats"
}
```

## Releasing

CD runs on merge to `main`: `heronlabs/action-tag-release-build@v5` bumps version from Conventional Commits, syncs `plugin.json` + `marketplace.json`, tags, releases.

1. Edit source, open PR.
2. **Don't hand-bump `version`** — CD owns it. Bump inferred from merge commit.
3. Merge. CD handles the rest.

<!-- supera:guardrails -->
## Working with this repo (managed by /start — edits between these markers are overwritten on re-run)

- **Edit, don't rewrite.** Change only the needed entry in a config/generated file; preserve the rest.
- **No scope creep.** Build only what was asked.
- **TypeScript strict mode.** All types explicit.
- **Scope a change to where it belongs** — most changes are localized to one area.
<!-- /supera:guardrails -->
