# Supera Status Lifecycle + Solo-Dev Trim Implementation Plan

**Status:** ✅ DONE — all 13 tasks shipped in v0.4.0 (commits `c7e5e21`→`36f1876`). Retained as an execution record; do not re-run. Spec: [`../specs/2026-06-07-supera-status-lifecycle.md`](../specs/2026-06-07-supera-status-lifecycle.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken ClickUp status order in supera's ship lifecycle, make status names config-driven, fold `/resume` + `/finish` + `/pause` into an idempotent `/ship`, drop assignee + ClickUp time-tracking, and add a CI gate that keeps schema↔skills↔manifest in sync.

**Architecture:** supera is a Claude Code *plugin*: its "code" is Markdown `SKILL.md` files, one JSON schema, two JSON manifests, plus a new Bash CI gate. The gate (`scripts/check-consistency.sh`) is the test harness — it goes red against today's repo and green once the edits land. There is no unit-test runner; the gate plays that role. Status names move out of skill bodies into `schema/supera.schema.json` under `clickup.statuses` (defaults = today's strings, so existing `.claude/supera.json` files keep working). `/ship` absorbs the resume/finish/pause logic and routes by the existing git+ClickUp phase ladder.

**Tech Stack:** Markdown skills, JSON Schema (draft 2020-12), GitHub Actions, Bash, `jq`, `grep`.

**Spec:** `docs/specs/2026-06-07-supera-status-lifecycle.md` (all decisions D1–D9 locked; O1=fold all three, O2=silent teardown).

**Status name convention** (used everywhere below): each ClickUp-touching skill resolves `STATUS` once in step 0 from `CONFIG.clickup?.statuses ?? {}` with these defaults, then calls `clickup_update_task(..., status=STATUS.<key>)` — **never** a quoted literal:

| key | default | meaning |
|---|---|---|
| `STATUS.ready` | `pending` | refined, ready to ship |
| `STATUS.building` | `in progress` | engineer implementing |
| `STATUS.review` | `in review` | PR open: CI + human review |
| `STATUS.blocked` | `blocked` | stuck (repeat CI fail / blocker) |
| `STATUS.rejected` | `rejected` | PR closed without merge (terminal) |
| `STATUS.closed` | `closed` | merged, done, archived (terminal) |

`completed`/`accepted` are human-only verdicts — never set by a skill, never in the map.

---

## Task 1: Add `clickup.statuses` to the schema

**Files:**
- Modify: `schema/supera.schema.json` (the `clickup` property, ~line 36-43)

- [ ] **Step 1: Add the `statuses` map under `clickup.properties`**

Replace this block:

```json
    "clickup": {
      "type": ["object", "null"],
      "description": "ClickUp wiring. Set to null (or omit) to run ticket-less: ship/pr-watch skip all ClickUp + time-tracking steps and operate purely on git + GitHub.",
      "additionalProperties": false,
      "properties": {
        "listId": { "type": ["string", "null"], "description": "List that holds this repo's backlog. Required for ticket creation." }
      }
    },
```

with:

```json
    "clickup": {
      "type": ["object", "null"],
      "description": "ClickUp wiring. Set to null (or omit) to run ticket-less: ship/pr-watch skip all ClickUp steps and operate purely on git + GitHub.",
      "additionalProperties": false,
      "properties": {
        "listId": { "type": ["string", "null"], "description": "List that holds this repo's backlog. Required for ticket creation." },
        "statuses": {
          "type": "object",
          "description": "Maps supera lifecycle phases to THIS repo's ClickUp status names (statuses are space-specific). Each skill reads CONFIG.clickup.statuses.<key>; omit a key to keep its default. Used only when clickup.listId is set. The human-only verdicts (completed/accepted) are intentionally absent — supera never sets them.",
          "additionalProperties": false,
          "properties": {
            "ready":    { "type": "string", "default": "pending",     "description": "Refined and ready to ship. Set by /refine-ticket." },
            "building": { "type": "string", "default": "in progress", "description": "Engineer implementing. Set by /ship." },
            "review":   { "type": "string", "default": "in review",   "description": "PR open: CI + human review. Set by /ship at PR push." },
            "blocked":  { "type": "string", "default": "blocked",     "description": "Stuck: repeated CI failure or unresolved blocker. Set by /pr-watch." },
            "rejected": { "type": "string", "default": "rejected",    "description": "PR closed without merge. Terminal. Set by /pr-watch." },
            "closed":   { "type": "string", "default": "closed",      "description": "Merged, done, archived. Set by /ship on merge." }
          }
        }
      }
    },
```

- [ ] **Step 2: Validate the JSON parses**

Run: `jq -e '.properties.clickup.properties.statuses.properties | keys' schema/supera.schema.json`
Expected: prints `["blocked","building","closed","ready","rejected","review"]` (order may vary), exit 0.

- [ ] **Step 3: Commit**

```bash
git add schema/supera.schema.json
git commit -m "feat: add clickup.statuses map to schema"
```

---

## Task 2: Add the CI consistency gate (the failing test)

This is the test harness. It MUST fail now (raw status literals + dead `/resume,/finish,/pause` refs still in the skills) and pass after the edits below land. It scans **both `skills/` and `agents/`** (every `*.md`) so a literal or dead reference can't hide in an agent file or in supera-init's emitted config.

**Files:**
- Create: `scripts/check-consistency.sh`
- Create: `.github/workflows/consistency.yml`

- [ ] **Step 1: Write the gate script**

Create `scripts/check-consistency.sh`:

