#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for skills/pr-watch/scripts/wait-for.sh
#
# Runs the poller on PR 154 against the fake gh (gh-fixtures), from a sandbox
# standing in for the worktree root, with poll-sec 1 and timeouts of a few
# seconds, and asserts on the final WAIT line, the exit code and the number
# of gh calls. No network.

bats_require_minimum_version 1.5.0

load gh-fixtures

setup() {
  SANDBOX="$(mktemp -d)"
  SCRIPT="$BATS_TEST_DIRNAME/../skills/pr-watch/scripts/wait-for.sh"
  FIXTURES="$BATS_TEST_DIRNAME/fixtures/gh/wait-for"
}

teardown() {
  teardown_gh
  rm -rf "$SANDBOX"
}

# wait_for MODE [TIMEOUT] [POLL] [PASSTHROUGH]: runs the poller on PR 154 from the sandbox
wait_for() {
  if [ "$#" -ge 4 ]; then
    ( cd "$SANDBOX" && "$SCRIPT" "$1" 154 "$2" "$3" "$4" )
  else
    ( cd "$SANDBOX" && "$SCRIPT" "$1" 154 "${2:-3}" "${3:-1}" )
  fi
}

# pr_ci: the sandbox has a workflow that triggers on pull_request
pr_ci() {
  mkdir -p "$SANDBOX/.github/workflows"
  printf 'on: pull_request\njobs: {}\n' >"$SANDBOX/.github/workflows/ci.yml"
}

# contains_usage TEXT: succeeds when TEXT is the usage line
contains_usage() {
  case "$1" in
    "usage: wait-for.sh "*) return 0 ;;
  esac
  echo "expected usage, got: $1" >&2
  return 1
}

# ---------------------------------------------------------------- merge

@test "merge: done:merged when state becomes MERGED on 2nd poll" {
  gh_scenario "$FIXTURES/merge-merged"

  run wait_for merge

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT merge 154 done:merged" ]
  [ "$(gh_calls pr_view_154)" -eq 2 ]
}

@test "merge: done:closed on CLOSED" {
  gh_scenario "$FIXTURES/merge-closed"

  run wait_for merge

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT merge 154 done:closed" ]
}

@test "merge: timeout exit 2 when state stays OPEN" {
  gh_scenario "$FIXTURES/merge-open"

  run wait_for merge

  [ "$status" -eq 2 ]
  [ "$output" = "WAIT merge 154 timeout" ]
  [ "$(gh_calls pr_view_154)" -ge 2 ]
  [ "$(gh_calls pr_view_154)" -le 5 ]
}

# ---------------------------------------------------------------- queue / change

@test "queue: done:started when queued list empties" {
  gh_scenario "$FIXTURES/queue-started"

  run wait_for queue

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT queue 154 done:started" ]
  [ "$(gh_calls run_list)" -eq 2 ]
}

@test "change: done:updated when updatedAt differs" {
  gh_scenario "$FIXTURES/change-updated"

  run wait_for change

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT change 154 done:updated" ]
  [ "$(gh_calls pr_view_154)" -eq 2 ]
}

# ---------------------------------------------------------------- checks

@test "checks: done:failed when gh pr checks exits non-zero" {
  pr_ci
  gh_scenario "$FIXTURES/checks-failed"

  run wait_for checks

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT checks 154 done:failed" ]
  [ "$(gh_calls pr_checks_154)" -eq 1 ]
}

@test "checks: done:finished when gh pr checks exits 0" {
  pr_ci
  gh_scenario "$FIXTURES/checks-finished"

  run wait_for checks

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT checks 154 done:finished" ]
}

@test "checks: done:no-ci when has-pr-ci reports NO_PR_CI, without calling gh" {
  mkdir "$SANDBOX/no-fixtures"
  gh_scenario "$SANDBOX/no-fixtures"

  run wait_for checks

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT checks 154 done:no-ci" ]
  [ ! -e "$GH_SHIM_SCENARIO/.calls" ]
}

@test "checks: done:no-checks after settle phase with empty rollup" {
  pr_ci
  gh_scenario "$FIXTURES/checks-no-checks"

  run wait_for checks

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT checks 154 done:no-checks" ]
  [ "$(gh_calls pr_view_154)" -ge 2 ]
  [ "$(gh_calls pr_checks_154)" -eq 0 ]
}

@test "checks: timeout exit 2 ends a watch that never returns" {
  pr_ci
  gh_scenario "$FIXTURES/checks-hangs"

  run wait_for checks 2 1

  [ "$status" -eq 2 ]
  [ "$output" = "WAIT checks 154 timeout" ]
  [ "$(gh_calls pr_checks_154)" -eq 1 ]
}

# ---------------------------------------------------------------- errors, passthrough, usage

@test "error exit 1 after two consecutive gh failures" {
  gh_scenario "$FIXTURES/gh-error"

  run wait_for merge

  [ "$status" -eq 1 ]
  [ "$output" = "WAIT merge 154 error:gh" ]
  [ "$(gh_calls pr_view_154)" -eq 2 ]
}

@test "queue: error exit 1 when run list fails twice even though pr view succeeds" {
  gh_scenario "$FIXTURES/queue-run-list-fails"

  run wait_for queue

  [ "$status" -eq 1 ]
  [ "$output" = "WAIT queue 154 error:gh" ]
  [ "$(gh_calls run_list)" -eq 2 ]
}

@test "a single gh failure is retried after poll-sec" {
  gh_scenario "$FIXTURES/gh-error-once"

  run wait_for merge

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT merge 154 done:merged" ]
  [ "$(gh_calls pr_view_154)" -eq 2 ]
}

@test "passthrough echoed verbatim" {
  gh_scenario "$FIXTURES/merge-closed"

  run wait_for merge 3 1 "/pr-watch 154:waits=160 160 --tick 7"

  [ "$status" -eq 0 ]
  [ "$output" = "WAIT merge 154 done:closed /pr-watch 154:waits=160 160 --tick 7" ]
}

@test "usage exit 64 without timeout" {
  run --separate-stderr "$SCRIPT" merge 154

  [ "$status" -eq 64 ]
  [ -z "$output" ]
  contains_usage "$stderr"
}

@test "usage exit 64 on an unknown mode or a zero poll" {
  run --separate-stderr "$SCRIPT" sleep 154 3
  [ "$status" -eq 64 ]

  run --separate-stderr "$SCRIPT" merge 154 3 0

  [ "$status" -eq 64 ]
  contains_usage "$stderr"
}
