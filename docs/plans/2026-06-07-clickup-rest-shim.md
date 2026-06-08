# ClickUp REST shim Implementation Plan

**Status:** 🧊 DEFERRED (iceboxed 2026-06-08) — unblocked but has no real consumer; do not start until the autonomy roadmap lands a headless workflow that needs ClickUp-from-CI. Rationale in the spec header. Spec: [`../specs/2026-06-07-clickup-rest-shim-design.md`](../specs/2026-06-07-clickup-rest-shim-design.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give supera's lifecycle skills a headless ClickUp transport — a single zero-dependency Node `.mjs` REST twin of the five surviving MCP ops — so `/ship` and `/pr-watch` sync tickets from CI where the claude.ai MCP server is absent.

**Architecture:** One self-contained `scripts/clickup.mjs` (Node 18+ global `fetch`, zero deps) exposes exactly five subcommands — `get-task`, `create-task`, `update-status`, `add-tags`, `comment` — mirroring the surviving MCP tools 1:1. It hardcodes the host (`https://api.clickup.com/api/v2`) and the token env-var name (`CLICKUP_TOKEN`), validates `^pk_` before any request, and never adds a config field. `skills/{ship,pr-watch}` choose transport per call site with a `CU=$([ -n "$CLICKUP_TOKEN" ] && echo rest || echo mcp)` branch plus an anti-silent guard that red-builds a headless run that intends a ticket write but has no token. The Bash consistency gate gains two asserts.

**Tech Stack:** Node 18+ (built-in global `fetch`, `node:test`, `node:assert`), Bash + jq + grep (the existing consistency gate), Markdown skill bodies.

**Spec:** `docs/specs/2026-06-07-clickup-rest-shim-design.md` (decisions D1–D12, op surface §3, routing §4.2, security §6, error table §7, testing §8).

---

## Blocked preconditions (do NOT attempt until unblocked)

These need a real `pk_` ClickUp token, which cannot be minted in-session. They are documented here so the executor knows the order and does not fake them. **Per the spec, the headless smoke test (Task 14) is the true correctness gate — the unit tests below prove only that the shim builds the JSON it intends, not that ClickUp accepts it.**

- **P1 — Mint the `supera-bot` token (human + ClickUp admin).** Create a dedicated low-privilege `supera-bot` ClickUp account; add it to the **Workloads space only**; mint its personal `pk_<digits>_<base62>` token. A founder token is forbidden in any agent-accessible env (spec §6.1). Residual blast radius = full Workloads-space CRUD (accepted, bounded).
- **P2 — Run the §8.1 live-API spike (needs P1).** Confirm three load-bearing facts against the live API and feed the answers back into Task 3 and Task 5:
  1. **create-task body field** — `markdown_content` vs `markdown_description`. Create a task, read the description back, confirm which key populated it. The plan defaults to `markdown_content` (spec lean); if wrong, change the one constant in Task 3's `buildCreateBody` and its test.
  2. **PUT status case-folding** — board statuses are UPPERCASE (`IN PROGRESS`), schema defaults lowercase (`in progress`). If the match is case-sensitive, **flag the redesign** that its `clickup.statuses` default names must match exact board casing. No shim code changes — the shim already sends the resolved name verbatim.
  3. **404 disambiguation** — record the real `err`/`ECODE` strings that distinguish *tag-not-in-space* from *task-not-found* on `POST /task/{id}/tag/{name}`. If the default heuristic in Task 5's `classifyAddTagError` (`/task|item/` → task-not-found) does not match the real strings, update its regex.
- **P3 — Record one fixture per real call (needs P1).** Save a real response body from `get-task`, `create-task`, and `comment` so the unit suite can assert against real ClickUp shapes. Strip any token; never commit a real `pk_`.
- **P4 — Enable GitHub secret scanning + push protection (human, GitHub settings).** Catches a committed `pk_` at push time, not just by the CI grep (spec §6.4).
- **P5 — The GitHub workflow + secret wiring is NOT in this PR.** It is consumer-repo infra owned by `supera-init`, a follow-up (spec §9, §12.9).

**The lifecycle redesign is already merged on `main`** (verified: `clickup.statuses` map, `STATUS.<key>`-driven MCP-named call sites, and `scripts/check-consistency.sh` all present). The spec's §9 hard-serialization concern is therefore satisfied — this plan may touch `skills/*` and the gate now.

**Execution context:** Run on a feature branch / worktree (via `/ship` or `superpowers:using-git-worktrees`), never on `main`. Every `git commit` step below assumes that branch.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/clickup.mjs` | Create | The shim. Pure helpers (token validation, redaction, body builders, status/id extractors, tag-name encoder, 404 classifier, arg parser) + five request functions (DI `fetch`) + a CLI entry guarded so the module is importable for tests. |
| `scripts/clickup.test.mjs` | Create | `node --test` suite over the pure helpers and the request functions with `fetch` injected. No network, no token. |
| `skills/ship/SKILL.md` | Modify | Add the step-0 `CU` predicate + anti-silent guard; convert all 10 `clickup_*(...)` call sites to paired `CU=rest`/`CU=mcp` branches. |
| `skills/pr-watch/SKILL.md` | Modify | Same step-0 preamble; convert the 3 `clickup_update_task(...)` call sites. |
| `scripts/check-consistency.sh` | Modify | Add assert 5 (no real `pk_` literal repo-wide) and assert 6 (REST-routed call sites name only `node …/clickup.mjs` — bare MCP tokens only on `CU=mcp` rows). |
| `.gitignore` | Modify | `.env*` then `!.env.example` (order matters). |
| `.env.example` | Create | Empty `CLICKUP_TOKEN=` placeholder. |
| `CLAUDE.md` | Modify | Note the shim + routing; token is env-only, never config. |
| `.claude-plugin/plugin.json` | Modify | Bump `version` 0.4.0 → 0.5.0. |
| `.claude-plugin/marketplace.json` | Modify | Bump `version` 0.4.0 → 0.5.0 (identical). |

**Module contract (shared across Tasks 1–7 — keep names identical):**
- `validateToken(token) -> token` (throws if not `^pk_`)
- `redact(s) -> string` (masks `pk_`-shaped substrings → `pk_***`)
- `extractStatus(task) -> string|null` (reads `task.status.status`, the NAME)
- `normalizeTask(task) -> {id, name, status}`
- `buildCreateBody({name, status, markdown_content, tags}) -> object`
- `extractCreatedId(data) -> string|null`
- `encodeTagName(name) -> string`
- `classifyAddTagError(httpStatus, data) -> 'task-not-found' | 'tag-skip' | 'fatal'`
- `parseArgs(argv) -> {op, flags}`
- Request fns (all take `ctx = {token, fetchImpl, baseUrl}`, all return `{code: 0|1, out: string, err: string}`): `getTask(taskId, ctx)`, `createTask({list_id,name,status,markdown_content,tags}, ctx)`, `updateStatus(taskId, status, ctx)`, `addTags(taskId, tags, ctx)`, `comment(taskId, text, ctx)`
- `main(argv, env, fetchImpl) -> {code, out, err}`

**CLI flag vocabulary (used identically by the shim and the skills):** `--task`, `--status`, `--list`, `--name`, `--content`, `--tags` (comma-separated), `--text`.

---

## Task 1: Foundations — token validation + redactor

**Files:**
- Create: `scripts/clickup.mjs`
- Create: `scripts/clickup.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/clickup.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateToken, redact } from './clickup.mjs';