```bash
#!/usr/bin/env bash
# Consistency gate for the supera plugin repo.
# Enforces the CLAUDE.md invariants that were previously discipline-only.
# Scans BOTH skills/ and agents/ (every *.md) so a status literal or dead
# reference can't slip in through an agent file or supera-init's emitted config:
#   1. plugin.json and marketplace.json versions match.
#   2. No raw ClickUp status string literals in a skill/agent (must use STATUS.<key>).
#   3. Every STATUS.<key> referenced exists in schema clickup.statuses.
#   4. No references to deleted skills (/resume, /finish, /pause) remain.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

# Markdown surface the gate guards: every skill + agent body.
SCAN=(skills/ agents/)

# 1. Version sync
pv=$(jq -r '.version' .claude-plugin/plugin.json)
mv=$(jq -r '.plugins[0].version' .claude-plugin/marketplace.json)
if [ "$pv" != "$mv" ]; then
  echo "FAIL(1): version mismatch — plugin.json=$pv marketplace.json=$mv"
  fail=1
else
  echo "OK(1): versions match ($pv)"
fi

# 2. No raw status literals in any skill/agent
hits=$(grep -rnE 'status[[:space:]]*=[[:space:]]*"' "${SCAN[@]}" --include='*.md' || true)
if [ -n "$hits" ]; then
  echo "FAIL(2): raw status string literal — use STATUS.<key>:"
  echo "$hits"
  fail=1
else
  echo "OK(2): no raw status literals"
fi

# 3. Every STATUS.<key> referenced exists in the schema
schema_keys=$(jq -r '.properties.clickup.properties.statuses.properties | keys[]' schema/supera.schema.json | sort -u)
used_keys=$(grep -rhoE 'STATUS\.[a-zA-Z]+' "${SCAN[@]}" --include='*.md' | sed 's/STATUS\.//' | sort -u || true)
k3=0
for k in $used_keys; do
  if ! echo "$schema_keys" | grep -qx "$k"; then
    echo "FAIL(3): STATUS.$k used but not defined in schema clickup.statuses"
    fail=1; k3=1
  fi
done
[ "$k3" -eq 0 ] && echo "OK(3): all STATUS.<key> references defined in schema"

# 4. No dead-skill references (/ship pause is allowed — the slash precedes 'ship', not 'pause')
dead=$(grep -rnE '/(resume|finish|pause)' "${SCAN[@]}" --include='*.md' || true)
if [ -n "$dead" ]; then
  echo "FAIL(4): reference to a deleted skill (/resume, /finish, /pause) — use /ship (or /ship pause):"
  echo "$dead"
  fail=1
else
  echo "OK(4): no dead-skill references"
fi

exit $fail
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/check-consistency.sh`

- [ ] **Step 3: Run it — verify it FAILS against today's repo**

Run: `bash scripts/check-consistency.sh; echo "exit=$?"`
Expected: prints `OK(1)`, `FAIL(2)` (lists ship/refine/resume/finish raw literals — `agents/` are clean), `OK(3)`, `FAIL(4)` (lists `/resume`,`/finish`,`/pause` refs), then `exit=1`.

- [ ] **Step 4: Write the GitHub Actions workflow**

Create `.github/workflows/consistency.yml`:

```yaml
name: consistency
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run consistency gate
        run: bash scripts/check-consistency.sh
```

- [ ] **Step 5: Commit**

```bash
git add scripts/check-consistency.sh .github/workflows/consistency.yml
git commit -m "test: add schema/skill/manifest consistency gate"
```

---

## Task 3: Edit `refine-ticket` — drop assignee + timer, set `STATUS.ready`

**Files:**
- Modify: `skills/refine-ticket/SKILL.md`

- [ ] **Step 1: Update the frontmatter description** (remove assignee + time-tracking mentions)

Replace:

```
description: "Refine a draft ClickUp ticket: rename to a friendly human title, enforce the concise template, fold subtasks, fill tags / assignee / priority / due date from .claude/supera.json, mirror the title onto any open PR, and start time tracking so /ship can pick it up clean."
```

with:

```
description: "Refine a draft ClickUp ticket: rename to a friendly human title, enforce the concise template, fold subtasks, fill tags / priority / due date from .claude/supera.json, mirror the title onto any open PR, and move it to the 'ready' status so /ship can pick it up clean."
```

- [ ] **Step 2: Load `STATUS` in step 0**

Replace:

```
## 0 — Load config

Read `.claude/supera.json` into `CONFIG` for the `tags` taxonomy. If absent, skip tag derivation (still refine title/body/fields).
```

with:

```
## 0 — Load config

Read `.claude/supera.json` into `CONFIG` for the `tags` taxonomy. If absent, skip tag derivation (still refine title/body/fields).

Resolve `STATUS` once from `CONFIG.clickup?.statuses ?? {}` with defaults: `STATUS.ready = …?.ready ?? "pending"` (the only status this skill sets).
```

- [ ] **Step 3: Drop assignee from the required-fields table**

Replace the table in step 4:

```
| Field | How to derive |
|---|---|
| `assignees` | `me` unless the text names someone else |
| `tags` | Match path hints in the body against `CONFIG.tags`; apply every match |
| `priority` | `urgent` if incident/outage/blocking · `high` if release blocker · `low` if cleanup/nice-to-have · else `normal` |
| `due_date` | Only if the body has an explicit date or "by <day>"; convert relative → absolute `YYYY-MM-DD` using today. Never guess |
| `status` | `open` if absent |
```

with:

```
| Field | How to derive |
|---|---|
| `tags` | Match path hints in the body against `CONFIG.tags`; apply every match |
| `priority` | `urgent` if incident/outage/blocking · `high` if release blocker · `low` if cleanup/nice-to-have · else `normal` |
| `due_date` | Only if the body has an explicit date or "by <day>"; convert relative → absolute `YYYY-MM-DD` using today. Never guess |
| `status` | `STATUS.ready` — refining is what makes a ticket ready to ship |
```

- [ ] **Step 4: Drop assignee + set `STATUS.ready` in the update call**

Replace:

```
Apply non-tag fields in one call:
```
clickup_update_task(task_id="<id>", status="open", assignees=["me"], priority="<priority>", due_date="<YYYY-MM-DD>")
```
```

with:

```
Apply non-tag fields in one call:
```
clickup_update_task(task_id="<id>", status=STATUS.ready, priority="<priority>", due_date="<YYYY-MM-DD>")
```
```

- [ ] **Step 5: Delete the "Start time tracking" step (step 5)**

Delete this whole block:

```
## 5 — Start time tracking

```
clickup_get_current_time_entry()
clickup_stop_time_tracking()                                                # only if a timer runs on a different task
clickup_start_time_tracking(task_id="<id>", description="refine: ticket prep")
```

```

- [ ] **Step 6: Renumber the report step and drop the timer from it**

Replace:

```
## 6 — Report

One line per applied change (skip non-applicable lines): `title`, `body`, `subtasks-folded`, `assignees`, `tags`, `tags-missing`, `priority`, `due_date`, `pr-title-mirror`, `pr-title-mismatch`, `timer`. Then stop the timer (`/ship` starts its own):
```
clickup_stop_time_tracking()
```
End — the user invokes `/ship <id>` next.
```

with:

```
## 5 — Report

One line per applied change (skip non-applicable lines): `title`, `body`, `subtasks-folded`, `tags`, `tags-missing`, `priority`, `due_date`, `status`, `pr-title-mirror`, `pr-title-mismatch`. End — the user invokes `/ship <id>` next.
```

- [ ] **Step 7: Update the final rule about status + remove the timer rule**

Replace:

