#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for skills/ship/scripts/not-run-marker.sh
#
# Writes an engineer receipt into a sandbox, runs the script on it and asserts
# on the marker line, the exit code and stderr. No git, no gh.

bats_require_minimum_version 1.5.0

setup() {
  SANDBOX="$(mktemp -d)"
  SCRIPT="$BATS_TEST_DIRNAME/../skills/ship/scripts/not-run-marker.sh"
}

teardown() {
  rm -rf "$SANDBOX"
}

# receipt VERIFICATION: writes a receipt with that verification object to $SANDBOX/receipt.json
receipt() {
  printf '{"summary": "Add a one-line README", "filesChanged": ["README.md"], "verification": %s}\n' "$1" >"$SANDBOX/receipt.json"
}

marker() { "$SCRIPT" "$SANDBOX/receipt.json"; }

@test "prints sorted marker for e2e and integration" {
  receipt '{"build": "skipped", "lint": "pass", "unit": "pass", "integration": "not_run", "e2e": "not_run"}'

  run --separate-stderr marker

  [ "$status" -eq 0 ]
  [ "$output" = "<!-- supera: not_run=e2e,integration -->" ]
  [ -z "$stderr" ]
}

@test "prints nothing when no not_run" {
  receipt '{"build": "skipped", "lint": "pass", "unit": "pass", "e2e": "skipped"}'

  run --separate-stderr marker

  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$stderr" ]
}

@test "exit 3 for not_run on unit" {
  receipt '{"lint": "pass", "unit": "not_run", "e2e": "not_run"}'

  run --separate-stderr marker

  [ "$status" -eq 3 ]
  [ -z "$output" ]
  [ "$stderr" = "not_run on unit is not accepted: run it or report fail" ]
}

@test "exit 3 for not_run on lint" {
  receipt '{"lint": "not_run", "unit": "pass"}'

  run --separate-stderr marker

  [ "$status" -eq 3 ]
  [ -z "$output" ]
  [ "$stderr" = "not_run on lint is not accepted: run it or report fail" ]
}

@test "exit 3 for not_run on build" {
  receipt '{"build": "not_run", "lint": "pass", "unit": "pass"}'

  run --separate-stderr marker

  [ "$status" -eq 3 ]
  [ -z "$output" ]
  [ "$stderr" = "not_run on build is not accepted: run it or report fail" ]
}

@test "exit 1 on malformed receipt" {
  printf '{"summary": "Add a one-line README", "verification": {"unit": "pass"\n' >"$SANDBOX/receipt.json"

  run --separate-stderr marker

  [ "$status" -eq 1 ]
  [ -z "$output" ]
  [ "$stderr" = "not-run-marker: $SANDBOX/receipt.json is not a readable JSON receipt" ]
}
