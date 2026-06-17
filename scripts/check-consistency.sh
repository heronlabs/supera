#!/usr/bin/env bash
# Consistency gate for the supera plugin repo.
# Enforces the CLAUDE.md "Core invariants" that are otherwise discipline-only.
# Scans skills/ + agents/ (every *.md), the schema, and the example/live configs.
#   1. plugin.json / marketplace.json versions match, are valid semver, names agree.
#   2. No raw ClickUp status string literals in a skill/agent (must use STATUS.<key>).
#   3. Every STATUS.<key> referenced is defined in schema clickup.statuses.
#   4. No references to removed skills (regression guard).
#   5. .claude/supera.json + examples/*.json validate against schema/supera.schema.json.
#   6. Every CONFIG.<path> a skill/agent reads resolves to a property in the schema.
#   7. Every property in the schema carries a description.
# Checks 5-7 need python3 + the `jsonschema` package; 1-4 are pure bash + jq.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

# Markdown surface the gate guards: every skill + agent body.
SCAN=(skills/ agents/)

# 1. Version sync + semver shape + plugin-name agreement
pv=$(jq -r '.version' .claude-plugin/plugin.json)
mv=$(jq -r '.plugins[0].version' .claude-plugin/marketplace.json)
pn=$(jq -r '.name' .claude-plugin/plugin.json)
mn=$(jq -r '.plugins[0].name' .claude-plugin/marketplace.json)
if [ "$pv" != "$mv" ]; then
  echo "FAIL(1): version mismatch — plugin.json=$pv marketplace.json=$mv"; fail=1
elif ! printf '%s' "$pv" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "FAIL(1): version '$pv' is not semver MAJOR.MINOR.PATCH"; fail=1
elif [ "$pn" != "$mn" ]; then
  echo "FAIL(1): plugin name mismatch — plugin.json=$pn marketplace.json=$mn"; fail=1
else
  echo "OK(1): versions match ($pv), valid semver, names agree ($pn)"
fi

# 2. No raw status literals in any skill/agent (status must flow through STATUS.<key>)
hits=$(grep -rnE 'status[[:space:]]*=[[:space:]]*"' "${SCAN[@]}" --include='*.md' || true)
if [ -n "$hits" ]; then
  echo "FAIL(2): raw status string literal — use STATUS.<key>:"; echo "$hits"; fail=1
else
  echo "OK(2): no raw status literals"
fi

# 3. Every STATUS.<key> referenced exists in the schema
schema_keys=$(jq -r '.properties.clickup.properties.statuses.properties | keys[]' schema/supera.schema.json | sort -u)
used_keys=$(grep -rhoE 'STATUS\.[a-zA-Z]+' "${SCAN[@]}" --include='*.md' | sed 's/STATUS\.//' | sort -u || true)
k3=0
for k in $used_keys; do
  if ! printf '%s\n' "$schema_keys" | grep -qx "$k"; then
    echo "FAIL(3): STATUS.$k used but not defined in schema clickup.statuses"; fail=1; k3=1
  fi
done
[ "$k3" -eq 0 ] && echo "OK(3): all STATUS.<key> references defined in schema"

# 4. No references to removed skills. Regression guard — extend when a skill is retired.
# `/ship pause` is legal: the slash precedes 'ship', never 'pause', so /pause won't match.
removed='resume|finish|pause|fast-ship'
dead=$(grep -rnE "/(${removed})" "${SCAN[@]}" --include='*.md' || true)
if [ -n "$dead" ]; then
  echo "FAIL(4): reference to a removed skill (/resume /finish /pause /fast-ship) — use /ship (or /ship pause):"
  echo "$dead"; fail=1
else
  echo "OK(4): no references to removed skills"
fi

# 5-7. Schema-aware checks (config validation, CONFIG-path resolution, doc completeness).
if ! python3 -c 'import jsonschema' 2>/dev/null; then
  echo "FAIL(5-7): python3 'jsonschema' not installed — run: python3 -m pip install jsonschema"; fail=1
else
  python3 - <<'PY' || fail=1
import glob, json, re, sys

schema = json.load(open('schema/supera.schema.json'))
import jsonschema
validator = jsonschema.Draft202012Validator(schema)
rc = 0

# 5. Live config + every example validate against the schema.
targets = [p for p in ['.claude/supera.json'] if glob.glob(p)] + sorted(glob.glob('examples/*.json'))
errs = []
for t in targets:
    for e in sorted(validator.iter_errors(json.load(open(t))), key=lambda e: list(e.path)):
        errs.append(f"  {t}: {'/'.join(map(str, e.path)) or '<root>'}: {e.message}")
if errs:
    print("FAIL(5): config fails schema validation:"); print("\n".join(errs)); rc = 1
else:
    print(f"OK(5): {len(targets)} config file(s) validate against schema")

# 6. Every CONFIG.<path> a skill/agent reads must resolve to a schema property.
def resolves(path):
    node = schema
    for seg in path:
        props = node.get('properties')
        if not props or seg not in props:
            return False
        node = props[seg]
    return True

token = re.compile(r'CONFIG([.?A-Za-z0-9_*]*)')
unknown = set()
for f in glob.glob('skills/**/*.md', recursive=True) + glob.glob('agents/*.md'):
    for m in token.finditer(open(f).read()):
        segs = []
        for seg in m.group(1).replace('?', '').split('.'):
            if not seg:        # trailing/leading dot from prose
                continue
            if seg == '*':     # wildcard stands in for "any leaf" — stop, prefix already checked
                break
            segs.append(seg)
        if segs and not resolves(segs):
            unknown.add('CONFIG.' + '.'.join(segs))
if unknown:
    print("FAIL(6): CONFIG path read by a skill/agent is absent from the schema:")
    for u in sorted(unknown):
        print(f"  {u}")
    rc = 1
else:
    print("OK(6): every CONFIG.<path> reference resolves in schema")

# 7. Every property in the schema is documented (CLAUDE.md invariant #7).
undocumented = []
def walk(node, path):
    for key, sub in (node.get('properties') or {}).items():
        p = path + [key]
        if 'description' not in sub:
            undocumented.append('.'.join(p))
        walk(sub, p)
    items = node.get('items')
    if isinstance(items, dict):
        walk(items, path + ['[]'])
walk(schema, [])
if undocumented:
    print("FAIL(7): schema property missing a description:")
    for u in undocumented:
        print(f"  {u}")
    rc = 1
else:
    print("OK(7): every schema property documented")

sys.exit(rc)
PY
fi

exit $fail
