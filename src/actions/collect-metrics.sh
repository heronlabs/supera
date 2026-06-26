#!/usr/bin/env bash
set -euo pipefail

# Collects metrics-* artifacts from a repo's workflow runs
# Usage: REPO=heronlabs/supera bash src/actions/collect-metrics.sh

REPO="${REPO:?REPO environment variable is required}"

mkdir -p collected
runs=$(gh run list -R "$REPO" --limit 80 --json databaseId -q '.[].databaseId' 2>/dev/null || true)
for run in $runs; do
  gh run download -R "$REPO" "$run" -p 'metrics-*' -D "collected/$run" 2>/dev/null || true
done
found=$(find collected -name metrics-event.json | wc -l | tr -d ' ')
echo "Collected $found metrics event(s) from $REPO."
