#!/bin/sh
# Usage: create-worktree.sh WT_DIR REMOTE BASE SLUG
# Creates or reuses the worktree of branch SLUG and prints its absolute path.
# WT_DIR is relative to the main checkout. A local SLUG is reused (with the
# worktree it already has, if any), else a SLUG on REMOTE is fetched, else SLUG
# is created off REMOTE/BASE. Git's own output goes to stderr. Exits non-zero
# when WT_DIR/SLUG exists but is not a worktree: it is never deleted.
set -eu

usage='usage: create-worktree.sh WT_DIR REMOTE BASE SLUG'
wt_dir=${1:?$usage}
remote=${2:?$usage}
base=${3:?$usage}
slug=${4:?$usage}

root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
dir=$wt_dir/$slug
cd "$root"
git fetch "$remote" "$base" >&2
git worktree prune   # drop registrations whose directory is gone

if git show-ref --verify --quiet "refs/heads/$slug"; then
  echo "Branch $slug already exists locally — reusing." >&2
  if [ -z "$(git for-each-ref --format='%(worktreepath)' "refs/heads/$slug")" ]; then
    git worktree add "$dir" "$slug" >&2
  fi
elif git ls-remote --exit-code --heads "$remote" "refs/heads/$slug" >/dev/null; then
  echo "Branch $slug exists on $remote — fetching." >&2
  git fetch "$remote" "$slug" >&2
  git worktree add "$dir" "$slug" >&2
else
  # Branch exists nowhere, so a worktree at the path is left over from a crashed run.
  if [ -e "$dir/.git" ]; then
    git worktree remove --force "$dir"
  fi
  git worktree add "$dir" -b "$slug" "$remote/$base" >&2
fi

wt=$(git for-each-ref --format='%(worktreepath)' "refs/heads/$slug")
if [ -z "$wt" ] || [ "$wt" = "$root" ]; then
  echo "Branch $slug is not checked out in a linked worktree (main checkout: $root)." >&2
  exit 1
fi
printf '%s\n' "$wt"
