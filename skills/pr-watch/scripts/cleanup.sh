#!/bin/sh
# Usage: cleanup.sh REMOTE BASE BRANCH
# Post-merge cleanup, run from the main checkout whatever the current
# directory: removes BRANCH's worktree (never the main checkout), deletes
# BRANCH locally and on REMOTE, and fast-forwards local BASE only when the main
# checkout is on it and clean. Idempotent. Refuses BRANCH = BASE.
set -eu

usage='usage: cleanup.sh REMOTE BASE BRANCH'
remote=${1:?$usage}
base=${2:?$usage}
branch=${3:?$usage}

if [ "$branch" = "$base" ]; then
  echo "Refusing to clean up $branch: it is the base branch." >&2
  exit 1
fi

root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
cd "$root"
git worktree prune

# Checked first: refs/heads/feat would also match the worktree of feat/x.
if git show-ref --verify --quiet "refs/heads/$branch"; then
  wt=$(git for-each-ref --format='%(worktreepath)' "refs/heads/$branch")
  if [ -n "$wt" ] && [ "$wt" != "$root" ]; then
    git worktree remove --force "$wt"
  fi
  # Squash merges leave the branch unmerged locally — -D, safe because the PR is MERGED.
  git branch -D "$branch"
fi

if git ls-remote --exit-code "$remote" "refs/heads/$branch" >/dev/null; then
  git push "$remote" --delete "$branch"
fi

# Fast-forward local base only when the main checkout is on it and clean — never reset or force
if [ "$(git branch --show-current)" = "$base" ] && [ -z "$(git status --porcelain)" ]; then
  git fetch "$remote" "$base"
  git merge --ff-only "$remote/$base"
fi
