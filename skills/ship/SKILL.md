---
name: ship
description: Implement a task end-to-end — create worktree, delegate to supera-engineer (code + tests), self-verify, commit, push, open PR, hand off to pr-watch for CI monitoring. Idempotent: re-run in a dirty worktree continues where it left off.
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Implement a task in an isolated git worktree. Delegate all code + tests to `supera-engineer`. On verification pass: commit, push, open PR, hand off to `pr-watch` for CI monitoring. On verification fail after 3 loops: leave changes for manual review.

## Debug mode

When debug mode is active, ship pauses after each major step to show what happened, let you inspect issues, and decide what to do next.

**Activation**: Debug mode is active if either:
- `CONFIG.debugMode === true` (set in `.claude/supera.json`)
- The env var `SUPERAS_DEBUG` is set to `"true"` (case-insensitive)

When active, set `DEBUG=true`. Otherwise `DEBUG` is unset/false.

**Step pass pattern — if `DEBUG` is active after a step succeeds:**

1. Announce: `[DEBUG] Step <N> — <name> OK`
2. Show concise results (key values, file paths, PR number, etc.).
3. Ask the user: "Continue to next step? (y/n)"
4. If "n", stop the process and surface where you stopped.

**Step fail pattern — if `DEBUG` is active after a step fails:**

1. Announce: `[DEBUG] Step <N> — <name> FAILED`
2. Show the error context: what command ran, what output it produced, and what went wrong.
3. Ask the user: "Retry, skip, or abort? (r/s/a)"
4. - **retry (r)**: Re-execute the step's commands and re-check.
   - **skip (s)**: Log a warning, note why, and continue to the next step.
   - **abort (a)**: Stop the whole process and surface the failure for manual review.

When `DEBUG` is not active, the skill runs exactly as before — no pauses, no prompts.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /start first."` and stop.
- `BASE = CONFIG.baseBranch`
- `WT_DIR = ".worktrees"`
- `REMOTE = CONFIG.remote`
- `DEBUG` is `true` if `CONFIG.debugMode === true` or the `SUPERAS_DEBUG` env var is `"true"` (case-insensitive). If `DEBUG`: announce `"[DEBUG] Debug mode active — will pause after each step for review."`

## 1 — Parse task

`$ARGUMENTS` is a free-text task description. If empty, ask for one.

Derive a branch slug: lowercase, kebab-case, ≤50 chars, prefixed by type with a dash (`feat-`, `fix-`, `docs-`, `refactor-`, `chore-`). Example: `"add payment retry"` → `feat-add-payment-retry`.

If `DEBUG` is active after this step:
  - Announce: `[DEBUG] Step 1 — Parse task OK — slug: $SLUG`
  - Follow the **Step pass pattern** above (ask user to continue).

## 2 — Detect context

Check if we're already in a supera worktree:

```bash
git worktree list | grep -F "$(pwd)"
pwd
```

**Already in a worktree** → continue implementing in place. The worktree is the workspace. Skip step 3.

**Not in a worktree** → proceed to step 3.

If `DEBUG` is active after this step:
  - Determine `IN_WORKTREE` (yes/no) from the detection result.
  - Announce: `[DEBUG] Step 2 — Detect context OK — in_worktree: $IN_WORKTREE`
  - Follow the **Step pass pattern** above.

## 3 — Create worktree

```bash
git fetch $REMOTE $BASE
# If branch already exists locally, reuse it instead of failing
if git show-ref --verify --quiet "refs/heads/$SLUG"; then
  echo "Branch $SLUG already exists locally — reusing."
  git worktree add "$WT_DIR/$SLUG" "$SLUG" 2>/dev/null || true
# If branch exists on remote but not locally, fetch and checkout
elif git ls-remote --heads "$REMOTE" "$SLUG" | grep -q "$SLUG"; then
  echo "Branch $SLUG exists on $REMOTE — fetching."
  git fetch "$REMOTE" "$SLUG"
  git worktree add "$WT_DIR/$SLUG" "$SLUG"
else
  # Clean up stale worktree from crashed previous run
  if [ -d "$WT_DIR/$SLUG" ] && ! git worktree list | grep -qF "$WT_DIR/$SLUG"; then
    git worktree remove --force "$WT_DIR/$SLUG" 2>/dev/null || true
  fi
  git worktree add "$WT_DIR/$SLUG" -b "$SLUG" "$REMOTE/$BASE"
fi
cd "$WT_DIR/$SLUG"
```

Install dependencies after creating/entering the worktree:
```bash
if   [ -f pnpm-lock.yaml ];    then pnpm install --frozen-lockfile
elif [ -f yarn.lock ];          then yarn install --immutable
elif [ -f package-lock.json ];  then npm ci
elif [ -f Cargo.toml ];         then cargo fetch
fi
```

If `DEBUG` is active after this step:
  - Announce: `[DEBUG] Step 3 — Create worktree OK — path: $WT_DIR/$SLUG`
  - Follow the **Step pass pattern** above.

## 4 — Plan and delegate

Announce: *"Delegating to supera-engineer in worktree `$WT_DIR/$SLUG`."*

Dispatch `supera-engineer` with: the task description, the worktree path, and the path to `.claude/supera.json`. **Do NOT use `isolation: "worktree"`** — ship already owns the worktree. Use `subagent_type: "supera:supera-engineer"` only; the engineer works in the current worktree directory. The engineer writes a plan to `.supera/plan.md`, implements code + tests, self-verifies, and returns a receipt.

Wait for its JSON receipt. Parse it:
- **All verification `pass`** → done. Surface the summary and files changed.
- **Any `fail`** → delegate back to engineer with the failure output (max 3 loops). If still failing after 3, surface the failure.

