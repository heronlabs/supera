#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for tests/gh-shim/gh, the fake gh the script tests put on PATH
# through gh_scenario (gh-fixtures.bash).

bats_require_minimum_version 1.5.0

load gh-fixtures

setup() {
  SANDBOX="$(mktemp -d)"
  mkdir "$SANDBOX/scenario"
}

teardown() {
  teardown_gh
  rm -rf "$SANDBOX"
}

# fixture NAME CONTENT: writes CONTENT as $SANDBOX/scenario/NAME
fixture() { printf '%s\n' "$2" >"$SANDBOX/scenario/$1"; }

@test "shim replays <key>.out and exit code" {
  fixture pr_view_154.out '{"state":"OPEN"}'
  fixture pr_view_154.code 3
  gh_scenario "$SANDBOX/scenario"

  run --separate-stderr gh pr view 154 --json state -q .state

  [ "$status" -eq 3 ]
  [ "$output" = '{"state":"OPEN"}' ]
  [ "$(command -v gh)" = "$GH_SHIM_DIR/gh" ]
}

@test "shim serves .1.out then .2.out on consecutive calls" {
  fixture pr_view_154.1.out '{"state":"OPEN"}'
  fixture pr_view_154.2.out '{"state":"MERGED"}'
  gh_scenario "$SANDBOX/scenario"

  run gh pr view 154 --json state
  [ "$output" = '{"state":"OPEN"}' ]

  run gh pr view 154 --json state

  [ "$status" -eq 0 ]
  [ "$output" = '{"state":"MERGED"}' ]
  [ "$(gh_calls pr_view_154)" -eq 2 ]
}

@test "shim falls back to <key>.out past the numbered files" {
  fixture pr_view_154.1.out '{"state":"OPEN"}'
  fixture pr_view_154.out '{"state":"MERGED"}'
  gh_scenario "$SANDBOX/scenario"

  run gh pr view 154 --json state
  [ "$output" = '{"state":"OPEN"}' ]

  run gh pr view 154 --json state

  [ "$status" -eq 0 ]
  [ "$output" = '{"state":"MERGED"}' ]
}

@test "shim with only a .code file prints nothing and exits with it" {
  fixture pr_view_154.code 1
  gh_scenario "$SANDBOX/scenario"

  run --separate-stderr gh pr view 154 --json state

  [ "$status" -eq 1 ]
  [ -z "$output" ]
  [ -z "$stderr" ]
}

@test "shim sleeps for <key>.sleep seconds before answering" {
  fixture pr_checks_154.out 'All checks were successful'
  fixture pr_checks_154.sleep 1
  gh_scenario "$SANDBOX/scenario"
  local before
  before=$(date +%s)

  run gh pr checks 154 --watch

  [ "$status" -eq 0 ]
  [ "$output" = 'All checks were successful' ]
  [ $(( $(date +%s) - before )) -ge 1 ]
}

@test "shim exits 99 on missing fixture" {
  gh_scenario "$SANDBOX/scenario"

  run --separate-stderr gh run list --commit abc --status queued

  [ "$status" -eq 99 ]
  [ -z "$output" ]
  [ "$stderr" = "gh-shim: no fixture for run_list" ]
}

@test "shim flattens an api path into the key" {
  fixture api_repos_owner_repo_pulls_154_comments.out '[]'
  gh_scenario "$SANDBOX/scenario"

  run gh api 'repos/{owner}/{repo}/pulls/154/comments' --paginate

  [ "$status" -eq 0 ]
  [ "$output" = '[]' ]
}

@test "shim counts calls in a copy, never in the fixture directory" {
  fixture pr_view_154.out '{"state":"OPEN"}'
  gh_scenario "$SANDBOX/scenario"

  run gh pr view 154 --json state

  [ "$status" -eq 0 ]
  [ ! -e "$SANDBOX/scenario/.calls" ]
  [ "$(gh_calls pr_view_154)" -eq 1 ]
}
