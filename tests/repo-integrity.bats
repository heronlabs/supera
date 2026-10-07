#!/usr/bin/env bats
# Static checks on the plugin's own content. Claude Code substitutes
# ${CLAUDE_SKILL_DIR} (skills only) and ${CLAUDE_PLUGIN_ROOT} (skills and
# agents) inline, and replaces every `$` + digit token with a skill argument,
# so a broken path or a stray token only shows up when a skill runs elsewhere.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

# refs VAR FILE: the paths after ${VAR}/ in FILE, one per line, trailing punctuation dropped
refs() {
  grep -oE "[$]\\{$1\\}/[^]\`\"'[:space:])]+" "$2" | sed -E "s|^[$][{]$1[}]/||; s/[.,;:]+\$//" || :
}

# check_refs VAR BASE FILE: every ${VAR}/ path in FILE exists under BASE, scripts executable.
# Prints the number of paths checked.
check_refs() {
  local path count=0
  for path in $(refs "$1" "$3"); do
    [ -e "$2/$path" ] || { echo "$3: \${$1}/$path does not exist" >&2; return 1; }
    case "$path" in
      *.sh) [ -x "$2/$path" ] || { echo "$3: \${$1}/$path is not executable" >&2; return 1; } ;;
    esac
    count=$((count + 1))
  done
  echo "$count"
}

@test "every CLAUDE_SKILL_DIR path in a SKILL.md exists, and its scripts are executable" {
  local file count total=0
  for file in "$ROOT"/skills/*/SKILL.md; do
    count="$(check_refs CLAUDE_SKILL_DIR "$(dirname "$file")" "$file")"
    total=$((total + count))
  done
  [ "$total" -gt 0 ]
}

@test "every CLAUDE_PLUGIN_ROOT path in a SKILL.md or agent exists, and its scripts are executable" {
  local file count total=0
  for file in "$ROOT"/skills/*/SKILL.md "$ROOT"/agents/*.md; do
    count="$(check_refs CLAUDE_PLUGIN_ROOT "$ROOT" "$file")"
    total=$((total + count))
  done
  [ "$total" -gt 0 ]
}

@test "agents never use CLAUDE_SKILL_DIR — it is only substituted in skills" {
  run grep -l 'CLAUDE_SKILL_DIR' "$ROOT"/agents/*.md

  [ "$status" -eq 1 ]
}

@test "no SKILL.md or agent contains a dollar-digit token" {
  run grep -nE '[$][0-9]' "$ROOT"/skills/*/SKILL.md "$ROOT"/agents/*.md

  [ "$status" -eq 1 ]
}

@test "every bundled script is executable" {
  local script
  for script in "$ROOT"/scripts/*.sh "$ROOT"/skills/*/scripts/*.sh; do
    [ -x "$script" ] || { echo "$script is not executable" >&2; return 1; }
  done
}

@test "no bundled script deletes a directory with rm -r" {
  run grep -nE '(^|[[:space:];&|(])rm[[:space:]]+-[[:alnum:]]*[rR]' "$ROOT"/scripts/*.sh "$ROOT"/skills/*/scripts/*.sh

  [ "$status" -eq 1 ]
}
