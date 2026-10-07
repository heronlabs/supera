#!/bin/sh
# Usage: ensure-worktree.sh WT_DIR REMOTE BRANCH
# Prints the root of the checkout to work on BRANCH in: the current linked
# worktree when it is on BRANCH, else WT_DIR/BRANCH, fetched and added when
# missing. Prints WRONG_CHECKOUT to stderr and exits 1 when that checkout is
# not on BRANCH.
set -eu

usage='usage: ensure-worktree.sh WT_DIR REMOTE BRANCH'
wt_dir=${1:?$usage}
remote=${2:?$usage}
branch=${3:?$usage}

dir=$(git rev-parse --show-toplevel)
if [ "$(git rev-parse --path-format=absolute --git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ] \
  || [ "$(git branch --show-current)" != "$branch" ]; then
  if [ ! -d "$wt_dir/$branch" ]; then
    { git fetch "$remote" "$branch" && git worktree add "$wt_dir/$branch" "$branch"; } >&2 || :
  fi
  if [ -d "$wt_dir/$branch" ]; then
    dir=$(cd "$wt_dir/$branch" && pwd -P)
  fi
fi

# A plain directory inside the main checkout reports the main checkout's root.
if [ "$(git -C "$dir" rev-parse --show-toplevel)" != "$dir" ] \
  || [ "$(git -C "$dir" branch --show-current)" != "$branch" ]; then
  echo "WRONG_CHECKOUT" >&2
  exit 1
fi
printf '%s\n' "$dir"
