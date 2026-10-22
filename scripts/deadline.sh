#!/bin/sh
# Usage: deadline.sh SECONDS [PASSTHROUGH]
# Engineer deadline for ship and pr-watch, launched in the background right
# after an engineer is dispatched. Sleeps SECONDS, then prints one line and
# exits 0:
#   ENGINEER_DEADLINE <seconds> [<passthrough>]
# PASSTHROUGH is echoed verbatim. Missing or non-integer SECONDS: usage on
# stderr, exit 64.
set -eu

usage='usage: deadline.sh SECONDS [PASSTHROUGH]'
seconds=${1:-}
passthrough=${2:-}

case $seconds in
  '' | *[!0-9]*)
    echo "$usage" >&2
    exit 64
    ;;
esac

sleep "$seconds"
if [ -n "$passthrough" ]; then
  printf 'ENGINEER_DEADLINE %s %s\n' "$seconds" "$passthrough"
else
  printf 'ENGINEER_DEADLINE %s\n' "$seconds"
fi
