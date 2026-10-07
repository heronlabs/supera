#!/usr/bin/env bats
# shellcheck disable=SC2154 # $stderr is set by `run --separate-stderr`; shellcheck < 0.10 does not know
# bats tests for skills/ship/scripts/: detect-worktree.sh, exclude-supera.sh
# and create-worktree.sh
#
# Runs each script from the main checkout, its subdirectories and linked
# worktrees of a clone of a throwaway bare remote, and asserts on the output,
# the exit code and the worktrees and refs it leaves. No network.

bats_require_minimum_version 1.5.0

load git-fixtures

setup() {
  setup_repo
  SCRIPTS="$BATS_TEST_DIRNAME/../skills/ship/scripts"
}

teardown() {
  teardown_repo
}

detect() { in_dir "$1" "$SCRIPTS/detect-worktree.sh" main; }
exclude() { in_dir "$1" "$SCRIPTS/exclude-supera.sh"; }
create() { in_dir "$1" "$SCRIPTS/create-worktree.sh" .worktrees origin main "$2"; }

# ---------------------------------------------------------------- detect-worktree.sh

@test "detect-worktree: main checkout root is not a worktree" {
  run detect "$REPO"

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'IN_WORKTREE=false\nCUR=main')" ]
}

@test "detect-worktree: main checkout subdirectory is not a worktree" {
  mkdir -p "$REPO/sub/dir"

  run detect "$REPO/sub/dir"

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'IN_WORKTREE=false\nCUR=main')" ]
}

@test "detect-worktree: main checkout on a feature branch is not a worktree" {
  git -C "$REPO" checkout -q -b feat-x

  run detect "$REPO"

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'IN_WORKTREE=false\nCUR=feat-x')" ]
}

@test "detect-worktree: linked worktree root on a feature branch is a worktree" {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-x" -b feat-x

  run detect "$REPO/.worktrees/feat-x"

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'IN_WORKTREE=true\nCUR=feat-x')" ]
}

@test "detect-worktree: linked worktree subdirectory is a worktree" {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-x" -b feat-x
  mkdir -p "$REPO/.worktrees/feat-x/sub/dir"

  run detect "$REPO/.worktrees/feat-x/sub/dir"

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'IN_WORKTREE=true\nCUR=feat-x')" ]
}

@test "detect-worktree: detached linked worktree is not a worktree" {
  git -C "$REPO" worktree add -q --detach "$REPO/.worktrees/detached"

  run detect "$REPO/.worktrees/detached"

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'IN_WORKTREE=false\nCUR=')" ]
}

@test "detect-worktree: linked worktree on BASE is not a worktree" {
  git -C "$REPO" checkout -q -b other
  git -C "$REPO" worktree add -q "$REPO/.worktrees/main" main

  run detect "$REPO/.worktrees/main"

  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'IN_WORKTREE=false\nCUR=main')" ]
}

@test "detect-worktree: missing BASE fails with usage" {
  run in_dir "$REPO" "$SCRIPTS/detect-worktree.sh"

  [ "$status" -ne 0 ]
  contains "$output" "usage: detect-worktree.sh BASE"
}

# ---------------------------------------------------------------- exclude-supera.sh

@test "exclude-supera: run twice, .supera/ is listed once and ignored" {
  run exclude "$REPO"
  [ "$status" -eq 0 ]
  run exclude "$REPO"
  [ "$status" -eq 0 ]

  [ "$(grep -cxF '.supera/' "$REPO/.git/info/exclude")" -eq 1 ]
  mkdir "$REPO/.supera"
  printf 'plan\n' >"$REPO/.supera/plan.md"
  [ -z "$(git -C "$REPO" status --porcelain)" ]
}

@test "exclude-supera: from a linked worktree, writes the exclude file every worktree shares" {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-x" -b feat-x

  run exclude "$REPO/.worktrees/feat-x"

  [ "$status" -eq 0 ]
  grep -qxF '.supera/' "$REPO/.git/info/exclude"
  [ ! -e "$REPO/.git/worktrees/feat-x/info/exclude" ]
  git -C "$REPO/.worktrees/feat-x" check-ignore -q .supera/plan.md
  git -C "$REPO" check-ignore -q .supera/plan.md
}

@test "exclude-supera: never creates or edits .gitignore" {
  run exclude "$REPO"
  [ "$status" -eq 0 ]
  [ ! -e "$REPO/.gitignore" ]

  commit_file "$REPO" .gitignore node_modules/
  run exclude "$REPO"

  [ "$status" -eq 0 ]
  [ "$(cat "$REPO/.gitignore")" = "node_modules/" ]
  [ -z "$(git -C "$REPO" status --porcelain)" ]
}

@test "exclude-supera: creates info/ when it is missing" {
  rm -rf "$REPO/.git/info"

  run exclude "$REPO"

  [ "$status" -eq 0 ]
  [ "$(grep -cxF '.supera/' "$REPO/.git/info/exclude")" -eq 1 ]
}

