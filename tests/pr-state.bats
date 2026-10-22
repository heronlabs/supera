#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for skills/pr-watch/scripts/pr-state.sh
#
# Runs the script on PR 154 against the fake gh (gh-fixtures), from a sandbox
# standing in for the worktree root whose .github/workflows the test writes,
# and asserts on the key=value lines and the exit code. No network.

bats_require_minimum_version 1.5.0

load gh-fixtures

setup() {
  SANDBOX="$(mktemp -d)"
  SCRIPT="$BATS_TEST_DIRNAME/../skills/pr-watch/scripts/pr-state.sh"
  FIXTURES="$BATS_TEST_DIRNAME/fixtures/gh/pr-state"
}

teardown() {
  teardown_gh
  rm -rf "$SANDBOX"
}

pr_state() { ( cd "$SANDBOX" && "$SCRIPT" 154 ); }

# workflow NAME: writes stdin to .github/workflows/NAME in the sandbox
workflow() {
  mkdir -p "$SANDBOX/.github/workflows"
  cat >"$SANDBOX/.github/workflows/$1"
}

# value KEY: the value of KEY in $output
value() { printf '%s\n' "$output" | sed -n "s/^$1=//p"; }

# keys: the keys of $output, space-separated
keys() { printf '%s\n' "$output" | cut -d= -f1 | tr '\n' ' ' | sed 's/ $//'; }

@test "prints all 16 keys in order for a green PR" {
  workflow ci.yml <<'YAML'
name: Continuous Integration
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-24.04
YAML
  gh_scenario "$FIXTURES/green"

  run pr_state

  [ "$status" -eq 0 ]
  [ "$(keys)" = "state headSha mergeStateStatus mergeable reviewDecision checksTotal checksSuccess checksFailure checksPending checksSkipped failing queuedOver10m queuedSelfHosted unresolvedThreads hasPrCi lastActivityAgeSec" ]
  [ "$(value state)" = "OPEN" ]
  [ "$(value headSha)" = "0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3" ]
  [ "$(value mergeStateStatus)" = "CLEAN" ]
  [ "$(value mergeable)" = "MERGEABLE" ]
  [ "$(value reviewDecision)" = "APPROVED" ]
  [ "$(value checksTotal)" = "3" ]
  [ "$(value checksSuccess)" = "2" ]
  [ "$(value checksFailure)" = "0" ]
  [ "$(value checksPending)" = "0" ]
  [ "$(value checksSkipped)" = "1" ]
  [ "$(value failing)" = "" ]
  [ "$(value queuedOver10m)" = "" ]
  [ "$(value queuedSelfHosted)" = "false" ]
  [ "$(value unresolvedThreads)" = "0" ]
  [ "$(value hasPrCi)" = "true" ]
  [ "$(value lastActivityAgeSec)" -gt 600 ]
}

@test "counts failing checks and lists name:runId" {
  gh_scenario "$FIXTURES/failing"

  run pr_state

  [ "$status" -eq 0 ]
  [ "$(value checksTotal)" = "5" ]
  [ "$(value checksSuccess)" = "1" ]
  [ "$(value checksFailure)" = "3" ]
  [ "$(value checksPending)" = "1" ]
  [ "$(value failing)" = "lint:123,test:124,pulumi-preview/sandbox:" ]
  [ "$(value mergeStateStatus)" = "UNSTABLE" ]
  [ "$(value reviewDecision)" = "" ]
}

@test "flags queuedOver10m and queuedSelfHosted from a self-hosted workflow" {
  workflow ci.yml <<'YAML'
name: Continuous Integration
on: pull_request
jobs:
  lint:
    runs-on: [self-hosted, linux]
YAML
  gh_scenario "$FIXTURES/queued"

  run pr_state

  [ "$status" -eq 0 ]
  [ "$(value checksPending)" = "1" ]
  [ "$(value queuedOver10m)" = "Continuous Integration" ]
  [ "$(value queuedSelfHosted)" = "true" ]
}

@test "queuedSelfHosted is false when the queued workflow runs on GitHub-hosted labels" {
  workflow ci.yml <<'YAML'
name: Continuous Integration
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-24.04
  test:
    runs-on:
      - macos-15
YAML
  gh_scenario "$FIXTURES/queued"

  run pr_state

  [ "$status" -eq 0 ]
  [ "$(value queuedOver10m)" = "Continuous Integration" ]
  [ "$(value queuedSelfHosted)" = "false" ]
}

@test "queuedSelfHosted reads a runner group under a bare runs-on" {
  workflow ci.yml <<'YAML'
name: Continuous Integration
on: pull_request
jobs:
  lint:
    runs-on:
      group: heronlabs-runners
      labels: [linux]
YAML
  gh_scenario "$FIXTURES/queued"

  run pr_state

  [ "$status" -eq 0 ]
  [ "$(value queuedSelfHosted)" = "true" ]
}

@test "unresolvedThreads counts root comments only" {
  gh_scenario "$FIXTURES/threads"

  run pr_state

  [ "$status" -eq 0 ]
  [ "$(value unresolvedThreads)" = "2" ]
}

@test "hasPrCi=false in a repo without pull_request workflows" {
  workflow cd.yml <<'YAML'
on:
  push:
    branches: [main]
YAML
  gh_scenario "$FIXTURES/green"

  run pr_state

  [ "$status" -eq 0 ]
  [ "$(value hasPrCi)" = "false" ]
  [ "$(value checksTotal)" = "3" ]
}

@test "exit 1 when gh pr view fails" {
  gh_scenario "$FIXTURES/gh-error"

  run --separate-stderr pr_state

  [ "$status" -eq 1 ]
  [ -z "$output" ]
  [ "$stderr" = "pr-state: gh failed: pr view" ]
}
