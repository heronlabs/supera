#!/usr/bin/env bats
# bats tests for scripts/changed-files.sh
#
# Runs the script in a clone of a throwaway bare remote and asserts on the
# paths it prints. No network.

load git-fixtures

setup() {
  setup_repo
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/changed-files.sh"
}

teardown() {
  teardown_repo
}

# changed [DIR]: runs the script from DIR (default: the clone's root)
changed() { in_dir "${1:-$REPO}" "$SCRIPT"; }

# sorted: $output, one path per line, sorted
sorted() { printf '%s\n' "$output" | sort; }

@test "clean worktree: prints nothing" {
  run changed

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "staged and unstaged changes: one path each" {
  printf 'b\n' >"$REPO/a.txt"
  printf 'new\n' >"$REPO/staged.txt"
  git -C "$REPO" add staged.txt

  run changed

  [ "$status" -eq 0 ]
  [ "$(sorted)" = "$(printf 'a.txt\nstaged.txt')" ]
}

@test "rename: lists both the old and the new path" {
  git -C "$REPO" mv a.txt b.txt

  run changed

  [ "$status" -eq 0 ]
  [ "$(sorted)" = "$(printf 'a.txt\nb.txt')" ]
}

@test "deletion: lists the deleted path" {
  rm "$REPO/a.txt"

  run changed

  [ "$status" -eq 0 ]
  [ "$output" = "a.txt" ]
}

@test "untracked nested directory: lists every file in it" {
  mkdir -p "$REPO/new/deep"
  printf 'x\n' >"$REPO/new/deep/x.txt"
  printf 'y\n' >"$REPO/new/y.txt"

  run changed

  [ "$status" -eq 0 ]
  [ "$(sorted)" = "$(printf 'new/deep/x.txt\nnew/y.txt')" ]
}

@test ".supera/ at the root is left out even when not ignored, a nested one is kept" {
  mkdir -p "$REPO/.supera" "$REPO/docs/.supera"
  printf 'plan\n' >"$REPO/.supera/plan.md"
  printf 'doc\n' >"$REPO/docs/.supera/kept.md"
  printf 'keep\n' >"$REPO/keep.txt"

  run changed

  [ "$status" -eq 0 ]
  [ "$(sorted)" = "$(printf 'docs/.supera/kept.md\nkeep.txt')" ]
}

@test "only .supera/ changed: prints nothing and succeeds" {
  mkdir -p "$REPO/.supera"
  printf 'plan\n' >"$REPO/.supera/plan.md"

  run changed

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "from a subdirectory: paths stay relative to the worktree root" {
  mkdir -p "$REPO/sub/dir"
  printf 'f\n' >"$REPO/sub/dir/f.txt"

  run changed "$REPO/sub/dir"

  [ "$status" -eq 0 ]
  [ "$output" = "sub/dir/f.txt" ]
}

@test "linked worktree: lists that worktree's changes only" {
  git -C "$REPO" worktree add -q "$REPO/.worktrees/feat-x" -b feat-x
  printf 'wt\n' >"$REPO/.worktrees/feat-x/wt.txt"

  run changed "$REPO/.worktrees/feat-x"

  [ "$status" -eq 0 ]
  [ "$output" = "wt.txt" ]
}

@test "outside a git repository: fails instead of printing an empty list" {
  mkdir "$SANDBOX/plain"

  run changed "$SANDBOX/plain"

  [ "$status" -ne 0 ]
}
