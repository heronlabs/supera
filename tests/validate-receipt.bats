#!/usr/bin/env bats
# bats tests for hooks/validate-receipt.sh
#
# Each fixture under tests/fixtures/receipt/ is a final message of
# supera-engineer. The tests wrap one into a SubagentStop event, run the hook
# with it on stdin and CLAUDE_PLUGIN_ROOT at the repo, and assert on the exit
# code and stdout: nothing for a valid receipt or a no-op, one
# {"decision":"block"} line otherwise. The real jq does the work, so the tests
# skip where it is missing.

setup() {
  if ! command -v jq >/dev/null; then
    skip "needs jq"
  fi

  PLUGIN_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  HOOK="$PLUGIN_ROOT/hooks/validate-receipt.sh"
  SCHEMA="$PLUGIN_ROOT/schema/receipt.schema.json"
  FIXTURES="$BATS_TEST_DIRNAME/fixtures/receipt"
  SANDBOX="$(mktemp -d)"
  TRAILER="Return a receipt matching $SCHEMA as the last fenced json block of your final message."
}

teardown() {
  [ -n "${SANDBOX:-}" ] || return 0
  rm -rf "$SANDBOX"
}

# event FIXTURE [AGENT_TYPE] [STOP_HOOK_ACTIVE] -> $SANDBOX/event.json, the
# SubagentStop event whose last_assistant_message is the fixture's text.
event() {
  jq -n --rawfile message "$FIXTURES/$1" \
    --arg agent_type "${2:-supera:supera-engineer}" --argjson active "${3:-false}" \
    '{session_id: "session-fixture", transcript_path: "/tmp/transcript.jsonl", cwd: "/tmp",
      agent_id: "agent-fixture", agent_type: $agent_type, hook_event_name: "SubagentStop",
      stop_hook_active: $active, agent_transcript_path: "/tmp/agent.jsonl",
      last_assistant_message: $message}' >"$SANDBOX/event.json"
}

# Run the hook with $SANDBOX/event.json on stdin.
# Usage: run_hook [VAR=value ...]  (later assignments override the defaults)
# Sets EXIT_CODE; stdout/stderr land in $SANDBOX/stdout and $SANDBOX/stderr.
run_hook() {
  set +e
  env CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$@" "$HOOK" \
    <"$SANDBOX/event.json" >"$SANDBOX/stdout" 2>"$SANDBOX/stderr"
  EXIT_CODE=$?
  set -e
}

# The hook blocked: exit 0, one line of JSON, and a reason ending in the trailer.
assert_block() {
  [ "$EXIT_CODE" -eq 0 ]
  [ "$(wc -l <"$SANDBOX/stdout")" -eq 1 ]
  jq -e '.decision == "block" and (.reason | type == "string")' "$SANDBOX/stdout" >/dev/null
  [ "$(jq -r '.reason' "$SANDBOX/stdout" | sed 's/.*\. Return a receipt/Return a receipt/')" = "$TRAILER" ]
}

# The hook let the engineer stop: exit 0, no output.
assert_pass() {
  [ "$EXIT_CODE" -eq 0 ]
  [ ! -s "$SANDBOX/stdout" ]
}

reason() { jq -r '.reason' "$SANDBOX/stdout"; }

# ---------------------------------------------------------------- tests

@test "valid receipt in a fence surrounded by prose: passes" {
  event valid-fenced.md

  run_hook

  assert_pass
}

@test "valid bare JSON message: passes" {
  event valid-bare.json

  run_hook

  assert_pass
}

@test "two json fences, last one valid: passes" {
  event two-fences-last-valid.md

  run_hook

  assert_pass
}

@test "two json fences, last one invalid: blocks on the last one" {
  event two-fences-last-invalid.md

  run_hook

  assert_block
  [ "$(reason)" = "Receipt check failed: verification.unit is \"ok\", expected one of \"pass\", \"fail\", \"skipped\". $TRAILER" ]
}

@test "missing filesChanged: blocks naming the key" {
  event missing-files-changed.md

  run_hook

  assert_block
  [ "$(reason)" = "Receipt check failed: receipt is missing required key \"filesChanged\". $TRAILER" ]
}

