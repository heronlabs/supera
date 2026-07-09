---
name: ship
description: Implement a task end-to-end — create worktree, delegate to supera-engineer (code + tests), self-verify, commit, push, open PR, hand off to pr-watch for CI monitoring. Idempotent: re-run in a dirty worktree continues where it left off.
allowed-tools: Bash, Read, Glob, Grep, Agent
---

Implement a task in an isolated git worktree. Delegate all code + tests to `supera-engineer`. On verification pass: commit, push, open PR, hand off to `pr-watch` for CI monitoring. On verification fail after 3 loops: leave changes for manual review.

## 0 — Load config

Read `.claude/supera.json` at the repo root into `CONFIG`.

- **If it does not exist:** tell the user `"This repo isn't set up for supera yet — run /start first."` and stop.
- `BASE = CONFIG.baseBranch`
- `WT_DIR = ".worktrees"`
- `REMOTE = CONFIG.remote`
- `BUILD_CMD = CONFIG.buildCommand` (may be empty — skip if unset)
- `LINT_CMD = CONFIG.lintCommand` (may be empty — skip if unset)

## 1 — Parse task

`$ARGUMENTS` is a free-text task description. If empty, ask for one.

Derive a branch slug: lowercase, kebab-case, ≤50 chars, prefixed by type with a dash (`feat-`, `fix-`, `docs-`, `refactor-`, `chore-`). Example: `"add payment retry"` → `feat-add-payment-retry`.

## 2 — Detect context

Check if we're already in a supera worktree:

```bash
git worktree list | grep -F "$(pwd)"
pwd
```

**Already in a worktree** → continue implementing in place. The worktree is the workspace. Skip step 3.

**Not in a worktree** → proceed to step 3.

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

## 4 — Plan and delegate

Announce: *"Delegating to supera-engineer in worktree `$WT_DIR/$SLUG`."*

Dispatch `supera-engineer` with: the task description, the worktree path, and the path to `.claude/supera.json`. **Do NOT use `isolation: "worktree"`** — ship already owns the worktree. Use `subagent_type: "supera:supera-engineer"` only; the engineer works in the current worktree directory. The engineer writes a plan to `.supera/plan.md`, implements code + tests, self-verifies, and returns a receipt.

**SendMessage guard:** Before the subagent sends structured messages back to the orchestrator (e.g., its JSON receipt), it must load the SendMessage tool schema into its prompt by calling `ToolSearch` with `query: "select: SendMessage"`. Without this, typed parameters may be rejected with `InputValidationError`.

Wait for its JSON receipt. Parse it:
- **All verification `pass`** → done. Surface the summary and files changed.
- **Any `fail`** → delegate back to engineer with the failure output (max 3 loops). If still failing after 3, surface the failure.

### 4a — Verify engineer changes

**Before committing, independently verify the engineer actually made changes:**

```bash
# Verify unstaged or staged changes exist
git diff --stat
git diff --cached --stat
```

If both are empty, the engineer reported completion but made zero changes — **treat as verification failure.** Delegate back to engineer with the specific instruction to make changes, or apply edits directly. Do NOT proceed to commit with no diff.

Cross-check `receipt.filesChanged` against `git diff --name-only` and `git diff --cached --name-only`. Files in the receipt that don't appear in the diff (or vice versa) indicate the engineer worked in a different context — flag this.

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

## 6 — Push

**Before pushing, run fast pre-flight checks** to catch issues the engineer may have missed:

```bash
# Run build if CONFIG.buildCommand is set — catch issues before CI
# Run lint if CONFIG.lintCommand is set
```

If build or lint fails: surface the failure. Don't push broken code — delegate back to engineer or fix directly.

```bash
git push -u $REMOTE $SLUG
```

If branch already exists on remote (push rejected), surface the error — user resolves.

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

## 8 — Hand off to pr-watch

Announce: *"PR #$PR created. Handing off to pr-watch — monitoring CI, fixing failures, merging when green."*

Invoke the `pr-watch` skill with `$PR`.

## Rules

- Read `.claude/supera.json` first — never hardcode commands or branches.
- Never remove `BASE` or its worktree.
- **Idempotent** — re-run in a dirty worktree picks up where engineer left off. No state tracking needed.
- Never commit to base directly. Commits only on the feature branch in the worktree.
- Commit hygiene follows `guidelines/commit-conventions.md`.
- Only commit/push/PR when all verification gates pass.
