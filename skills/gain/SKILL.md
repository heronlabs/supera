---
name: gain
description: "Show your own supera telemetry: read the local ~/.supera/events.jsonl the SessionEnd hook captures and print a per-skill dashboard of cost, turns, retries, and success rate — compared against the fleet median when the metrics branch is reachable. Local-only; your runs land on the fleet only with SUPERA_METRICS=1. Triggers: 'supera gain', 'my supera stats', 'show my telemetry'."
allowed-tools: Bash, Read  # also requires the gh CLI for the optional fleet comparison
---

Print **your own** supera usage dashboard from the local telemetry the SessionEnd hook records. Every supera skill run on this machine leaves a privacy-safe `metrics-event` in `~/.supera/events.jsonl` (counts, tokens, cost — never code, paths, or prompts); `/gain` rolls those up per skill so you can see what your runs actually cost and how often they retry. Nothing leaves your machine here — the fleet comparison is read-only, and your runs only join the fleet when you opt in with `SUPERA_METRICS=1`.

## 0 — Locate the data

The local event log is `~/.supera/events.jsonl` (one `metrics-event` JSON per line). If it does not exist or is empty, tell the user *"No local supera runs recorded yet — run /supera:ship, /supera:pr-watch, or /supera:audit and they'll show up here."* and stop. There is no config to read; the path is fixed convention, not repo-specific.

## 1 — Render the dashboard

Reuse the rollup helpers rather than re-deriving the math — `src/metrics/metrics-rollup.ts` already exports `summarize`, `renderDashboard`, and `percentile`, the same code the daily fleet rollup uses, so the local and fleet views stay consistent. Run them over the local events via the plugin's `jiti`:

```bash
LOCAL=~/.supera/events.jsonl
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON -e '
  const {renderDashboard, summarize, percentile} = await import("${CLAUDE_PLUGIN_ROOT}/src/metrics/metrics-rollup.ts");
  const fs = await import("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").map(l=>l.trim()).filter(Boolean).map(l=>JSON.parse(l));
  process.stdout.write(renderDashboard(lines, new Date().toISOString()));
' "$LOCAL"
```

The dashboard is the per-skill table `summarize`/`renderDashboard` already produce: runs, success rate, cost p50/p95, turns p50/p95, duration p50/p95, plus any cost regressions. Print it verbatim — don't reformat or editorialize.

## 2 — Fleet comparison (optional, read-only)

If `gh` is authenticated and the repo publishes a `metrics` branch, fetch the fleet's rolled-up `metrics/events.jsonl` and show the dev's per-skill cost p50 next to the fleet's, so they can see whether their runs are above or below the median. This is **read-only** — `/gain` never writes the fleet branch (only the opt-in `SUPERA_METRICS=1` SessionEnd push does):

```bash
gh api repos/{owner}/{repo}/contents/metrics/events.jsonl?ref=metrics -q '.content' 2>/dev/null | base64 -d > /tmp/supera-fleet-events.jsonl || true
```

If the fetch succeeds and is non-empty, run `summarize` over both event sets and, per skill, print one line: `<skill>: your cost p50 $X vs fleet $Y`. Use `percentile` for any extra cut you want. If the branch is unreachable or `gh` isn't authenticated, **skip silently** — the local dashboard is the whole point; the fleet line is a bonus.

## Rules

- Read-only. `/gain` never writes `events.jsonl` or the `metrics` branch — the SessionEnd hook owns local capture, and the opt-in `SUPERA_METRICS=1` push owns the fleet write.
- Local-only by default. A dev's runs reach the fleet only when they set `SUPERA_METRICS=1` (see the hook); `/gain` itself sends nothing.
- Reuse `src/metrics/metrics-rollup.ts` helpers — don't re-implement percentiles or the dashboard.
