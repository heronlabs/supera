# Supera — autonomy & supply-chain roadmap

**Date:** 2026-05-30
**Status:** Proposed (design record; no code change in this revision)

## Problem

Supera ships well from the terminal, but it is a **power tool, not yet a superagent**:

1. **No durable autonomy.** `/pr-watch` "babysits" via `ScheduleWakeup`, which only lives while
   the interactive laptop session is alive. Close the terminal → the loop dies. Every run needs
   a human pressing a button and waiting.
2. **Supply chain is "run on demand" = never runs.** The `supera-supply-chain-auditor` agent
   exists and is gated by `audits.supplyChain`, but nothing triggers it. A dead capability.
3. **Soft contracts.** The `supera-engineer` receipt is prose; orchestrators scrape it ad-hoc.
   `/pr-watch` keeps no real attempt-state across hops. Fine at small scale; cracks under autonomy.

## Goal

Move the loop **off the laptop**: event-driven, server-side execution so audits run, CI gets
fixed, and PRs get watched without a human present — starting with the one capability that is
both highest-ROI and currently dead: agentic supply-chain auditing in CI.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Runtime | GitHub Actions via the official `anthropics/claude-code-action`. |
| 2 | Supply-chain in CI | **Agentic** — Claude runs `supera-supply-chain-auditor`, triages, applies safe overrides, opens a PR + prioritized issue. No plain-audit hot path. |
| 3 | Cost discipline | Agentic jobs run on `schedule` (cron) / explicit label / `workflow_dispatch` only — **never** on the per-PR hot path. |
| 4 | Fleet (multi-repo) | **Deferred.** Prove the single-repo autonomous loop first. |

## Hard caveat — ClickUp MCP is absent in CI

ClickUp runs through `mcp__claude_ai_ClickUp`, a **claude.ai-authenticated MCP server**. In
headless / GitHub Actions / cron runs that server is **not available**. Therefore:

- CI-side jobs cannot touch ClickUp via MCP.
- Any ticket sync from CI must use **ClickUp REST + an API-token secret**, or stay laptop-side.
- The autonomy phases below stay **git/GitHub-native** (ticket-less mode, already a first-class
  supera invariant). ClickUp-from-CI is an explicit later sub-step requiring the REST shim.

## Phases (ranked by leverage)

### Phase 0 — Contracts & headless readiness (foundation)
Autonomy is impossible until skills run non-interactively and emit parseable output.
- **Structured receipt:** promote `supera-engineer`'s receipt to a JSON schema
  (`schema/receipt.schema.json`) so orchestrators and CI parse PASS/FAIL deterministically.
- **Headless semantics:** define `--non-interactive` for `/ship` and `/pr-watch` — no
  `AskUserQuestion`; ambiguous decisions become a PR/issue comment + a `blocked` exit.
- **Durable pr-watch state:** persist attempt-count / last-failure-signature to the PR (hidden
  marker comment or `.supera/state`) so a fresh CI invocation resumes the loop.
- **Schema additions:** `ci` block (provider, native audit commands) and `automation` block
  (enabled triggers). Schema-first, per the sync invariant.

### Phase 1 — Agentic supply-chain audit (the pilot)
- `.github/workflows/supera-audit.yml`: `claude-code-action` headless invoking
  `supera-supply-chain-auditor` — detect manager, run native audit, triage, apply safe CVE
  overrides on a branch, open a PR + a prioritized issue (CVEs applied → unfixable → secrets →
  drift → freshness → typo-squat).
- **Triggers:** weekly `schedule` + `workflow_dispatch` + optional `supera:audit` label.
  Not on every PR (Decision 3).
- `supera-init` writes the workflow file when `audits.supplyChain` is true.
- Secret: `ANTHROPIC_API_KEY` (per-repo or org). Permissions: `contents:write`,
  `pull-requests:write`, `issues:write`.
- **Cost note:** pure-agentic spends tokens per run; bound by cadence (weekly) and the auditor's
  graceful degradation on probe failure.

### Phase 2 — PR autonomy (pr-watch off the laptop)
- `.github/workflows/supera-pr-watch.yml`: on `pull_request` + `check_suite: completed` →
  headless pr-watch (fix CI via engineer, address review threads, run review fan-out). GH events
  replace `ScheduleWakeup`; interactive `/pr-watch` stays for local use (additive).
- **Review fan-out:** wire the already-installed `pr-review-toolkit` agents
  (`silent-failure-hunter`, `type-design-analyzer`, `pr-test-analyzer`) via the `Workflow`
  primitive — parallel lenses per PR instead of one `code-review` pass. The concrete
  "more value per run" lever.

### Phase 3 — Issue/label-driven ship
- `.github/workflows/supera-ship.yml`: on issue labeled `supera:ship` → headless `/ship`,
  producing an open PR with zero terminal. ClickUp-triggered ship waits on the REST shim.

## Deferred — Fleet control plane (future direction)

Out of near-term scope; recorded so it isn't lost:
- A registry of repos + ClickUp lists + audit cadence (home TBD: separate private repo vs
  central manifest).
- Scheduled cross-repo fan-out (matrix → repo-dispatch; needs a PAT/App).
- A cross-repo digest (green-and-ready PRs, new CVEs, blocked tickets) → ClickUp/Slack — the
  "multiple projects" dashboard.
- Audit-history persistence for CVE trend over time.

**Why deferred:** autonomy value must be proven per-repo before adding a control plane, and the
ClickUp-MCP-in-CI caveat must be solved first.

## Invariants preserved

1. Nothing repo-specific is hardcoded — new values (`ci`, `automation`, workflow paths) go in
   the schema first.
2. `supera-engineer` stays the only implementer; CI jobs orchestrate and delegate, never edit
   app code directly.
3. Ticket-less stays first-class — CI defaults to it; ClickUp sync from CI is opt-in via REST.
4. CI is the quality gate; the engineer self-verifies as pre-flight only.
5. Schema and skills stay in sync.

## Risks

- **Token cost** in CI — mitigated by Decision 3 (agentic on cron/label only).
- **`claude-code-action` permissions** — needs `contents:write`, `pull-requests:write`,
  `issues:write`; secret management per repo or org.
- **ScheduleWakeup → GH events** — keep local `/pr-watch` for interactive use; CI is additive.
- **ClickUp absent in CI** — see caveat; gates Phase 3 ClickUp triggers and the fleet digest.
