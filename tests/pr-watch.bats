#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for skills/pr-watch/scripts/: ensure-worktree.sh, cleanup.sh and
# has-pr-ci.sh
#
# Runs each script in a clone of a throwaway bare remote, with linked worktrees
# and squash merges done the way GitHub does them (one new commit on main), and
# asserts on the output, the exit code and the worktrees and refs left behind
# locally and on the remote. No network.

bats_require_minimum_version 1.5.0

load git-fixtures

setup() {
  setup_repo
  SCRIPTS="$BATS_TEST_DIRNAME/../skills/pr-watch/scripts"
}

teardown() {
  teardown_repo
}

ensure() { in_dir "$1" "$SCRIPTS/ensure-worktree.sh" "$REPO/.worktrees" origin "$2"; }
cleanup() { in_dir "$1" "$SCRIPTS/cleanup.sh" origin main "$2"; }
has_pr_ci() { in_dir "$REPO" "$SCRIPTS/has-pr-ci.sh"; }

# merged_pr BRANCH: BRANCH has a worktree in .worktrees/ with one commit, is
# pushed, and is squash-merged into the remote's main
merged_pr() {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/$1" -b "$1" origin/main
  commit_file "$REPO/.worktrees/$1" "$1.txt" "$1"
  git -C "$REPO/.worktrees/$1" push -q origin "$1"
  squash_merge "$1"
}

# workflow NAME: writes stdin to .github/workflows/NAME
workflow() {
  mkdir -p "$REPO/.github/workflows"
  cat >"$REPO/.github/workflows/$1"
}

# ---------------------------------------------------------------- ensure-worktree.sh

@test "ensure-worktree: from the main checkout, a branch only on the remote is fetched into WT_DIR/BRANCH" {
  push_branch feat-x

  run --separate-stderr ensure "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-x" ]
  [ "$(git -C "$output" branch --show-current)" = "feat-x" ]
  [ "$(git -C "$output" rev-parse HEAD)" = "$(git -C "$REMOTE_DIR" rev-parse feat-x)" ]
}

@test "ensure-worktree: inside the branch's linked worktree, stays there and prints its root" {
  git -C "$REPO" worktree add -q "$SANDBOX/elsewhere" -b feat-x
  mkdir -p "$SANDBOX/elsewhere/sub"

  run --separate-stderr ensure "$SANDBOX/elsewhere/sub" feat-x

  [ "$status" -eq 0 ]
  [ "$output" = "$SANDBOX/elsewhere" ]
  [ ! -e "$REPO/.worktrees/feat-x" ]
}

@test "ensure-worktree: from another worktree, reuses WT_DIR/BRANCH" {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-x" -b feat-x
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-y" -b feat-y

  run --separate-stderr ensure "$REPO/.worktrees/feat-y" feat-x

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-x" ]
}

@test "ensure-worktree: main checkout on BRANCH, no worktree to add, stays in the main checkout" {
  git -C "$REPO" checkout -q -b feat-x
  git -C "$REPO" push -q origin feat-x

  run --separate-stderr ensure "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO" ]
}

@test "ensure-worktree: WT_DIR/BRANCH on another branch is WRONG_CHECKOUT" {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-x" -b feat-other

  run --separate-stderr ensure "$REPO" feat-x

  [ "$status" -eq 1 ]
  [ -z "$output" ]
  contains "$stderr" "WRONG_CHECKOUT"
}

@test "ensure-worktree: a leftover plain directory at WT_DIR/BRANCH is WRONG_CHECKOUT and kept" {
  git -C "$REPO" checkout -q -b feat-x
  mkdir -p "$REPO/.worktrees/feat-x"
  printf 'keep\n' >"$REPO/.worktrees/feat-x/keep.txt"

  run --separate-stderr ensure "$REPO" feat-x

  [ "$status" -eq 1 ]
  contains "$stderr" "WRONG_CHECKOUT"
  [ "$(cat "$REPO/.worktrees/feat-x/keep.txt")" = "keep" ]
}

@test "ensure-worktree: a branch that exists nowhere is WRONG_CHECKOUT" {
  run --separate-stderr ensure "$REPO" feat-missing

  [ "$status" -eq 1 ]
  contains "$stderr" "WRONG_CHECKOUT"
  [ ! -e "$REPO/.worktrees/feat-missing" ]
}

# ---------------------------------------------------------------- cleanup.sh

@test "cleanup: squash-merged branch — worktree removed, branch deleted with -D locally and on the remote" {
  merged_pr feat-x
  git -C "$REPO" fetch -q origin
  run git -C "$REPO" merge-base --is-ancestor feat-x origin/main
  [ "$status" -eq 1 ]   # not merged, so `branch -d` would refuse

  run cleanup "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ ! -e "$REPO/.worktrees/feat-x" ]
  has_no_ref "$REPO" refs/heads/feat-x
  has_no_ref "$REMOTE_DIR" refs/heads/feat-x
}

@test "cleanup: removes only BRANCH's worktree — feat-x-2 stays" {
  merged_pr feat-x
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-x-2" -b feat-x-2

  run cleanup "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ ! -e "$REPO/.worktrees/feat-x" ]
  [ "$(git -C "$REPO/.worktrees/feat-x-2" branch --show-current)" = "feat-x-2" ]
  git -C "$REPO" show-ref --verify --quiet refs/heads/feat-x-2
}

