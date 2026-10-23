#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for scripts/deadline.sh
#
# Runs the deadline with one-second waits and asserts on the final
# ENGINEER_DEADLINE line, the exit code, stderr and the elapsed time.
# No git, no gh.

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/deadline.sh"
}

deadline() { "$SCRIPT" "$@"; }

@test "prints ENGINEER_DEADLINE 1 after one second" {
  start=$(date +%s)

  run --separate-stderr deadline 1

  [ "$(($(date +%s) - start))" -ge 1 ]
  [ "$status" -eq 0 ]
  [ "$output" = "ENGINEER_DEADLINE 1" ]
  [ -z "$stderr" ]
}

@test "echoes passthrough verbatim" {
  run --separate-stderr deadline 1 "/pr-watch 154:waits=160 160 --tick 7"

  [ "$status" -eq 0 ]
  [ "$output" = "ENGINEER_DEADLINE 1 /pr-watch 154:waits=160 160 --tick 7" ]
  [ -z "$stderr" ]
}

@test "exit 64 without seconds" {
  run --separate-stderr deadline

  [ "$status" -eq 64 ]
  [ -z "$output" ]
  [ "$stderr" = "usage: deadline.sh SECONDS [PASSTHROUGH]" ]
}
