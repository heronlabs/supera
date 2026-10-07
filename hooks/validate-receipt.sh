#!/bin/sh
# SubagentStop hook: validates the receipt supera-engineer returns as its final
# message against schema/receipt.schema.json and, when it is missing or invalid,
# blocks the stop once so the engineer replies with a corrected receipt.
#
# Reads the hook event on stdin. Prints nothing when the receipt is valid, the
# agent is not supera-engineer, or the hook already blocked once
# (stop_hook_active); otherwise prints one {"decision":"block","reason":...}
# line. Always exits 0: a broken hook must never wedge the engineer, so a
# missing jq, schema or event is a silent no-op.
set -eu

command -v jq >/dev/null 2>&1 || exit 0

schema="${CLAUDE_PLUGIN_ROOT:-}/schema/receipt.schema.json"
[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -r "$schema" ] || exit 0

# The receipt is the last ```json fence of the message, else the whole message
# when it is a bare JSON object. Fences are read line by line: a fence opens on
# a ``` line of any language and closes on a bare ``` line, so a ```json line
# inside another fence is not a receipt. fromjson is never trusted to fail on
# blank text: older jq may return no output for it instead of an error. The
# schema is interpreted, not copied: only the keywords receipt.schema.json uses
# are understood, others are ignored.
# shellcheck disable=SC2016
program='
def json_fences:
  reduce (split("\n")[] | rtrimstr("\r")) as $line ({lang: null, body: [], found: []};
    if .lang == null then
      if ($line | test("^\\s*```")) then
        .lang = ($line | capture("^\\s*```\\s*(?<lang>[^\\s`]*)").lang) | .body = []
      else . end
    elif ($line | test("^\\s*```\\s*$")) then
      (if .lang == "json" then .found += [.body | join("\n")] else . end) | .lang = null
    else .body += [$line] end)
  | if .lang == "json" then .found + [.body | join("\n")] else .found end;

def where($path): if $path == "" then "receipt" else $path end;
def child($path; $key): if $path == "" then $key else "\($path).\($key)" end;

def problems($s; $path):
  . as $v
  | ([$s.type // empty] | flatten) as $want
  | if ($want | length) > 0 and (any($want[]; . == ($v | type)) | not) then
      ["\(where($path)) must be \($want | join(" or ")), got \($v | type)"]
    else
      (if $s.enum != null and (any($s.enum[]; . == $v) | not) then
         ["\(where($path)) is \($v | tojson), expected one of \($s.enum | map(tojson) | join(", "))"]
       else [] end)
      + (if ($v | type) == "string" and $s.minLength != null and ($v | length) < $s.minLength then
           ["\(where($path)) must have at least \($s.minLength) character(s)"]
         else [] end)
      + (if ($v | type) == "array" then
           (if $s.minItems != null and ($v | length) < $s.minItems then
              ["\(where($path)) must have at least \($s.minItems) item(s)"]
            else [] end)
           + (if $s.items != null then
                [range($v | length) as $i | $v[$i] | problems($s.items; "\(where($path))[\($i)]")[]]
              else [] end)
         else [] end)
      + (if ($v | type) == "object" then
           [($s.required // [])[] | select(. as $k | $v | has($k) | not)
             | "\(where($path)) is missing required key \(tojson)"]
           + (if $s.minProperties != null and ($v | length) < $s.minProperties then
                ["\(where($path)) must have at least \($s.minProperties) key(s)"]
              else [] end)
           + [$v | to_entries[] | .key as $k | .value
               | if ($s.properties // {}) | has($k) then problems($s.properties[$k]; child($path; $k))[]
                 elif $s.additionalProperties == false then "\(where($path)) has unexpected key \($k | tojson)"
                 elif ($s.additionalProperties | type) == "object" then problems($s.additionalProperties; child($path; $k))[]
                 else empty end]
         else [] end)
    end;

select(.agent_type == "supera:supera-engineer" and .stop_hook_active != true)
| .last_assistant_message
| select(type == "string")
| (json_fences | last) as $fence
| (if $fence != null and ($fence | test("^\\s*$")) then
     {lead: "The last ```json block is empty."}
   elif $fence != null then
     try {receipt: ($fence | fromjson)}
     catch {lead: "The last ```json block is not valid JSON (\(tostring | sub(" \\(while parsing[\\s\\S]*$"; "")))."}
   else
     ([try {receipt: fromjson} catch null] | .[0])
     | if (.receipt | type) == "object" then .
       else {lead: "No receipt found: the final message has no ```json block and is not a JSON object."} end
   end)
| (.lead // (.receipt | problems($schema[0]; "") | select(length > 0) | "Receipt check failed: \(join("; ")).")) as $lead
| {decision: "block",
   reason: "\($lead) Return a receipt matching \($schema_path) as the last fenced json block of your final message."}
'

out=$(jq -c --arg schema_path "$schema" --slurpfile schema "$schema" "$program" 2>/dev/null) || exit 0
if [ -n "$out" ]; then
  printf '%s\n' "$out"
fi
exit 0
