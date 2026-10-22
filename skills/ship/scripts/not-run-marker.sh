#!/bin/sh
# Usage: not-run-marker.sh RECEIPT_JSON_FILE
# Reads an engineer receipt and prints the PR-body marker for the verification
# layers valued not_run, lanes sorted — `<!-- supera: not_run=e2e,integration -->`
# — or nothing when there is none. Exits 3, printing nothing on stdout and
# `not_run on <key> is not accepted: run it or report fail` on stderr (one line
# per key), when build, lint or unit is not_run: those gates always run. Exits
# 1 when the file is missing or not a JSON receipt. Needs jq.
set -eu

receipt=${1:?usage: not-run-marker.sh RECEIPT_JSON_FILE}

lanes=$(jq -r '(.verification // {}) | to_entries | map(select(.value == "not_run") | .key) | sort | .[]' "$receipt" 2>/dev/null) || {
  echo "not-run-marker: $receipt is not a readable JSON receipt" >&2
  exit 1
}
[ -n "$lanes" ] || exit 0

blocked=0
for lane in $lanes; do
  case $lane in
    build | lint | unit)
      echo "not_run on $lane is not accepted: run it or report fail" >&2
      blocked=1
      ;;
  esac
done
[ "$blocked" -eq 0 ] || exit 3

printf '<!-- supera: not_run=%s -->\n' "$(printf '%s' "$lanes" | tr '\n' ',')"
