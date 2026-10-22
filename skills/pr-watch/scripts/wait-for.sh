#!/bin/sh
# Usage: wait-for.sh MODE PR TIMEOUT_SEC [POLL_SEC] [PASSTHROUGH]
# Background poller for pr-watch, run from the worktree root. Polls gh every
# POLL_SEC (default 300; 60 for checks) until the state change of MODE, then
# prints one final line and exits:
#   WAIT <mode> <PR> done|timeout|error[:<reason>] [<passthrough>]
# exit 0 on done, 2 on timeout, 1 on error, 64 on usage. PASSTHROUGH is
# echoed verbatim. Modes and their done reasons:
#   checks  checks appeared on the head and `gh pr checks --watch --fail-fast`
#           returned: finished (exit 0) | failed (any other exit, a gh error
#           inside the watch included — the next tick's pr-state.sh tells
#           them apart) | no-ci (sibling has-pr-ci.sh prints NO_PR_CI) |
#           no-checks (none appeared within the settle phase: POLL_SEC polls
#           for at most 10 min)
#   queue   no run for the head sha is queued any more: started
#   merge   PR state is MERGED or CLOSED: merged | closed
#   change  PR updatedAt differs from its value at start: updated
# A failing gh poll is retried once after POLL_SEC; a second consecutive
# failure ends error:gh. Needs jq.
set -eu

usage='usage: wait-for.sh checks|queue|merge|change PR TIMEOUT_SEC [POLL_SEC] [PASSTHROUGH]'
mode=${1:-}
pr=${2:-}
timeout=${3:-}
poll=${4:-}
passthrough=${5:-}

die_usage() {
  echo "$usage" >&2
  exit 64
}
case $mode in
  checks | queue | merge | change) ;;
  *) die_usage ;;
esac
case $pr in '' | *[!0-9]*) die_usage ;; esac
case $timeout in '' | *[!0-9]*) die_usage ;; esac
if [ -z "$poll" ]; then
  if [ "$mode" = checks ]; then poll=60; else poll=300; fi
fi
case $poll in *[!0-9]* | 0*) die_usage ;; esac

start=$(date +%s)
deadline=$((start + timeout))

# finish STATUS EXIT_CODE: prints the final line and exits
finish() {
  if [ -n "$passthrough" ]; then
    printf 'WAIT %s %s %s %s\n' "$mode" "$pr" "$1" "$passthrough"
  else
    printf 'WAIT %s %s %s\n' "$mode" "$pr" "$1"
  fi
  exit "$2"
}

# gh_poll ARGS...: runs gh into $out; a failure returns 1 and the second in a
# row ends error. A poll resets the count once every call of its iteration
# succeeded.
failures=0
gh_poll() {
  if out=$(gh "$@"); then
    return 0
  fi
  failures=$((failures + 1))
  [ "$failures" -lt 2 ] || finish error:gh 1
  return 1
}

# sleep_until UNTIL: sleeps POLL_SEC, no further than UNTIL (epoch seconds);
# returns 1 when UNTIL has passed
sleep_until() {
  now=$(date +%s)
  left=$(($1 - now))
  [ "$left" -gt 0 ] || return 1
  if [ "$left" -lt "$poll" ]; then sleep "$left"; else sleep "$poll"; fi
}

# tick: sleeps towards the deadline; ends timeout once it is reached
tick() {
  sleep_until "$deadline" || finish timeout 2
}

# field OUT EXPR: jq -r EXPR over OUT, empty when OUT is not JSON
field() {
  printf '%s' "$1" | jq -r "$2" 2>/dev/null || :
}

case $mode in
  merge)
    while :; do
      if gh_poll pr view "$pr" --json state; then
        failures=0
        case $(field "$out" '.state // empty') in
          MERGED) finish done:merged 0 ;;
          CLOSED) finish done:closed 0 ;;
        esac
      fi
      tick
    done
    ;;
  change)
    first=
    while :; do
      if gh_poll pr view "$pr" --json updatedAt; then
        failures=0
        at=$(field "$out" '.updatedAt // empty')
        if [ -z "$first" ]; then
          first=$at
        elif [ "$at" != "$first" ]; then
          finish done:updated 0
        fi
      fi
      tick
    done
    ;;
  queue)
    while :; do
      if gh_poll pr view "$pr" --json headRefOid; then
        sha=$(field "$out" '.headRefOid // empty')
        if [ -n "$sha" ] && gh_poll run list --commit "$sha" --status queued --json databaseId; then
          failures=0
          [ "$(field "$out" 'length')" != 0 ] || finish done:started 0
        fi
      fi
      tick
    done
    ;;
  checks)
    "$(dirname "$0")/has-pr-ci.sh" >/dev/null 2>&1 || finish done:no-ci 0
    settle=$((start + 600))
    [ "$settle" -lt "$deadline" ] || settle=$deadline
    while :; do
      if gh_poll pr view "$pr" --json statusCheckRollup; then
        failures=0
        [ "$(field "$out" '.statusCheckRollup | length')" = 0 ] || break
      fi
      sleep_until "$settle" || finish done:no-checks 0
    done
    # The watch blocks; a kill -0 loop stands in for a POSIX timeout(1).
    gh pr checks "$pr" --watch --fail-fast --interval 30 >/dev/null 2>&1 &
    watch=$!
    while kill -0 "$watch" 2>/dev/null; do
      if [ "$(date +%s)" -ge "$deadline" ]; then
        kill "$watch" 2>/dev/null || :
        wait "$watch" 2>/dev/null || :
        finish timeout 2
      fi
      sleep 1
    done
    rc=0
    wait "$watch" || rc=$?
    if [ "$rc" -eq 0 ]; then finish done:finished 0; fi
    finish done:failed 0
    ;;
esac
