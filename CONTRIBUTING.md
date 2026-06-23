# Contributing to supera

Thanks for your interest. supera is a Claude Code plugin — this repo **is** the plugin, so a change here changes behaviour in every repo where supera is installed. Treat it as load-bearing.

## How it's structured

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version). |
| `.claude-plugin/marketplace.json` | Marketplace entry. Keep its `version` in sync with `plugin.json`. |
| `skills/` | `init`, `start`, `pr-watch`, `refactor`, `audit` — each a `SKILL.md`. |
| `agents/` | `supera-engineer`, `supera-security-auditor`. |
| `schema/` | The `.claude/supera.json` contract and the agent→skill JSON receipts (**source of truth**). |
| `guidelines/` | Canonical cross-cutting conventions, referenced by skills and agents — never restated. |

## Core invariants — please don't break these

- **Nothing repo-specific is hardcoded in a skill.** Commands, branches, and remotes come from `.claude/supera.json`. Need a new repo-specific value? Add it to `schema/supera.schema.json` first, then read it.
- **Skills orchestrate, agents implement, shared guidelines are canonical.** Route lifecycle and PR mechanics in skills; delegate application code to `supera-engineer`. A rule stated in two documents is a defect.
- **Nothing commits to base directly.** Every change ships via a branch/worktree and a PR; CI is the gate.
- **The PR is the unit of work.** supera is git/GitHub-native — no external tracker.
- **Schema and skills stay in sync.** A field a skill reads must exist in the schema with a description and a default.

## Making a change

1. Edit the skill / agent / schema.
2. **Versioning is automated — don't hand-bump `version`.** On merge to `main`, [`.github/workflows/continuous-deployment.yml`](.github/workflows/continuous-deployment.yml) bumps it — the bump type is inferred from the merge commit via Conventional Commits (`feat:` → minor, a breaking change → major, anything else → patch) — tags `v<version>`, cuts a GitHub release, and syncs `plugin.json` + `marketplace.json` + `package.json` in lockstep. PRs squash-merge, so give the squash commit's subject the right type to get the bump you want. To force a bump regardless of the commit, run the workflow manually (`workflow_dispatch`) and pick the `spec`.
3. Keep the plugin `name` a simple identifier (`supera`) — it is the command namespace (`/supera:start`), so scoped/`@org` names break loading.
4. Open a PR. Once merged, the CD releases it and consumers pick it up on their next `/plugin update`.

## Testing your change

Install the plugin from your local checkout (point a marketplace at the local path while developing) and exercise the affected skill against a throwaway repo. Because supera drives real git/GitHub operations, verify against a repo you don't mind opening test PRs in.

## Commit conventions

Follow [`guidelines/commit-conventions.md`](guidelines/commit-conventions.md): one single-line conventional-commit subject (`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`, ≤50 chars), no co-author trailers.