```
- **Single unit:** one ticket → one branch → one PR. Leave the ticket self-contained.
- Never invent dates. One timer per ticket — stop any prior timer first. This skill never moves status past `open` — `/ship` owns the lifecycle.
```

with:

```
- **Single unit:** one ticket → one branch → one PR. Leave the ticket self-contained.
- Never invent dates. This skill moves a refined draft to `STATUS.ready` (`pending`); `/ship` owns the rest of the lifecycle. No assignee, no time-tracking.
```

- [ ] **Step 8: Commit**

```bash
git add skills/refine-ticket/SKILL.md
git commit -m "feat(refine): drop assignee + timer, set STATUS.ready"
```

---

## Task 4: Rewrite `ship` — full lifecycle, status fix, drop assignee/timer

This is the core task. `/ship` absorbs `/resume`, `/finish`, and `/pause`; fixes the `completed`→`in review` bug; and removes assignee + ClickUp time-tracking. Replace the whole file.

**Files:**
- Modify (full rewrite): `skills/ship/SKILL.md`

- [ ] **Step 1: Replace the entire file contents**

Write `skills/ship/SKILL.md` with exactly:

````markdown
---
name: ship
description: "Repo-agnostic full-lifecycle orchestrator: ClickUp ticket → worktree → plan → delegate to supera-engineer (code + tests) → self-verified → PR → ticket 'in review' → /pr-watch, and on a merged PR closes the ticket + tears down. Idempotent: re-run to resume interrupted work or close out; `/ship pause` checkpoints mid-flight. Driven by .claude/supera.json so it works in any repo."
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Drive a task through its whole life — zero → open PR → merged → closed — in **any** repo. Read this repo's `.claude/supera.json` for stack commands, ClickUp list, worktree base, status names, and the tag table. Delegate the actual code + tests to the `supera-engineer` agent. `/ship` is **idempotent** and owns the entire phase ladder: a re-run continues from the detected phase (step 1.5) — resuming an interrupted build, opening the PR, or closing out a merged PR. `/ship pause` checkpoints work mid-flight. After the PR is open it hands off to `/pr-watch`.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /supera-init first."` Offer to run `/supera-init` now. Do not proceed without config.
- `CLICKUP = CONFIG.clickup?.listId` — if null/absent, run **ticket-less**: skip every ClickUp step below and operate on git + GitHub only.
- `BASE = CONFIG.worktree?.base ?? CONFIG.pr?.base ?? <detected default branch>`.
- `WT_DIR = CONFIG.worktree?.dir ?? ".worktrees"`. `REMOTE = CONFIG.pr?.remote ?? "origin"`.
- `STATUS` — resolve once from `CONFIG.clickup?.statuses ?? {}` with defaults:
  `STATUS.building = …?.building ?? "in progress"`,
  `STATUS.review = …?.review ?? "in review"`,
  `STATUS.closed = …?.closed ?? "closed"`.
  Always set ticket status via `STATUS.<key>` — never a hardcoded string.

## 1 — Parse arguments

**Pause sub-command:** if `$ARGUMENTS` begins with `pause` (e.g. `pause`, `pause 86abc`), run the **Pause checkpoint** flow at the end of this skill and stop — do not run the pipeline below.

Otherwise `$ARGUMENTS` may be:
- A free-text task description — e.g. `"add payment retry on timeout"`
- A ClickUp ticket ID + optional extra context — e.g. `"86abc123 also handle nil amounts"`
- Just a ClickUp ticket ID — e.g. `"86abc123"`
- A branch name (resume / close-out an existing ship) — e.g. `"feat-add-payment-retry-on-timeout"`

If empty, ask for a task description.

Derive a branch slug: lowercase, kebab-case, ≤50 chars, special chars stripped, prefixed by type with a **dash, never a slash** (`feat-`, `fix-`, `docs-`, `refactor-`, `chore-`). Example: `"add payment retry on timeout"` → `feat-add-payment-retry-on-timeout`. The slug is used verbatim as both the branch name **and** the worktree folder name, so it must be a single path segment — no `/`. This guarantees one flat folder per worktree (`<WT_DIR>/feat-add-payment-retry-on-timeout`), never a nested `<WT_DIR>/feat/…` subtree.

## 1.5 — Phase routing (idempotency + lifecycle)

Before creating anything, detect whether work for this task already exists — `/ship` must **never** double-create a worktree or duplicate an engineer's work, and a re-run drives the next phase. Detect the branch (the derived slug, or a branch name passed directly) and its state. The PR probe runs from the repo root (no worktree needed); the two `git -C <WT_DIR>/<slug>` probes run **only when the worktree is present**:
```bash
gh pr list --head <slug> --state all --json number,state     # PR? merged? (repo-root, always safe)
git worktree list | grep <slug>                              # worktree present? gates the next two:
git -C <WT_DIR>/<slug> log --oneline <REMOTE>/<BASE>..<slug> # commits beyond base?
git -C <WT_DIR>/<slug> log -1 --pretty=%s                    # is HEAD a 'wip:' checkpoint?
```
If a PR exists, route by the PR state **first** (`pr-open` / `merged`) — those phases don't need a live worktree, so a removed worktree never blocks close-out. The build phases (`scaffolded` / `building` / `built`) require the worktree probes; if a PR is absent and the worktree is gone, treat it as `fresh`. Route by phase (the shared lifecycle ladder). **Announce the detected phase before acting** so a mis-detection is visible:

| Phase | Signal | Action |
|---|---|---|
| `fresh` | no branch, no worktree | Fall through to step 2 (normal pipeline). |
| `scaffolded` | worktree/branch, **0 commits** vs base | **Resume:** delegate the full implementation (**Resuming interrupted work** below), then continue to step 5. |
| `building` | commits, **HEAD is `wip:`**, no PR | **Resume:** soft-reset the checkpoint, recover `nextUp`, delegate the remainder (**Resuming interrupted work** below), then continue to step 5. |
| `built` | commits, HEAD not `wip:`, no PR | Skip steps 2–4; jump straight to **step 5** (open the PR). |
| `pr-open` | PR exists, not merged | Invoke `/pr-watch <N>` (+ `--clickup-ticket=<id>` if a ticket is linked). Stop. |
| `merged` | PR merged | Run **Closing out a merged PR** below. Stop. |

Fresh tasks fall straight through — this guard only fires when prior work is detected.

## 2 — ClickUp ticket  *(skip entirely if ticket-less)*

**If a ticket ID was provided:** fetch it for the title + status:
```
clickup_get_task(task_id="<id>")
```
Use the title as the canonical task description (augmented by extra context from `$ARGUMENTS`).