If `DEBUG` is active during the delegation loop:
  - Before each automatic retry, follow the **Step fail pattern** — let the user choose retry, skip, or abort instead of auto-retrying.
  - If the user chooses "skip", proceed as if verification passed and continue to the next step.

If `DEBUG` is active after delegation succeeds:
  - Announce: `[DEBUG] Step 4 — Delegate OK — summary: $receipt.summary`
  - Follow the **Step pass pattern** above.

## 5 — Commit

If any verification gate is `fail` after 3 loops, stop — surface the failure, leave changes for manual review.

All verification passes:
```bash
# Guard: nothing to commit is a defect — surface it
[ -z "$(git status --porcelain)" ] && echo "ERROR: no changes to commit" && exit 1

TYPE=$(echo "$SLUG" | cut -d'-' -f1)
# Validate TYPE is a known conventional-commit prefix
case "$TYPE" in feat|fix|docs|refactor|chore|test|ci|perf|style) ;; *) TYPE="chore" ;; esac
git add -A
git commit -m "$TYPE: $SUMMARY"
```
`$SUMMARY` is `receipt.summary`, truncated to 50 chars maximum (to keep `$TYPE: $SUMMARY` ≤72 chars). Commit follows `guidelines/commit-conventions.md` — no body, no co-author trailer.

If `DEBUG` is active after this step:
  - If commit failed (no changes, or git error), follow the **Step fail pattern**.
  - If commit succeeded, announce: `[DEBUG] Step 5 — Commit OK — SHA: $(git rev-parse HEAD)`
  - Follow the **Step pass pattern** above.

## 6 — Push

```bash
git push -u $REMOTE $SLUG
```

If branch already exists on remote (push rejected), surface the error — user resolves.

If `DEBUG` is active after this step:
  - If push failed, follow the **Step fail pattern** (user may fix remote state before retrying).
  - If push succeeded, announce: `[DEBUG] Step 6 — Push OK — pushed $SLUG to $REMOTE`
  - Follow the **Step pass pattern** above.

## 7 — Create PR

Resolve the PR body template:

```bash
# Check for user's template first
BODY_FILE=""
for tmpl in .github/PULL_REQUEST_TEMPLATE.md pull_request_template.md; do
  [ -f "$tmpl" ] && { BODY_FILE="$tmpl"; break; }
done
if [ -z "$BODY_FILE" ] && [ -d .github/PULL_REQUEST_TEMPLATE ]; then
  for tmpl in .github/PULL_REQUEST_TEMPLATE/*.md; do
    [ -f "$tmpl" ] && { BODY_FILE="$tmpl"; break; }
  done
fi
```

**If no user template found:** Read `.github/PULL_REQUEST_TEMPLATE.md` from the supera plugin's installation directory (the directory containing `skills/`, `agents/`, `schema/` — its `.github/PULL_REQUEST_TEMPLATE.md`). Write it to `.supera/pr-template.md` in the worktree, filling in what is known from the receipt:

| Template section | Fill with |
|---|---|
| **Description** | `receipt.summary` |
| **Motivation** | Leave with its comment prompt — user fills in the "why". |
| **Approach** | Bullet list of `receipt.filesChanged` with a one-line note per file from the engineer's plan. |
| **Checklist** | Fill checkboxes from `receipt.verification`: `pass` → `[x]`, `fail` → `[ ]`, `skipped` → remove that row. |
| **Evidence** | Leave with its comment prompt. |
| **Risk assessment** | Leave with its comment prompt. |
| **Post-merge** | Leave with its comment prompt. |

Set `BODY_FILE=".supera/pr-template.md"`.

**If a user template IS found:** Write a filled copy to `.supera/pr-template.md` — copy the template, then fill known sections inline:
- **Description** → replace the section content (after its heading, before the next `##`) with `receipt.summary`.
- **Checklist** → for each checkbox line, set `[x]` if the corresponding `receipt.verification` key is `pass`, `[ ]` if `fail`; delete rows for `skipped` keys.
- Leave all other sections (Motivation, Evidence, Risk, Post-merge) as-is — user fills those.

Set `BODY_FILE=".supera/pr-template.md"`.

```bash
PR_URL=$(gh pr create \
  --base $BASE \
  --head $SLUG \
  --title "$TYPE: $SUMMARY" \
  --body-file "$BODY_FILE" 2>&1) || true
# If gh pr create failed (e.g., PR already exists), recover the PR number
if [ -z "$PR_URL" ]; then
  PR=$(gh pr list --head $SLUG --json number -q '.[0].number')
else
  PR=$(gh pr view --json number -q .number)
fi
```

If `DEBUG` is active after this step:
  - If PR creation failed (no PR number resolved), follow the **Step fail pattern**.
  - If PR creation succeeded, announce: `[DEBUG] Step 7 — Create PR OK — #$PR`
  - Follow the **Step pass pattern** above.

## 8 — Hand off to pr-watch

Announce: *"PR #$PR created. Handing off to pr-watch — monitoring CI, fixing failures, merging when green."*

Invoke the `pr-watch` skill with `$PR`.

If `DEBUG` is active after this step:
  - Announce: `[DEBUG] Step 8 — Hand off to pr-watch OK — PR #$PR handed off`
  - If the handoff failed, follow the **Step fail pattern** (user may want to inspect the PR before retrying).

## Rules

- Read `.claude/supera.json` first — never hardcode commands or branches.
- Never remove `BASE` or its worktree.
- **Idempotent** — re-run in a dirty worktree picks up where engineer left off. No state tracking needed.
- Never commit to base directly. Commits only on the feature branch in the worktree.
- Commit hygiene follows `guidelines/commit-conventions.md`.
- Only commit/push/PR when all verification gates pass.