@test "cleanup: BRANCH feat never matches the worktree of feat/a" {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat/a" -b feat/a

  run cleanup "$REPO" feat

  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO/.worktrees/feat/a" branch --show-current)" = "feat/a" ]
  git -C "$REPO" show-ref --verify --quiet refs/heads/feat/a
}

@test "cleanup: run from inside the worktree it removes" {
  merged_pr feat-x

  run cleanup "$REPO/.worktrees/feat-x" feat-x

  [ "$status" -eq 0 ]
  [ ! -e "$REPO/.worktrees/feat-x" ]
  has_no_ref "$REPO" refs/heads/feat-x
}

@test "cleanup: a remote branch already deleted is tolerated" {
  merged_pr feat-x
  git -C "$REMOTE_DIR" update-ref -d refs/heads/feat-x

  run cleanup "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ ! -e "$REPO/.worktrees/feat-x" ]
  has_no_ref "$REPO" refs/heads/feat-x
}

@test "cleanup: fast-forwards local BASE when the main checkout is on it and clean" {
  merged_pr feat-x

  run cleanup "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" rev-parse main)" = "$(git -C "$REMOTE_DIR" rev-parse main)" ]
}

@test "cleanup: leaves local BASE alone when the main checkout is dirty" {
  merged_pr feat-x
  local before
  before="$(git -C "$REPO" rev-parse main)"
  printf 'uncommitted\n' >"$REPO/a.txt"

  run cleanup "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" rev-parse main)" = "$before" ]
  [ "$(cat "$REPO/a.txt")" = "uncommitted" ]
}

@test "cleanup: leaves local BASE alone when the main checkout is on another branch" {
  merged_pr feat-x
  local before
  before="$(git -C "$REPO" rev-parse main)"
  git -C "$REPO" checkout -q -b other

  run cleanup "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" rev-parse main)" = "$before" ]
  [ "$(git -C "$REPO" rev-parse other)" = "$before" ]
  [ "$(git -C "$REPO" branch --show-current)" = "other" ]
}

@test "cleanup: a second run succeeds and changes nothing" {
  merged_pr feat-x
  run cleanup "$REPO" feat-x
  [ "$status" -eq 0 ]
  local after
  after="$(git -C "$REPO" for-each-ref --format='%(refname) %(objectname)')"

  run cleanup "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" for-each-ref --format='%(refname) %(objectname)')" = "$after" ]
}

@test "cleanup: refuses BRANCH = BASE and touches nothing" {
  git -C "$REPO" checkout -q -b other   # main checked out nowhere, so `branch -D main` would succeed

  run --separate-stderr cleanup "$REPO" main

  [ "$status" -eq 1 ]
  contains "$stderr" "Refusing to clean up main: it is the base branch."
  git -C "$REPO" show-ref --verify --quiet refs/heads/main
  git -C "$REMOTE_DIR" show-ref --verify --quiet refs/heads/main
}

# ---------------------------------------------------------------- has-pr-ci.sh

@test "has-pr-ci: on: pull_request" {
  workflow ci.yml <<'YAML'
on: pull_request
jobs: {}
YAML

  run has_pr_ci

  [ "$status" -eq 0 ]
  [ "$output" = ".github/workflows/ci.yml" ]
}

@test "has-pr-ci: flow list on: [push, pull_request]" {
  workflow ci.yml <<'YAML'
on: [push, pull_request]
YAML

  run has_pr_ci

  [ "$status" -eq 0 ]
  [ "$output" = ".github/workflows/ci.yml" ]
}

@test "has-pr-ci: block list entry - pull_request" {
  workflow ci.yml <<'YAML'
on:
  - push
  - pull_request
YAML

  run has_pr_ci

  [ "$status" -eq 0 ]
  [ "$output" = ".github/workflows/ci.yml" ]
}

@test "has-pr-ci: mapping key pull_request: with filters" {
  workflow ci.yml <<'YAML'
on:
  pull_request:
    branches: [main]
YAML

  run has_pr_ci

  [ "$status" -eq 0 ]
  [ "$output" = ".github/workflows/ci.yml" ]
}

@test "has-pr-ci: pull_request_target" {
  workflow ci.yml <<'YAML'
on:
  pull_request_target:
    types: [opened]
YAML

  run has_pr_ci

  [ "$status" -eq 0 ]
  [ "$output" = ".github/workflows/ci.yml" ]
}

@test "has-pr-ci: a push-only workflow reading github.event.pull_request is NO_PR_CI" {
  workflow cd.yml <<'YAML'
on:
  push:
    branches: [main]
jobs:
  release:
    if: github.event_name == 'pull_request' || github.event.pull_request.merged
    runs-on: ubuntu-24.04
    steps:
      - run: echo "${{ github.event.pull_request.head.sha }}"
YAML

  run has_pr_ci

  [ "$status" -eq 1 ]
  [ "$output" = "NO_PR_CI" ]
}

@test "has-pr-ci: no workflows directory is NO_PR_CI" {
  run has_pr_ci

  [ "$status" -eq 1 ]
  [ "$output" = "NO_PR_CI" ]
}

@test "has-pr-ci: lists only the workflows that trigger on pull requests" {
  workflow cd.yml <<'YAML'
on:
  push:
    branches: [main]
YAML
  workflow ci.yml <<'YAML'
on:
  pull_request:
YAML

  run has_pr_ci

  [ "$status" -eq 0 ]
  [ "$output" = ".github/workflows/ci.yml" ]
}
