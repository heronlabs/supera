#!/bin/sh
# Usage: review-scope.sh REMOTE/BASE
# Decides whether ship's review gate runs. From the worktree root, counts the
# changed lines against REMOTE/BASE — `git diff --numstat` added plus deleted —
# plus every line of each untracked file (`git ls-files --others
# --exclude-standard`), .supera/ left out. Prints `SKIP:docs-only` when every
# changed or untracked path ends in .md, `SKIP:small <n>` when n is 20 or
# fewer, else `REVIEW <n>`. Exits 0 always, 1 only outside a git worktree.
set -eu

base=${1:?usage: review-scope.sh REMOTE/BASE}

top=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "review-scope: not inside a git worktree" >&2
  exit 1
}
cd "$top" || exit 1

numstat=$(git diff --numstat --no-renames "$base")
tracked=$(printf '%s\n' "$numstat" | awk -F'\t' 'NF && $3 !~ /^\.supera\//')
untracked=$(git ls-files --others --exclude-standard | grep -v '^\.supera/' || :)

n=$(printf '%s\n' "$tracked" | awk -F'\t' 'NF { if ($1 != "-") n += $1; if ($2 != "-") n += $2 } END { print n + 0 }')
if [ -n "$untracked" ]; then
  lines=$(printf '%s\n' "$untracked" | while IFS= read -r f; do cat "$f"; done | wc -l | tr -d ' ')
  n=$((n + lines))
fi

paths=$({ printf '%s\n' "$tracked" | cut -f3-; printf '%s\n' "$untracked"; } | grep -v '^$' || :)

if [ -n "$paths" ] && ! printf '%s\n' "$paths" | grep -qv '\.md$'; then
  echo "SKIP:docs-only"
elif [ "$n" -le 20 ]; then
  echo "SKIP:small $n"
else
  echo "REVIEW $n"
fi
