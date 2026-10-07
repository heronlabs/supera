---
name: ship
description: Implement a task end-to-end — create worktree, delegate to supera-engineer (code + tests), self-verify, commit, push, open PR, hand off to pr-watch for CI monitoring. Idempotent — re-run in a dirty worktree continues where it left off.
argument-hint: "<task description> [--breaking]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent
---

Implement a task in an isolated git worktree. Delegate all code + tests to `supera-engineer`. On verification pass: commit, push, open PR, hand off to `pr-watch` for CI monitoring. On verification fail after 3 loops: leave changes for manual review.

## 0 — Detect repo context

No config file — everything is derived from the repo itself:

- `WT_DIR = ".worktrees"`
- `REMOTE`: the sole git remote, or `origin` when several exist.
- `BASE`: the default branch —
  ```bash
  BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null) \
    || BASE=$(git symbolic-ref --short refs/remotes/$REMOTE/HEAD | cut -d/ -f2-)
  ```
- `BUILD_CMD` / `LINT_CMD`: detect from the repo — declared scripts (`package.json` `build` / `lint`), `Makefile` targets, or the commands CI workflows run. May be empty — skip the gate if the repo has none.
- `AUDIT_CMD`: the dependency-audit command a CI workflow (`.github/workflows/`) runs, copied verbatim. Empty when CI runs none — never assume one.

## 1 — Parse task

`$ARGUMENTS` is a free-text task description. If empty, ask for one.

`BREAKING=true` when `$ARGUMENTS` contains `--breaking` or the task explicitly says the change is breaking; otherwise `false`. `TASK` is `$ARGUMENTS` with `--breaking` removed — use `TASK` wherever the task description is needed below.

Derive a branch slug from `TASK`: lowercase, kebab-case, ≤50 chars, prefixed by type with a dash (`feat-`, `fix-`, `docs-`, `refactor-`, `chore-`). Example: `"add payment retry"` → `feat-add-payment-retry`.

## 2 — Detect context

Check if we're already in a supera worktree. Human-readable git output (including `git worktree list`) may be rewritten by shell hooks — don't parse it; compare `rev-parse` paths, which differ only inside a linked worktree:

```bash
pwd
CUR=$(git branch --show-current)
GITDIR=$(git rev-parse --path-format=absolute --git-dir)
COMMONDIR=$(git rev-parse --path-format=absolute --git-common-dir)
IN_WORKTREE=false
if [ "$GITDIR" != "$COMMONDIR" ] && [ -n "$CUR" ] && [ "$CUR" != "$BASE" ]; then IN_WORKTREE=true; fi
echo "IN_WORKTREE=$IN_WORKTREE CUR=$CUR"
```

**Already in a worktree** (`IN_WORKTREE=true`) → continue implementing in place. The worktree is the workspace; `SLUG=$CUR` (the branch, not a re-derived slug). Skip step 3.

**Not in a worktree** → proceed to step 3.

Either way, keep `.supera/` out of commits — add it to the repo-local exclude file, shared by every worktree of the repo. Never edit the user's `.gitignore`.

```bash
EXCLUDE=$(git rev-parse --path-format=absolute --git-path info/exclude)
mkdir -p "$(dirname "$EXCLUDE")"
grep -qxF '.supera/' "$EXCLUDE" 2>/dev/null || printf '\n.supera/\n' >> "$EXCLUDE"
```

## 3 — Create worktree

```bash
cd "$(git rev-parse --show-toplevel)"
git fetch $REMOTE $BASE
git worktree prune   # drop registrations whose directory is gone
# If branch already exists locally, reuse it instead of failing
if git show-ref --verify --quiet "refs/heads/$SLUG"; then
  echo "Branch $SLUG already exists locally — reusing."
  git worktree add "$WT_DIR/$SLUG" "$SLUG" 2>/dev/null || true
# If branch exists on remote but not locally, fetch and checkout
elif git ls-remote --exit-code --heads "$REMOTE" "refs/heads/$SLUG" >/dev/null; then
  echo "Branch $SLUG exists on $REMOTE — fetching."
  git fetch "$REMOTE" "$SLUG"
  git worktree add "$WT_DIR/$SLUG" "$SLUG"
else
  # Branch exists nowhere, so a worktree at the path is left over from a crashed run
  [ -e "$WT_DIR/$SLUG/.git" ] && git worktree remove --force "$WT_DIR/$SLUG"
  git worktree add "$WT_DIR/$SLUG" -b "$SLUG" "$REMOTE/$BASE"
fi
cd "$WT_DIR/$SLUG"
```

If `git worktree add` fails because `$WT_DIR/$SLUG` exists and isn't a worktree, surface it — the user removes it.

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

Dispatch `supera-engineer` with: the task description and the worktree path. The engineer detects the repo's own build/lint/test commands. **Do NOT use `isolation: "worktree"` and do NOT pass `name:`** — ship already owns the worktree, and a named Agent call is launched as a teammate, which under `teammateMode: "tmux"` (or `"auto"` in a tmux or iTerm2 terminal) opens a second pane and splits the user's screen. Use `subagent_type: "supera:supera-engineer"` only — the receipt arrives as the Agent tool's result; no separate message back to the orchestrator. The engineer works in the current worktree directory: it writes a plan to `.supera/plan.md`, implements code + tests, self-verifies, and returns a receipt.

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

If both are empty, the engineer made zero changes. **Check `receipt.notes` before delegating back** — never enter a delegation loop on an empty diff:

- **Notes legitimately explain the empty diff** (task already implemented, nothing to change, blocked on missing info) → do NOT re-delegate. Surface the notes to the user and stop.
- **Notes are empty or claim work was done** → the engineer idled. Treat as verification failure and re-delegate **once**, with the explicit instruction to make changes (counts toward the 3-loop max). If the diff is empty again, stop delegating — apply the edits directly or surface the failure.

Either way: do NOT proceed to commit with no diff.

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
BANG=""; [ "$BREAKING" = true ] && BANG="!"
git add -A
git commit -m "$TYPE$BANG: $SUMMARY"
```
`$SUMMARY` is written by the orchestrator: a concise imperative summary of the change (from `receipt.summary` and the diff), phrased so the subject fits the length limit in the commit guideline — rephrase, never truncate. Commit follows `${CLAUDE_PLUGIN_ROOT}/guidelines/commit-conventions.md` — no body, no co-author trailer.

## 6 — Push

**Before pushing, run the cheap gates the repo's CI runs** to catch issues the engineer may have missed. Record each command and its result — step 7's Evidence uses them.

```bash
# Run BUILD_CMD if detected — catch issues before CI
# Run LINT_CMD if detected
# Run AUDIT_CMD if detected
```

If build or lint fails: surface the failure. Don't push broken code — fix trivial issues directly (lint/format, typos, conflict markers), otherwise delegate back to engineer; amend the commit and re-run pre-flight.

If the audit fails, check whether this PR changed dependencies:

```bash
# DEP_FILES: the manifests and lockfiles AUDIT_CMD reads
git diff --quiet "$REMOTE/$BASE...HEAD" -- $DEP_FILES
```

- **No dependency changes** (exit 0) → the advisory already exists on base and is not this PR's fix. Surface it and push anyway — pr-watch handles it.
- **Dependencies changed** → treat it like a build/lint failure.

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

**If no user template found:** Read `${CLAUDE_PLUGIN_ROOT}/.github/PULL_REQUEST_TEMPLATE.md`. Write it to `.supera/pr-template.md` in the worktree, filling in what is known:

| Template section | Fill with |
|---|---|
| **Description** | `receipt.summary`. When `BREAKING=true`, add a line saying what breaks. |
| **Motivation** | Replace the comment prompt with the task description (`TASK`) — it is the user's "why". Keep any issue reference it contains. |
| **Approach** | Bullet list of `receipt.filesChanged` with a one-line note per file from the engineer's plan. |
| **Checklist** | Fill checkboxes from `receipt.verification`: `pass` → `[x]`, `fail` → `[ ]`, `skipped` → remove that row. Tick "Breaking change documented" when `BREAKING=true`. |
| **Evidence** | Replace the comment prompt with the verification actually run: each `receipt.verification` gate and result, then each step 6 pre-flight command and result (including any surfaced pre-existing audit advisory). |
| **Risk assessment** | Leave with its comment prompt. |
| **Post-merge** | Leave with its comment prompt. |

Set `BODY_FILE=".supera/pr-template.md"`.

**If a user template IS found:** Write a filled copy to `.supera/pr-template.md` — copy the template, then fill known sections inline:
- **Description** → replace the section content (after its heading, before the next `##`) with `receipt.summary` (plus what breaks, when `BREAKING=true`).
- **Checklist** → for each checkbox line, set `[x]` if the corresponding `receipt.verification` key is `pass`, `[ ]` if `fail`; delete rows for `skipped` keys; tick a breaking-change row when `BREAKING=true`.
- **Motivation** and **Evidence** (or the template's equivalent headings, matched case-insensitively) → fill as in the table above.
- Leave all other sections (Risk, Post-merge, …) as-is — user fills those.

Set `BODY_FILE=".supera/pr-template.md"`.

```bash
PR_URL=$(gh pr create \
  --base $BASE \
  --head $SLUG \
  --title "$TYPE$BANG: $SUMMARY" \
  --body-file "$BODY_FILE" 2>&1) || true
# If gh pr create failed (e.g., PR already exists), recover the PR number
if [ -z "$PR_URL" ]; then
  PR=$(gh pr list --head $SLUG --json number -q '.[0].number')
else
  PR=$(gh pr view --json number -q .number)
fi
```

## 8 — Hand off to pr-watch

Announce: *"PR #$PR created. Handing off to pr-watch — monitoring CI and fixing failures until green. Merging stays yours."*

Invoke the `pr-watch` skill with `$PR`.

## Rules

- Detect commands and branches from the repo (declared scripts, Makefile, CI workflows) — never assume a package manager or branch name.
- Don't parse human-readable git output — shell hooks may rewrite it. Use `git rev-parse`, exit codes (`--quiet`, `--exit-code`), and direct path checks.
- Never edit the user's `.gitignore` — `.supera/` goes in `info/exclude` (step 2).
- Never remove `BASE` or its worktree.
- **Idempotent** — re-run in a dirty worktree picks up where engineer left off. No state tracking needed.
- Never commit to base directly. Commits only on the feature branch in the worktree.
- Commit hygiene follows `${CLAUDE_PLUGIN_ROOT}/guidelines/commit-conventions.md`.
- The orchestrator fixes only trivial issues directly (lint/format, typos, conflict markers); all other code goes through `supera-engineer`.
- Only commit/push/PR when all verification gates pass. An audit advisory that already exists on base doesn't block (step 6).