test('validateToken accepts a pk_ token and returns it', () => {
  assert.equal(validateToken('pk_TEST_DO_NOT_USE'), 'pk_TEST_DO_NOT_USE');
});

test('validateToken throws on a missing or non-pk_ value', () => {
  assert.throws(() => validateToken(undefined), /CLICKUP_TOKEN/);
  assert.throws(() => validateToken('nope'), /CLICKUP_TOKEN/);
});

test('redact masks a pk_-shaped substring', () => {
  assert.equal(redact('auth pk_TEST_DO_NOT_USE failed'), 'auth pk_*** failed');
});

test('redact leaves clean strings untouched', () => {
  assert.equal(redact('all good'), 'all good');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/clickup.test.mjs`
Expected: FAIL — `Cannot find module './clickup.mjs'` (file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/clickup.mjs`:

```js
// supera ClickUp REST shim — single-file, zero-dependency Node (18+) twin of the
// five surviving MCP ops. Host + token env-var name are hardcoded (no config surface).
// See docs/specs/2026-06-07-clickup-rest-shim-design.md.

const BASE_URL = 'https://api.clickup.com/api/v2';

export function validateToken(token) {
  if (typeof token !== 'string' || !/^pk_/.test(token)) {
    throw new Error('CLICKUP_TOKEN missing or not a pk_ token');
  }
  return token;
}

export function redact(s) {
  return String(s).replace(/pk_[A-Za-z0-9_]+/g, 'pk_***');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/clickup.test.mjs`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/clickup.mjs scripts/clickup.test.mjs
git commit -m "feat(shim): clickup.mjs token validation + stderr redactor"
```

---

## Task 2: get-task — status-object → name normalization

**Files:**
- Modify: `scripts/clickup.mjs`
- Modify: `scripts/clickup.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/clickup.test.mjs`:

```js
import { extractStatus, normalizeTask, getTask } from './clickup.mjs';

const CTX = (fetchImpl) => ({ token: 'pk_TEST_DO_NOT_USE', fetchImpl, baseUrl: 'https://api.clickup.com/api/v2' });

test('extractStatus reads the NAME from the status object', () => {
  assert.equal(extractStatus({ status: { status: 'in review', type: 'custom' } }), 'in review');
  assert.equal(extractStatus({}), null);
  assert.equal(extractStatus(null), null);
});

test('normalizeTask emits {id,name,status} with status as the NAME', () => {
  assert.deepEqual(
    normalizeTask({ id: 'abc', name: 'Fix retry', status: { status: 'in progress' } }),
    { id: 'abc', name: 'Fix retry', status: 'in progress' },
  );
});

test('getTask returns code 0 and normalized JSON on 2xx', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ id: 'abc', name: 'T', status: { status: 'in review' } }), { status: 200 });
  const r = await getTask('abc', CTX(fetchImpl));
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { id: 'abc', name: 'T', status: 'in review' });
});

