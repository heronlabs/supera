# Delegation

Canonical rules for every supera orchestrator that dispatches a supera agent — `supera-engineer` (`/ship` for the change, `/pr-watch` for CI and review fixes) and `supera-reviewer` (`/ship`'s review gate). Referenced, not restated: if you delegate, follow this.

## Dispatch

- Dispatch with `subagent_type: "supera:supera-engineer"` or `subagent_type: "supera:supera-reviewer"` — the two supera agents, same form for both.
- **Never pass `isolation: "worktree"`.** The skill already owns the worktree — isolation creates a separate one where the engineer's changes are invisible to the commit step and to the reviewer.
- **Never pass `name:`.** A named Agent call is launched as a teammate, which under `teammateMode: "tmux"` (or `"auto"` in a tmux or iTerm2 terminal) opens a second pane and splits the user's screen. Unnamed, the agent is a plain subagent.
- The Agent tool returns at once; its result carries the **agent id** — internal metadata, never shown to the user; keep the engineer's for the deadline below. The agent's final message — the engineer's receipt, the reviewer's findings — arrives as a task notification when it finishes; wait for it.

## Deadline

Right after an engineer dispatch, launch the deadline with Bash `run_in_background`:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/deadline.sh" 3600 "<re-invocation>"
```
Args: `SECONDS [PASSTHROUGH]`. Sleeps, then prints `ENGINEER_DEADLINE <seconds> [<passthrough>]` and exits 0 (missing or non-integer seconds: usage on stderr, exit 64). The passthrough is the calling skill's own re-invocation, so the notification is self-describing even after context compaction.

When its notification arrives:

- **Receipt already in** → the deadline is a no-op; ignore it.
- **No receipt yet** → send the engineer one `SendMessage`, to the captured agent id, with exactly this text: *"Stop and return the receipt now with the current state; mark unverified gates `not_run`."* Then launch the deadline again with the same arguments.
- **Second deadline, still no receipt** → surface the stall to the user and stop waiting for that engineer.

## Receipt is a claim

Verify every receipt against the worktree before acting on it, with the same command the engineer uses for `filesChanged` (every `git status --porcelain` path, untracked new files included, `.supera/` left out — never `git diff`, which misses untracked files) plus the plan's file list:

```bash
CHANGED=$("${CLAUDE_PLUGIN_ROOT}/scripts/changed-files.sh")
PLANNED=$(sed -n '/^## Files/,/^## /p' .supera/plan.md 2>/dev/null | grep '^- ' | sed 's/^- *//; s/`//g; s/[[:space:]]*$//')
EXTRA=$(comm -23 <(printf '%s\n' "$CHANGED" | sort) <(printf '%s\n' "$PLANNED" | sort))
```

- **Receipt** — `receipt.filesChanged` must match `CHANGED`. A mismatch means the engineer worked in a different context — flag it.
- **Scope** — `EXTRA` lists changed files missing from the plan's `## Files`. Any not justified in `receipt.notes` go back to the engineer to revert or justify (counts toward the loop cap).
- **Verification** — `receipt.verification` is a claim too: the orchestrator's own pre-flight before pushing (ship step 6) decides, never the receipt alone.

## Empty diff

`CHANGED` empty means the engineer made zero changes. **Check `receipt.notes` before delegating back** — never enter a delegation loop on an empty diff:

- **Notes legitimately explain the empty diff** (task already implemented, nothing to change, blocked on missing info; no code change needed — a flaky test, CI-side config, already fixed on the branch) → do NOT re-delegate. Surface the notes to the user and act on them: stop, re-run CI, or block.
- **Notes are empty or claim work was done** → the engineer idled. Treat as verification failure and re-delegate **once**, with the explicit instruction to make changes (counts toward the loop cap). Empty again → stop delegating — fix directly if trivial (below), otherwise surface the failure.

Either way: never commit with no changes.

## Trivial fixes

The orchestrator edits directly only trivial fixes: lint/format, typos, conflict markers, mechanical few-line fixes. Anything touching logic or tests goes to the engineer.

Before any direct Edit or Write, run `pwd` and confirm you are in the intended worktree (`.worktrees/<branch>`).
