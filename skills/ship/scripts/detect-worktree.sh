#!/bin/sh
# Usage: detect-worktree.sh BASE
# Prints IN_WORKTREE=true|false and CUR=<current branch>. true only inside a
# linked worktree on a branch other than BASE: git-dir differs from the common
# dir only in a linked worktree, and a detached HEAD has no branch.
set -eu

base=${1:?usage: detect-worktree.sh BASE}

cur=$(git branch --show-current)
git_dir=$(git rev-parse --path-format=absolute --git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
in_worktree=false
if [ "$git_dir" != "$common_dir" ] && [ -n "$cur" ] && [ "$cur" != "$base" ]; then
  in_worktree=true
fi
echo "IN_WORKTREE=$in_worktree"
echo "CUR=$cur"