@test "empty summary: blocks on its minLength" {
  event empty-summary.md

  run_hook

  assert_block
  [ "$(reason)" = "Receipt check failed: summary must have at least 1 character(s). $TRAILER" ]
}

@test "verification value ok: blocks with the allowed values" {
  event verification-ok.md

  run_hook

  assert_block
  [ "$(reason)" = "Receipt check failed: verification.unit is \"ok\", expected one of \"pass\", \"fail\", \"skipped\". $TRAILER" ]
}

@test "extra top-level key: blocks naming the key" {
  event extra-key.md

  run_hook

  assert_block
  [ "$(reason)" = "Receipt check failed: receipt has unexpected key \"status\". $TRAILER" ]
}

@test "filesChanged not an array: blocks on its type" {
  event files-changed-not-array.md

  run_hook

  assert_block
  [ "$(reason)" = "Receipt check failed: filesChanged must be array, got string. $TRAILER" ]
}

@test "several problems: every one is listed in a single reason" {
  event several-problems.md

  run_hook

  assert_block
  reason | grep -qF 'summary must have at least 1 character(s)'
  reason | grep -qF 'filesChanged[0] must be string, got number'
  reason | grep -qF 'verification.unit is "ok"'
  reason | grep -qF 'receipt has unexpected key "status"'
}

@test "no JSON at all: blocks as no receipt found" {
  event no-json.md

  run_hook

  assert_block
  [ "$(reason)" = "No receipt found: the final message has no \`\`\`json block and is not a JSON object. $TRAILER" ]
}

@test "malformed JSON in the fence: blocks as not valid JSON" {
  event malformed.md

  run_hook

  assert_block
  reason | grep -qF 'The last ```json block is not valid JSON ('
}

@test "empty json fence: blocks as empty, a later non-json fence is not the receipt" {
  event empty-fence.md

  run_hook

  assert_block
  [ "$(reason)" = "The last \`\`\`json block is empty. $TRAILER" ]
}

@test "schema is the source of truth: a schema that allows ok accepts it" {
  mkdir -p "$SANDBOX/plugin/schema"
  jq '.properties.verification.additionalProperties.enum += ["ok"]' "$SCHEMA" \
    >"$SANDBOX/plugin/schema/receipt.schema.json"
  event verification-ok.md

  run_hook CLAUDE_PLUGIN_ROOT="$SANDBOX/plugin"

  assert_pass
}

@test "stop_hook_active true: an invalid receipt is let through, no retry loop" {
  event no-json.md supera:supera-engineer true

  run_hook

  assert_pass
}

@test "other agent_type: an invalid receipt is ignored" {
  event no-json.md general-purpose

  run_hook

  assert_pass
}

@test "jq absent: exits 0 with no output" {
  mkdir "$SANDBOX/empty-bin"
  [ -z "$(PATH="$SANDBOX/empty-bin" command -v jq)" ]
  event no-json.md

  run_hook PATH="$SANDBOX/empty-bin"

  assert_pass
}

@test "CLAUDE_PLUGIN_ROOT empty: exits 0 with no output" {
  event no-json.md

  run_hook CLAUDE_PLUGIN_ROOT=

  assert_pass
}

@test "malformed event on stdin: exits 0 with no output" {
  printf 'not json\n' >"$SANDBOX/event.json"

  run_hook

  assert_pass
}

@test "event without last_assistant_message: exits 0 with no output" {
  printf '{"agent_type": "supera:supera-engineer", "stop_hook_active": false}\n' >"$SANDBOX/event.json"

  run_hook

  assert_pass
}

@test "output: one line of valid block JSON for every fixture that blocks" {
  local fixture blocked=0
  for fixture in "$FIXTURES"/*; do
    event "$(basename "$fixture")"
    run_hook
    [ "$EXIT_CODE" -eq 0 ]
    if [ -s "$SANDBOX/stdout" ]; then
      assert_block
      blocked=$((blocked + 1))
    fi
  done
  [ "$blocked" -ge 10 ]
}
