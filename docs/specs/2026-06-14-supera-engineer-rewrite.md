# supera-engineer rewrite + host guardrails

**Date:** 2026-06-14
**Status:** ✅ Shipped v0.5.0 (commits `e3c5c7e`→`2a7c5e4`). Plan: [`../plans/2026-06-14-supera-engineer-rewrite.md`](../plans/2026-06-14-supera-engineer-rewrite.md).
**Scope:**
- **In repo (the PR):** `agents/supera-engineer.md` (rewrite), `skills/supera-init/SKILL.md` (write a guardrail block into the target repo's `CLAUDE.md`), new `docs/recommended-host-config.md`, `docs/README.md` (index row), `version` bump in `plugin.json` + `marketplace.json`.
- **Out of repo (personal recipes the user applies on his machine, documented in the new docs page):** global `~/.claude/CLAUDE.md` guardrail block; a `PostToolUse` auto-format hook in `.claude/settings.json`; optional Context7 MCP install.

This is the approved **Phases A + B** of the master plan. Phases C (usage-limit resilience / off-laptop autonomy) and D (rebuild the supply-chain auditor) are deferred to their own specs.

---

## 1. Why (grounded in the usage report)

Source: the Claude Code Insights report `report-2026-06-14-162034.html` (2026-05-31 → 06-14): 1,493 messages, 151 sessions, 14 days. The friction it measured, ranked, with where each one actually lives:

| Report friction | Evidence | Lives in | Fixed by |
|---|---|---|---|
| **Over-scoping / excessive changes** (the #1 measured friction) | Rewrote a whole `package.json` to add deps; over-built a config-repo abstraction → reverted. `Excessive Changes`, `Wrong Approach ×4`, `User Rejected ×6`. | Both the **main thread** (direct edits: Bash 1216, Edit 185) **and** the engineer. | §4.1 (global guardrails) + §3.2 (hoist scope discipline in the engineer). |
| **Misread ambiguous literals** | `environment: pulumi` read as a mapping, not a GitHub Environment literally named `pulumi`. `Misunderstood ×4`. | Both. | §4.1 (global guardrails) + §3.4 (ambiguity-as-restatement, flag literals). |
| **Fake-green / buggy code** | `Buggy Code ×2`; quality bar is "all-green, no open threads." | The engineer. | §3.3 (anti-fake-green rule). |
| **ClickUp list-ID misuse** | Team/workspace ID used as a list ID → "Team not authorized." | Main thread. | §4.1 (ClickUp list-ID guardrail). |
| **Interruptions from usage limits** | A session died on a usage limit before a security review finished. | Long unattended sessions. | **Not solved here** — that's Phase C. §3.5 (STATUS token) is only a small down-payment: it makes a returned receipt machine-readable so a killed/handed-off run leaves a parseable state. |

**Honest framing.** The engineer is *already* decent on scope — it has merge-don't-rewrite and smallest-viable-change rules today (steps 3 + Rules). The biggest measured friction is cross-cutting and a large share of it happens on the **main thread**, which the engineer never touches. So an agent-only rewrite cannot capture the gains. This spec therefore has two parts:

- **Part 1 — sharpen the engineer** (the literal "rewrite the agent"): hoist + intensify what's there, and add the genuinely new behaviour (anti-fake-green, headless ambiguity handling, tight tool/model frontmatter, a status token).
- **Part 2 — host guardrails**: the report's four prescribed `CLAUDE.md` rules + two gotchas, **shipped into every supera repo's `CLAUDE.md` by `supera-init`** (plus personal recipes — global CLAUDE.md, an auto-format hook), so the *main thread* gets the same discipline the engineer does.

The engineer-relevant rules are baked into the agent (Part 1) **and** shipped to the repo's `CLAUDE.md` by `supera-init` (Part 2), so both the delegated engineer and the main thread are covered.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Hoist scope discipline to a top-of-body "Prime directive"** block, before the process steps, and make it forceful. | The strongest existing rules are buried in step 3 + the Rules list. Friction #1 deserves to be the first thing the agent reads. Mostly a re-org + intensify, not net-new. |
| **D2** | **Anti-fake-green rule (net-new):** never delete/skip/`xfail`/weaken a test, loosen an assertion, or suppress an error to make a check pass. A check passes only when the behaviour is correct; otherwise return it red. | Today's rules cover "evidence before assertions" and "report faithfully" but never explicitly forbid *gaming* the gate. Targets `Buggy Code` + the all-green bar. |
| **D3** | **Ambiguity-as-restatement (rewrites a dead instruction):** the engineer runs headless and cannot ask the user. Replace step 2's "invoke `superpowers:brainstorming`" (a subagent can't drive that user dialogue) with: proceed on the most reasonable reading, record the assumption in the receipt, and **flag ambiguous literals** (config keys, IDs, env names). Escalate only a genuinely expensive-to-undo fork via a `needs-review` receipt. | Matches the measured preference for reasonable-defaults + momentum over clarifying-question pauses, fixes an instruction that can't work from a subagent, and directly addresses the literal-misread friction. |
| **D4** | **Frontmatter: `tools: ["*"]` → curated allowlist** `[Read, Write, Edit, Bash, Grep, Glob, TodoWrite, Skill]`. **Omit `Agent`.** | Tight, deterministic surface. Omitting `Agent` enforces the single-implementer invariant in the manifest, not just by discipline — the engineer can't spawn sub-engineers; escalation to `nelson` stays the orchestrator's call. |
| **D5** | **Pin `model: opus`** (confirmed). | The engineer is the quality-critical implementer and the default is `inherit`, which silently downgrades quality when dispatched from a cheaper-model session. Trade-off: higher cost, accepted given the "all-green" bar. |
| **D6** | **Receipt gains a trailing machine-readable `STATUS: ok \| needs-review \| blocked` token.** The orchestrator *consuming* it is **out of scope** (a `/ship` follow-up). | Forward-compatible and human-useful now; gate-safe (`STATUS:` ≠ the `status="…"` literal the consistency gate forbids). Keeps Phase B a pure agent change — no skill edits. |
| **D7** | **Context7 is reframed:** NOT wired into the engineer; documented in Part 2 as an optional main-thread MCP. | The report shows **no** stale-library-API friction, so wiring it into the engineer solves a problem the data doesn't have. Coupling a pinned allowlist to an env-dependent MCP's tool names adds fragility for speculative benefit — violates smallest-viable-change. (This trims the originally-listed B.6; flagged here for veto.) |
| **D8** | **The auto-format hook ships as a personal `.claude/settings.json` recipe, not in the plugin.** | No `hooks/` surface exists in the plugin today; the engineer already self-formats before returning, so the hook's incremental value is on the **main thread's** direct edits. A stack-specific (`pnpm`) hook also contradicts supera's repo-agnostic invariant. Document it; don't ship it. |
| **D9** | **No schema change.** The only skill changed is **`supera-init`** (D11); all other skills and the schema are untouched. | Keeping Context7/the hook out of the plugin runtime (D7/D8) means no schema field is needed, and supera-init writing the guardrail block needs no new config. The schema↔skills sync burden stays nil. |
| **D10** | **Version bump `0.4.2 → 0.5.0`** (confirmed — the "major" of the two options, not patch `0.4.3`). | The engineer rewrite + supera-init guardrails are the most significant behavioural change since the lifecycle redesign. |
| **D11** | **`supera-init` writes a generic guardrail block into the target repo's `CLAUDE.md`** — additive, marker-delimited (`<!-- supera:guardrails -->`), idempotent; the ClickUp-list-ID line emitted only when `clickup.listId` is set. | Gives the host guardrails a *shipped* delivery path (the main thread in every supera repo gets them), not just a manual recipe. Additive + markers = never clobbers an existing `CLAUDE.md`; re-init refreshes only between markers. |

---

## 3. Part 1 — the engineer rewrite (`agents/supera-engineer.md`)

### 3.1 Frontmatter (D4, D5)

```yaml
---
name: supera-engineer
description: <unchanged>
tools: [Read, Write, Edit, Bash, Grep, Glob, TodoWrite, Skill]
model: opus
---
```

- `Bash` (git, verify commands), `Read/Write/Edit` (code), `Grep/Glob` (orient), `TodoWrite` (tracking), `Skill` (the superpowers it invokes: TDD, systematic-debugging, verification-before-completion). That's the complete set it uses.
- **No `Agent`** — single-implementer invariant.
- **No web/MCP** — deterministic core (see D7 on Context7).

### 3.2 New "Prime directive" block (D1) — top of body, before the process

A short, forceful block hoisting the scope rules that are today scattered through step 3 + Rules:

- **Smallest viable change.** Surgical edits, never a from-scratch rewrite of a file that already exists — *especially* config/generated files (`package.json`, `tsconfig`, lockfiles, manifests, CI yaml): change the one entry in place; preserve everything else.
- **No speculative abstraction.** No wrapper, layer, option, or indirection the ticket didn't ask for. The simpler of two working solutions wins.
- **Nothing outside the ticket's scope changes.** Restate the in-scope boundary in one line before editing. Pre-existing unrelated failures: flag, don't fix.
- **You run headless — you cannot ask the user** (see §3.4).

### 3.3 Anti-fake-green (D2) — added to Rules + the self-verify gate (step 4)

> Never delete, skip, `xfail`, or weaken a test; never loosen an assertion; never suppress, swallow, or `try/except`-around an error to make a check pass. A check is "passing" only when the underlying behaviour is correct. If you cannot make it genuinely pass within scope, stop and report it red, with the command output and what's blocking it — do not paper over it.

This strengthens the existing "evidence before assertions" / "report faithfully" rules with an explicit anti-gaming clause.

### 3.4 Ambiguity-as-restatement (D3) — rewrites step 2's ambiguity branch

Replace "If the ticket is genuinely ambiguous … invoke `superpowers:brainstorming`" with:

> You run headless and cannot ask the user. For ordinary ambiguity, choose the most reasonable interpretation consistent with the repo's existing conventions, **state the assumption** in your receipt's *Decisions / assumptions* section, and proceed. Be especially careful with ambiguous **literals** — config keys, IDs, and env names can be literal values, not mappings (e.g. `environment: pulumi` may name a GitHub Environment literally called `pulumi`); say which reading you took. Only when a fork is genuinely expensive to undo *and* has two materially different outcomes: stop and return a `STATUS: needs-review` receipt naming the fork, rather than guessing.

(`superpowers:test-driven-development`, `systematic-debugging`, and `verification-before-completion` invocations are **kept** — those don't need user dialogue and work fine from a subagent.)

### 3.5 STATUS token (D6) — appended to the receipt

Keep the existing prose receipt template (`## Implemented`, `### Files`, `### Verification`, `### Decisions / assumptions`, `### Out of scope`). Append one trailing line:

```
STATUS: ok            # in-scope, verified green, complete
# STATUS: needs-review  # proceeded, but a flagged fork/assumption needs a human glance, or a check couldn't be run
# STATUS: blocked       # hard blocker; work is incomplete
```

The orchestrator reading this token is a separate, small `/ship` change — **out of scope here** (see §6), so Part 1 stays a pure agent edit.

### 3.6 What is explicitly *unchanged*

The 5-step process (Orient → Plan → Implement-with-tests → Self-verify → Receipt), TDD-by-default, the verify-from-`supera.json` gate, the no-commit-to-base rule, the single-line conventional-commit subject with **no `Co-Authored-By` trailer**, and the receipt sections all stay. This is a sharpening, not a redesign of the contract — `/ship` still dispatches the same agent with the same external behaviour.

---

## 4. Part 2 — host guardrails (one block, multiple delivery points)

The guardrail content is defined once (§4.1). It reaches Claude two ways: **shipped** into every supera repo by `supera-init` (§4.2, the primary mechanism, D11), and as personal recipes the user applies on his machine (§4.3–4.5), documented in a new repo doc `docs/recommended-host-config.md`.

### 4.1 The guardrail block (canonical content)

The report's four prescribed rules + the two recurring gotchas:

- **Edit, don't rewrite** config/generated files — change only the needed entry; preserve the rest.
- **No scope creep** — build only what was asked; no speculative abstractions; flag-and-proceed-small instead of expanding silently.
- **Ambiguous literals: flag, don't guess silently** (the `environment: pulumi` case — a value, not a mapping).
- **Cross-repo changes: update all related repos** (e.g. `heronlabs` ↔ `cloud-iac-heronlabs`) unless told otherwise.
- **CI/infra settings live outside code** — GitHub Environment + branch-protection rules are in repo settings, not the yaml.
- **ClickUp list IDs come from the hierarchy** (workspace → space → folder → list); never the team/workspace ID. *(Emitted only when `clickup.listId` is set.)*

### 4.2 Shipped — `supera-init` writes it into the project `CLAUDE.md` (D11)

A new `supera-init` step (after "Confirm and write", before "Report") inserts §4.1 into the target repo's `CLAUDE.md`, delimited by markers:

```
<!-- supera:guardrails -->
## Working with this repo (managed by /supera-init — edits between these markers are overwritten on re-init)
…the §4.1 bullets…
<!-- /supera:guardrails -->
```

Behaviour:
- **No `CLAUDE.md`** → create it with the block.
- **`CLAUDE.md` exists, no markers** → show the block and confirm (matching the existing "ask before overwriting `supera.json`" rule), then **append** it — never touch existing content.
- **Markers present** → replace only the text between them (idempotent; re-init refreshes, never duplicates).
- The ClickUp line is included only when `clickup.listId` is set (ticket-less repos omit it) — consistent with "ticket-less is first-class."

This is what makes Part 2 *shipped*, not just advice: the main thread in every initialised repo gets the same discipline the engineer carries.

### 4.3 Personal — global `~/.claude/CLAUDE.md` (machine-wide)

The same §4.1 block, appended to the user's global file (today just `@RTK.md`) so it applies in repos that aren't supera-initialised too. Additive, not a rewrite (dogfooding the rule).

### 4.4 Personal — PostToolUse auto-format hook (D8)

A `.claude/settings.json` recipe for his TS/pnpm repos (stack-specific, hence per-repo, not plugin-shipped):

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write",
  "hooks": [ { "type": "command", "command": "pnpm -s lint --fix && pnpm -s format" } ] } ] } }
