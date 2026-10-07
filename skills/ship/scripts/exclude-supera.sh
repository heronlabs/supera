#!/bin/sh
# Usage: exclude-supera.sh
# Adds .supera/ to the repo-local exclude file, shared by every worktree of the
# repo, once. Never touches .gitignore.
set -eu

exclude=$(git rev-parse --path-format=absolute --git-path info/exclude)
mkdir -p "$(dirname "$exclude")"
grep -qxF '.supera/' "$exclude" 2>/dev/null || printf '\n.supera/\n' >>"$exclude"