**If no ticket ID:** create one on this repo's list, deriving tags from `CONFIG.tags`. Let ClickUp assign the list's default initial status (`open`) — do not name it:
```
clickup_create_task(
  list_id="<CLICKUP>",
  name="<task description>",
  markdown_description="<body from the ClickUp template below>",
  tags=[ ...matched CONFIG.tags values ]   # omit if none
)
```

Save the task ID — you update it throughout. No assignee (single-developer project).

## 3 — Create worktree

```bash
git fetch <REMOTE> <BASE>
git worktree add <WT_DIR>/<slug> -b <slug> <REMOTE>/<BASE>
```
Then run the post-create step (install) if defined:
```bash
cd <WT_DIR>/<slug> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>
```
Confirm the worktree exists and the install succeeded before continuing. If the worktree already exists for this branch, reuse it (do not error).

## 4 — Plan and delegate

Form an internal implementation plan. It stays internal — proceed immediately unless the user explicitly said "show me the plan first" or invoked `/plan` before `/ship`.

**Choose the executor:**
- **Default → `supera-engineer`** (one strong agent does code + tests, self-verifies).
- **Escalate → `nelson`** only when the ticket is genuinely multi-component and parallelisable (several independent subsystems, a migration across many sites). `nelson` fans the work out; use it sparingly — solo is the norm.

**Move ticket to building** *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", status=STATUS.building)
```

Announce: *"Plan ready. Delegating to `<executor>` in worktree `<WT_DIR>/<slug>`."*

Dispatch the executor with: the full task description, the worktree path, and the path to `.claude/supera.json`. The engineer self-verifies (build/test/lint from config) before returning — **do not run the quality gate yourself; CI is the gate, the engineer is the pre-flight.** Wait for its receipt. If the receipt shows a verification FAIL the engineer couldn't resolve in scope, surface it to the user before pushing.

## 5 — Create the PR

Push the branch:
```bash
git -C <WT_DIR>/<slug> push -u <REMOTE> <slug>
```

**Move ticket to in review** — PR open, CI running, awaiting review *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", status=STATUS.review)
```

Derive labels + tags from changed paths against `CONFIG.tags`:
```bash
git -C <WT_DIR>/<slug> diff --name-only <REMOTE>/<BASE>
```
Every `CONFIG.tags` glob matching at least one changed file contributes its tag — used as both the GitHub `--label` and (best-effort) the ClickUp tag. A PR can carry several. Apply ClickUp tags *(skip if ticket-less)*:
```
clickup_update_task(task_id="<id>", tags=[ ...matched tags ])
```
ClickUp tags must pre-exist in the space — if a tag call fails, continue (best-effort).

Write the PR body (template below), then create the PR assigned to `@me` so it lands in the user's review queue. Do **not** add `--reviewer` (GitHub blocks self-review; the gh-CLI user is the author):
```bash
gh pr create \
  --base <BASE> \
  --title "<short human summary, <70 chars, no conventional-commit prefix>" \
  --body "$(cat <<'EOF'
<body below>
EOF
)" \
  --assignee @me \
  --label "<tag1>" --label "<tag2>"
```
Save the PR number. Link it on the ticket *(skip if ticket-less)*:
```
clickup_create_task_comment(task_id="<id>", comment_text="PR #<N> opened: <PR URL>")
```

## 6 — Hand off to /pr-watch

Invoke `/pr-watch <PR-number>` — append `--clickup-ticket=<ticket-id>` only when a ticket exists.

Announce: *"PR #<N> is open. <Ticket in review (CI running). >Handing off to `/pr-watch <PR-number>`. Once it reports the PR merged, re-run `/ship <slug>` to close the ticket and clean up."*

---

## Resuming interrupted work (phases `scaffolded` / `building`)

Reached from step 1.5 when a worktree/branch exists but no PR. `/ship` continues the build, then falls through to step 5 to open the PR — it never restarts from scratch.

If the worktree is missing but the branch exists on the remote (paused on another machine), recreate it first:
```bash
git fetch <REMOTE> <slug>
git worktree add <WT_DIR>/<slug> <slug>
cd <WT_DIR>/<slug> && <CONFIG.worktree.postCreate ?? CONFIG.verify.install>
```

**`building` — undo the checkpoint first.** A `wip:` HEAD is a pause checkpoint, not real history. Un-commit it so the engineer continues from clean staged state, and recover `nextUp`:
```bash
git -C <WT_DIR>/<slug> show -s --format=%b HEAD     # read nextUp from the wip: body BEFORE resetting
git -C <WT_DIR>/<slug> reset --soft HEAD~1
```
Also read the latest `⏸ Paused` ClickUp comment *(ticket mode)* for `nextUp`.

**Re-delegate the remainder.** Move the ticket to building and dispatch the engineer *(skip the ClickUp line if ticket-less)*:
```
clickup_update_task(task_id="<id>", status=STATUS.building)
```
Dispatch `supera-engineer` with: the task description (ticket title + recovered `nextUp`), the worktree path, and the path to `.claude/supera.json`. For `building`, lead with `nextUp` so the engineer continues exactly where pause stopped — don't redo finished work. The engineer self-verifies before returning (**CI is the gate; don't run the full build/test/lint here**). Wait for its receipt; surface any unresolved FAIL before continuing.

Then fall through to **step 5** to open the PR. If a soft-reset rewrote an already-pushed `wip:` commit, push with `--force-with-lease` (never `--force`).

---

## Pause checkpoint (`/ship pause`)

Reached from step 1 when `$ARGUMENTS` begins with `pause`. Stop work cleanly so a later `/ship <slug>` resumes without guessing. No state file — git carries the work; the ticket comment is the human mirror.

1. **Resolve the WIP.** Parse the rest of `$ARGUMENTS` (ticket id, branch, or empty). Empty → the current branch or the single worktree under `WT_DIR` (ambiguous → list and ask). Resolve `WT_PATH`, `BRANCH`, and (ticket mode) `TICKET`.
2. **Capture `nextUp`.** In one or two concrete lines, what is done and what remains — name the next file/step, not "continue work". This becomes the `wip:` commit subject + body and the payload a resume reads back.
3. **Commit the checkpoint:**
```bash
git -C <WT_PATH> add -A
git -C <WT_PATH> status --porcelain      # anything staged?
```
   - Changes present → `git -C <WT_PATH> commit -m "wip: <nextUp one-liner>" -m "<remaining steps, one per line>"`.
   - Tree already clean → skip the commit; the branch state itself is the checkpoint.
   The `wip:` prefix is load-bearing: the resume path keys off it to soft-reset before continuing. Never name a real commit `wip:`.
