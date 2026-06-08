# Supera ClickUp REST shim

**Date:** 2026-06-07
**Status:** 🧊 DEFERRED (iceboxed 2026-06-08) — technically *unblocked* (its hard precondition, the status-lifecycle redesign, merged in v0.4.0), but **no real consumer exists**: the only headless callers it names (`/ship`, `/pr-watch` in CI) are unbuilt, and the repo's sole workflow is `consistency.yml`. Building the REST twin now is a part with no socket. Revisit when [`2026-05-30-supera-autonomy-roadmap.md`](2026-05-30-supera-autonomy-roadmap.md) Phase 1/2 lands a workflow that actually needs ClickUp-from-CI. Plan: [`../plans/2026-06-07-clickup-rest-shim.md`](../plans/2026-06-07-clickup-rest-shim.md).
**Scope (this plugin PR):** new `scripts/clickup.mjs` (single-file, zero-dependency Node shim); per-call-site transport routing added to `skills/{ship,pr-watch}`; two new asserts in the lifecycle redesign's `scripts/check-consistency.sh`; `.env.example` + `.gitignore`; `CLAUDE.md` note; version bump.
**Explicitly NOT in this PR:** any schema change (the shim adds **zero** schema fields — §5); the GitHub workflow + secret wiring (that is **consumer-repo** infra owned by `supera-init`, a follow-up — §9, §12).
**Hard precondition:** the [status-lifecycle redesign](2026-06-07-supera-status-lifecycle.md) (commit `697e788`, **Approved**) must merge **first**. This shim consumes — never redefines — that redesign's `clickup.statuses` map and its `STATUS.<key>`-driven, MCP-named call sites.

---

## 1. Problem

supera's lifecycle skills reach ClickUp through the MCP server `mcp__claude_ai_ClickUp`, which is **claude.ai-authenticated and present only on the interactive laptop**. In any headless run — GitHub Actions via `anthropics/claude-code-action`, cron, the future fleet digest — that MCP server is **absent**, and an MCP tool is **model-invoked only** (a script cannot call it). So today every ClickUp write a headless skill would perform has no transport and silently does nothing. The autonomy roadmap names the fix exactly: *"Any ticket sync from CI must use ClickUp REST + an API-token secret."* This spec is that REST path.

**Who actually needs it (re-anchored).** The near-term headless consumers are narrower than "Phase 3" implies:

- **ClickUp-triggered `/ship`** and **headless `/pr-watch`** operate on an **existing** ticket and need `get-task`, `update-status`, and `comment`. These are the genuine near-term callers.
- The **issue/label-driven headless `/ship`** path stays **git/GitHub-native and ticket-less** — it never calls ClickUp, so it neither needs nor receives the token (this matters for the threat model, §6).
- `create-task` and `add-tags` have **no near-term headless trigger** (nothing headless creates or tags a ticket yet). They exist in the shim only so `/ship`'s single code path is **not forked** into a CI branch and a laptop branch. We say this plainly rather than implying a caller that does not exist.

Three constraints shape the design.

### 1.1 The MCP surface cannot be proxied from a script
A Bash/Node wrapper cannot invoke `mcp__claude_ai_ClickUp__*`. So the shim is not a universal proxy — it can only be a **drop-in REST twin** of the surviving MCP tool surface, selected per-environment. The indirection therefore lives at the *call-site* level (a per-call transport branch), not inside one executable (§4.2).

### 1.2 The op surface is tiny and already pruned
The lifecycle redesign drops time-tracking (D7) and assignee (D6). What survives headless is **exactly five ops**: `get-task`, `create-task`, `update-status`, `add-tags`, `comment`. No timers, no assignee resolve, no lists/folders/search. A heavyweight TS CLI for five `fetch` calls is gross overkill and reintroduces the toolchain supera deliberately has zero of.

### 1.3 A committed config file must not hold — or *route* — a secret
`.claude/supera.json` is committed **and PR-editable**. The `pk_` token must never live in it. The draft's instinct to add `clickup.tokenEnv` (which env var to read) and `clickup.apiBase` (where to send it) is worse than YAGNI: together they turn a PR-editable config into a **"read-any-env-var, POST-to-any-host" exfiltration gadget** (§6). The resolution is to add **no** config surface at all — hardcode the host and the env-var name in the shim (§4.1, §5). Transport selection keys on the token's **presence in the environment**, which is shell-testable from a markdown skill body and is the true capability gate.

---

## 2. Decisions (locked, revised from the draft per the four critique lenses)