# ---------------------------------------------------------------- create-worktree.sh

@test "create-worktree: new branch from a subdirectory lands in the main checkout's .worktrees/, off REMOTE/BASE" {
  mkdir -p "$REPO/sub/dir"
  advance_main

  run --separate-stderr create "$REPO/sub/dir" feat-new

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-new" ]
  [ "$(git -C "$output" branch --show-current)" = "feat-new" ]
  [ "$(git -C "$output" rev-parse HEAD)" = "$(git -C "$REMOTE_DIR" rev-parse main)" ]
  [ ! -e "$REPO/sub/dir/.worktrees" ]
}

@test "create-worktree: from a detached linked worktree, still lands in the main checkout's .worktrees/" {
  git -C "$REPO" worktree add -q --detach "$REPO/.worktrees/detached"

  run --separate-stderr create "$REPO/.worktrees/detached" feat-new

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-new" ]
  [ ! -e "$REPO/.worktrees/detached/.worktrees" ]
}

@test "create-worktree: an existing local branch is reused, not reset to BASE" {
  git -C "$REPO" checkout -q -b feat-local
  commit_file "$REPO" local.txt local
  git -C "$REPO" checkout -q main
  local tip
  tip="$(git -C "$REPO" rev-parse feat-local)"

  run --separate-stderr create "$REPO" feat-local

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-local" ]
  [ "$(git -C "$output" rev-parse HEAD)" = "$tip" ]
  contains "$stderr" "Branch feat-local already exists locally — reusing."
}

@test "create-worktree: a re-run reuses the worktree as it is" {
  run --separate-stderr create "$REPO" feat-x
  [ "$status" -eq 0 ]
  printf 'work in progress\n' >"$REPO/.worktrees/feat-x/wip.txt"

  run --separate-stderr create "$REPO" feat-x

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-x" ]
  [ "$(cat "$REPO/.worktrees/feat-x/wip.txt")" = "work in progress" ]
}

@test "create-worktree: a branch that only exists on the remote is fetched and tracked" {
  push_branch feat-remote

  run --separate-stderr create "$REPO" feat-remote

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-remote" ]
  [ "$(git -C "$output" rev-parse HEAD)" = "$(git -C "$REMOTE_DIR" rev-parse feat-remote)" ]
  [ "$(git -C "$REPO" for-each-ref --format='%(upstream)' refs/heads/feat-remote)" = "refs/remotes/origin/feat-remote" ]
  contains "$stderr" "Branch feat-remote exists on origin — fetching."
}

@test "create-worktree: a stale registered worktree at the path, with no branch anywhere, is recreated" {
  git -C "$REPO" worktree add -q --detach "$REPO/.worktrees/feat-stale"
  printf 'crash leftover\n' >"$REPO/.worktrees/feat-stale/leftover.txt"

  run --separate-stderr create "$REPO" feat-stale

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-stale" ]
  [ "$(git -C "$output" branch --show-current)" = "feat-stale" ]
  [ ! -e "$output/leftover.txt" ]
}

@test "create-worktree: prune clears the registration of a deleted worktree directory" {
  run --separate-stderr create "$REPO" feat-gone
  [ "$status" -eq 0 ]
  rm -rf "$REPO/.worktrees/feat-gone"

  run --separate-stderr create "$REPO" feat-gone

  [ "$status" -eq 0 ]
  [ "$output" = "$REPO/.worktrees/feat-gone" ]
  [ "$(git -C "$output" branch --show-current)" = "feat-gone" ]
}

@test "create-worktree: a leftover plain directory at the path is reported and kept" {
  mkdir -p "$REPO/.worktrees/feat-plain"
  printf 'keep\n' >"$REPO/.worktrees/feat-plain/keep.txt"

  run --separate-stderr create "$REPO" feat-plain

  [ "$status" -ne 0 ]
  contains "$stderr" "already exists"
  [ "$(cat "$REPO/.worktrees/feat-plain/keep.txt")" = "keep" ]
}

@test "create-worktree: a leftover plain directory is reported and kept when the branch exists locally" {
  git -C "$REPO" branch feat-plain
  mkdir -p "$REPO/.worktrees/feat-plain"
  printf 'keep\n' >"$REPO/.worktrees/feat-plain/keep.txt"

  run --separate-stderr create "$REPO" feat-plain

  [ "$status" -ne 0 ]
  contains "$stderr" "already exists"
  [ "$(cat "$REPO/.worktrees/feat-plain/keep.txt")" = "keep" ]
}

@test "create-worktree: a branch checked out in the main checkout is reported" {
  git -C "$REPO" checkout -q -b feat-main

  run --separate-stderr create "$REPO" feat-main

  [ "$status" -ne 0 ]
  [ -z "$output" ]
  contains "$stderr" "Branch feat-main is not checked out in a linked worktree"
}