test('getTask hard-fails on a non-2xx', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ err: 'Task not found', ECODE: 'ITEM_013' }), { status: 404 });
  const r = await getTask('bad', CTX(fetchImpl));
  assert.equal(r.code, 1);
  assert.match(r.err, /Task not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/clickup.test.mjs`
Expected: FAIL — `extractStatus`/`normalizeTask`/`getTask` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/clickup.mjs`:

```js
async function doFetch(method, url, body, ctx) {
  const res = await ctx.fetchImpl(url, {
    method,
    headers: { Authorization: ctx.token, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

export function extractStatus(task) {
  return task?.status?.status ?? null;
}

export function normalizeTask(task) {
  return { id: task?.id ?? null, name: task?.name ?? null, status: extractStatus(task) };
}

export async function getTask(taskId, ctx) {
  const { ok, status, data } = await doFetch('GET', `${ctx.baseUrl}/task/${encodeURIComponent(taskId)}`, undefined, ctx);
  if (ok && data) return { code: 0, out: JSON.stringify(normalizeTask(data)), err: '' };
  return { code: 1, out: '', err: `get-task ${taskId} failed: ${status} ${data?.err ?? ''} ${data?.ECODE ?? ''}`.trim() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/clickup.test.mjs`
Expected: PASS — all tests (Tasks 1–2) passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/clickup.mjs scripts/clickup.test.mjs
git commit -m "feat(shim): get-task with status-object normalization"
```

---

## Task 3: create-task — body builder + empty-id hard-fail

**Spike dependency (P2.1):** `buildCreateBody` sends `markdown_content` (spec lean). If the spike confirms `markdown_description`, change that one key in the function **and** the test expectation below.

**Files:**
- Modify: `scripts/clickup.mjs`
- Modify: `scripts/clickup.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/clickup.test.mjs`:

```js
import { buildCreateBody, extractCreatedId, createTask } from './clickup.mjs';

test('buildCreateBody omits status (→ ClickUp default open) and includes content + tags', () => {
  assert.deepEqual(
    buildCreateBody({ name: 'T', markdown_content: 'body', tags: ['cli'] }),
    { name: 'T', markdown_content: 'body', tags: ['cli'] },
  );
});

test('buildCreateBody includes status when provided and drops empty tags', () => {
  assert.deepEqual(
    buildCreateBody({ name: 'T', status: 'pending', markdown_content: 'b', tags: [] }),
    { name: 'T', status: 'pending', markdown_content: 'b' },
  );
});

test('extractCreatedId returns the id or null', () => {
  assert.equal(extractCreatedId({ id: '123' }), '123');
  assert.equal(extractCreatedId({}), null);
  assert.equal(extractCreatedId(null), null);
});

test('createTask returns the new id on 2xx', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ id: '900', name: 'T' }), { status: 200 });
  const r = await createTask({ list_id: 'L', name: 'T', markdown_content: 'b', tags: [] }, CTX(fetchImpl));
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { id: '900' });
});

test('createTask hard-fails on a 2xx body with no usable id', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ name: 'T' }), { status: 200 });
  const r = await createTask({ list_id: 'L', name: 'T', markdown_content: 'b', tags: [] }, CTX(fetchImpl));
  assert.equal(r.code, 1);
  assert.match(r.err, /no usable id/);
});

