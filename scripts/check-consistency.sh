#!/usr/bin/env bash
# Consistency gate for the supera plugin repo.
# Enforces the CLAUDE.md invariants that were previously discipline-only.
# Scans BOTH skills/ and agents/ (every *.md) so a status literal or dead
# reference can't slip in through an agent file or supera-init's emitted config:
#   1. plugin.json and marketplace.json versions match.
#   2. No raw ClickUp status string literals in a skill/agent (must use STATUS.<key>).
#   3. Every STATUS.<key> referenced exists in schema clickup.statuses.
#   4. No references to deleted skills (/resume, /finish, /pause) remain.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

# Markdown surface the gate guards: every skill + agent body.
SCAN=(skills/ agents/)

# 1. Version sync
pv=$(jq -r '.version' .claude-plugin/plugin.json)
mv=$(jq -r '.plugins[0].version' .claude-plugin/marketplace.json)
if [ "$pv" != "$mv" ]; then
  echo "FAIL(1): version mismatch — plugin.json=$pv marketplace.json=$mv"
  fail=1
else
  echo "OK(1): versions match ($pv)"
fi

# 2. No raw status literals in any skill/agent
hits=$(grep -rnE 'status[[:space:]]*=[[:space:]]*"' "${SCAN[@]}" --include='*.md' || true)
if [ -n "$hits" ]; then
  echo "FAIL(2): raw status string literal — use STATUS.<key>:"
  echo "$hits"
  fail=1
else
  echo "OK(2): no raw status literals"
fi

# 3. Every STATUS.<key> referenced exists in the schema
schema_keys=$(jq -r '.properties.clickup.properties.statuses.properties | keys[]' schema/supera.schema.json | sort -u)
used_keys=$(grep -rhoE 'STATUS\.[a-zA-Z]+' "${SCAN[@]}" --include='*.md' | sed 's/STATUS\.//' | sort -u || true)
k3=0
for k in $used_keys; do
  if ! echo "$schema_keys" | grep -qx "$k"; then
    echo "FAIL(3): STATUS.$k used but not defined in schema clickup.statuses"
    fail=1; k3=1
  fi
done
[ "$k3" -eq 0 ] && echo "OK(3): all STATUS.<key> references defined in schema"

# 4. No dead-skill references (/ship pause is allowed — the slash precedes 'ship', not 'pause')
dead=$(grep -rnE '/(resume|finish|pause)' "${SCAN[@]}" --include='*.md' || true)
if [ -n "$dead" ]; then
  echo "FAIL(4): reference to a deleted skill (/resume, /finish, /pause) — use /ship (or /ship pause):"
  echo "$dead"
  fail=1
else
  echo "OK(4): no dead-skill references"
fi

exit $fail
