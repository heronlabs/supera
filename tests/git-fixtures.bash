# Shared fixtures for the script tests (`load git-fixtures`): a bare remote with
# one commit on main and a clone of it, in a throwaway sandbox. Git runs without
# the user's or the system's config, so hooks, signing and aliases stay out.

# setup_repo -> $SANDBOX, $REMOTE_DIR (bare remote), $REPO (clone, on main)
setup_repo() {
  SANDBOX="$(cd "$(mktemp -d)" && pwd -P)"   # git reports /private/var, not /var
  REMOTE_DIR="$SANDBOX/remote.git"
  REPO="$SANDBOX/repo"
  : >"$SANDBOX/gitconfig"
  export GIT_CONFIG_GLOBAL="$SANDBOX/gitconfig" GIT_CONFIG_NOSYSTEM=1
  export GIT_AUTHOR_NAME=Supera GIT_AUTHOR_EMAIL=supera@example.com
  export GIT_COMMITTER_NAME=Supera GIT_COMMITTER_EMAIL=supera@example.com
  git init -q --bare -b main "$REMOTE_DIR"
  git clone -q "$REMOTE_DIR" "$REPO" 2>/dev/null
  commit_file "$REPO" a.txt a
  git -C "$REPO" push -q origin main
}

teardown_repo() {
  [ -n "${SANDBOX:-}" ] || return 0
  rm -rf "$SANDBOX"
}

# in_dir DIR CMD [ARG ...]: runs CMD from DIR, as the Bash tool would after a cd
in_dir() {
  local dir="$1"
  shift
  ( cd "$dir" && "$@" )
}

# has_no_ref DIR REF: succeeds when REF is absent from the repository at DIR.
# A bare `! cmd` line never fails a bats test, nor does a failing `[[ ]]` on
# bash 3.2 (macOS); a function returning non-zero does.
has_no_ref() {
  ! git -C "$1" show-ref --verify --quiet "$2"
}

# contains TEXT NEEDLE: succeeds when TEXT contains NEEDLE
contains() {
  case "$1" in
    *"$2"*) return 0 ;;
  esac
  echo "expected to contain: $2" >&2
  return 1
}

# commit_file DIR PATH CONTENT: writes CONTENT to PATH in the checkout DIR and commits it
commit_file() {
  mkdir -p "$(dirname "$1/$2")"
  printf '%s\n' "$3" >"$1/$2"
  git -C "$1" add "$2"
  git -C "$1" commit -qm "$2: $3"
}

# other_clone -> $SANDBOX/other: a second clone of the remote (a teammate, or GitHub)
other_clone() {
  [ -d "$SANDBOX/other" ] || git clone -q "$REMOTE_DIR" "$SANDBOX/other"
  git -C "$SANDBOX/other" fetch -q origin
}

# advance_main: the remote's main gets a commit the clone has not fetched yet
advance_main() {
  other_clone
  git -C "$SANDBOX/other" checkout -q main
  git -C "$SANDBOX/other" merge -q --ff-only origin/main
  commit_file "$SANDBOX/other" upstream.txt upstream
  git -C "$SANDBOX/other" push -q origin main
}

# push_branch BRANCH: BRANCH exists only on the remote, one commit ahead of main
push_branch() {
  other_clone
  git -C "$SANDBOX/other" checkout -q -b "$1" origin/main
  commit_file "$SANDBOX/other" "$1.txt" "$1"
  git -C "$SANDBOX/other" push -q origin "$1"
}

# squash_merge BRANCH: merges the remote's BRANCH into the remote's main as one
# new commit, the way GitHub squash-merges a PR — BRANCH stays unmerged locally
squash_merge() {
  other_clone
  git -C "$SANDBOX/other" checkout -q main
  git -C "$SANDBOX/other" merge -q --ff-only origin/main
  git -C "$SANDBOX/other" merge -q --squash "origin/$1" >/dev/null
  git -C "$SANDBOX/other" commit -qm "$1 (squash)"
  git -C "$SANDBOX/other" push -q origin main
}
