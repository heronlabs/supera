# Auditor base — shared mechanics

Detection, gate, and receipt conventions for `supera-security-auditor`. The auditor inherits this and adds **only** its own verdict rubric (the supply-chain rubric in its own doc).

## Relationship to Dependabot

Dependabot and the auditor are layers, not rivals — and the auditor is **not** the mechanical-bump tool. Let Dependabot own the deterministic floor; the auditor owns the judgment Dependabot can't make.

- **Dependabot owns the mechanical, deterministic layer.** Routine version bumps, keeping already-pinned GitHub Actions fresh, and the security-update safety net — free, no LLM, with native write access to `.github/workflows/*` (no PAT needed). A repo that adopts supera should adopt Dependabot for this layer first, and may adopt it **on its own** — the auditor is an independent add-on layered on top, not a required follower.
- **The auditor fills what Dependabot can't.** Scoped transitive **overrides** (pnpm/npm `overrides` for a transitive CVE with no direct upgrade path); **CVE verdict reasoning** (upgrade vs scoped-override vs remove-stale-override vs hold vs flag, not a reflex pin); **false-positive suppression** (no churned noise PR); **SHA-pinning *unpinned* actions** (the initial `@v4`→`@<sha>` conversion — Dependabot preserves an action's existing pin style and won't make this change); and the **consolidated reasoning PR** that carries the verdicts.

The handoff: the auditor does the one-time tag→SHA pin Dependabot can't; Dependabot then keeps that SHA fresh afterward.

## Ecosystem detection

Inspect the repo root (and workspaces) for lockfile markers, in this priority:

| Marker | Manager |
|---|---|
| `pnpm-lock.yaml` | pnpm |
| `package-lock.json` | npm |
| `yarn.lock` | yarn (detect berry via `.yarnrc.yml`) |
| `Cargo.lock` / `Cargo.toml` | cargo |
| `go.sum` / `go.mod` | go |

- Multiple managers present ⇒ run each, and **label every finding by ecosystem**.
- A required tool missing (e.g. `cargo-audit`, `govulncheck`) ⇒ note the gap, skip that probe, **never fail the whole run**.
- **JS workspaces:** read `pnpm-workspace.yaml` (catalog + `pnpm.overrides`) and the root `package.json` `overrides`/`resolutions`; collect every `package.json` (root + members) and every `dependencies` / `devDependencies` / `peerDependencies` entry.

Your domain probe per manager (the native audit) and your apply primitives live in your own doc.

## Auto-apply gate — shared boxes

These boxes gate every ✅ change; your own doc adds domain-specific boxes (peer-range / re-audit for supply-chain). **A single miss ⇒ revert the tree to exactly as found and downgrade the finding to FLAG** — never a half-applied change.

- [ ] **One `name@version` per change.** The change targets a single package; the lockfile diff touches only that package.
- [ ] **Version actually moved.** Re-read the lockfile and prove the resolved version changed — a no-op edit is not a fix.
- [ ] **Real install + build + test mirroring CI.** Run an actual install and the repo's `verify.build` + `verify.test` with the CI lockfile flag (`--frozen-lockfile` / `--immutable` / `--locked`). **Never** `--lockfile-only` — it verifies an unbuilt tree. A green exit code alone is not proof — **read the output**.
- [ ] **Stage manifest + lockfile together.** Both move in one change; **never** hand-edit the lockfile.
- [ ] **Atomic revert on any miss.** Restore the tree exactly as found and downgrade the finding rather than ship a half-applied change.

## Always FLAG — shared baseline

Out of bounds for auto-apply, however mechanical they look — recommend the action and hand the decision to the user. Your own doc adds domain cases.

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

Your final message is consumed by `/audit`, **not a human** — return **only** a single JSON object that validates against `schema/audit-receipt.schema.json`, no prose before or after it. Set `auditor: "security"` and map `applied[]` / `findings[]` / `verification` / `degraded[]` per your own doc. `status` is the tristate `ok` / `needs-review` / `blocked` defined by the schema.

## Commit behaviour

Commit per `guidelines/commit-conventions.md` — see its "Who commits what" table for the security-auditor specifics (it leaves its edits uncommitted; `/audit` commits them).
