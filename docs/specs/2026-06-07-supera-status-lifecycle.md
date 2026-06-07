# Supera status lifecycle redesign + solo-dev trim

**Date:** 2026-06-07
**Status:** Approved — all decisions locked (O1/O2 resolved)
**Scope:** `schema/supera.schema.json`, `skills/{ship,pr-watch,refine-ticket,supera-init}`, deletion of `skills/{resume,finish,pause}`, `examples/*`, new CI consistency gate, version bump.

---

## 1. Problem

Three classes of problem, found by reading all six lifecycle skills + the schema against the actual ClickUp board.

### 1.1 Status order is semantically wrong, and supera mirrors it
ClickUp board order today (Workloads space):
`OPEN → PENDING → IN PROGRESS → COMPLETED → IN REVIEW → ACCEPTED → REJECTED → BLOCKED → CLOSED`.

`COMPLETED` sits **before** `IN REVIEW`. `ship/SKILL.md` follows the broken order literally: step 5 sets `completed` the moment the PR is pushed (CI not even green), then `/pr-watch` later sets `in review`. A PR is marked done *before* review. With the Progress-icons ClickApp enabled, board progress visibly fills then drops backward.

### 1.2 Bugs and dead config
- **String mismatch:** `ship` sets `status="completed"`; `finish` sets `status="complete"` (finish:69). Only `COMPLETED`/`CLOSED` exist — `"complete"` matches nothing, so `/finish` likely no-ops the close.
- **Hardcoded status strings** across ship/pr-watch/resume/finish/refine — violates the CLAUDE.md invariant *"Nothing repo-specific is hardcoded in a skill."* Status names are space-specific. Schema has **zero** status config.
- **Dead states:** `PENDING`, `ACCEPTED`, `REJECTED` are never set by any skill.

### 1.3 Team ceremony in a one-person project
Assignee assignment and ClickUp time-tracking both throw API errors and add no value for a solo developer. They are the two most ceremonial pieces of the lifecycle. `resume`, `finish`, and `ship` share one phase ladder and **detect state identically** (git + ClickUp, no state file) — three skills doing one idempotent skill's job.

---

## 2. Decisions (locked via Q&A)

| # | Decision |
|---|---|
| D1 | Adopt the corrected status order + 3 ClickUp groups (§3). |
| D2 | Statuses are an **audit log**. Automation drives the happy path; terminal verdicts auto-close. |
| D3 | Add a `clickup.statuses` map to the schema; skills read names from `CONFIG`, never literals. |
| D4 | `/finish` (folded into `/ship`) sets **`closed`** directly on merge. |
| D5 | `REJECTED` is terminal = ticket closed (PR closed without merge). |
| D6 | **Drop assignee** entirely (errors, no value solo). |
| D7 | **Drop ClickUp time-tracking API** entirely. Time is derived from git and posted as a **comment**. |
| D8 | Trim: fold `/resume`, `/finish`, **and `/pause`** into idempotent `/ship` (resolved O1); add a schema↔skill CI gate. |
| D9 | Close-out tears down worktree + branch **silently**, no confirm (resolved O2). |

---

## 3. Status model

### 3.1 Lifecycle (the log)
```
OPEN ──► PENDING ──► IN PROGRESS ──► IN REVIEW ──► CLOSED
(raw     (refined,   (engineer       (PR open:      (merged,
 backlog) ready)      building)       CI + human)    auto-closed)
                          ▲
                       BLOCKED (stuck, not terminal)

terminal verdicts (human log markers): COMPLETED · ACCEPTED · REJECTED
```

### 3.2 Phase → status → owner
| stage | status | who sets |
|---|---|---|
| raw backlog (even just a title) | `open` | human / ticket create |
| refined, ready to ship | `pending` | `/refine-ticket` *(was `open`)* |
| engineer building | `in progress` | `/ship` |
| PR open: CI + human review | `in review` | `/ship` at PR push *(was `completed` 🐛)* |
| stuck: 2× CI fail / blocker | `blocked` | `/pr-watch` |
| PR closed without merge | `rejected` | `/pr-watch` |
| merged | `closed` | `/ship` (merged path) *(was `complete` 🐛)* |
| human verdict markers | `completed` / `accepted` | human only |

Automation drives **4 happy-path statuses** (`pending → in progress → in review → closed`) + **2 exceptions** (`blocked`, `rejected`). `completed`/`accepted` stay available for the human to mark, but supera's merge path goes straight to `closed`.

### 3.3 ClickUp board config (applied by hand in the UI)
```
Active:  OPEN → PENDING → IN PROGRESS → IN REVIEW → BLOCKED
Done:    COMPLETED → ACCEPTED → REJECTED
Closed:  CLOSED
```
Happy path monotonic so progress icons fill cleanly. `BLOCKED` stays Active (live-but-stuck). The three verdicts sit in Done; `CLOSED` archives. This is a manual ClickUp step, documented here, not code.