test('createTask hard-fails on a non-2xx', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ err: 'List not found' }), { status: 404 });
  const r = await createTask({ list_id: 'bad', name: 'T', markdown_content: 'b', tags: [] }, CTX(fetchImpl));
  assert.equal(r.code, 1);
  assert.match(r.err, /List not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/clickup.test.mjs`
Expected: FAIL — `buildCreateBody`/`extractCreatedId`/`createTask` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/clickup.mjs`:

```js
export function buildCreateBody({ name, status, markdown_content, tags }) {
  const body = { name };
  if (status) body.status = status;
  if (markdown_content !== undefined) body.markdown_content = markdown_content;
  if (Array.isArray(tags) && tags.length) body.tags = tags;
  return body;
}

export function extractCreatedId(data) {
  return data && typeof data.id === 'string' && data.id.length ? data.id : null;
}

export async function createTask({ list_id, name, status, markdown_content, tags }, ctx) {
  const body = buildCreateBody({ name, status, markdown_content, tags });
  const { ok, status: http, data } = await doFetch('POST', `${ctx.baseUrl}/list/${encodeURIComponent(list_id)}/task`, body, ctx);
  if (!ok) return { code: 1, out: '', err: `create-task failed: ${http} ${data?.err ?? ''}`.trim() };
  const id = extractCreatedId(data);
  if (!id) return { code: 1, out: '', err: 'create-task: 2xx but response had no usable id' };
  return { code: 0, out: JSON.stringify({ id }), err: '' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/clickup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clickup.mjs scripts/clickup.test.mjs
git commit -m "feat(shim): create-task body builder + empty-id hard-fail"
```

---

## Task 4: update-status — plain-string status, idempotent

**Files:**
- Modify: `scripts/clickup.mjs`
- Modify: `scripts/clickup.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/clickup.test.mjs`:

```js
import { updateStatus } from './clickup.mjs';

test('updateStatus sends {status} as a plain string and succeeds on 2xx', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return new Response('{}', { status: 200 }); };
  const r = await updateStatus('abc', 'in review', CTX(fetchImpl));
  assert.equal(r.code, 0);
  assert.match(sent.url, /\/task\/abc$/);
  assert.deepEqual(sent.body, { status: 'in review' });
});

test('updateStatus hard-fails and names the status on a 400', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ err: 'Status not found' }), { status: 400 });
  const r = await updateStatus('abc', 'bogus', CTX(fetchImpl));
  assert.equal(r.code, 1);
  assert.match(r.err, /bogus/);
  assert.match(r.err, /Status not found/);
});
```

(Idempotency — re-setting the current status is a 2xx no-op — is enforced by the ClickUp API; the first test covers the 2xx path the orchestrator relies on.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/clickup.test.mjs`
Expected: FAIL — `updateStatus` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/clickup.mjs`:

```js
export async function updateStatus(taskId, status, ctx) {
  const { ok, status: http, data } = await doFetch('PUT', `${ctx.baseUrl}/task/${encodeURIComponent(taskId)}`, { status }, ctx);
  if (ok) return { code: 0, out: '', err: '' };
  return { code: 1, out: '', err: `update-status ${taskId}→"${status}" failed: ${http} ${data?.err ?? ''}`.trim() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/clickup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clickup.mjs scripts/clickup.test.mjs
git commit -m "feat(shim): update-status (plain-string status, idempotent)"
```

---

## Task 5: add-tags — per-tag loop with 404 disambiguation

**Spike dependency (P2.3):** `classifyAddTagError` defaults to `/task|item/` → task-not-found. If the spike's real `err`/`ECODE` strings differ, update the regex (and the matching test bodies).

**Files:**
- Modify: `scripts/clickup.mjs`
- Modify: `scripts/clickup.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/clickup.test.mjs`:

```js
import { encodeTagName, classifyAddTagError, addTags } from './clickup.mjs';

test('encodeTagName URL-encodes spaces', () => {
  assert.equal(encodeTagName('needs review'), 'needs%20review');
});

test('classifyAddTagError distinguishes task-not-found, tag-skip, fatal', () => {
  assert.equal(classifyAddTagError(404, { err: 'Task not found', ECODE: 'ITEM_013' }), 'task-not-found');
  assert.equal(classifyAddTagError(404, { err: 'Tag not found in space' }), 'tag-skip');
  assert.equal(classifyAddTagError(500, { err: 'boom' }), 'fatal');
});

test('addTags posts one tag at a time and succeeds when all 2xx', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return new Response('{}', { status: 200 }); };
  const r = await addTags('abc', ['cli', 'cms'], CTX(fetchImpl));
  assert.equal(r.code, 0);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/task\/abc\/tag\/cli$/);
});

test('addTags skips a tag-not-in-space (exit 0) and records it', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ err: 'Tag not found in space' }), { status: 404 });
  const r = await addTags('abc', ['ghost'], CTX(fetchImpl));
  assert.equal(r.code, 0);
  assert.match(r.err, /skipped/);
  assert.match(r.err, /ghost/);
});

test('addTags hard-fails on a task-not-found 404', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ err: 'Task not found', ECODE: 'ITEM_013' }), { status: 404 });
  const r = await addTags('bad', ['cli'], CTX(fetchImpl));
  assert.equal(r.code, 1);
  assert.match(r.err, /not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/clickup.test.mjs`
Expected: FAIL — `encodeTagName`/`classifyAddTagError`/`addTags` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/clickup.mjs`:

```js
export function encodeTagName(name) {
  return encodeURIComponent(name);
}

export function classifyAddTagError(httpStatus, data) {
  if (httpStatus === 404) {
    const msg = `${data?.err ?? ''} ${data?.ECODE ?? ''}`.toLowerCase();
    // Spike (P2.3) confirms exact strings; default: any "task"/"item" → task-not-found.
    return /task|item/.test(msg) ? 'task-not-found' : 'tag-skip';
  }
  return 'fatal';
}

export async function addTags(taskId, tags, ctx) {
  const skipped = [];
  for (const tag of tags) {
    const url = `${ctx.baseUrl}/task/${encodeURIComponent(taskId)}/tag/${encodeTagName(tag)}`;
    const { ok, status, data } = await doFetch('POST', url, undefined, ctx);
    if (ok) continue;
    const kind = classifyAddTagError(status, data);
    if (kind === 'tag-skip') { skipped.push(tag); continue; }
    if (kind === 'task-not-found') return { code: 1, out: '', err: `add-tags: task ${taskId} not found (${status})` };
    return { code: 1, out: '', err: `add-tags: tag "${tag}" failed: ${status} ${data?.err ?? ''}`.trim() };
  }
  return { code: 0, out: '', err: skipped.length ? `add-tags: skipped tags not in space: ${skipped.join(', ')}` : '' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/clickup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clickup.mjs scripts/clickup.test.mjs
git commit -m "feat(shim): add-tags per-tag loop with 404 disambiguation"
```

---

## Task 6: comment — plain text, notify_all=false

**Files:**
- Modify: `scripts/clickup.mjs`
- Modify: `scripts/clickup.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/clickup.test.mjs`:

```js
import { comment } from './clickup.mjs';

test('comment posts plain text with notify_all=false', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return new Response('{}', { status: 200 }); };
  const r = await comment('abc', 'PR #7 opened', CTX(fetchImpl));
  assert.equal(r.code, 0);
  assert.match(sent.url, /\/task\/abc\/comment$/);
  assert.deepEqual(sent.body, { comment_text: 'PR #7 opened', notify_all: false });
});

test('comment hard-fails on a non-2xx', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ err: 'forbidden' }), { status: 403 });
  const r = await comment('abc', 'x', CTX(fetchImpl));
  assert.equal(r.code, 1);
  assert.match(r.err, /forbidden/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/clickup.test.mjs`
Expected: FAIL — `comment` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/clickup.mjs`:

```js
export async function comment(taskId, text, ctx) {
  const body = { comment_text: text, notify_all: false };
  const { ok, status, data } = await doFetch('POST', `${ctx.baseUrl}/task/${encodeURIComponent(taskId)}/comment`, body, ctx);
  if (ok) return { code: 0, out: '', err: '' };
  return { code: 1, out: '', err: `comment on ${taskId} failed: ${status} ${data?.err ?? ''}`.trim() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/clickup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clickup.mjs scripts/clickup.test.mjs
git commit -m "feat(shim): comment (plain text, notify_all=false)"
```

---

## Task 7: arg parser, `main` dispatch, CLI entry

**Files:**
- Modify: `scripts/clickup.mjs`
- Modify: `scripts/clickup.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/clickup.test.mjs`:

```js
import { parseArgs, main } from './clickup.mjs';

test('parseArgs splits the op from --flag value pairs', () => {
  assert.deepEqual(
    parseArgs(['update-status', '--task', 'abc', '--status', 'in review']),
    { op: 'update-status', flags: { task: 'abc', status: 'in review' } },
  );
});

test('main fails fast with no token (before any fetch)', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('{}', { status: 200 }); };
  const r = await main(['get-task', '--task', 'abc'], {}, fetchImpl);
  assert.equal(r.code, 1);
  assert.equal(called, false);
  assert.match(r.err, /CLICKUP_TOKEN/);
});

test('main routes update-status and splits --tags for add-tags', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return new Response('{}', { status: 200 }); };
  const env = { CLICKUP_TOKEN: 'pk_TEST_DO_NOT_USE' };

  const u = await main(['update-status', '--task', 'abc', '--status', 'closed'], env, fetchImpl);
  assert.equal(u.code, 0);

  const t = await main(['add-tags', '--task', 'abc', '--tags', 'cli,cms'], env, fetchImpl);
  assert.equal(t.code, 0);
  assert.ok(seen.some((u) => /\/tag\/cli$/.test(u)));
  assert.ok(seen.some((u) => /\/tag\/cms$/.test(u)));
});

test('main hard-fails loud on an empty --task', async () => {
  const fetchImpl = async () => new Response('{}', { status: 200 });
  const r = await main(['get-task'], { CLICKUP_TOKEN: 'pk_TEST_DO_NOT_USE' }, fetchImpl);
  assert.equal(r.code, 1);
  assert.match(r.err, /--task/);
});

test('main redacts a token that leaks into an error string', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ err: 'leaked pk_TEST_DO_NOT_USE' }), { status: 400 });
  const r = await main(['update-status', '--task', 'a', '--status', 's'], { CLICKUP_TOKEN: 'pk_TEST_DO_NOT_USE' }, fetchImpl);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /pk_TEST_DO_NOT_USE/);
  assert.match(r.err, /pk_\*\*\*/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/clickup.test.mjs`
Expected: FAIL — `parseArgs`/`main` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/clickup.mjs`:

```js
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const [op, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = rest[i + 1]; i++; }
  }
  return { op, flags };
}

