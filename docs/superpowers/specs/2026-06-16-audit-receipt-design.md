# Audit receipt — design

## Problem

`supera-engineer` emits a structured receipt (`schema/receipt.schema.json`) so `/ship` and
`/pr-watch` branch on `status` instead of scraping prose. The two auditor agents
(`supera-supply-chain-auditor`, `supera-freshness-auditor`) have **no output contract** — they
emit a prose two-list report ("Applied autonomously" / "Needs your call"), and `/audit` builds
its PR body by *relaying that prose*. That reintroduces the exact prose-scraping the receipt was
built to kill, and leaves a headless cron with no structured signal when something is unfixable.

## Goal (scoped)

Give the auditors a structured receipt so `/audit`:

1. **Renders the PR body / report from data** — no prose relay.
2. **Has a headless signal** — a shared `status` enum + `flag` findings the cron can surface.

Explicitly **out of scope** (YAGNI, cheap to add later with no schema change): per-finding inline
PR review comments, and merge-gating on `hold`/`flag`. The findings already carry `file:line` +
`verdict`, so those become pure consumers later.

## Schema — `schema/audit-receipt.schema.json`

Each auditor returns **one** receipt as its final message (pure JSON, no prose — mirrors the
engineer receipt). `/audit` parses both and merges.

```jsonc
{
  "auditor": "supply-chain | freshness",        // discriminator
  "status":  "ok | needs-review | blocked",     // SAME shape as engineer receipt
  "applied":  [ { "verdict", "target", "from", "to", "commit?", "verifiedBy?" } ],
  "findings": [ { "verdict", "target", "file?", "line?", "action" } ],
  "verification": { "install?": check, "build?": check, "test?": check },
  "degraded": [ "string" ]
}
```

- `status`: `ok` = ran clean, every safe fix applied (or nothing found), nothing needs a human ·
  `needs-review` = advisory findings exist (PR still opens) · `blocked` = could not audit at all
  (no lockfile, manager/probe missing).
- `applied[].verdict` enum: `upgrade | pin | remove-pin` (the auto-applied remediations).
- `findings[].verdict` enum: `recommend | hold | flag` (the needs-a-human verdicts).
- `check` is a local `$defs` (duplicated from the engineer receipt, **not** `$ref`-ed across
  files — schema files stay independently readable).

### The commit-ownership nuance (load-bearing)

- **supply-chain** leaves its edits *uncommitted* in the tree; `/audit` step 4a stages + commits
  them as ONE `fix: apply safe CVE overrides` commit. So the auditor **cannot** know that SHA →
  `applied[].commit` is **optional**; supply-chain omits it.
- **freshness** makes its own atomic per-package commits → it **fills** `applied[].commit`.

Required keys: receipt → `["auditor","status"]`; applied item → `["verdict","target"]`; finding
item → `["verdict","target","action"]`.

## Wiring

1. **`schema/audit-receipt.schema.json`** — new file (above).
2. **`supera-supply-chain-auditor` §6 Report** — replace the prose two-list instruction with
   "return a single JSON object validating against `schema/audit-receipt.schema.json`, no prose";
   map CVEs-applied → `applied[]` (omit `commit`), unfixable/flagged + secrets + typo-squat →
   `findings[]`, degraded probes → `degraded[]`, the §3 gate run → `verification`.
3. **`supera-freshness-auditor` §7 Report** — same, with `auditor: "freshness"`, per-package
   commit SHAs filled in `applied[].commit`, `recommend/hold/flag` → `findings[]`.
4. **`/audit`** —
   - step 4a/4b: "Capture its two-list report" → "Parse its JSON receipt".
   - step 6: build the PR body **from** `applied[]` / `findings[]` / `degraded[]` of both receipts
     (combined). Report-only surface likewise. Combined `status` = worst of the two.
   - non-interactive: any receipt `status == "blocked"` → exit `blocked` (unchanged hard-stop
     path). After opening the PR, if any `findings[].verdict == "flag"`, emit a loud run-log line
     and (when a PR exists) a `gh pr comment` listing the flags — the cron's signal. PR still
     opens; flags are advisory, not a job failure.

Engineer receipt untouched. Deny-path gate (step 5) untouched — it is `/audit`'s own gate, not an
auditor's.

## Verification

- `schema/audit-receipt.schema.json` parses as valid JSON Schema.
- A hand-written sample receipt (one `applied`, one `flag` finding, a `verification.test` PASS)
  validates against it.
- No remaining "two-list report" capture language in `/audit`; both auditor §Report sections
  reference the schema.

## Version

Behavioural change → bump `0.21.0 → 0.22.0` in both manifests.
