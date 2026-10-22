#!/bin/sh
# Usage: not-run-lanes.sh PR
# Prints, one per line, the verification layers the engineer did not run
# locally for PR's change: the lanes of the last `<!-- supera: not_run=... -->`
# marker ship appended to the PR body. Prints nothing when the body has no
# marker. One gh call (pr view); exits 1 with `not-run-lanes: gh failed: pr
# view` on stderr when it fails. Needs jq.
set -eu

pr=${1:?usage: not-run-lanes.sh PR}

view=$(gh pr view "$pr" --json body) || {
  echo "not-run-lanes: gh failed: pr view" >&2
  exit 1
}
printf '%s' "$view" | jq -r '.body // ""' \
  | grep -oE '<!-- supera: not_run=[^[:space:]]+ -->' | tail -n 1 \
  | sed -E 's/^<!-- supera: not_run=(.*) -->$/\1/' | tr ',' '\n'
