#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for skills/pr-watch/scripts/not-run-lanes.sh
#
# Runs the script on PR 154 against the fake gh (gh-fixtures) and asserts on
# the lanes it prints and the exit code. No network.

bats_require_minimum_version 1.5.0

load gh-fixtures

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../skills/pr-watch/scripts/not-run-lanes.sh"
  FIXTURES="$BATS_TEST_DIRNAME/fixtures/gh/not-run-lanes"
}

teardown() {
  teardown_gh
}

lanes() { "$SCRIPT" 154; }

@test "prints e2e and integration from marker" {
  gh_scenario "$FIXTURES/marker"

  run --separate-stderr lanes

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'e2e\nintegration')" ]
  [ -z "$stderr" ]
}

@test "prints nothing without marker" {
  gh_scenario "$FIXTURES/no-marker"

  run --separate-stderr lanes

  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$stderr" ]
}

@test "uses the last marker when two exist" {
  gh_scenario "$FIXTURES/two-markers"

  run lanes

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'integration\nsmoke')" ]
}

@test "exit 1 when gh fails" {
  gh_scenario "$FIXTURES/gh-error"

  run --separate-stderr lanes

  [ "$status" -eq 1 ]
  [ -z "$output" ]
  [ "$stderr" = "not-run-lanes: gh failed: pr view" ]
}
