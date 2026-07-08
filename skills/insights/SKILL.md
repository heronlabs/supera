---
name: insights
description: Analyze the shipping process — detect failure patterns, surface friction, auto-fix known issues. Modeled on Claude Code Insights reports but focused on supera:ship lifecycle health.
allowed-tools: Bash, Read, Grep, Agent
---

Analyze the supera shipping lifecycle across the repo. Detect failure patterns, surface friction points, and auto-fix known issues. Two modes: **report** (analyze only) and **fix** (analyze + auto-fix).

## 0 — Load config

Read `.claude/supera.json` into `CONFIG`. If missing: "Run /start first."

`REMOTE = CONFIG.remote || "origin"`

Parse `$ARGUMENTS`:
- `--fix` → `AUTOFIX=true`. Detect AND apply fixes.
- A PR number → scope analysis to that PR's shipping lifecycle.
- Empty → scan the whole repo for recent shipping activity (last 30 days).

## 1 — Gather

Collect shipping telemetry:

```bash
# 1. Open branches (feature branches = shipping activity)
git branch -r | grep -v "$REMOTE/HEAD" | grep -v "$REMOTE/main" | grep -v "$REMOTE/master"

# 2. Stale worktrees (crashed/interrupted ships)
git worktree list

# 3. Recent ship commits (last 30 days)
git log --all --oneline --since="30 days ago" --grep="^feat:\|^fix:\|^docs:\|^refactor:\|^chore:" --format="%h %s (%an, %ar)"

# 4. Open PRs
gh pr list --state open --json number,title,headRefName,createdAt,state --limit 20 2>/dev/null || echo "NO_GH"

# 5. Recently merged PRs
gh pr list --state merged --json number,title,headRefName,mergedAt --limit 20 2>/dev/null || echo "NO_GH"

# 6. Failed CI runs on feature branches
gh run list --limit 20 --json name,status,conclusion,headBranch,displayTitle 2>/dev/null | grep -v '"conclusion":"success"' || echo "NO_FAILURES"

# 7. Engineer plans (in worktrees)
find .worktrees -name "plan.md" -path "*/.supera/*" 2>/dev/null | while read f; do echo "=== $f ==="; cat "$f" 2>/dev/null || echo "EMPTY"; done

# 8. Receipt traces (engineer output in .supera/)
find .worktrees -name "*.json" -path "*/.supera/*" 2>/dev/null || echo "NO_RECEIPTS"
```

## 2 — Analyze

From gathered data, classify findings into:

### Failure patterns (auto-detect)

| Pattern | Signal | Severity |
|---|---|---|
| **Engineer idle** | Branch exists, no commits, no diff in worktree | HIGH |
| **Isolation leak** | Worktree has commits but `filesChanged` receipt is empty or mismatched | HIGH |
| **CI loop** | Same branch has 3+ failed CI runs on same job | HIGH |
| **Orphan worktree** | Worktree exists but branch deleted/merged | MEDIUM |
| **Stale branch** | Branch with no activity > 14 days, PR still open | MEDIUM |
| **Dirty worktree** | Worktree has uncommitted changes from crashed ship | MEDIUM |
| **Missing verification** | Commit exists but no `.supera/plan.md` (engineer skipped planning) | LOW |
| **Ghost PR** | Branch deleted but PR still open | LOW |
| **Rebase drift** | Branch behind base, mergeStateStatus = BEHIND | MEDIUM |
| **Review stall** | PR open > 7 days, reviewDecision = REVIEW_REQUIRED | LOW |

### Friction categories (matching Insights report style)

| Category | Description | Example signal |
|---|---|---|
| Agent delegation failures | Engineer claimed completion, no changes made | Empty diff after delegate |
| CI churn | Multiple fix commits trying to pass CI | 3+ CI runs on same branch |
| Context breaks | Worktree created but no commits | Orphan worktree, stale branch |
| Wrong approach | Commits reverted or amended multiple times | Reflog shows resets |
| Tool errors | gh CLI failures, git errors in logs | grep for "error:", "fatal:", "exit code" |

## 3 — Report

Output a structured report:

```
## Ship Insights — <repo name>

### At a Glance
- Branches: N active, M stalled
- PRs: X open, Y merged (30d)
- Worktrees: W active, Z orphaned
- CI health: P% passing

### Top Friction
1. <pattern>: N occurrences — <impact>
2. ...

### What's Working
- <positive pattern>

### Risk Matrix
| Pattern | Count | Auto-fixable? |
|---|---|---|
| ... | N | yes/no |
```

If scoped to a specific PR: include timeline (created → first commit → CI → review → merge), highlight where delays happened.

## 4 — Autofix (only if `--fix`)

For each auto-fixable pattern, apply the fix:

| Pattern | Auto-fix |
|---|---|
| **Engineer idle** | If branch exists with no commits: `cd` into worktree, re-dispatch engineer with explicit task, verify diff |
| **Orphan worktree** | `git worktree remove --force <path>` |
| **Stale branch** | If PR closed but branch exists: `git branch -d <branch>` |
| **Dirty worktree** | Report uncommitted changes. If stashable: `git stash`. If engineer's work: re-dispatch to complete |
| **Ghost PR** | `gh pr close <N> --comment "Auto-closed: branch deleted."` |
| **Rebase drift** | `git fetch $REMOTE $BASE && git rebase $REMOTE/$BASE && git push --force-with-lease` |
| **CI loop** | Analyze failure log, classify (build/lint/test/lockfile/transient), delegate to engineer with log excerpt. Same rules as pr-watch step 2. |
| **Review stall** | Post reminder comment: `gh pr comment $PR --body "Auto-reminder: PR waiting for review for >7 days."` |

For fixes that modify code or rebase: **ask user before applying** (unless `--yes` flag is also passed).

After fixing, re-run the gather step to verify issues resolved.

## 5 — Guardrails

- **Read-only by default.** Without `--fix`, never modify anything — only report.
- **Ask before destructive fixes.** Rebases, branch deletions, PR closures require confirmation (or `--yes`).
- **Never touch `CONFIG.baseBranch`.** Don't delete, rebase, or modify the base branch worktree.
- **Scope to feature branches only.** Skip main/master/develop.
- **One fix per pass.** Apply the highest-severity fix, verify, then suggest re-running for remaining issues. Don't batch risky changes.
- **Honest detection.** If signals are ambiguous, report them as "possible" with confidence level — don't fabricate certainty.

## Rules

- Gather → Analyze → Report → (optional) Fix. Always complete the report even if `--fix` fails.
- Use `gh` CLI for PR/CI data — fall back gracefully if not available ("gh not configured — CI/PR analysis skipped").
- Worktree operations are safe: `git worktree remove --force` only on orphaned worktrees (branch gone).
- Commit hygiene follows `guidelines/commit-conventions.md`.
- Read `.claude/supera.json` for commands — don't assume pnpm/npm.