export async function main(argv, env = process.env, fetchImpl = globalThis.fetch) {
  const { op, flags } = parseArgs(argv);
  let token;
  try { token = validateToken(env.CLICKUP_TOKEN); }
  catch (e) { return { code: 1, out: '', err: redact(e.message) }; }
  const ctx = { token, fetchImpl, baseUrl: BASE_URL };

  const needTask = () => (flags.task ? null : { code: 1, out: '', err: `${op}: --task required` });
  let r;
  switch (op) {
    case 'get-task':       r = needTask() ?? await getTask(flags.task, ctx); break;
    case 'update-status':  r = needTask() ?? await updateStatus(flags.task, flags.status, ctx); break;
    case 'add-tags':       r = needTask() ?? await addTags(flags.task, (flags.tags ?? '').split(',').filter(Boolean), ctx); break;
    case 'comment':        r = needTask() ?? await comment(flags.task, flags.text, ctx); break;
    case 'create-task':    r = await createTask({
        list_id: flags.list, name: flags.name, status: flags.status,
        markdown_content: flags.content, tags: (flags.tags ?? '').split(',').filter(Boolean),
      }, ctx); break;
    default:               r = { code: 1, out: '', err: `unknown op: ${op}` };
  }
  return { code: r.code, out: redact(r.out), err: redact(r.err) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('clickup: using REST transport\n'); // §6.5 — flip is never silent
  const { code, out, err } = await main(process.argv.slice(2));
  if (out) process.stdout.write(out + '\n');
  if (err) process.stderr.write(err + '\n');
  process.exit(code);
}
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `node --test scripts/clickup.test.mjs`
Expected: PASS — every test from Tasks 1–7.

- [ ] **Step 5: Smoke the CLI's no-token guard (no network, no token)**

Run: `node scripts/clickup.mjs get-task --task abc; echo "exit=$?"`
Expected: stderr `clickup: using REST transport` then `CLICKUP_TOKEN missing or not a pk_ token`; `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add scripts/clickup.mjs scripts/clickup.test.mjs
git commit -m "feat(shim): arg parser, main dispatch, redacted CLI entry"
```

---

## Task 8: route `skills/ship/SKILL.md` call sites

No unit test — the gate (Task 10) and the headless smoke test (Task 14) verify this. Each edit converts a bare MCP call into a paired `CU=rest`/`CU=mcp` branch so the gate's assert 6 (bare MCP tokens only on `CU=mcp` rows) passes.

**Files:**
- Modify: `skills/ship/SKILL.md`

- [ ] **Step 1: Add the routing preamble to §0**

In `skills/ship/SKILL.md`, after the `STATUS` resolution bullet (ends at line 21 `Always set ticket status via STATUS.<key>…`), add:

````markdown
- **Transport (`CU`)** — choose ClickUp transport once, here. REST in headless runs (token present, MCP absent), MCP on the laptop (token unset, MCP present):
  ```bash
  SHIM="${CLAUDE_PLUGIN_ROOT}/scripts/clickup.mjs"
  CU=$( [ -n "${CLICKUP_TOKEN:-}" ] && echo rest || echo mcp )
  # Anti-silent guard: a headless run that intends a ticket write but has no token
  # must RED-BUILD, never silently skip the sync (closes the §1 bug under a green build).
  if { [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${CI:-}" ]; } && [ "$CU" = mcp ] && [ -n "<CLICKUP>" ]; then
    echo "clickup: headless run intending a ticket write but CLICKUP_TOKEN unset — refusing to silently skip ticket sync" >&2
    exit 1
  fi
  ```
  At each ClickUp call site below, run the `CU=rest` line via Bash when `CU=rest`, else make the `CU=mcp` MCP call unchanged. The `clickup.listId` / ticket-less guard stays orthogonal — every call site already sits inside `if CLICKUP set`.
````

- [ ] **Step 2: Convert the §2 get-task call site (line 63)**

Replace:
```
clickup_get_task(task_id="<id>")
```
with:
```
- `CU=rest` → `node "$SHIM" get-task --task <id>`
- `CU=mcp`  → `clickup_get_task(task_id="<id>")`
```

- [ ] **Step 3: Convert the §2 create-task call site (lines 69–74)**

Replace the fenced `clickup_create_task(...)` block with:
```
- `CU=rest` → `node "$SHIM" create-task --list "<CLICKUP>" --name "<task description>" --content "<body from the ClickUp template below>" --tags "<comma-separated matched CONFIG.tags values>"` (omit `--tags` if none; omit `--status` so ClickUp assigns the default `open`)
- `CU=mcp`  → `clickup_create_task(list_id="<CLICKUP>", name="<task description>", markdown_description="<body from the ClickUp template below>", tags=[ ...matched CONFIG.tags values ])`
```
(Note: the REST body field is `markdown_content` inside the shim; the MCP param is `markdown_description`. Both carry the same body — they differ because one is the REST API field and the other the MCP tool param.)

- [ ] **Step 4: Convert the §4 update-status (building) call site (line 101)**

Replace:
```
clickup_update_task(task_id="<id>", status=STATUS.building)
```
with:
```
- `CU=rest` → `node "$SHIM" update-status --task <id> --status "<STATUS.building>"`
- `CU=mcp`  → `clickup_update_task(task_id="<id>", status=STATUS.building)`
```

- [ ] **Step 5: Convert the §5 update-status (review) call site (line 117)**

Replace:
```
clickup_update_task(task_id="<id>", status=STATUS.review)
```
with:
```
- `CU=rest` → `node "$SHIM" update-status --task <id> --status "<STATUS.review>"`
- `CU=mcp`  → `clickup_update_task(task_id="<id>", status=STATUS.review)`
```

- [ ] **Step 6: Convert the §5 tag call site (line 126)**

Replace:
```
clickup_update_task(task_id="<id>", tags=[ ...matched tags ])
```
with:
```
- `CU=rest` → `node "$SHIM" add-tags --task <id> --tags "<comma-separated matched tags>"`
- `CU=mcp`  → `clickup_update_task(task_id="<id>", tags=[ ...matched tags ])`
```
(The REST twin loops one `POST …/tag/{name}` per tag; the MCP twin sets the whole array on the task. Both are best-effort — a missing tag is skipped.)

- [ ] **Step 7: Convert the §5 PR-link comment call site (line 144)**

Replace:
```
clickup_create_task_comment(task_id="<id>", comment_text="PR #<N> opened: <PR URL>")
```
with:
```
- `CU=rest` → `node "$SHIM" comment --task <id> --text "PR #<N> opened: <PR URL>"`
- `CU=mcp`  → `clickup_create_task_comment(task_id="<id>", comment_text="PR #<N> opened: <PR URL>")`
```

- [ ] **Step 8: Convert the resume-path update-status (building) call site (line 175)**

Replace:
```
clickup_update_task(task_id="<id>", status=STATUS.building)
```
(the one in **Resuming interrupted work**) with:
```
- `CU=rest` → `node "$SHIM" update-status --task <id> --status "<STATUS.building>"`
- `CU=mcp`  → `clickup_update_task(task_id="<id>", status=STATUS.building)`
```

- [ ] **Step 9: Convert the pause-comment call site (line 200)**

Replace:
```
clickup_create_task_comment(task_id="<TICKET>", comment_text="⏸ Paused. Done: <…>. Next: <nextUp>. Branch `<BRANCH>` pushed — resume with /ship <BRANCH>.")
```
with:
```
- `CU=rest` → `node "$SHIM" comment --task <TICKET> --text "⏸ Paused. Done: <…>. Next: <nextUp>. Branch <BRANCH> pushed — resume with /ship <BRANCH>."`
- `CU=mcp`  → `clickup_create_task_comment(task_id="<TICKET>", comment_text="⏸ Paused. Done: <…>. Next: <nextUp>. Branch `<BRANCH>` pushed — resume with /ship <BRANCH>.")`
```

- [ ] **Step 10: Convert the close-out comment + status call sites (lines 230–231)**

Replace:
```
clickup_create_task_comment(task_id="<TICKET>", comment_text="<summary block>")
clickup_update_task(task_id="<TICKET>", status=STATUS.closed)
```
with:
```
- `CU=rest` → `node "$SHIM" comment --task <TICKET> --text "<summary block>"` then `node "$SHIM" update-status --task <TICKET> --status "<STATUS.closed>"`
- `CU=mcp`  → `clickup_create_task_comment(task_id="<TICKET>", comment_text="<summary block>")` then `clickup_update_task(task_id="<TICKET>", status=STATUS.closed)`
```
(The close-out duplicate-comment guard stays skill-side: the merged path already `get-task`s first — no-op if the ticket is already `STATUS.closed`. `update-status` to `closed` is idempotent; the guard prevents the duplicate comment.)

- [ ] **Step 11: Commit**

```bash
git add skills/ship/SKILL.md
git commit -m "feat(ship): route ClickUp call sites through the REST shim when CLICKUP_TOKEN is set"
```

---

## Task 9: route `skills/pr-watch/SKILL.md` call sites

**Files:**
- Modify: `skills/pr-watch/SKILL.md`

- [ ] **Step 1: Add the routing preamble to §0**

In `skills/pr-watch/SKILL.md`, after the `STATUS` resolution paragraph (line 13), add:

````markdown
**Transport (`CU`).** Choose ClickUp transport once: REST in headless runs, MCP on the laptop. The anti-silent guard keys on `CLICKUP_TICKET` (pr-watch's "intends a write" signal):
```bash
SHIM="${CLAUDE_PLUGIN_ROOT}/scripts/clickup.mjs"
CU=$( [ -n "${CLICKUP_TOKEN:-}" ] && echo rest || echo mcp )
if { [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${CI:-}" ]; } && [ "$CU" = mcp ] && [ -n "<CLICKUP_TICKET>" ]; then
  echo "clickup: headless pr-watch with a linked ticket but CLICKUP_TOKEN unset — refusing to silently skip ticket sync" >&2
  exit 1
fi
```
At each ClickUp call site below, use the `CU=rest` line when `CU=rest`, else the `CU=mcp` MCP call unchanged.
````

- [ ] **Step 2: Convert the §2 rejected call site (line 39)**

Replace:
```
clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.rejected)
```
with:
```
- `CU=rest` → `node "$SHIM" update-status --task <CLICKUP_TICKET> --status "<STATUS.rejected>"`
- `CU=mcp`  → `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.rejected)`
```

- [ ] **Step 3: Convert the §3 review-assert call site (line 51)**

Replace:
```
clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.review)
```
with:
```
- `CU=rest` → `node "$SHIM" update-status --task <CLICKUP_TICKET> --status "<STATUS.review>"`
- `CU=mcp`  → `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.review)`
```

