#!/bin/sh
# Usage: changed-files.sh
# Prints every changed path of the current worktree, one per line, relative to
# its root: staged, unstaged and untracked (each file of a new directory), a
# rename as both paths, .supera/ left out even where it isn't ignored.
# Prints nothing on a clean worktree.
set -eu

status=$(git status --porcelain --untracked-files=all --no-renames)
[ -n "$status" ] || exit 0
printf '%s\n' "$status" | cut -c4- | grep -v '^\.supera/' || :
