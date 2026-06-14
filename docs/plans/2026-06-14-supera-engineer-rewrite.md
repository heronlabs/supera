# supera-engineer rewrite + host guardrails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sharpen `supera-engineer` against the usage report's measured frictions, and ship the host guardrails into every supera repo via `supera-init`.

**Architecture:** Two parts. Part 1 edits one agent file (`agents/supera-engineer.md`) — frontmatter + four body changes. Part 2 adds one step to `skills/supera-init/SKILL.md` (write a marker-delimited guardrail block into the target repo's `CLAUDE.md`) and a personal-recipes doc. Close with a version bump. No schema or other skill changes.

**Tech Stack:** Markdown agent/skill bodies; `scripts/check-consistency.sh` (bash + jq + grep) is the regression gate; `jq` reads the manifests.

**Spec:** [`../specs/2026-06-14-supera-engineer-rewrite.md`](../specs/2026-06-14-supera-engineer-rewrite.md).

**Conventions for this plan:** This is a docs/config repo with no unit-test runner. The "test" for each task is a **grep assertion** (define it, confirm it's red before the edit, green after) plus `scripts/check-consistency.sh` staying green. Commits use the repo's terse style — single-line conventional subject, **no `Co-Authored-By` trailer** (matches this repo's git log).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `agents/supera-engineer.md` | Modify (Tasks 1–5) | The implementer agent. Frontmatter (tools/model) + body (prime directive, ambiguity, anti-fake-green, STATUS token). |
| `skills/supera-init/SKILL.md` | Modify (Task 6) | Add step 5: write the guardrail block into the target repo's `CLAUDE.md`. |
| `docs/recommended-host-config.md` | Create (Task 7) | Personal host recipes: global CLAUDE.md block, auto-format hook, Context7. |
| `.claude-plugin/plugin.json` | Modify (Task 8) | `version` 0.4.2 → 0.5.0. |
| `.claude-plugin/marketplace.json` | Modify (Task 8) | `version` 0.4.2 → 0.5.0 (identical). |
| `docs/README.md` | Already edited (spec step) | Index row for this feature — committed with the planning docs. |

Tasks 1–5 all touch the same file but are independent edits; each commits separately for a clean history. Task 8 (version) goes last so the bump reflects the completed behaviour change.

---

## Task 1: Engineer frontmatter — curated tools + pinned model

**Files:**
- Modify: `agents/supera-engineer.md:4` (the `tools:` line)

- [ ] **Step 1: Write the failing assertions**

Run: `grep -nE '^(tools: \[Read|model: opus)' agents/supera-engineer.md`
Expected now: **no output** (red — neither line exists yet).

- [ ] **Step 2: Apply the edit**

Replace the frontmatter `tools` line:

```
tools: ["*"]
```

with the curated allowlist plus a pinned model (omitting `Agent` makes the single-implementer invariant structural — the engineer cannot spawn sub-engineers):

```
tools: [Read, Write, Edit, Bash, Grep, Glob, TodoWrite, Skill]
model: opus
```

- [ ] **Step 3: Verify the assertions pass**

Run: `grep -nE '^(tools: \[Read|model: opus)' agents/supera-engineer.md`
Expected: **two lines** (the new `tools:` line and `model: opus`).

Run: `grep -c '"\*"' agents/supera-engineer.md`
Expected: `0` (the old `["*"]` is gone).

Run: `grep -c 'Agent' agents/supera-engineer.md`
Expected: `0` (no `Agent` tool granted — also confirms no stray mention).

- [ ] **Step 4: Verify the gate still passes**

Run: `bash scripts/check-consistency.sh`
Expected: `OK(1)` … `OK(4)` (all four).

- [ ] **Step 5: Commit**

```bash
git add agents/supera-engineer.md
git commit -m "feat: curate engineer tools, pin model: opus"
```

---

## Task 2: Engineer body — "Prime directive" scope block

**Files:**
- Modify: `agents/supera-engineer.md` (insert after the intro paragraph, before `## Process`)

- [ ] **Step 1: Write the failing assertion**

Run: `grep -c 'Prime directive' agents/supera-engineer.md`
Expected now: `0` (red).

- [ ] **Step 2: Apply the edit**

Find this line (the end of the intro, currently around line 12):

```
You will be given: the task description, the worktree path, and (usually) the path to `.claude/supera.json`. If any is missing, find it: the config is at `<repo-root>/.claude/supera.json`.
```

Insert immediately **after** it (a blank line, then the block):

```markdown
## Prime directive — read before touching anything

**The #1 way this role fails is doing too much.** Before any edit, hold these:

- **Smallest viable change.** Surgical edits, never a from-scratch rewrite of a file that already exists — *especially* config/generated files (`package.json`, `tsconfig`, lockfiles, manifests, CI yaml): change the one entry in place and preserve everything else. To add one line, add one line.
- **No speculative abstraction.** No wrapper, layer, option, or indirection the ticket didn't ask for. When two solutions both work, ship the smaller one.
- **Nothing outside the ticket's scope changes.** Restate the in-scope boundary to yourself in one line before editing. Pre-existing unrelated failures: flag them, don't fix them.
- **You run headless — you cannot ask the user.** Proceed on the most reasonable reading and record the assumption (see step 2); escalate only a genuinely expensive-to-undo fork, via a `needs-review` receipt.
```

- [ ] **Step 3: Verify the assertion passes**

Run: `grep -c 'Prime directive' agents/supera-engineer.md`
Expected: `1`.

Run: `grep -n '## Process' agents/supera-engineer.md`
Expected: one match, on a line **after** the Prime directive block (block precedes the process).

- [ ] **Step 4: Verify the gate**

Run: `bash scripts/check-consistency.sh`
Expected: all four `OK`.

- [ ] **Step 5: Commit**

```bash
git add agents/supera-engineer.md
git commit -m "feat: hoist engineer scope discipline to a prime directive"
```

---

## Task 3: Engineer step 2 — ambiguity-as-restatement (headless)

**Files:**
- Modify: `agents/supera-engineer.md` (the `### 2 — Plan internally` section)

- [ ] **Step 1: Write the failing assertion**

Run: `grep -c 'cannot ask the user' agents/supera-engineer.md`
Expected now: `0` (red). (The old text invokes `superpowers:brainstorming`, which a subagent can't drive for user dialogue.)

- [ ] **Step 2: Apply the edit**

Replace this exact block:

```
### 2 — Plan internally

Form a concrete plan: which files change, what the new behaviour is, how you'll prove it. If the ticket is genuinely ambiguous (two reasonable interpretations that lead to different code), invoke the `superpowers:brainstorming` skill to resolve intent before writing — do **not** guess on a fork that's expensive to undo. If it's clear, proceed.
```

with:

```
### 2 — Plan internally

Form a concrete plan: which files change, what the new behaviour is, how you'll prove it.

You run headless and **cannot ask the user.** For ordinary ambiguity, choose the most reasonable interpretation consistent with the repo's existing conventions, **state the assumption** in your receipt's *Decisions / assumptions* section, and proceed. Be especially careful with ambiguous **literals** — config keys, IDs, and env names can be literal values, not mappings (e.g. `environment: pulumi` may name a GitHub Environment literally called `pulumi`); say which reading you took. Only when a fork is genuinely expensive to undo **and** has two materially different outcomes: stop and return a `STATUS: needs-review` receipt naming the fork, rather than guessing.
```

- [ ] **Step 3: Verify the assertions**

Run: `grep -c 'cannot ask the user' agents/supera-engineer.md`
Expected: `1`.

Run: `grep -c 'superpowers:brainstorming' agents/supera-engineer.md`
Expected: `0` (the un-runnable invocation is gone).

Run: `grep -cE 'superpowers:(test-driven-development|systematic-debugging|verification-before-completion)' agents/supera-engineer.md`
Expected: `3` (the three subagent-safe skill invocations are untouched).

- [ ] **Step 4: Verify the gate**

Run: `bash scripts/check-consistency.sh`
Expected: all four `OK`.

- [ ] **Step 5: Commit**

```bash
git add agents/supera-engineer.md
git commit -m "feat: replace engineer ask-user branch with headless restatement"
```

---

## Task 4: Engineer — anti-fake-green rule

**Files:**
- Modify: `agents/supera-engineer.md` (step 4 self-verify, and the Rules list)

- [ ] **Step 1: Write the failing assertion**

Run: `grep -c 'fake green' agents/supera-engineer.md`
Expected now: `0` (red).

- [ ] **Step 2: Add the rule to step 4**

Find this exact paragraph (end of `### 4 — Self-verify`):

```
Read the real output. Fix until green. **Never claim done without showing the command output.** If a check has no command in config, say so rather than inventing one. Resolve mechanical lint/format failures yourself before returning — formatter diffs, import ordering, JSON/YAML key sorting are the cheapest CI failures to prevent and the most wasteful to bounce off CI.
```

Insert immediately **after** it (blank line, then):

```markdown
**Never fake green.** Do not delete, skip, `xfail`, or weaken a test; do not loosen an assertion; do not suppress, swallow, or wrap an error to make a check pass. A check is "passing" only when the underlying behaviour is correct. If you cannot make it genuinely pass within scope, stop and return it red — with the command output and what's blocking it.
```

- [ ] **Step 3: Add the matching Rules bullet**

Find this exact line in the `## Rules` list:

```
- Evidence before assertions: a check is "passing" only after you've seen it pass in this session.
```

Insert immediately **after** it:

```
- Never fake green: no deleted or weakened tests, loosened assertions, or swallowed errors to pass a check. Genuinely green, or reported red.
```

- [ ] **Step 4: Verify the assertions**

Run: `grep -c 'fake green' agents/supera-engineer.md`
Expected: `2` (the step-4 paragraph + the Rules bullet).

- [ ] **Step 5: Verify the gate**

Run: `bash scripts/check-consistency.sh`
Expected: all four `OK`.

- [ ] **Step 6: Commit**

```bash
git add agents/supera-engineer.md
git commit -m "feat: forbid faking green in engineer self-verify"
```

---

## Task 5: Engineer — STATUS token in the receipt

**Files:**
- Modify: `agents/supera-engineer.md` (step 5 receipt template + a closing line)

- [ ] **Step 1: Write the failing assertion**

Run: `grep -c 'STATUS: ok' agents/supera-engineer.md`
Expected now: `0` (red).

- [ ] **Step 2: Apply the edit**

Find the end of the receipt template — this exact block, including the closing fence:

````
### Out of scope / follow-ups
- <flagged WIP failures, deferred work — empty if none>
```
````

Replace it with (adds the STATUS lines inside the code block, then a closing instruction after the fence):

````
### Out of scope / follow-ups
- <flagged WIP failures, deferred work — empty if none>

STATUS: ok            # in-scope, verified green, complete
# STATUS: needs-review  # proceeded, but a flagged fork/assumption needs a human glance, or a check couldn't be run
# STATUS: blocked       # hard blocker; work is incomplete
```

End with exactly one `STATUS:` line (uncomment the one that fits). It is the machine-readable verdict the orchestrator — and a session resuming your work — reads first.
````

- [ ] **Step 3: Verify the assertions**

Run: `grep -c 'STATUS: ok' agents/supera-engineer.md`
Expected: `1`.

Run: `grep -cE 'STATUS: (needs-review|blocked)' agents/supera-engineer.md`
Expected: `2`.

- [ ] **Step 4: Verify the gate (token must not trip check 2)**

Run: `bash scripts/check-consistency.sh`
Expected: all four `OK` — confirms the colon-form `STATUS:` is not read as a `status="…"` literal.

- [ ] **Step 5: Commit**

```bash
git add agents/supera-engineer.md
git commit -m "feat: add STATUS verdict token to engineer receipt"
```

---

## Task 6: supera-init — write guardrails into the repo's CLAUDE.md

**Files:**
- Modify: `skills/supera-init/SKILL.md` (insert a new step 5 before Report; renumber Report → 6; add a Rules bullet)

- [ ] **Step 1: Write the failing assertion**

Run: `grep -c 'supera:guardrails' skills/supera-init/SKILL.md`
Expected now: `0` (red).

- [ ] **Step 2: Insert the new step**

Find the current Report heading:

```
## 5 — Report
```

Insert the following **before** it, then change that heading to `## 6 — Report`:

`````markdown
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
- **ClickUp list IDs come from the hierarchy** (workspace → space → folder → list); never the team/workspace ID.
<!-- /supera:guardrails -->
````

Apply it like this:
- **No `CLAUDE.md`** → create it containing the block.
- **`CLAUDE.md` exists without the markers** → show the block and confirm (same courtesy as overwriting `supera.json`), then **append** it after the existing content — never modify what is already there.
- **Markers already present** → replace only the text between `<!-- supera:guardrails -->` and `<!-- /supera:guardrails -->`; leave everything else untouched (idempotent re-init).
- **Drop the ClickUp line entirely when `clickup` is `null`** (ticket-less repos) — that gotcha only applies when this repo uses ClickUp.
`````

- [ ] **Step 3: Add the Rules bullet**

Find this exact line in the `## Rules` list:

```
- Output must validate against `schema/supera.schema.json`.
```

Insert immediately **after** it:

```
- The CLAUDE.md guardrail block is marker-delimited and idempotent: create or refresh only between the `<!-- supera:guardrails -->` markers, never touch content outside them, and drop the ClickUp line when `clickup` is null.
```

- [ ] **Step 4: Verify the assertions**

Run: `grep -c 'supera:guardrails' skills/supera-init/SKILL.md`
Expected: `4` (open + close marker in the template, plus two references in the prose/Rules).

Run: `grep -nE '^## [0-9] —' skills/supera-init/SKILL.md`
Expected: steps `1`–`6` in order, ending with `## 6 — Report` (no duplicate `## 5`).

- [ ] **Step 5: Verify the gate (new prose must stay clean)**

Run: `bash scripts/check-consistency.sh`
Expected: all four `OK` — confirms the new block adds no `status="…"` literal and no `/resume|/finish|/pause` reference.

- [ ] **Step 6: Commit**

```bash
git add skills/supera-init/SKILL.md
git commit -m "feat: supera-init writes guardrails into repo CLAUDE.md"
```

---

## Task 7: New doc — recommended host config

**Files:**
- Create: `docs/recommended-host-config.md`

- [ ] **Step 1: Write the failing assertion**

Run: `test -f docs/recommended-host-config.md && echo EXISTS || echo MISSING`
Expected now: `MISSING` (red).

- [ ] **Step 2: Create the file**

Write `docs/recommended-host-config.md` with exactly this content:

````markdown
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
````

- [ ] **Step 3: Verify the assertions**

Run: `test -f docs/recommended-host-config.md && echo EXISTS`
Expected: `EXISTS`.

Run: `grep -c 'PostToolUse' docs/recommended-host-config.md`
Expected: `1`.

- [ ] **Step 4: Commit**

```bash
git add docs/recommended-host-config.md
git commit -m "docs: add recommended host config recipes"
```

---

## Task 8: Version bump → 0.5.0

**Files:**
- Modify: `.claude-plugin/plugin.json` (the `version` field)
- Modify: `.claude-plugin/marketplace.json` (`plugins[0].version`)

- [ ] **Step 1: Write the failing assertion**

Run: `jq -r '.version' .claude-plugin/plugin.json`
Expected now: `0.4.2` (red — not yet bumped).

- [ ] **Step 2: Bump both manifests**

In `.claude-plugin/plugin.json`, change `"version": "0.4.2"` to `"version": "0.5.0"`.
In `.claude-plugin/marketplace.json`, change `"version": "0.4.2"` to `"version": "0.5.0"` (inside `plugins[0]`).

- [ ] **Step 3: Verify versions match at 0.5.0**

Run: `jq -r '.version' .claude-plugin/plugin.json; jq -r '.plugins[0].version' .claude-plugin/marketplace.json`
Expected: two lines, both `0.5.0`.

- [ ] **Step 4: Verify the gate (check 1 = version sync)**

Run: `bash scripts/check-consistency.sh`
Expected: `OK(1): versions match (0.5.0)` and `OK(2)`–`OK(4)`.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump to 0.5.0"
```

---

## Final verification (after all tasks)

- [ ] Run `bash scripts/check-consistency.sh` → all four `OK`, version `0.5.0`.
- [ ] Run `git log --oneline -9` → the eight task commits + the planning-docs commit, in order.
- [ ] Update the `docs/README.md` index row status from 🔲 Proposed to ✅ Shipped v0.5.0 (with commit range), and flip the spec's `**Status:**` line to match.

---

## Self-Review (filled in by the planner)

**1. Spec coverage** — every spec section maps to a task:
- §3.1 frontmatter (D4/D5) → Task 1. §3.2 prime directive (D1) → Task 2. §3.4 ambiguity (D3) → Task 3. §3.3 anti-fake-green (D2) → Task 4. §3.5 STATUS token (D6) → Task 5. §4.2 supera-init guardrails (D11) → Task 6. §4.3–4.5 personal recipes → Task 7. §7 release / D10 version → Task 8 + Final verification. §3.6 "unchanged" items are honoured (no task removes the 5-step process, TDD, no-base-commit, or the no-Co-Authored-By rule). D7/D8 (Context7 & hook stay personal) → Task 7, with no engineer wiring.
- **Gap check:** §6 lists "/ship consuming the STATUS token" as out of scope — correctly **no task** for it. ✓

**2. Placeholder scan** — no `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every edit shows exact old/new text; every verification shows an exact command + expected output. ✓

**3. Consistency** — the `STATUS:` token form (`STATUS: ok`, colon) is used identically in Task 5 and §3.5 of the spec; the `<!-- supera:guardrails -->` marker string is identical in Task 6, the spec §4.2, and the verification greps; the guardrail bullets in Task 6 (project) and Task 7 (global) are deliberately parallel, not contradictory. Version `0.5.0` is identical across Task 8 and the manifests. ✓