| # | Decision |
|---|---|
| D1 | Headless ClickUp goes over **REST v2**; the laptop path stays **MCP**. Transport is chosen by **token-presence**, with an explicit **anti-silent guard** for the headless-without-token case (§4.2). |
| D2 | Shape = **(b) a single-file, zero-dependency Node `.mjs`** at `${CLAUDE_PLUGIN_ROOT}/scripts/clickup.mjs`, run as `node "…/clickup.mjs" <op>`. No build, no install, no `node_modules`. (Rejected: bash+curl — quoting-hell on JSON bodies; TS package — toolchain + private-npm + version-decoupling; composite action — wrong layer, can't be called mid-turn.) |
| D3 | The shim exposes **exactly five subcommands** mirroring the surviving MCP tools 1:1: `get-task`, `create-task`, `update-status`, `add-tags`, `comment`. Nothing else. |
| D4 | **No new config surface.** The shim hardcodes the host (`api.clickup.com`, https only) and the token env-var name (`CLICKUP_TOKEN`); it validates the resolved value matches `^pk_` before sending. **Zero schema fields are added** (§5). `listId` and the resolved `STATUS.<key>` names are passed in as **args** by the skill (which already reads them from `CONFIG` post-redesign). |
| D5 | **Routing wraps the redesign's *actual* call sites**, not an invented adapter vocabulary. The locked redesign emits MCP-tool literals with `STATUS.<key>` args (e.g. `clickup_update_task(status=STATUS.review)`). Each such call site in `ship`/`pr-watch` gets a per-call **`CU` branch**: `CU=rest` → `node clickup.mjs <op>` with the same args; else the existing MCP call, unchanged (§4.2). No call site is rewritten into new syntax; the approved spec is not re-opened. |
| D6 | **Status is name-driven, zero literals.** The shim sets verbatim the resolved value of `CONFIG.clickup.statuses.<key>` via ClickUp's plain-string `status` field. The shim hardcodes no status string. `create-task` omits `status` → ClickUp default `open`. |
| D7 | **Best-effort tagging, but no 404 conflation.** `add-tags` loops one `POST …/tag/{name}` per tag; a tag *genuinely absent from the space* is a non-fatal skip, but a **task-not-found** 404 hard-fails (§7). |
| D8 | **No prompts, ever.** The shim communicates only via **binary exit code** (0 = success/best-effort/idempotent no-op; non-zero = hard failure) + stderr. The response→behaviour table is **total** (§7); the *specific* ClickUp error rides stderr, not a wide exit-code taxonomy. |
| D9 | **No automatic retry/backoff in v1.** Any 429 / 5xx / network error is a loud hard-fail. This keeps non-idempotent `create-task`/`comment` from double-firing and keeps the file genuinely thin (so "line coverage + Stryker N/A" is honest — §8). Backoff is deferred to when the fleet digest can actually hit the rate limit. |
| D10 | The shim **must not expose** time-tracking or assignee endpoints (carries the lifecycle spec's D6/D7). Elapsed time reaches ClickUp only as git-derived **text inside `comment`**. |
| D11 | **The headless smoke test is the true correctness gate.** `node --test` over pure functions guards against regressions but **cannot** prove ClickUp accepts the requests (§8). Stryker is **N/A** — justified only because D9's cuts make the file thin. |
| D12 | **The token is never weaponizable from config and never sits in a prompt-injectable agent's shell.** Host + env-name are hardcoded (D4); a dedicated low-privilege `supera-bot` account is a **hard prerequisite**; untrusted-input triggers get no token (§6). |

---

## 3. Op surface

Five ops. Each is one REST endpoint, invoked from the call sites below — all already inside the `if clickup.listId / CLICKUP_TICKET set` guard. Status values are always the resolved `STATUS.<key>`; the shim never names a literal.

| Op (subcommand) | Args (MCP-parity names) | REST method + endpoint | Headless call-sites | Notes / gotchas |
|---|---|---|---|---|
| **get-task** | `task_id` | `GET /task/{task_id}` | `ship` §2 (read title+status as canonical description) | Parse `name` (title) + **`status.status`** (the NAME string — `status` is an object `{status,type,color,…}`, not a bare string). Emit `{id,name,status}` with `status` as the NAME. No `team_id` (native ids). |
| **create-task** | `list_id`, `name`, `status?`, `markdown_content`, `tags[]` | `POST /list/{list_id}/task` | *(no near-term headless caller — present for un-forking, §1)* | `list_id = CONFIG.clickup.listId`. **Omit `status`** → ClickUp default `open`. Body field is **`markdown_content`** *(precondition: confirm vs `markdown_description` against the live API — §8)*. `tags` is a JSON **array** (the one place it is). **Hard-fail on any 2xx whose body lacks a usable `id`** — never return success with an empty handle (§7). |
| **update-status** | `task_id`, `status` | `PUT /task/{task_id}` body `{"status":"<name>"}` | `ship` §4 `building`, §5 `review` (the core fix), close-out `closed`; `pr-watch` `review`-assert / `blocked` / `rejected` | `status` is a **plain string**, name-matched, NOT an id/object. Unknown name → 400 `Status not found`. **Idempotent** — re-setting the current status is a no-op success. *(Precondition: confirm case-folding — board statuses are UPPERCASE, schema defaults lowercase — §8.)* |
| **add-tags** | `task_id`, `tags[]` | `POST /task/{task_id}/tag/{tag_name}` **per tag** | `ship` §5 (tags from changed paths) | **No tags array on update** — loop one POST per tag; URL-encode the name (`%20`). A 404 must be **disambiguated by `ECODE`/`err`**: *tag-not-in-space* → non-fatal skip (exit 0); *task-not-found* → hard-fail (§7). Confirm the task exists once (the `ship` flow already did `get-task` in §2) before the loop. |
| **comment** | `task_id`, `comment_text`, `notify_all=false` | `POST /task/{task_id}/comment` | `ship` §5 (PR link), close-out §5.5 (summary incl. `⏱ ~Xh`) | `comment_text` is **plain text** — markdown is **not** rendered (differs from the MCP tool). The git-derived `⏱ ~Xh (sha hh:mm → merged hh:mm)` line is fine as plain text. Omit assignee (D6). |

**Output parity is REST-only, not cross-backend.** Only the REST side normalizes `get-task` to `{id,name,status}` (status as NAME). The MCP `clickup_get_task` returns its own object whose `status` is an *object* — the two shapes differ. We do **not** claim a stable cross-backend output shape. This is tolerable because, post-redesign, `/ship`'s phase routing keys off **git** (step 1.5), so `get-task`'s `status` field is effectively unused downstream; it is read for the title.

Interactive-only (stay **MCP-only**, never in the shim): `refine-ticket`'s rename, body-reformat, delete-subtask, priority, due_date. `team_id`/`custom_task_ids` are omitted everywhere — supera uses native task ids.

---

## 4. Architecture

### 4.1 Shape: one zero-dep Node `.mjs` in the plugin (D2)

`${CLAUDE_PLUGIN_ROOT}/scripts/clickup.mjs` — a single self-contained file using Node 18+'s built-in global `fetch`, **zero dependencies, no build, no install**. It ships and versions with `plugin.json`; `claude-code-action` already has the plugin on disk, so a skill runs it as one line: `node "${CLAUDE_PLUGIN_ROOT}/scripts/clickup.mjs" <op> …`.

The file hardcodes two things that the draft wrongly tried to make configurable (§5, §6):

- **Host:** requests go only to `https://api.clickup.com/api/v2`. The host is a constant in the source — there is **no `apiBase` override from config**. This removes the "POST-to-any-host" exfiltration surface.
- **Token env-var name:** the shim reads `process.env.CLICKUP_TOKEN` (a fixed literal), and **validates the value matches `^pk_`** before sending. There is **no `tokenEnv` indirection from config**. This removes the "read-any-env-var" surface and the half-wired-field bug (a config that renamed the var would have silently routed to an absent MCP).

**Why (b) over (a) bash+curl:** the two ops that build JSON bodies — `create-task` (`name`+`markdown_content`+`tags[]`) and `comment` — are exactly where bash+curl is quoting-hell and ends up shelling to `jq -n` anyway. Node's native `JSON.stringify`/`parse` makes the shim correct and readable, and gives real structured non-2xx branching. Ethos cost is near-identical: still one checked-in file, still "no node *toolchain*" (just the runtime executing one file — no pnpm/Nest/Stryker).

**Why not (c) TS package / (d) composite action:** (c) is the only option that literally meets the org's 100% Stryker bar, but that bar is an org convention for *shipped TS products*; this is plugin-internal glue, and supera's own declared gate is the Bash+jq+grep consistency check (lifecycle §6), not Stryker. (c) also reintroduces the toolchain, becomes a separate (likely private) artifact needing `npx`/`NPM_TOKEN`, and decouples the shim version from `plugin.json`. (d) is the wrong layer: the near-term ops fire from *inside* the agent's turn (the model reasons, then updates/comments), which a sibling workflow step cannot be invoked from, and it can't serve the laptop path. *(The one case where a non-agent step IS the right answer — untrusted-input triggers — is a §6 security control, deferred with the fleet work, not a v1 deliverable.)*

### 4.2 The single indirection point — routing onto the redesign's *real* call sites

The draft's central mechanism assumed the redesign would emit a brand-new adapter vocabulary (`clickup update-status <id> "$STATUS_review"`). **It does not.** The locked, approved redesign (commit `697e788`, §5.2/§5.3) emits **MCP-tool literals with `STATUS.<key>` args**, and the current skills already contain exactly these (verified: `ship` lines 118/146/173 → `clickup_update_task(status=STATUS.review)`, `clickup_create_task(...)`, `clickup_create_task_comment(...)`; `refine` 24/42/75/79). Routing therefore **wraps the calls the redesign actually lands** — it does not invent or request new syntax, and it does not re-open the approved spec.

There is **one** distinguishing signal: **is a ClickUp REST token present in the environment?** It is the true capability gate — you cannot REST without `$CLICKUP_TOKEN`, and you cannot MCP without the claude.ai-authenticated server. The token is exported **only** in headless Actions (from a secret), exactly where MCP is absent; on the laptop it is unset and MCP is present.

Each existing `clickup_<op>(...)` call site in `ship`/`pr-watch` is wrapped in a per-call transport branch, decided once per skill in step 0:

```bash
# step 0, reached ONLY on the branch where this invocation intends a ClickUp write
# (i.e. the skill's existing clickup.listId / CLICKUP_TICKET guard already passed —
#  a ticket-less invocation never reaches here, so it is never red-built below).
# LIST_ID = the resolved clickup.listId already read into CONFIG.
CU=$( [ -n "${CLICKUP_TOKEN:-}" ] && echo rest || echo mcp )

# anti-silent guard (closes the headless+no-token quadrant — see below)
if { [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${CI:-}" ]; } && [ "$CU" = mcp ] && [ -n "$LIST_ID" ]; then
  echo "clickup: headless run intending a ticket write but CLICKUP_TOKEN unset — refusing to silently skip ticket sync" >&2
  exit 1
fi
```

Then, at each call site, the model picks the backend:

| op | `CU=rest` (REST twin) | `CU=mcp` (unchanged MCP call the redesign lands) |
|---|---|---|
| get-task | `node clickup.mjs get-task --task <id>` | `clickup_get_task(...)` |
| create-task | `node clickup.mjs create-task …` | `clickup_create_task(...)` |
| update-status | `node clickup.mjs update-status --task <id> --status "$STATUS_<key>"` | `clickup_update_task(status=STATUS.<key>)` |
| add-tags | `node clickup.mjs add-tags --task <id> --tags …` | `clickup_add_tag_to_task(...)` (per tag) |
| comment | `node clickup.mjs comment --task <id> --text …` | `clickup_create_task_comment(...)` |

**The anti-silent guard is load-bearing.** Token-presence selects the *transport*, but it cannot by itself prove MCP availability — a misconfigured headless job (token not mapped onto the step, or a future custom workflow) would otherwise route `CU=mcp` into an **absent** MCP server and silently no-op, recreating the very §1 bug under a green build. The guard makes "headless **and** `clickup.listId` set **and** no token" a **red build**, never a skipped step. The `listId`/ticket-less guard remains **orthogonal** and stays skill-side — every wrapped call already sits inside `if CLICKUP set`.

**Honest constraint:** an MCP tool is model-invoked, so `clickup.mjs` cannot proxy to MCP; the indirection lives at the per-call-site branch, and the shim's contract is to be a mechanical REST twin so the mapping stays 1:1.

---

## 5. No schema changes

**The shim adds zero fields to `schema/supera.schema.json`.** This is a deliberate reversal of the draft's `tokenEnv` + `apiBase`:

- Both are **global API constants, not repo-specific values** — the invariant *"nothing repo-specific is hardcoded"* targets per-repo config (list IDs, commands, status *names*), not the ClickUp host or the conventional secret name. Adding them over-applies the invariant.
- Both are **token-egress surfaces** on a PR-editable file (§6). Removing them is the cleanest mitigation: there is nothing in `supera.json` to weaponize.
- `tokenEnv` was also **half-wired** — the draft's own step-0 predicate and error message hardcode `CLICKUP_TOKEN`, so a repo that set a custom name would silently route to MCP. A field nothing honors must not exist.

So the only ClickUp config the shim depends on is `clickup.listId` (already in the schema) and `clickup.statuses` (added by the redesign, **not** this PR — §9). The token is an env secret. **The shim therefore touches the schema not at all**, which also erases one of the two same-file collisions with the parallel redesign (§9).

---

## 6. Security & credentials

This is the part the draft got most wrong: its threat model was "the shim must not *log* the token," but the real headless threat is an **attacker-influenced agent** holding a full-privilege, never-expiring credential. GitHub secret masking protects logs — it does **not** protect the ClickUp-comment and PR-comment sinks this shim introduces. The controls below defend the actual threat.

### 6.1 Credential type and the dedicated bot (hard prerequisite)
- A personal `pk_<userId>_<random>` token, sent **raw** in `Authorization: pk_…` (NO `Bearer` — Bearer is OAuth-only and a common 401 cause). OAuth is rejected for v1 (needs a hosted callback + refresh plumbing a runner has no user for).
- **A founder `pk_` token is forbidden in any agent-accessible env, including the pilot.** A personal token carries the minting user's **full permissions across every workspace they belong to** — there is no per-scope narrowing on the token itself. Minting from a dedicated low-privilege **`supera-bot`** service account is a **hard prerequisite, not an interim** (this revises the draft's O2). Token scope == the **account's space memberships**: keep `supera-bot` out of all spaces except **Workloads**. **Residual blast radius is full Workloads-space CRUD** — stated here as an accepted, bounded risk rather than an unstated one.

### 6.2 The config can no longer be turned into an exfil gadget
Because the host and env-var name are **hardcoded in the shim** (§4.1) and the resolved value is **validated `^pk_`** before any request, a PR that edits `.claude/supera.json` can no longer (a) repoint the destination to an attacker host, nor (b) repoint the read to `ANTHROPIC_API_KEY`/`GITHUB_TOKEN` and ship a *different* secret out. **`.claude/supera.json` is a trust boundary in headless runs** and must not be sourced from untrusted PR/branch content for token-bearing ops — but with §4.1, there is nothing token-routing left in it to abuse.

### 6.3 Agent-exfiltration threat model (the real threat)
In a headless run the token lives in `$CLICKUP_TOKEN` in the same runner env where `claude-code-action` runs an LLM with Bash. That agent could `printenv CLICKUP_TOKEN` and write it into a ClickUp comment or a PR comment **via the very ops this shim adds**. If the agent's instructions are attacker-influenced (an issue title/body it is told to act on), that is a direct prompt-injection → token-exfiltration channel. Mitigations, in priority order:

1. **The near-term consumers are not untrusted-input-driven.** ClickUp-triggered `/ship` and headless `/pr-watch` act on **founder-authored tickets**, not on arbitrary external issue text. The **issue/label-driven path that *is* attacker-influenced stays ticket-less and gets no token** (§1). Do not wire the token into that path.
2. **Dedicated low-priv bot** (§6.1) bounds what an exfiltrated token can do to Workloads-space CRUD.
3. **For any *future* untrusted-input trigger that needs ClickUp sync:** keep the token **out of the agent's shell** — run the REST sync in a **non-agent workflow step** (`node clickup.mjs …` invoked by the workflow, fed the structured sync-intent the agent emitted), so `$CLICKUP_TOKEN` is never in the env of the step that processes untrusted text. Gate such triggers on `author_association` (OWNER/MEMBER/COLLABORATOR only). This is a documented precondition for that future work, **not** a v1 deliverable (no near-term untrusted consumer exists).
4. **Least privilege on the token-bearing step:** it gets the minimum GitHub-token permissions and does **not** co-hold `issues:write`/`pull-requests:write` to public sinks while consuming untrusted input.

### 6.4 Injection, masking, leak detection, rotation
- **CI injection:** store as a GitHub Actions secret named `CLICKUP_TOKEN`, sibling to `ANTHROPIC_API_KEY`. Map it to the env var on the **single step** that runs the ClickUp sync — never workflow-level `env:` and never a `with:` input (those can surface in logs). Phase-pilot = a **repository** secret; an **environment** secret (`clickup`, with required reviewers) if approval-gating is wanted; an **org** secret scoped to "Selected repositories" only when the fleet shares one token. **Correction to the draft's exclusion list:** since the redesign makes headless `/pr-watch` a genuine ClickUp *writer* (sets `review`/`blocked`/`rejected`), the `pr-watch` workflow that syncs ClickUp **must** receive the token on its sync step — otherwise that sync silently vanishes (§3 ⇄ §6 contradiction, now resolved). Only workflows that genuinely never sync ClickUp (e.g. the ticket-less audit) get **no** token. Never `pull_request_target` from forks.
- **Masking is log-hygiene only.** It redacts the workflow **log**; it does **not** redact a ClickUp-comment or PR-comment body. Emit `::add-mask::$CLICKUP_TOKEN` **unconditionally** at step start (a registered secret is already masked; this is cheap defense-in-depth), but do not credit masking as protection for the comment sinks.
- **Shim leak controls:** header-only auth; never log request headers; never `echo`/`printf`/`set -x` the token; never put it in a URL/query; never interpolate env/headers into a `comment` body. **Defense-in-depth redactor:** every string the shim writes to stderr/stdout passes through a redactor that masks any `pk_`-shaped substring before emit — unit-tested to fire on a synthetic token in an error path.
- **Leak detection (the draft had none):** enable **GitHub secret scanning + push protection** (catches a committed `pk_` at push, not just by CI grep); register a custom pattern for `pk_` if needed; review the ClickUp audit log for the bot account.
- **Rotation:** `pk_` never expires → **90-day rotation cadence** plus rotate-on-suspected-leak, via revoke-in-ClickUp + update-the-one-secret; the runbook is tested.
- **gitignore / grep:** add `.env*` **then** `!.env.example` (order matters, or the placeholder gets ignored); commit `.env.example` with an empty `CLICKUP_TOKEN=`. The consistency-gate `pk_` grep bans the real `pk_<digits>_<base62>` shape **repo-wide** and **allow-lists** a non-real sentinel (`pk_TEST_DO_NOT_USE`) for fixtures, so it never matches a synthetic token nor goes loose enough to miss a real one.

### 6.5 Transport-flip footgun
Transport keys on token-presence, so a dev who exports `CLICKUP_TOKEN` in a **persistent shell profile** would silently flip every `/ship` and `/pr-watch` on the laptop to REST forever, losing MCP's richer behaviour with no signal. Mitigation: the shim **emits a one-line stderr notice on every REST-routed run** (`clickup: using REST transport`), so the flip is never silent; and the docs recommend sourcing the token **per-session** (direnv / git-ignored `.env.local`), never a persistent profile.

**Must never be committed:** the `pk_` value in any form; in `supera.json` or `examples/*`; in a dotenv holding the real token; as a literal in workflow YAML (commit the `${{ secrets.CLICKUP_TOKEN }}` *reference*); in shim source, skill markdown, specs, README, commit messages, or test fixtures.

---

## 7. Error handling & non-interactive semantics

The shim **never prompts**. It communicates via a **binary exit code** + stderr; stdout is reserved for the op's JSON result. The exit code is binary so the orchestrator has one thing to branch on; the *specific* ClickUp error rides stderr. The response→behaviour table is **total** — every response maps either to a documented success/best-effort (exit 0) or to a hard failure (exit 1) with the error surfaced.

| Condition | Exit | Behaviour |
|---|---|---|
| 2xx, body parses, handle present | **0** | Success. `create-task`/`get-task` emit `{id,…}` on stdout. |
| **2xx but body lacks a usable `id`** (create-task) | **1** | Hard-fail. Never report success with an empty handle (a silent-orphan amplifier). |
| `update-status` to the current status | **0** | Idempotent no-op success — required by `pr-watch`'s `review`-assert and `/ship` merged re-runs. |
| `add-tags`: **tag-not-in-space** (404, `ECODE`/`err` = tag missing) | **0** | Best-effort skip; record the skipped tag on stderr; continue the loop. |
| `add-tags`/any op: **task-not-found** (404, `ECODE`/`err` = task) | **1** | Hard-fail — do **not** swallow a bad task id as a tag skip. |
| **401** (bad/missing token) | **1** | Surface ClickUp `err`/`ECODE` only. This is the CI-absent-MCP failure mode the shim replaces — loud. |
| **403** (bot account lacks access to the task/list) | **1** | Distinct stderr message — the low-priv account will 403 on a task outside Workloads. |
| **400 `Status not found`** | **1** | stderr names the offending status NAME → config drift in `clickup.statuses`, fixable. |
| **400 other** (e.g. a space's status-transition rule rejects the move) | **1** | Surface `err`/`ECODE`. |
| **429** | **1** | Hard-fail loud (no retry/backoff in v1 — D9). supera's ~5 ops/ticket sit far under 100/min; backoff lands with the fleet digest. |
| **Any other non-2xx / network error** | **1** | Default catch-all: hard-fail, surface what we have. Makes the table total. |
| **Empty `task_id`** passed in | **1** | Loud stderr (revised from the draft's silent exit 0) — a lost id must not masquerade as green. The real ticket-less guard is skill-side; the shim should not paper over a missing id. |

**No automatic retry in v1 (D9).** `create-task` and `comment` are **not idempotent**; a blanket "retry on 5xx" would double-create on a lost-response-after-success. v1 hard-fails loud instead, and the orchestrator re-runs the *idempotent* skill flow.

**Exit-code → red-job propagation (the draft never specified this).** Exit codes are decorative unless a non-zero shim exit actually fails the Action. The contract: the workflow step (or skill-emitted command) invokes the shim as `node clickup.mjs … || { echo "clickup sync failed" >&2; exit 1; }` on the ops the lifecycle treats as real (`get-task`, `update-status`, `create-task`) so a hard-fail turns the **step** red; `add-tags`/`comment` are best-effort (the lifecycle already tolerates their failure) and do not fail the step on a non-fatal skip. Without this wired path, a hard ClickUp failure could be narrated past and surface as silent green.

**Re-run idempotency for the non-idempotent ops** (handled skill-side, not by retry):
- `create-task` has **no near-term headless caller** (§1), so its re-run hazard is moot in v1. If a future free-text headless trigger creates tasks, it must dedup by a name/marker search **before** posting (not by git state) — documented as a precondition for that consumer.
- The **close-out `comment`** is the live risk: re-running `/ship <branch>` after merge re-detects `merged` (the PR persists after branch deletion). Guard skill-side: before posting the close-out comment + setting `closed`, `get-task` and **no-op if the ticket is already `closed`**. `update-status` to `closed` is idempotent; the guard prevents the *duplicate comment*.

---

## 8. Testing strategy

**The headless smoke test is the true correctness gate.** Mocked-`fetch` unit tests prove only that the shim *builds* the JSON it intends — they prove nothing about whether ClickUp *accepts* it. Every failure mode that actually matters for a REST twin (wrong body field, wrong endpoint, wrong auth shape, mis-parsing the status *object*) passes green under a stub. So:

1. **Before coding, spike three load-bearing REST facts against the live API** (preconditions, not footnotes):
   - **PUT status case-folding.** The board statuses are UPPERCASE (`IN PROGRESS`) while the redesign's schema defaults are lowercase (`in progress`). If the match is case-*sensitive*, every headless status move 400s. Confirm; if case-sensitive, flag to the redesign that its default status names must match exact board casing (cross-spec dependency).
   - **create-task body field.** Confirm `markdown_content` vs `markdown_description` by creating a task and reading the description back; if wrong, the task is created (exit 0) with an empty/literal description — a silent quality failure. Send the confirmed field (or both keys) and **read-back-assert the description is non-empty**.
   - **404 disambiguation.** Confirm the `ECODE`/`err` shape that distinguishes *tag-not-in-space* from *task-not-found* (§7 depends on it).
2. **Record one fixture from each real call** — `get-task` (status-object parse), `create-task` (body + response), `comment` — so the unit suite asserts against real ClickUp shapes, not invented ones.
3. **`node --test` over the pure functions** — body builders, the `status.status` extractor, the URL/tag-name encoder, the response→`{id,name,status}` normalizer, the `^pk_` validator, the binary exit-code mapper, and the stderr **redactor** — with `fetch` injected so no network is touched and no token is needed. These guard regressions; they are **not** the correctness gate.
4. **Stryker is N/A**, and this is now **honest**: D9's cuts (no retry, no 429 backoff, no 5-way exit taxonomy) make the file genuinely thin glue. The keep-heavy-logic-while-waiving-mutation combination the YAGNI lens flagged does not apply.

**CI placement (stated honestly).** supera has zero workflows today and its redesign gate is explicitly "Bash+jq+grep, no node toolchain." Running `node --test` in CI therefore adds a **separate, minimal Node job** distinct from the Bash consistency gate (GH runners ship Node; with no `package.json`/install it is still "no node *toolchain*", just the runtime). Decision to confirm at review: run that Node job in CI, or keep `node --test` **dev-time only**. Either way, assert (don't assume) Node ≥18 with global `fetch` on the `claude-code-action` runner, and decide whether `*.test.mjs` ships to consumers' plugin dirs or is excluded.

**Two cheap asserts** are added to the lifecycle's `scripts/check-consistency.sh` (still Bash+jq+grep): (a) no `pk_<digits>_<base62>` literal appears anywhere in the repo (sentinel allow-listed — §6.4); (b) **REST-routed** call sites name only `node clickup.mjs`, scoped to **exclude** `refine-ticket` (intentionally MCP-only) and the explicit `CU=mcp` branch of `ship`/`pr-watch` (which legitimately name the `clickup_*` tools). The assert targets the precise short-form tokens (`clickup_update_task`, …) *outside* those exempted regions — not the `mcp__` prefix, which skill bodies never use.

---

## 9. Coordination with the approved status-lifecycle redesign

The redesign (commit `697e788`, **Approved**) is being implemented by a **parallel agent right now**. The draft mis-described the overlap as "mechanical/disjoint." It is not — it is **line-level conflict on the same files**, and the two specs have a strict **producer/consumer** dependency. The rule is hard serialization.

- **Routing rebased onto the redesign's real output (§4.2).** The redesign emits MCP-tool literals with `STATUS.<key>` args (verified in-repo). This shim **wraps those calls** with a `CU` branch — it does **not** invent an adapter vocabulary, and it does **not** ask the locked spec to change its call-site syntax. Nothing in the approved spec is re-opened.
- **Hard serialization — the shim PR does NOT touch shared surfaces until the redesign merges.** To add the `CU` branches, the shim must re-edit the **same call-site lines** in `skills/ship` and `skills/pr-watch` that the redesign is rewriting right now. Those are not disjoint files. The shim PR therefore does **not** touch `skills/*` or `scripts/check-consistency.sh` until the redesign PR is merged. (Because the shim adds **no** schema fields — §5 — the schema `clickup` object is no longer a shared edit at all.)
- **Producer/consumer on `check-consistency.sh`.** The redesign **creates** that script (lifecycle §6); this shim **extends** it (§8). That is a strict ordering dependency, not parallel work — the shim's asserts are added on top of the merged script.
- **Ordering.** Sequence: **(1)** the redesign merges its `statuses` map + `STATUS.<key>`-driven, MCP-named call sites + the consistency gate; **(2)** this shim rebases onto the merged skills, adds the `CU` branches + `clickup.mjs` + the two consistency asserts. The shim carries the redesign's **D6 (no assignee)** and **D7 (no time-tracking)** verbatim — it exposes neither endpoint (D10); elapsed time reaches ClickUp only as git-derived text in `comment`.

---

## 10. Out of scope (YAGNI)

- **No schema fields** — host + env-name hardcoded in the shim (§5).
- **No retry / no 429 backoff in v1** — loud hard-fail (D9); backoff lands with the fleet digest that can actually hit the limit.
- **No wide exit-code taxonomy** — binary 0/1; the specific error is stderr (§7).
- **No time-entry API**, **no assignee/resolve** — D7/D6; elapsed time is git-derived comment text only.
- **No lists/folders/spaces/search/hierarchy**, no `clickup_filter_tasks`, no member lookup — beyond the five.
- **No refine-only ops in the shim** — rename, body-reformat, delete-subtask, priority, due_date stay MCP-only.
- **No status validation at runtime** — `CONFIG.clickup.statuses` *is* the curated valid-name set; a bad name simply 400s.
- **No tag creation** — tags must pre-exist; the shim never auto-creates.
- **No OAuth, no token-refresh, no composite action, no TS package.** **No custom-task-id support** — native ids only.
- **No GitHub workflow or secret in this plugin PR** — consumer-repo infra owned by `supera-init`, a follow-up (§12).
- **No non-agent-step sync pipeline in v1** — a §6.3 control for *future* untrusted-input triggers; no near-term consumer needs it.

---

## 11. Open decisions (for the review gate)

- **O1 — `node --test` in CI vs dev-only.** A minimal Node job in `consistency.yml` enforces line coverage but adds a second CI job to a Bash-only repo. *Lean: dev-time only for v1, with the smoke test as the real gate; add the Node job if regressions appear.*
- **O2 — does `*.test.mjs` ship to consumers?** Tests in the plugin dir reach every consumer on `/plugin update`. *Lean: exclude tests from the shipped plugin (dev-only path), keep `clickup.mjs` as the only shipped script.*
- **O3 — close-out duplicate-comment guard placement.** `get-task`-then-no-op-if-`closed` (§7) can live in the `ship` merged path or in a tiny shim flag. *Lean: skill-side in the merged path — keeps the shim a dumb twin.*
- **O4 — comment rich formatting.** Comments are plain text. If the `⏱ ~Xh` block reads poorly, a later version can use ClickUp's `comment` block-array. *Lean: defer — plain text is fine.*

*(The draft's O1 "lock `CLICKUP_TOKEN`" and O2 "service-account vs founder token" are now **decided**, not open: the env name is hardcoded (D4) and the dedicated bot is a hard prerequisite (§6.1).)*

---

## 12. Release

1. **Land the lifecycle redesign first** (§9) — `statuses` map, `STATUS.<key>`-driven MCP-named call sites, and `scripts/check-consistency.sh`.
2. **Spike the three REST facts** (§8.1) against the live API; pin `markdown_content` vs `markdown_description` and status case-folding **before** coding.
3. Add `scripts/clickup.mjs` (five subcommands, zero deps, hardcoded host + `CLICKUP_TOKEN` + `^pk_` validation + stderr redactor) with `node --test` over the pure functions and one real-call fixture per op.
4. Rebase `skills/{ship,pr-watch}` onto the merged redesign and add the step-0 `CU` predicate + **anti-silent guard** + per-call `CU` branches (refine stays MCP-only). Update `CLAUDE.md` (shim + routing; token is env-only, never config).
5. Extend `scripts/check-consistency.sh` with the no-`pk_`-literal + REST-routing asserts (§8).
6. Add `.env.example` (empty `CLICKUP_TOKEN=`) + gitignore `.env*` (then `!.env.example`); enable GitHub secret scanning + push protection (§6.4).
7. Bump `version` in `plugin.json` **and** `marketplace.json` (identical).
8. **Mint the `supera-bot` `pk_` token** (Workloads-space-only), store the GitHub secret, and run the **headless smoke test** — one real `/ship` (or `/pr-watch`) sync end to end. This is the correctness gate (§8).
9. **Follow-up, not this PR:** `supera-init` writes the per-consumer-repo workflow + maps `CLICKUP_TOKEN` onto the sync step (the workflow + secret are consumer infra, not a plugin file — §9). The token-bearing `pr-watch` sync step is included (§6.4); ticket-less workflows are not.