---

## 4. Schema change

Add to `clickup` in `schema/supera.schema.json`:

```json
"statuses": {
  "type": "object",
  "description": "Maps supera lifecycle phases to THIS repo's ClickUp status names (statuses are space-specific). Each skill reads CONFIG.clickup.statuses.<key>; omit a key to keep its default. Used only when clickup.listId is set.",
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
```

Defaults = current strings, so **every existing `.claude/supera.json` keeps working untouched** (backward compatible). `completed`/`accepted` are deliberately *not* in the map — supera never sets them.

`backlog`/`open` is not in the map: ticket creation uses ClickUp's default initial status (`open`); no skill needs to name it.

---

## 5. Skill changes

Every ClickUp-touching skill loads `STATUS = CONFIG.clickup?.statuses ?? {}` in step 0 and reads `STATUS.<key> ?? "<default>"`. No status literal remains in any skill body.

### 5.1 `refine-ticket`
- **Drop assignee:** remove `assignees=["me"]` from the `clickup_update_task` call (refine:75) and the assignee row from its template table (refine:71-area).
- **Drop time-tracking:** remove "start time tracking so /ship can pick it up clean" from the description and any timer call.
- **Status:** set `STATUS.ready` (`pending`) instead of `open`. Update the "never moves status past `open`" rule → "moves a refined draft to `ready`; `/ship` owns the rest."

### 5.2 `ship`
- **Step 0:** drop the "tracks time … via `clickup_start/stop_time_tracking`" paragraph (ship:18). Load `STATUS`.
- **Step 2:** drop `clickup_resolve_assignees` + `assignees=[…]` from `clickup_create_task`. Drop the "Start time tracking — phase: ticket setup" block (ship:77-82).
- **Steps 3, 4, 5, 6:** delete every "Switch/Stop time tracking" block.
- **Step 4:** `clickup_update_task(status=STATUS.building)`.
- **Step 5 (the core fix):** replace `clickup_update_task(status="completed")` with `clickup_update_task(status=STATUS.review)`. Update surrounding prose ("Move ticket to **in review** — PR open, CI running, awaiting review").
- **Step 1.5 routing — absorb resume + finish:**
  | Phase | Signal | New action |
  |---|---|---|
  | `fresh` | no branch/worktree | step 2 (normal pipeline) |
  | `scaffolded` | worktree/branch, 0 commits | delegate full impl to engineer, continue to PR |
  | `building` | commits, **HEAD is `wip:`** | soft-reset checkpoint, recover `nextUp`, delegate remainder, continue to PR |
  | `built` | commits, no `wip:` HEAD, no PR | jump to step 5 (open PR) |
  | `pr-open` | PR exists, not merged | invoke `/pr-watch <N>` |
  | `merged` | PR merged | **run the close-out** (§5.5) |
- **Step 6 announce:** drop "run `/finish`"; reflect that `/ship` re-run on a merged PR closes out.
- **`pause` sub-command:** `/ship pause [ticket/branch]` runs the checkpoint flow absorbed from `/pause` (§5.4) and stops. This is an explicit verb, not a detected phase — handled before the step-1.5 routing.
- **Lifecycle-controls table + step-1.5 prose:** remove `/resume`, `/finish`, and `/pause` rows; add the `/ship pause` sub-command; keep `/pr-watch`.
- **Ticket-lifecycle-reference table (ship:240-251):** rewrite per §3.2; **delete the "Time entry" column.**
- **Rules:** remove timer/assignee rules; keep "CI is the gate", "never commit to base", idempotency.

### 5.3 `pr-watch`
- Load `STATUS`.
- The `in review` set is now redundant (ship sets it at push) — keep as an idempotent assert: `clickup_update_task(status=STATUS.review)` only if not already there.
- `CLOSED` (not merged) branch (pr-watch:37) → `clickup_update_task(status=STATUS.rejected)` before exit.
- 2× same-failure escalation (pr-watch:68) → `STATUS.blocked`.
- `MERGED` branch (pr-watch:36) → hand to **`/ship <branch>`** (which now closes out), not `/finish`.

### 5.4 `pause` *(folded into `/ship pause` — resolved O1)*
The checkpoint logic moves into `/ship`'s `pause` sub-command; `skills/pause/SKILL.md` is deleted (§5.6). Behaviour absorbed:
- Stage WIP as a `wip:` commit (body = `nextUp` for resume recovery). Push so the checkpoint survives a machine switch.
- Drop the timer (`clickup_get_current_time_entry` / `clickup_stop_time_tracking`, pause:64-68). Leave status `in progress` (= `STATUS.building`).
- Resume copy points to `/ship` (resume is folded into the step-1.5 `building` phase).
- Optional: post elapsed-so-far as a comment instead of stopping a timer (git first-commit → now). Low priority.