4. **Push so the work survives:** `git -C <WT_PATH> push -u <REMOTE> <BRANCH>` (`--force-with-lease` only if it rewrote history).
5. **Sync the ticket** *(skip if ticket-less)* — comment the pause; leave the status `STATUS.building` (pause is not a blocker):
```
clickup_create_task_comment(task_id="<TICKET>", comment_text="⏸ Paused. Done: <…>. Next: <nextUp>. Branch `<BRANCH>` pushed — resume with /ship <BRANCH>.")
```
6. **Report:** *"Paused `<BRANCH>`. WIP committed + pushed, worktree kept. Resume with `/ship <BRANCH>`."* List `wip-commit` (sha or "tree clean"), `pushed`, `ticket-comment` (ticket mode only). Stop.

---

## Closing out a merged PR (phase `merged`)

Reached from step 1.5 when the PR is `MERGED`. Record what shipped, close the ticket, tear down the workspace. Only merged work is closed here — abandoning unmerged work is a manual `gh pr close` + `git worktree remove`. **The worktree may already be gone** (close-out partially ran, or it was paused/removed on another machine), so build the summary from `gh` — which works from the repo root — not from `git -C <WT_PATH>`.

1. **Build the summary — all from the merged PR (no live worktree needed):**
   - **Goal** — the ticket title *(ticket mode)*, else the branch slug as a one-line intent.
   - **Files, commit count, first-commit time, merge time:**
```bash
gh pr view <N> --json files   -q '.files[].path'              # changed files
gh pr view <N> --json commits -q '.commits | length'         # commit count
gh pr view <N> --json commits -q '.commits[0].committedDate' # first commit time (PR commits are oldest-first)
gh pr view <N> --json mergedAt -q .mergedAt                   # merge time
```
   **Time spent** = first-commit time → merge time (no ClickUp time-tracking API).
   Format:
```
✅ Shipped: <goal>
   PR #<N> merged · <X commits> · ⏱ ~<T> (<first hh:mm> → merged <hh:mm>)
   Files (<count>):
     - <path>
     - <path>
```
2. **Close the ticket** *(skip if ticket-less)* — post the summary as a comment, then set closed:
```
clickup_create_task_comment(task_id="<TICKET>", comment_text="<summary block>")
clickup_update_task(task_id="<TICKET>", status=STATUS.closed)
```
3. **Tear down the workspace** (silently — no confirm; each step is guarded so a missing worktree/branch is a no-op, not an error):
```bash
git worktree list | grep -q "<WT_DIR>/<slug>" && git worktree remove <WT_PATH>   # --force only if it refuses on an unclean tree
git rev-parse --verify --quiet <BRANCH> >/dev/null && git branch -D <BRANCH>      # delete local branch if present
```
   Leave the remote branch alone (GitHub deletes it on merge if configured). **Never** remove `BASE` or its worktree.
4. **Report:** print the summary to the terminal (ticket-less prints only) and confirm: *"Ticket closed, worktree removed, branch `<BRANCH>` deleted locally."* The lifecycle is closed.

---

## Lifecycle controls

`/ship` owns the whole ladder. Only `/pr-watch` lives outside it — `/ship` routes to it, never duplicates it. `/ship pause` is a sub-command, not a separate skill.

| Control | When | Owns |
|---|---|---|
| `/ship pause <ticket\|branch>` | Need to stop mid-ticket | Commits + pushes a `wip:` checkpoint, comments the ticket, **keeps** the worktree. |
| `/ship <branch>` (re-run, `building`/`scaffolded`) | A ship didn't finish | Detects the phase, undoes a `wip:` checkpoint, re-delegates the remainder to `supera-engineer`, opens the PR. |
| `/pr-watch <N>` | PR is open | Drives CI green + review threads to resolution. Hands merged PRs back to `/ship`. |
| `/ship <branch>` (re-run, `merged`) | PR is merged | Posts the summary (goal · time · files), sets the ticket `closed`, removes the worktree + local branch. The terminal step. |

The phase ladder in step 1.5 is the shared contract: `fresh → scaffolded → building → built → pr-open → merged`. Every skill detects it the same way (git + ClickUp, no state file).

---

## ClickUp ticket body template

```
## Context
<1–2 sentences: what's broken / missing and why now>

## Outcome
- <observable change 1>
- <observable change 2>

## Out of scope
- <related but deferred>          ← omit section if empty

## Notes
- <link or fact>                   ← omit section if empty
```

## GitHub PR body template

```
## Summary
<one paragraph: what changed and why — for a reviewer who hasn't seen the ticket>

## Changes
- <concrete change per area>

## Test plan
- [ ] <verification step the reviewer can run or check>

## Notes
<ClickUp link if a ticket exists: [ClickUp #<id>](https://app.clickup.com/t/<id>)>
<load-bearing decisions or known follow-ups — omit if none>
```

## Ticket lifecycle reference  *(ClickUp mode only)*

| Phase | Status | Set by |
|---|---|---|
| Refined, ready to ship | `STATUS.ready` (`pending`) | `/refine-ticket` |
| Engineer dispatched | `STATUS.building` (`in progress`) | `/ship` step 4 |
| Branch pushed, PR open, CI + review | `STATUS.review` (`in review`) | `/ship` step 5 |
| Paused mid-ticket | `STATUS.building` (unchanged) | `/ship pause` |
| Unexpected blocker / repeat CI fail | `STATUS.blocked` (`blocked`) | `/pr-watch` |
| PR closed without merge | `STATUS.rejected` (`rejected`) | `/pr-watch` |
| PR merged → closed out | `STATUS.closed` (`closed`) | `/ship` (merged path) |

Human-only verdicts `completed` / `accepted` are never set by a skill — mark them by hand if you want that nuance in the log.

## Rules

- Read `.claude/supera.json` first — never hardcode commands, list IDs, branches, tags, or **status names** (always `STATUS.<key>`).
- Ticket-less mode (no `clickup.listId`) is first-class: skip all ClickUp steps, ship purely on git + GitHub. Derive close-out time from git commit timestamps.
- Never commit directly to the base branch. Never remove `BASE` or its worktree.
- **Idempotent + full-lifecycle:** run the step 1.5 phase routing first — never double-create a worktree or duplicate work; continue from the detected phase (resume / open PR / close out). Only `/pr-watch` lives outside `/ship`; never duplicate it.
- Always delegate code + tests to `supera-engineer` (or `nelson` for genuinely parallel work) — `/ship` orchestrates, it does not implement.
- The engineer self-verifies as pre-flight; **CI is the quality gate** — do not run a full build/test/lint from the orchestrator before pushing.
- Always `--assignee @me`, never `--reviewer`. No ClickUp assignee, no ClickUp time-tracking.
- A `wip:` HEAD is always soft-reset before resuming, then pushed `--force-with-lease` (never `--force`).
````

