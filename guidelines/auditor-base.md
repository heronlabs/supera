# Auditor base — shared mechanics

Shared detection, gate, and receipt conventions for `supera-security-auditor` (security) and `supera-freshness-auditor` (currency). Each auditor inherits this and adds **only** its own verdict rubric. The two are disjoint in _what_ they judge; this is the _how_ they share.

## Ecosystem detection

Inspect the repo root (and workspaces) for lockfile markers, in this priority:

| Marker                      | Manager                               |
| --------------------------- | ------------------------------------- |
| `pnpm-lock.yaml`            | pnpm                                  |
| `package-lock.json`         | npm                                   |
| `yarn.lock`                 | yarn (detect berry via `.yarnrc.yml`) |
| `Cargo.lock` / `Cargo.toml` | cargo                                 |

- Multiple managers present ⇒ run each, and **label every finding by ecosystem**.
- A required tool missing (e.g. `cargo-audit`) ⇒ note the gap, skip that probe, **never fail the whole run**.
- **JS workspaces:** read `pnpm-workspace.yaml` (catalog + `pnpm.overrides`) and the root `package.json` `overrides`/`resolutions`; collect every `package.json` (root + members) and every `dependencies` / `devDependencies` / `peerDependencies` entry.

Your domain probe per manager (native audit, or latest-in-range + publish-date) and your apply primitives live in your own doc.

## Auto-apply gate — shared boxes

These boxes are common to **both** auditors and gate every ✅ change; your own doc adds domain-specific boxes (peer-range / re-audit for supply-chain; cooldown / coupled-set / catalog / level for freshness). **A single miss ⇒ revert the tree to exactly as found and downgrade the finding to FLAG/RECOMMEND** — never a half-applied change.

- [ ] **One `name@version` per change.** The change targets a single package; the lockfile diff touches only that package.
- [ ] **Version actually moved.** Re-read the lockfile and prove the resolved version changed — a no-op edit is not a fix.
- [ ] **Real install + build + test mirroring CI.** Run an actual install and the repo's `verify.build` + `verify.test` with the CI lockfile flag (`--frozen-lockfile` / `--immutable` / `--locked`). **Never** `--lockfile-only` — it verifies an unbuilt tree. A green exit code alone is not proof — **read the output**.
- [ ] **Stage manifest + lockfile together.** Both move in one change; **never** hand-edit the lockfile.
- [ ] **Atomic revert on any miss.** Restore the tree exactly as found and downgrade the finding rather than ship a half-applied change.

## Always FLAG — shared baseline

Out of bounds for auto-apply in **both** auditors, however mechanical they look — recommend the action and hand the decision to the user. Your own doc adds domain cases.

- A **major / out-of-range** bump.
- **Range-widening** required.
- A **non-semver version descriptor**: a git-url dep, `patch:`, an npm alias, or a cargo `[patch]` git path — there is no clean range to move within.
- A dep that is **BOTH direct AND transitive** — moving one role desyncs the other.
- A **framework migration / EOL** runtime.
- A **documented load-bearing pin** — check the repo's `CLAUDE.md` / `.guides/` for "do not bump" and leave it alone.
- A **known-bad** latest (yanked / regressed) ⇒ **HOLD** (pin-below / wait).

## Degrade gracefully

A failed or degraded probe (missing native tool, network failure, unreachable publish date / release notes) is a **noted gap** that blocks auto-apply for the affected finding only — it never fails the whole run. Record it honestly in the receipt's `degraded[]`.

## Receipt

Your final message is consumed by `/audit`, **not a human** — return **only** a single JSON object that validates against `schema/audit-receipt.schema.json`, no prose before or after it. Set `auditor` to your kind and map `applied[]` / `findings[]` / `verification` / `degraded[]` per your own doc. `status` is the tristate `ok` / `needs-review` / `blocked` defined by the schema.

## Commit behaviour

Commit per `guidelines/commit-conventions.md` — see its "Who commits what" table for the security vs freshness specifics.
