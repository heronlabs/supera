#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for skills/ship/scripts/review-scope.sh
#
# Changes files in a clone of a throwaway bare remote, runs the script against
# origin/main and asserts on the SKIP/REVIEW line and the exit code. No network.

bats_require_minimum_version 1.5.0

load git-fixtures

setup() {
  setup_repo
  SCRIPT="$BATS_TEST_DIRNAME/../skills/ship/scripts/review-scope.sh"
}

teardown() {
  teardown_repo
}

# scope [DIR]: runs the script from DIR (default: the clone's root) against origin/main
scope() { in_dir "${1:-$REPO}" "$SCRIPT" origin/main; }

# lines PATH N: writes N numbered lines to PATH under the clone, directories created
lines() {
  mkdir -p "$(dirname "$REPO/$1")"
  seq 1 "$2" | sed 's/^/line /' >"$REPO/$1"
}

@test "SKIP:docs-only for README-only change" {
  lines README.md 25

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "SKIP:docs-only" ]
  [ -z "$stderr" ]
}

@test "SKIP:small 12 for a 12-line change" {
  lines a.txt 11

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "SKIP:small 12" ]
  [ -z "$stderr" ]
}

@test "REVIEW 21 counts untracked file lines" {
  lines a.txt 2
  lines src/new.sh 18

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "REVIEW 21" ]
  [ -z "$stderr" ]
}

@test "REVIEW 28 for a .md plus a code file — never SKIP:docs-only" {
  lines README.md 25
  lines a.txt 2

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "REVIEW 28" ]
  [ -z "$stderr" ]
}

@test "SKIP:small 8 for a small .md plus code change" {
  lines README.md 5
  lines a.txt 2

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "SKIP:small 8" ]
  [ -z "$stderr" ]
}

@test "SKIP:small 20 at the boundary" {
  lines a.txt 19

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "SKIP:small 20" ]
  [ -z "$stderr" ]
}

@test "REVIEW 21 just over the boundary" {
  lines a.txt 20

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "REVIEW 21" ]
  [ -z "$stderr" ]
}

@test "SKIP:small 14 sums added and deleted lines of a tracked file" {
  commit_file "$REPO" b.txt "$(seq 1 10)"
  git -C "$REPO" push -q origin main
  lines b.txt 4

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "SKIP:small 14" ]
  [ -z "$stderr" ]
}

@test "SKIP:small 1 for emptying a tracked file" {
  : >"$REPO/a.txt"

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "SKIP:small 1" ]
  [ -z "$stderr" ]
}

@test ".supera/ is ignored" {
  lines .supera/plan.md 50
  lines a.txt 5

  run --separate-stderr scope

  [ "$status" -eq 0 ]
  [ "$output" = "SKIP:small 6" ]
  [ -z "$stderr" ]
}

@test "exit 1 outside a repo" {
  mkdir "$SANDBOX/plain"

  run --separate-stderr scope "$SANDBOX/plain"

  [ "$status" -eq 1 ]
  [ -z "$output" ]
  [ "$stderr" = "review-scope: not inside a git worktree" ]
}
