# Shared fixtures for the tests that run gh (`load gh-fixtures`): a fake gh on
# PATH that replays canned output from a scenario directory — see gh-shim/gh
# for the lookup rules. Canned scenarios live under tests/fixtures/gh/.

GH_SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-shim"

# gh_scenario DIR: gh replays DIR's fixtures. DIR is copied under $GH_SANDBOX
# (created on first use) so the shim's call counters never land in the
# checkout; $GH_SHIM_SCENARIO is the copy.
gh_scenario() {
  : "${GH_SANDBOX:=$(mktemp -d)}"
  GH_SHIM_SCENARIO="$GH_SANDBOX/$(basename "$1")"
  rm -rf "$GH_SHIM_SCENARIO"
  cp -R "$1" "$GH_SHIM_SCENARIO"
  export GH_SHIM_SCENARIO
  case ":$PATH:" in
    *":$GH_SHIM_DIR:"*) ;;
    *) PATH="$GH_SHIM_DIR:$PATH"; export PATH ;;
  esac
}

teardown_gh() {
  [ -n "${GH_SANDBOX:-}" ] || return 0
  rm -rf "$GH_SANDBOX"
}

# gh_calls KEY: how many times the shim served KEY in the current scenario
gh_calls() {
  cat "$GH_SHIM_SCENARIO/.calls/$1" 2>/dev/null || echo 0
}