- [ ] **Step 4: Convert the §3 blocked call site (line 70)**

Replace:
```
clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.blocked)
```
with:
```
- `CU=rest` → `node "$SHIM" update-status --task <CLICKUP_TICKET> --status "<STATUS.blocked>"`
- `CU=mcp`  → `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.blocked)`
```

- [ ] **Step 5: Commit**

```bash
git add skills/pr-watch/SKILL.md
git commit -m "feat(pr-watch): route ClickUp call sites through the REST shim when CLICKUP_TOKEN is set"
```

---

## Task 10: extend `scripts/check-consistency.sh` with two asserts

**Files:**
- Modify: `scripts/check-consistency.sh:60-61` (insert asserts 5 and 6 before the final `exit $fail`)

- [ ] **Step 1: Add asserts 5 and 6**

In `scripts/check-consistency.sh`, between the assert-4 block (ends line 59) and `exit $fail` (line 61), insert:

```bash
# 5. No real ClickUp pk_ token literal anywhere (sentinel pk_TEST_DO_NOT_USE allow-listed).
#    Real shape is pk_<digits>_<base62>; the bracket in this very regex stops it self-matching.
tok=$(grep -rnE 'pk_[0-9]+_[A-Za-z0-9]+' . \
        --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees \
        | grep -v 'pk_TEST_DO_NOT_USE' || true)
if [ -n "$tok" ]; then
  echo "FAIL(5): a real-shaped pk_ token literal is present — never commit a ClickUp token:"
  echo "$tok"
  fail=1
else
  echo "OK(5): no real pk_ token literals"
fi

# 6. REST-routed call sites name only the shim. A bare MCP tool literal in ship/pr-watch
#    is allowed ONLY on a `CU=mcp` row; anywhere else it is an unrouted (silent-headless) call.
mcp=$(grep -rnE 'clickup_(get_task|create_task|update_task|create_task_comment|add_tag_to_task)\(' \
        skills/ship skills/pr-watch --include='*.md' \
        | grep -v 'CU=mcp' || true)
if [ -n "$mcp" ]; then
  echo "FAIL(6): bare MCP ClickUp call outside a CU=mcp branch — route it through the shim:"
  echo "$mcp"
  fail=1
else
  echo "OK(6): all ship/pr-watch ClickUp calls are routed (REST shim or CU=mcp branch)"
fi
```

