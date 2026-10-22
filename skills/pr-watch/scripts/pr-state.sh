#!/bin/sh
# Usage: pr-state.sh PR
# Run from the worktree root. One call gathers what a pr-watch tick needs and
# prints key=value lines, in this order:
#   state headSha mergeStateStatus mergeable reviewDecision
#   checksTotal checksSuccess checksFailure checksPending checksSkipped
#   failing            failing checks as name:runId, comma-separated (an
#                      external status has an empty run id); may be empty
#   queuedOver10m      workflows queued for more than 10 min, comma-separated
#   queuedSelfHosted   true when a runs-on of those workflows (inline value,
#                      list item, or labels:/group: under a bare runs-on) is
#                      not ubuntu-*/windows-*/macos-*; ${{ }} expressions are
#                      skipped
#   unresolvedThreads  root review comments (REST exposes no resolution state)
#   hasPrCi            true|false from the sibling has-pr-ci.sh
#   lastActivityAgeSec seconds since the later of createdAt and the head's
#                      commit date
# Three gh calls: pr view, run list, api (review comments). Exits 1 with
# `pr-state: gh failed: <subcommand>` on stderr when one fails. Needs jq.
set -eu

pr=${1:?usage: pr-state.sh PR}

# run_gh LABEL ARGS...: gh's stdout, or the failure message and exit 1
run_gh() {
  label=$1
  shift
  gh "$@" || {
    echo "pr-state: gh failed: $label" >&2
    exit 1
  }
}

view=$(run_gh 'pr view' pr view "$pr" --json state,headRefOid,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,createdAt,commits)
sha=$(printf '%s' "$view" | jq -r '.headRefOid // ""')
queued=$(run_gh 'run list' run list --commit "$sha" --status queued --json workflowName,createdAt)
comments=$(run_gh api api "repos/{owner}/{repo}/pulls/$pr/comments" --paginate)

printf '%s' "$view" | jq -r '
  def kind:
    if .__typename == "StatusContext" then .state
    elif .status == "COMPLETED" then .conclusion
    else "PENDING" end;
  def bucket:
    kind as $k
    | if $k == "SUCCESS" then "success"
      elif $k == "SKIPPED" or $k == "NEUTRAL" then "skipped"
      elif $k == "FAILURE" or $k == "ERROR" or $k == "CANCELLED" or $k == "TIMED_OUT"
           or $k == "ACTION_REQUIRED" or $k == "STARTUP_FAILURE" or $k == "STALE" then "failure"
      else "pending" end;
  def run_id: if .__typename == "StatusContext" then "" else ((.detailsUrl // "") | capture("/actions/runs/(?<id>[0-9]+)") | .id) // "" end;
  (.statusCheckRollup // []) as $checks
  | def count($b): [$checks[] | select(bucket == $b)] | length;
    "state=\(.state // "")",
    "headSha=\(.headRefOid // "")",
    "mergeStateStatus=\(.mergeStateStatus // "")",
    "mergeable=\(.mergeable // "")",
    "reviewDecision=\(.reviewDecision // "")",
    "checksTotal=\($checks | length)",
    "checksSuccess=\(count("success"))",
    "checksFailure=\(count("failure"))",
    "checksPending=\(count("pending"))",
    "checksSkipped=\(count("skipped"))",
    "failing=\([$checks[] | select(bucket == "failure") | "\(.name // .context // ""):\(run_id)"] | join(","))"
'

queued_names=$(printf '%s' "$queued" | jq -r '
  [.[] | select(now - (.createdAt | fromdateiso8601) > 600) | .workflowName] | unique | join(",")')
echo "queuedOver10m=$queued_names"

# workflow_named NAME: the workflow files whose top-level name: is NAME, else
# NAME itself when it is the file path GitHub uses for a nameless workflow
workflow_named() {
  for file in .github/workflows/*.yml .github/workflows/*.yaml; do
    [ -f "$file" ] || continue
    awk -v name="$1" -v sq="'" '
      /^name:/ {
        v = $0; sub(/^name:[ \t]*/, "", v); sub(/[ \t]+#.*$/, "", v); sub(/[ \t]+$/, "", v)
        if (substr(v, 1, 1) == "\"" || substr(v, 1, 1) == sq) v = substr(v, 2, length(v) - 2)
        if (v == name) found = 1
      }
      END { exit !found }' "$file" && printf '%s\n' "$file"
  done
  [ ! -f "$1" ] || printf '%s\n' "$1"
}

# self_hosted FILE...: succeeds when a runs-on in FILE... is not GitHub-hosted
self_hosted() {
  awk -v sq="'" '
    function check(v,  s, e, n, i, parts) {
      while ((s = index(v, "${{")) > 0) {
        e = index(substr(v, s), "}}")
        if (e == 0) { v = substr(v, 1, s - 1); break }
        v = substr(v, 1, s - 1) " " substr(v, s + e + 1)
      }
      sub(/[ \t]#.*$/, "", v)
      gsub(/[][,"]/, " ", v)
      gsub(sq, " ", v)
      n = split(v, parts, /[ \t]+/)
      for (i = 1; i <= n; i++) {
        if (parts[i] == "") continue
        if (parts[i] !~ /^(ubuntu|windows|macos)-/) other = 1
      }
    }
    /^[ \t]*runs-on:/ {
      v = $0; sub(/^[ \t]*runs-on:[ \t]*/, "", v); sub(/[ \t]*#.*$/, "", v)
      if (v == "") { block = 1; next }
      check(v); next
    }
    block && /^[ \t]*-[ \t]/ { v = $0; sub(/^[ \t]*-[ \t]*/, "", v); check(v); next }
    block && /^[ \t]*(labels|group):/ { v = $0; sub(/^[ \t]*(labels|group):[ \t]*/, "", v); check(v); next }
    block && /^[ \t]*$/ { next }
    { block = 0 }
    END { exit !other }' "$@"
}

queued_self_hosted=false
if [ -n "$queued_names" ]; then
  old_ifs=$IFS
  IFS=,
  for name in $queued_names; do
    IFS=$old_ifs
    files=$(workflow_named "$name")
    if [ -n "$files" ]; then
      # shellcheck disable=SC2086 # one path per line, split on purpose
      if self_hosted $files; then queued_self_hosted=true; fi
    fi
  done
  IFS=$old_ifs
fi
echo "queuedSelfHosted=$queued_self_hosted"

printf '%s' "$comments" | jq -rs '"unresolvedThreads=\([.[][] | select(.in_reply_to_id == null)] | length)"'

if "$(dirname "$0")/has-pr-ci.sh" >/dev/null 2>&1; then
  echo "hasPrCi=true"
else
  echo "hasPrCi=false"
fi

printf '%s' "$view" | jq -r '
  ([.createdAt, ((.commits // []) | last | .committedDate)] | map(select(. != null) | fromdateiso8601) | max) as $t
  | "lastActivityAgeSec=\((now - ($t // now)) | floor)"'