- [ ] **Step 2: Verify no raw status literal and no dead refs remain in ship**

Run: `grep -nE 'status[[:space:]]*=[[:space:]]*"|/(resume|finish|pause)' skills/ship/SKILL.md; echo "exit=$?"`
Expected: no matches, `exit=1` (grep found nothing). (`/ship pause` does not match `/pause`.)

- [ ] **Step 3: Commit**

```bash
git add skills/ship/SKILL.md
git commit -m "feat(ship): full lifecycle (resume+finish+pause), STATUS.review fix, drop assignee/timer"
```

---

## Task 5: Edit `pr-watch` — `STATUS.*`, rejected on close, hand merged to `/ship`

**Files:**
- Modify: `skills/pr-watch/SKILL.md`

- [ ] **Step 1: Load `STATUS` in step 0**

Replace:

```
## 0 — Load config

Read `.claude/supera.json` into `CONFIG` (for `verify.*` commands and `pr.base`/`pr.remote`). If absent, proceed with sensible git/gh defaults and skip any config-derived command (tell the user once that supera isn't initialised here).
```

with:

```
## 0 — Load config

Read `.claude/supera.json` into `CONFIG` (for `verify.*` commands and `pr.base`/`pr.remote`). If absent, proceed with sensible git/gh defaults and skip any config-derived command (tell the user once that supera isn't initialised here).

Resolve `STATUS` once from `CONFIG.clickup?.statuses ?? {}` with defaults: `STATUS.review = …?.review ?? "in review"`, `STATUS.blocked = …?.blocked ?? "blocked"`, `STATUS.rejected = …?.rejected ?? "rejected"`. Set ticket status only via `STATUS.<key>`.
```

- [ ] **Step 2: `MERGED` hands to `/ship`; `CLOSED` sets `STATUS.rejected`**

Replace:

```
- `MERGED` → **do not set the ticket status here** — `/finish` owns the `complete` close + teardown + summary. Announce: *"PR #<N> is merged — run `/finish`<` <ticket-id>` if `CLICKUP_TICKET` set> to close the ticket, summarise, and clean up the worktree."* Exit.
- `CLOSED` (not merged) → if `CLICKUP_TICKET` set, surface it; announce; exit.
```

with:

```
- `MERGED` → **do not close here** — `/ship` owns the close + teardown + summary. Announce: *"PR #<N> is merged — run `/ship <branch>` to close the ticket, summarise, and clean up the worktree."* Exit.
- `CLOSED` (not merged) → if `CLICKUP_TICKET` set, `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.rejected)`; surface it; announce; exit.
```

- [ ] **Step 3: CI-passed sets `STATUS.review` (idempotent assert)**

Replace:

```
### Passed
If `CLICKUP_TICKET` set, move ticket to `in review`. Proceed to step 4.
```

with:

```
### Passed
If `CLICKUP_TICKET` set, ensure the ticket is at `STATUS.review` (`/ship` already set it at push; assert idempotently — only update if it drifted): `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.review)`. Proceed to step 4.
```

- [ ] **Step 4: 2× failure escalation sets `STATUS.blocked`**

Replace:

```
Dispatch `supera-engineer` with the exact log excerpt; wait for the fix. **Track attempts — if the same failure repeats after 2 fix attempts:** if `CLICKUP_TICKET` set move ticket to `blocked`; stop; show the full log; ask for guidance; exit the turn.
```

with:

```
Dispatch `supera-engineer` with the exact log excerpt; wait for the fix. **Track attempts — if the same failure repeats after 2 fix attempts:** if `CLICKUP_TICKET` set, `clickup_update_task(task_id="<CLICKUP_TICKET>", status=STATUS.blocked)`; stop; show the full log; ask for guidance; exit the turn.
```

- [ ] **Step 5: Update the MERGED rule + blocked rule**

Replace:

```
- On `MERGED`, defer the close to `/finish` — never set the ticket `complete` or remove the worktree here; `/finish` owns the terminal step.
```

with:

```
- On `MERGED`, defer the close to `/ship` — never close the ticket or remove the worktree here; `/ship` owns the terminal step.
```

Then replace:

```
- Same CI failure twice after 2 fix attempts → ticket `blocked` (if linked), stop, show the log, ask.
```

with:

```
- Same CI failure twice after 2 fix attempts → ticket `STATUS.blocked` (if linked), stop, show the log, ask.
- PR closed without merge → ticket `STATUS.rejected` (if linked).
```

- [ ] **Step 6: Verify**

Run: `grep -nE 'status[[:space:]]*=[[:space:]]*"|/(resume|finish|pause)' skills/pr-watch/SKILL.md; echo "exit=$?"`
Expected: no matches, `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add skills/pr-watch/SKILL.md
git commit -m "feat(pr-watch): STATUS.* names, rejected on close, hand merged to /ship"
```

---

## Task 6: Update `fast-ship` prose (remove dead command names)

**Files:**
- Modify: `skills/fast-ship/SKILL.md` (line 7)

- [ ] **Step 1: Remove `/pause` / `/resume` / `/finish` from the intro**

Replace:

```
The deliberate fast path opposite of `/ship`. For a **small** change that doesn't merit a worktree, a PR, or a ticket — ship it straight to the base branch. No phase ladder, no `/pause` / `/resume` / `/pr-watch` / `/finish`; this skill runs start to finish in one shot.
```

with:

```
The deliberate fast path opposite of `/ship`. For a **small** change that doesn't merit a worktree, a PR, or a ticket — ship it straight to the base branch. No phase ladder, no `/ship` orchestration, no `/pr-watch`; this skill runs start to finish in one shot.
```

- [ ] **Step 2: Verify no dead refs remain in fast-ship**

Run: `grep -nE '/(resume|finish|pause)' skills/fast-ship/SKILL.md; echo "exit=$?"`
Expected: no matches, `exit=1`.

- [ ] **Step 3: Commit**

```bash
git add skills/fast-ship/SKILL.md
git commit -m "docs(fast-ship): drop references to folded-in commands"
```

---

## Task 7: Delete the folded-in skills

**Files:**
- Delete: `skills/resume/SKILL.md` (+ its directory)
- Delete: `skills/finish/SKILL.md` (+ its directory)
- Delete: `skills/pause/SKILL.md` (+ its directory)

- [ ] **Step 1: Remove the three skill directories**

```bash
git rm -r skills/resume skills/finish skills/pause
```

- [ ] **Step 2: Verify they're gone and nothing references them**