- [ ] **Step 2: Run the gate to verify all six checks pass**

Run: `bash scripts/check-consistency.sh; echo "exit=$?"`
Expected: `OK(1)`…`OK(6)` and `exit=0`. (Asserts 5/6 pass because Tasks 1–9 used the `pk_TEST_DO_NOT_USE` sentinel and put every MCP call on a `CU=mcp` row.)

- [ ] **Step 3: Commit**

```bash
git add scripts/check-consistency.sh
git commit -m "feat(gate): assert no pk_ token literal + ship/pr-watch ClickUp calls are routed"
```

---

## Task 11: `.env.example` + `.gitignore`

**Files:**
- Create: `.env.example`
- Modify: `.gitignore:11-12` (append after the `node_modules/` block)

- [ ] **Step 1: Create `.env.example`**

```
# ClickUp REST token for headless ticket sync (the shim reads $CLICKUP_TOKEN).
# Real value lives in a GitHub Actions secret / a git-ignored .env.local — NEVER commit it.
# Format: pk_<digits>_<base62>. Leave this placeholder empty.
CLICKUP_TOKEN=
```

- [ ] **Step 2: Append the dotenv rules to `.gitignore`**

After the `node_modules/` line (line 12), append:

```
# secrets — ignore every dotenv, but keep the committed placeholder (order matters)
.env*
!.env.example
```

- [ ] **Step 3: Verify the placeholder is tracked but a real dotenv is not**

Run: `git check-ignore -v .env.example .env.local 2>&1; git status --porcelain .env.example`
Expected: `.env.local` is ignored (matched by `.env*`); `.env.example` is NOT ignored (re-included by `!.env.example`) and shows as a new tracked file.

- [ ] **Step 4: Commit**

```bash
git add .gitignore .env.example
git commit -m "chore: gitignore dotenvs, commit empty CLICKUP_TOKEN placeholder"
```

---