```

Value is on the **main thread's** direct edits (the engineer already self-formats). The docs page notes it runs after every Edit/Write and the command is per-stack.

### 4.5 Personal — Context7 MCP (optional, D7)

An optional main-thread MCP for current library docs — install per Context7's README; not wired into the engineer. The docs page records why (no measured staleness friction; keeps the engineer's allowlist clean).

---

## 5. Consistency gate (must stay green)

`scripts/check-consistency.sh` runs on every PR. Confirmed safe against this change:

1. **Version sync** — bump both manifests together (D10). ✓
2. **No raw status literals** — greps `status[[:space:]]*=[[:space:]]*"`. The new `STATUS: ok` token uses a colon, not `status="`, so it does **not** match. Neither the engineer rewrite nor the supera-init guardrail block introduces a `status="…"` literal. ✓
3. **STATUS.<key> ↔ schema** — unaffected; no `STATUS.<key>` references added. ✓
4. **No dead-skill refs** — neither the rewrite nor the supera-init guardrail block adds `/resume`, `/finish`, or `/pause` mentions. ✓

The gate scans `skills/` + `agents/`, so the new supera-init block is covered automatically.

---

## 6. Out of scope / non-goals

- **`/ship` consuming the `STATUS` token** — the natural next step, but a skill change; kept out so Phase B is a pure agent edit. Follow-up.
- **Usage-limit resilience / off-laptop autonomy** — Phase C, separate spec. A+B does not solve the killed-session friction.
- **Rebuilding the supply-chain auditor** (OSV-Scanner + Socket) — Phase D, separate spec.
- **Shipping the format hook or Context7 inside the plugin** — deliberately personal config (D7, D8). May be promoted later if a repo-agnostic, config-driven form proves worth the surface.
- **An opt-out flag for the supera-init guardrail write** (e.g. `init.guardrails: false`) — not needed now; re-init only refreshes between markers and a user can delete the block. Add a schema flag later only if it proves annoying.
- **Schema changes** — none. The only skill touched is `supera-init` (D11).

---

## 7. Release

1. Rewrite `agents/supera-engineer.md` (§3).
2. Add the guardrail-writing step to `skills/supera-init/SKILL.md` (§4.2).
3. Add `docs/recommended-host-config.md` (§4) and a row to `docs/README.md`.
4. Bump `version` 0.4.2 → 0.5.0 in `plugin.json` **and** `marketplace.json` (identical).
5. Run `scripts/check-consistency.sh` — expect all four OK.
6. Commit. Consumers pick it up on next `/plugin update`; re-running `/supera-init` adds the guardrail block to each repo's `CLAUDE.md`.
7. (User, separately) apply the personal recipes (§4.3–4.5) from the new docs page.
