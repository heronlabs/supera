#!/usr/bin/env bats

setup() {
  TEST_DIR=$(mktemp -d)
  ORIG_DIR="$PWD"
  cd "$TEST_DIR" || exit 1

  # Create a mock gh CLI script on PATH
  MOCK_DIR=$(mktemp -d)
  export PATH="$MOCK_DIR:$PATH"
}

teardown() {
  cd "$ORIG_DIR" || exit 1
  rm -rf "$TEST_DIR" "$MOCK_DIR"
}

@test "collects metrics artifacts from a repo" {
  cat >"$MOCK_DIR/gh" <<'SCRIPT'
#!/usr/bin/env bash
case "$*" in
  "run list -R heronlabs/test-repo --limit 80 --json databaseId -q .[].databaseId")
    printf "10\n20\n"
    ;;
  "run download -R heronlabs/test-repo 10 -p metrics-* -D collected/10")
    mkdir -p collected/10
    : >collected/10/metrics-event.json
    ;;
  "run download -R heronlabs/test-repo 20 -p metrics-* -D collected/20")
    mkdir -p collected/20
    : >collected/20/metrics-event.json
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 1
    ;;
esac
SCRIPT
  chmod +x "$MOCK_DIR/gh"

  export REPO=heronlabs/test-repo
  bash "$ORIG_DIR/src/actions/collect-metrics.sh"
  [ -d collected/10 ]
  [ -d collected/20 ]
  [ -f collected/10/metrics-event.json ]
  [ -f collected/20/metrics-event.json ]
}

@test "handles repos with no runs" {
  cat >"$MOCK_DIR/gh" <<'SCRIPT'
#!/usr/bin/env bash
case "$*" in
  "run list -R heronlabs/test-repo --limit 80 --json databaseId -q .[].databaseId")
    printf ""
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 1
    ;;
esac
SCRIPT
  chmod +x "$MOCK_DIR/gh"

  export REPO=heronlabs/test-repo
  run bash "$ORIG_DIR/src/actions/collect-metrics.sh"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "Collected 0"
}

@test "handles gh CLI failure gracefully" {
  cat >"$MOCK_DIR/gh" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
  chmod +x "$MOCK_DIR/gh"

  export REPO=heronlabs/test-repo
  run bash "$ORIG_DIR/src/actions/collect-metrics.sh"
  [ "$status" -eq 0 ]
}