## Task 12: document the shim in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (Layout table + Core invariants)

- [ ] **Step 1: Add a `scripts/` row to the Layout table**

In `CLAUDE.md`, add a row to the Layout table (after the `agents/` row):

```
| `scripts/` | `check-consistency.sh` (the CI gate) and `clickup.mjs` — the zero-dependency Node REST twin of the five surviving ClickUp MCP ops, used in headless runs where the MCP server is absent. Run as `node "${CLAUDE_PLUGIN_ROOT}/scripts/clickup.mjs" <op>`. |
```

- [ ] **Step 2: Add a Core-invariant bullet**

Under `## Core invariants — do not break`, add:

```
- **The ClickUp token is env-only, never config.** The shim hardcodes the host (`api.clickup.com`) and the env-var name (`CLICKUP_TOKEN`) and validates `^pk_` before any request — no `tokenEnv`/`apiBase` field exists, so a PR-editable `supera.json` can never repoint the destination or exfiltrate a different secret. Transport is chosen per call site by token-presence (`CU=rest|mcp`), guarded so a headless run intending a ticket write without a token is a red build, never a silent skip.
```

- [ ] **Step 3: Verify the gate still passes (CLAUDE.md is not scanned, but confirm nothing regressed)**

Run: `bash scripts/check-consistency.sh; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the ClickUp REST shim + env-only token invariant"
```

---

## Task 13: version bump

**Files:**
- Modify: `.claude-plugin/plugin.json:4`
- Modify: `.claude-plugin/marketplace.json:11`

- [ ] **Step 1: Bump both manifests to 0.5.0**

In `.claude-plugin/plugin.json` change `"version": "0.4.0"` → `"version": "0.5.0"`.
In `.claude-plugin/marketplace.json` change `"version": "0.4.0"` → `"version": "0.5.0"`.

- [ ] **Step 2: Verify version sync via the gate**

Run: `bash scripts/check-consistency.sh; echo "exit=$?"`
Expected: `OK(1): versions match (0.5.0)` and `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to 0.5.0 (ClickUp REST shim)"
```

---

## Task 14: headless smoke test — the true correctness gate (BLOCKED on P1)

**This is the real correctness gate (spec §8, §11-O… , §12.8).** Mocked-`fetch` tests prove only intent; only a live call proves ClickUp accepts the requests. Do NOT mark the feature done until this passes.

**Files:** none — operational.

- [ ] **Step 1 (needs P1+P2+P3):** With the `supera-bot` token exported as `CLICKUP_TOKEN`, run one real end-to-end sync against a throwaway Workloads ticket — e.g. `node scripts/clickup.mjs get-task --task <real-id>` then `update-status` to a real board status and back, and a `comment`. Confirm exit 0 and the change shows in ClickUp.
- [ ] **Step 2:** Run a real `/ship` (or `/pr-watch`) in a headless-equivalent shell (`CLICKUP_TOKEN` set, MCP absent) against the throwaway ticket; confirm the status moves and the comment lands via REST, and that the stderr `clickup: using REST transport` notice appeared.
- [ ] **Step 3:** Confirm the anti-silent guard fires: unset `CLICKUP_TOKEN`, set `CI=1` and a non-empty ticket/list, and confirm the skill red-builds rather than silently skipping.
- [ ] **Step 4:** Record the spike's confirmed facts (P2.1–P2.3) back into the code if any default was wrong; re-run `node --test scripts/clickup.test.mjs` and `bash scripts/check-consistency.sh`.

---

## Self-review

**Spec coverage:**
- §3 op surface (5 ops) → Tasks 2–7. ✓
- §4.1 single zero-dep `.mjs`, hardcoded host + env-name, `^pk_` validate → Tasks 1, 7. ✓
- §4.2 per-call `CU` branch + anti-silent guard → Tasks 8, 9. ✓
- §5 no schema change → no schema task exists (deliberate). ✓
- §6 security: `^pk_` validate (T1), raw `Authorization` no Bearer (T2 `doFetch`), redactor (T1, wired T7), gitignore + `.env.example` (T11), token mint + secret scanning (P1, P4). ✓
- §7 error table: empty-id hard-fail (T3), idempotent status (T4), 404 disambiguation (T5), empty-task loud (T7), redaction (T7). ✓ (429/5xx fall through `doFetch`'s non-`ok` → `code 1`, no retry — D9.)
- §8 testing: `node --test` over pure fns + DI fetch (T1–T7), spike (P2), fixtures (P3), smoke test (T14), two gate asserts (T10). ✓
- §12 release sequence → Tasks ordered to match (redesign already merged; spike P2; shim T1–7; routing T8–9; gate T10; env T11; docs T12; version T13; smoke T14; workflow = P5 follow-up). ✓

**Placeholder scan:** No `TBD`/`implement later`. The two spike-dependent defaults (`markdown_content`, the `/task|item/` 404 heuristic) are real working code with explicit ref-back instructions, not placeholders.

**Type consistency:** `ctx = {token, fetchImpl, baseUrl}`, the `{code,out,err}` result shape, and every exported name match across Tasks 1–7 and the `main` dispatch. The CLI flag set (`--task/--status/--list/--name/--content/--tags/--text`) is identical in `main` (T7) and the skill call sites (T8–9). `<STATUS.key>` placeholders use only keys present in the schema (`building/review/closed/rejected/blocked`), so gate check 3 stays green.

**Gaps:** none blocking. O1 (run `node --test` in CI vs dev-only) and O2 (`*.test.mjs` shipping to consumers) stay open per the spec's leans — dev-only for v1; revisit if regressions appear. A consumer never invokes `clickup.test.mjs`, so it is inert even if it ships.