Run: `ls skills/ && grep -rnE '/(resume|finish|pause)' skills/ --include=SKILL.md; echo "exit=$?"`
Expected: `skills/` lists `fast-ship pr-watch refine-ticket ship supera-init` (no resume/finish/pause); grep prints nothing, `exit=1`.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: delete /resume, /finish, /pause (folded into /ship)"
```

---

## Task 8: Update CLAUDE.md skill inventory + invariants

**Files:**
- Modify: `CLAUDE.md` (the `skills/` row, the implementer invariant, the phase-ladder invariant)

- [ ] **Step 1: Update the `skills/` table row**

Replace:

```
| `skills/` | `supera-init`, `ship`, `fast-ship`, `pause`, `resume`, `finish`, `pr-watch`, `refine-ticket` — each a `SKILL.md`. `ship`/`pause`/`resume`/`finish` share one phase ladder (`fresh→scaffolded→building→built→pr-open→merged`), detected from git + ClickUp with no state file. `fast-ship` is the no-worktree/no-PR/no-ticket fast path — it ships small changes straight to base and sits outside the ladder. |
```

with:

```
| `skills/` | `supera-init`, `ship`, `fast-ship`, `pr-watch`, `refine-ticket` — each a `SKILL.md`. `ship` owns the full phase ladder (`fresh→scaffolded→building→built→pr-open→merged`), detected from git + ClickUp with no state file: re-run `/ship` to resume interrupted work or close out a merged PR, and `/ship pause` to checkpoint mid-flight. `fast-ship` is the no-worktree/no-PR/no-ticket fast path — it ships small changes straight to base and sits outside the ladder. |
```

- [ ] **Step 2: Update the implementer invariant**

Replace:

```
- **`supera-engineer` is the only implementer.** `/ship`, `/fast-ship`, `/resume`, and `/pr-watch` orchestrate and delegate; they never edit application code themselves. `nelson` is escalation-only for multi-component work.
```

with:

```
- **`supera-engineer` is the only implementer.** `/ship`, `/fast-ship`, and `/pr-watch` orchestrate and delegate; they never edit application code themselves. `nelson` is escalation-only for multi-component work.
```

- [ ] **Step 3: Update the phase-ladder invariant**

Replace:

```
- **One phase ladder, one owner per phase.** The lifecycle (`fresh→scaffolded→building→built→pr-open→merged`) is derived from git + ClickUp — **no state file**. `/ship` is idempotent (continues from the detected phase). `/pause` owns the `wip:` checkpoint convention; `/resume` owns continuation; `/finish` owns the `complete` close + worktree teardown (`/pr-watch` defers it). Skills detect the phase the same way and never duplicate each other's step.
```

with:

```
- **One phase ladder, one owner.** The lifecycle (`fresh→scaffolded→building→built→pr-open→merged`) is derived from git + ClickUp — **no state file**. `/ship` owns the whole ladder and is idempotent: it resumes interrupted builds, opens the PR, and on a merged PR closes the ticket (status `closed`) + tears down the worktree. `/ship pause` writes the `wip:` checkpoint. `/pr-watch` drives the open PR green and hands merged PRs back to `/ship`. Status names are config-driven (`clickup.statuses` in the schema → `STATUS.<key>` in skills), never hardcoded.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for folded lifecycle + config-driven statuses"
```

---

## Task 9: Document the `statuses` field in an example

Defaults make `statuses` optional, but one example should show it for discoverability.

**Files:**
- Modify: `examples/workloads.supera.json`

- [ ] **Step 1: Add a `statuses` block to the clickup config**

Replace:

```json
  "clickup": { "listId": "901415284967" },
```

with:

```json
  "clickup": {
    "listId": "901415284967",
    "statuses": {
      "ready": "pending",
      "building": "in progress",
      "review": "in review",
      "blocked": "blocked",
      "rejected": "rejected",
      "closed": "closed"
    }
  },
```

- [ ] **Step 2: Validate the JSON parses**

Run: `jq -e . examples/workloads.supera.json > /dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add examples/workloads.supera.json
git commit -m "docs(examples): show clickup.statuses map in workloads example"
```

---

## Task 10: Make `supera-init` emit the `statuses` block

Defaults cover behaviour, but a freshly-initialised repo never surfaces the status map — it's only discoverable by reading the schema. Have `supera-init` write the defaults inline (commented) when a ClickUp list is set, so the names are visible and editable per space. The gate is safe: the emitted JSON uses `"statuses": {...}`, not `status="..."`, and contains no `STATUS.` token.

**Files:**
- Modify: `skills/supera-init/SKILL.md`

- [ ] **Step 1: Emit `statuses` when a list is resolved (step 3)**

Replace:

```
`none` → `"clickup": null`. Otherwise `"clickup": { "listId": "<id>" }`.
```

with:

```
`none` → `"clickup": null`. Otherwise emit the list **and** the status defaults so per-space names are discoverable and editable:
`"clickup": { "listId": "<id>", "statuses": { "ready": "pending", "building": "in progress", "review": "in review", "blocked": "blocked", "rejected": "rejected", "closed": "closed" } }`.
These defaults validate against `clickup.statuses` in the schema; the user edits a value only if this ClickUp space renamed a status.
```

- [ ] **Step 2: Update the written-config template (step 4)**

Replace:

```
  "clickup": { "listId": "<id>" },   // or null
```

with:

```
  "clickup": {                       // or null to run ticket-less
    "listId": "<id>",
    // Optional per-space status names; defaults shown. Edit only if this ClickUp
    // space renamed a status. Omit the whole block to keep these defaults.
    "statuses": {
      "ready": "pending", "building": "in progress", "review": "in review",
      "blocked": "blocked", "rejected": "rejected", "closed": "closed"
    }
  },
```

- [ ] **Step 3: Add the rule**

Replace:

```
- Output must validate against `schema/supera.schema.json`.
```

with:

```
- When a ClickUp list is set, emit the `clickup.statuses` defaults inline so status names are visible and editable per space; omit the block (or any single key) to fall back to the schema defaults.
- Output must validate against `schema/supera.schema.json`.
```

- [ ] **Step 4: Verify supera-init stays gate-clean**

Run: `grep -nE 'status[[:space:]]*=[[:space:]]*"|STATUS\.|/(resume|finish|pause)' skills/supera-init/SKILL.md; echo "exit=$?"`
Expected: no matches, `exit=1` (the emitted `"statuses": {...}` block is not a `status="..."` literal).

- [ ] **Step 5: Commit**

```bash
git add skills/supera-init/SKILL.md
git commit -m "feat(supera-init): emit clickup.statuses defaults for discoverability"
```

---

## Task 11: Bump version + update manifest descriptions

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Bump `plugin.json` to 0.4.0 + update description**

Replace:

```json
  "description": "Repo-agnostic ticket-shipping superagent: ship, pause, resume, finish, pr-watch, refine-ticket, and a supply-chain auditor. One strong engineer agent does code + tests; behaviour is driven by a per-repo .claude/supera.json so the same skills work across pnpm, npm, cargo, Strapi, and more.",
  "version": "0.3.1",
