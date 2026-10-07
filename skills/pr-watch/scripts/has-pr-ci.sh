#!/bin/sh
# Usage: has-pr-ci.sh
# Run from the worktree root. Prints the workflow files under .github/workflows
# that trigger on pull_request or pull_request_target and exits 0; prints
# NO_PR_CI and exits 1 when there are none (or no workflows directory).
# `github.event.pull_request` and quoted 'pull_request' don't count.
set -eu

if grep -rlsE '(^|[[:space:],[])pull_request(_target)?([[:space:]]*:|[],[:space:]]|$)' .github/workflows; then
  exit 0
fi
echo "NO_PR_CI"
exit 1
