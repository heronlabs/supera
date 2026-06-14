# supera docs — index & source of truth

This is the **one place** to learn the status of every design record and plan. If a
doc's own header and this table disagree, **this table wins** — fix the doc.

## Layout

```
docs/
  README.md   <- you are here: status of everything + spec↔plan map
  specs/      <- design records: the WHAT and WHY (durable, one per feature)
  plans/      <- implementation plans: the HOW, task-by-task checklists
```

A feature usually has **one spec + one plan**, same date+slug. The spec is the
decision record; the plan is the execution checklist an agent runs via
`superpowers:executing-plans`. Keep them paired — when one changes materially,
reconcile the other or mark it superseded here.

## Status of every doc

| Feature | Spec | Plan | Status (truth) |
|---|---|---|---|
| **Core design** | [`supera-design`](specs/2026-05-29-supera-design.md) | — | ✅ **Shipped v0.1.0.** The foundation: plugin form factor, `supera-init`, config-driven skills, single `supera-engineer`. Accurate. |
| **Status lifecycle + solo-dev trim** | [`status-lifecycle`](specs/2026-06-07-supera-status-lifecycle.md) | [`status-lifecycle`](plans/2026-06-07-supera-status-lifecycle.md) | ✅ **Shipped v0.4.0** (commits `c7e5e21`→`36f1876`). Fixed the `completed`-before-`in review` bug, made status names config-driven (`clickup.statuses`), folded `/pause`+`/resume`+`/finish` into an idempotent `/ship`, dropped assignee + timer, added the `consistency.yml` CI gate. |
| **Pause / resume / finish skills** | [`lifecycle-skills`](specs/2026-05-30-supera-lifecycle-skills.md) | — | ⚠️ **SUPERSEDED** by status-lifecycle. Proposed the three as standalone skills; they were folded into `/ship` and **deleted** (`603d924`). Design-history only — do not implement. |
| **Autonomy & supply-chain roadmap** | [`autonomy-roadmap`](specs/2026-05-30-supera-autonomy-roadmap.md) | — | 🔲 **Proposed, 0% built.** Move the loop off the laptop (GitHub Actions). Phases 0–3 + deferred fleet. **Nothing here exists yet** — the only workflow in the repo is the bash consistency gate. This is the real unbuilt value. |
| **ClickUp REST shim** | [`clickup-rest-shim-design`](specs/2026-06-07-clickup-rest-shim-design.md) | [`clickup-rest-shim`](plans/2026-06-07-clickup-rest-shim.md) | 🧊 **Deferred (iceboxed 2026-06-08).** Unblocked (its precondition merged) but **no consumer exists** — the headless `/ship`/`/pr-watch` it serves are unbuilt. Revisit when autonomy Phase 1/2 lands a workflow that needs ClickUp-from-CI. |
| **Engineer rewrite + host guardrails** | [`engineer-rewrite`](specs/2026-06-14-supera-engineer-rewrite.md) | — | 🔲 **Proposed (2026-06-14).** Approved Phases A+B of the usage-report master plan. Part 1: sharpen `supera-engineer` (top-of-body scope "prime directive", anti-fake-green, headless ambiguity handling, curated `tools` + pinned `model: opus`, `STATUS` receipt token). Part 2: ship the guardrail block into each repo's `CLAUDE.md` via `supera-init`, plus personal recipes (global CLAUDE.md, auto-format hook, optional Context7). No schema change; `supera-init` updated. Bump → 0.5.0. Phases C (autonomy) + D (auditor) deferred. |

Legend: ✅ shipped · ⚠️ superseded · 🔲 proposed/unstarted · 🧊 deferred.

## Honest state of the roadmap (2026-06-08)

**What's solid.** The lifecycle is shipped and coherent: one `/ship` owns the whole
ladder, status names are config-driven, the consistency gate enforces the
"schema↔skills stay in sync" invariant in code instead of by discipline. v0.4.0 is
a clean resting point.

**Where the leverage actually is — and isn't.** The highest-value idea on the board
is `autonomy-roadmap`: *move the loop off the laptop* so `/pr-watch` survives a
closed terminal and the supply-chain auditor (today a **dead capability — nothing
triggers it**) actually runs. That work is **0% built**. Meanwhile effort has gone
into status-naming polish and the ClickUp REST shim — plumbing, not leverage.

**The shim is a part with no socket.** Its spec names headless `/ship` and `/pr-watch`
as consumers; neither exists. A ~250-line zero-dep script carries a 265-line spec and
a 1087-line plan that visibly argue with earlier drafts of themselves. It's been
over-deliberated relative to its payoff. Iceboxed until a real CI consumer needs it.

**Recommended next step (not yet a plan):** start `autonomy-roadmap` **Phase 0**
(structured `supera-engineer` receipt + `--non-interactive` semantics + durable
pr-watch state) then **Phase 1** (the agentic supply-chain audit workflow — turns the
one dead capability live on a cron). Those unlock everything else, including giving
the shim a reason to exist. Write a plan for Phase 0/1 before touching the shim.

## Conventions

- **Filenames:** `YYYY-MM-DD-<slug>.md`, same slug across the spec/plan pair.
- **Status header:** every doc carries a `**Status:**` line; it must agree with this
  table. On a status change, edit both.
- **Superseded docs stay** (history is valuable) but get a banner pointing forward.
- New design work: write the **spec** first (`specs/`), then a **plan** (`plans/`)
  when ready to build, then add a row here.