### 5.5 Close-out (absorbed from `finish` into `ship` merged path)
The worktree **may already be gone** (close-out partially ran, or it was paused/removed on another machine), so the close-out must not depend on a live worktree. Phase routing (step 1.5) probes the PR state **first** — `pr-open`/`merged` route off `gh pr list` from the repo root, so a removed worktree never blocks close-out. On `merged`:
1. Build summary entirely from the merged PR (no `git -C <WT_PATH>`): goal (ticket title / branch intent); files + commit count + first-commit time + merge time from `gh pr view <N> --json files,commits,mergedAt`. **Time from git** = first-commit `committedDate` → `mergedAt`. No `clickup_get_task_time_entries`.
2. `clickup_create_task_comment` with the summary block (incl. `⏱ ~T (first hh:mm → merged hh:mm)`).
3. `clickup_update_task(status=STATUS.closed)`.
4. Tear down **silently** (resolved O2), each step existence-guarded so a missing worktree/branch is a no-op, not an error: `git worktree list | grep -q <path> && git worktree remove <WT_PATH>`, `git rev-parse --verify --quiet <BRANCH> && git branch -D <BRANCH>` — no confirm, matches old `/finish`. Never touch `BASE`.
5. Print the summary to the terminal (ticket-less prints only).

### 5.7 `supera-init` (emit `statuses` defaults)
Defaults cover behaviour, but a freshly-initialised repo never surfaces the status map — it's only discoverable by reading the schema. When a ClickUp list is resolved, `supera-init` writes the `clickup.statuses` defaults inline (commented) so the names are visible and editable per space. Omitting the block (or any key) falls back to the schema defaults. Gate-safe: the emitted JSON uses `"statuses": {...}`, not a `status="..."` literal, and contains no `STATUS.` token.

### 5.6 Deletions
- Delete `skills/resume/SKILL.md` (folded into `/ship` step-1.5 `building` phase).
- Delete `skills/finish/SKILL.md` (folded into `/ship` merged path, §5.5).
- Delete `skills/pause/SKILL.md` (folded into `/ship pause` sub-command, §5.4).
- Update CLAUDE.md skill inventory + any cross-references.

---

## 6. CI consistency gate (new)

Root cause of the shipped bug: nothing connects schema ↔ board ↔ skills; the invariant "schema and skills stay in sync" is enforced by discipline, not tooling. Add `scripts/check-consistency.sh` run by `.github/workflows/consistency.yml` on PRs to this repo. It scans **both `skills/` and `agents/`** (every `*.md`) so a status literal or dead reference can't hide in an agent body or in supera-init's emitted config:

1. **Version sync:** `plugin.json` version == `marketplace.json` version.
2. **No raw status literals:** grep for `status="..."` in `clickup_update_task(... status=...)` position across `skills/` + `agents/` — fail if any appear outside a `STATUS.` reference.
3. **Schema keys referenced exist:** every `STATUS.<key>` used has a matching property in the schema's `clickup.statuses`.
4. **Dead-skill references:** grep for `/resume`, `/finish`, `/pause` mentions across `skills/` + `agents/` after deletion — fail if any remain (allow `/ship pause` as the replacement verb).

Bash + `jq` + `grep`; no node toolchain needed.

---

## 7. Out of scope / accepted non-goals
- Reducing the 9 ClickUp board statuses to 4 (board stays; automation just drives a subset). Revisit if the board proves noisy.
- `fast-ship`, `supera-engineer`, the supply-chain auditor — untouched. (`supera-init` **is** touched, §5.7.)
- **`COMPLETED` / `ACCEPTED` stay human-only.** No skill ever sets them — they sit in the board's Done group for a person to mark. Automating them would be theater: supera can't judge whether work is genuinely accepted. Deliberately absent from `clickup.statuses`.
- **No ClickUp-side auto-close.** Closing is driven by `/ship` on a merged PR; there is no ClickUp automation/webhook that closes a ticket when a PR merges out-of-band. If a PR merges without `/ship`, re-run `/ship <branch>` (merged-phase close-out) or set `closed` by hand. A webhook is a separate infra-level project.
- **Meta-over-product:** this improves the *plugin's* status discipline, not the products it ships — intrinsic to a tooling repo.

---

## 8. Open decisions — RESOLVED at review gate
- **O1 — `/pause`:** ✅ Fold all three. `/pause`, `/resume`, `/finish` all collapse into `/ship` (D8). `/ship pause` is the new checkpoint verb.
- **O2 — teardown confirm:** ✅ Delete silently, no confirm (D9). Matches old `/finish`.

---

## 9. Release
1. Apply schema + skill edits, deletions, CI gate.
2. Update CLAUDE.md (skill inventory: remove resume/finish; note statuses map).
3. Apply the ClickUp board reorder (§3.3) by hand.
4. Bump `version` in `plugin.json` **and** `marketplace.json` (identical).
5. Commit. Consumers pick it up on next `/plugin update`.