```

with:

```json
  "description": "Repo-agnostic ticket-shipping superagent: ship (full lifecycle — resume, pause, close-out), fast-ship, pr-watch, refine-ticket, and a supply-chain auditor. One strong engineer agent does code + tests; behaviour is driven by a per-repo .claude/supera.json so the same skills work across pnpm, npm, cargo, Strapi, and more.",
  "version": "0.4.0",
```

- [ ] **Step 2: Bump `marketplace.json` to 0.4.0 + update description**

Replace:

```json
      "description": "Repo-agnostic ticket-shipping superagent: ship, pause, resume, finish, pr-watch, refine-ticket, and a supply-chain auditor, driven by a per-repo .claude/supera.json config.",
      "version": "0.3.1",
```

with:

```json
      "description": "Repo-agnostic ticket-shipping superagent: ship (full lifecycle), fast-ship, pr-watch, refine-ticket, and a supply-chain auditor, driven by a per-repo .claude/supera.json config.",
      "version": "0.4.0",
```

- [ ] **Step 3: Verify versions match**

Run: `jq -r '.version' .claude-plugin/plugin.json; jq -r '.plugins[0].version' .claude-plugin/marketplace.json`
Expected: both print `0.4.0`.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump to 0.4.0; refresh manifest descriptions"
```

---

## Task 12: Run the gate green (final verification)

**Files:** none (verification only)

- [ ] **Step 1: Run the consistency gate**

Run: `bash scripts/check-consistency.sh; echo "exit=$?"`
Expected: `OK(1)`, `OK(2)`, `OK(3)`, `OK(4)`, then `exit=0`.

- [ ] **Step 2: If any check fails, fix the offending file and re-run**

The gate names the file:line. Fix forward (re-edit the skill / schema / manifest), re-run until `exit=0`. Do not weaken the gate to pass.

- [ ] **Step 3: Confirm the full skill set is coherent**

Run: `ls skills/ && grep -rln 'STATUS\.' skills/ --include=SKILL.md`
Expected: `skills/` = `fast-ship pr-watch refine-ticket ship supera-init`; `STATUS.` appears in `ship`, `pr-watch`, `refine-ticket`.

---

## Task 13: Manual ClickUp board reorder (human, no commit)

The board lives in ClickUp, not in this repo — apply by hand in the Workloads space UI. This is the only step supera can't automate.

- [ ] **Step 1: Reorder statuses into three groups**

```
Active:  OPEN → PENDING → IN PROGRESS → IN REVIEW → BLOCKED
Done:    COMPLETED → ACCEPTED → REJECTED
Closed:  CLOSED
```

Happy path (`OPEN→PENDING→IN PROGRESS→IN REVIEW→…→CLOSED`) is monotonic so the Progress-icons ClickApp fills cleanly. `BLOCKED` stays in Active (live but stuck). The three human verdicts sit in Done; `CLOSED` archives.

- [ ] **Step 2: Sanity-check one ticket end-to-end**

Run `/refine-ticket <id>` → confirm status moves to `PENDING`. Then `/ship <id>` → `IN PROGRESS` → (PR push) `IN REVIEW`. After merge, re-run `/ship <branch>` → `CLOSED`. Confirm the progress icons never run backward.

---

## Accepted non-goals (acknowledged gaps, no task)

Three gaps from the honest review are deliberately **not** addressed in code. They are owned by a human or live outside this repo:

1. **`COMPLETED` / `ACCEPTED` are human-only verdicts.** No skill ever sets them — they sit in the board's *Done* group (Task 13) for a person to mark when they want that nuance. Automating them would be theater: supera can't judge whether work is genuinely "accepted." Documented in the ship lifecycle reference and the schema description (deliberately absent from `clickup.statuses`).
2. **Meta-over-product.** This change improves the *plugin's* status discipline, not the products it ships. That's intrinsic to a tooling repo — out of scope by definition.
3. **No ClickUp-side auto-close.** Closing a ticket is driven by `/ship` on a merged PR (`STATUS.closed`); there is no ClickUp automation/webhook that closes a ticket when a PR merges out-of-band. If a PR is merged without `/ship`, the human re-runs `/ship <branch>` (the merged-phase close-out) or sets `closed` by hand. Adding a webhook is a separate, infra-level project.

## Self-review notes (author)

- **Spec coverage:** §3 status model → Tasks 1,3,4,5,13. §4 schema → Task 1. §5.1 refine → Task 3. §5.2 ship → Task 4. §5.3 pr-watch → Task 5. §5.4 pause-fold → Task 4 (Pause section). §5.5 close-out (worktree-optional, `gh`-derived) → Task 4 (Closing section). §5.6 deletions → Task 7 (+ fast-ship Task 6). §5.7 supera-init emits `statuses` → Task 10. §6 CI gate (scans `skills/` + `agents/`) → Task 2. §7 accepted non-goals → "Accepted non-goals" above. §9 release (CLAUDE.md, example, version, board) → Tasks 8,9,11,13. All covered.
- **No placeholders:** every edit shows exact before/after; ship is a full-file write.
- **Type/name consistency:** `STATUS.{ready,building,review,blocked,rejected,closed}` used identically across schema (Task 1), refine (Task 3), ship (Task 4), pr-watch (Task 5), and the gate (Task 2). No `STATUS.open`/`STATUS.completed` used (not in schema — would fail gate check 3, correctly).
- **Gate scope:** the gate scans both `skills/` and `agents/` (Task 2) so a status literal or dead `/resume,/finish,/pause` ref can't hide in an agent file or in supera-init's emitted config. Verified `agents/` is already clean, so broadening scope doesn't trip a false positive.
- **Close-out robustness:** the merged-phase summary derives from `gh pr view` (files, commit count, first-commit/merge time) and the teardown is existence-guarded (`git worktree list | grep -q`, `git rev-parse --verify`), so a removed worktree never blocks close-out (Task 4). Phase routing probes the PR state first for the same reason.
- **Gate determinism:** Task 2 documents the red state (FAIL 2 + 4); Task 12 confirms green. The grep `/(resume|finish|pause)` deliberately does not match `/ship pause` (slash precedes `ship`).
