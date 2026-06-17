---
name: refine-ticket
description: "Refine a draft tracker ticket: rename to a friendly human title, enforce the concise template, fold subtasks, fill project tag / priority / due date from .claude/supera.json, mirror the title onto any open PR, and move it to the 'ready' status so /ship can pick it up clean."
allowed-tools: Bash, Read  # also requires gh CLI and the tracker's MCP tools
---

Refine a draft tracker ticket so it matches the concise template and carries every field `/ship` needs to start work. Repo-agnostic: the project tag comes from this repo's `.claude/supera.json`.

## 0 — Load config

Read `.claude/supera.json` into `CONFIG` for `tracker.projectTag`. If absent, skip tagging (still refine title/body/fields).

`TOOL = CONFIG.tracker?.tools ?? {}` — the neutral-op → MCP-tool map. Invoke each tracker op as `TOOL.getTicket`, `TOOL.updateFields`, `TOOL.setStatus`, `TOOL.addTag`, `TOOL.deleteTicket` — never a hardcoded provider tool name. Each op is individually optional: a step that needs one guards on its presence in `TOOL` and skips when absent. Derive each call's arguments from the mapped tool's own schema.

Resolve `STATUS` once from `CONFIG.tracker?.statuses ?? {}` with defaults: `STATUS.ready = …?.ready ?? "pending"` (the only status this skill sets).

## 1 — Resolve the ticket

`$ARGUMENTS` is a tracker ticket ID (e.g. `86b9vh7n8`). If empty, ask the user. Fetch it via `TOOL.getTicket`, requesting its subtasks + description (derive the argument names from the tool's own schema).

## 2 — Rename to a friendly human title

Rewrite to a verb-led imperative English sentence, applied via `TOOL.updateFields` (name = the new title).
Reject and rewrite any title with: a conventional-commit prefix (`feat(api): …`), a `Phase N —` prefix, an app-name prefix (`server-backend: …`), unicode arrows (`→ ⇒ ->`), a trailing period, or length over 80 chars.

Good: `Add invoices and transfers to the domain model` · `Adopt k6 for load testing`.

Mirror the new title onto any open PR linked to this ticket:
1. `gh pr list --search "<ticket-id>" --state open --json number,title,body`; also scan PR bodies for the ticket id / its tracker URL. Dedupe both result sets by PR number — the same PR often matches both.
2. Exactly one match → `gh pr edit <num> --title "<new title>"`.
3. Zero → skip silently (`/ship` opens the PR later with the ticket title).
4. Multiple → list under `pr-title-mismatch:` in the report, leave untouched.

## 3 — Reformat the body and fold subtasks

Compare the current `description` against the template below. If it's missing `## Context` / `## Outcome`, rebuild from the template, preserving every existing fact (stray paragraphs → `## Notes`).

If the ticket has subtasks: for each, extract its `## Outcome` bullets (or its name + first paragraph if it has no template body), append to the parent's `## Outcome` (de-dupe exact matches). Then apply the rebuilt body via `TOOL.updateFields` (description = the new body) and delete each subtask via `TOOL.deleteTicket` (one call per subtask). **Guard on `TOOL.deleteTicket`:** if it is unmapped, skip subtask deletion entirely and note it under `subtasks-not-folded:` in the report — fold the outcomes into the parent, but leave the subtasks in place rather than erroring. If the body already follows the template and there are no subtasks, skip this step.

**Ticket body template:**
```
## Context
<1–2 sentences: what's broken / missing and why now>

## Outcome
- <observable change 1>
- <observable change 2>

## Out of scope
- <related but deferred>          ← omit if empty

## Notes
- <link or fact>                   ← omit if empty
```

## 4 — Fill required fields

| Field | How to derive |
|---|---|
| `tag` | Apply `CONFIG.tracker.projectTag` (this repo's project tag); skip if unset |
| `priority` | `urgent` if incident/outage/blocking · `high` if release blocker · `low` if cleanup/nice-to-have · else `normal` |
| `due date` | Only if the body has an explicit date or "by <day>"; convert relative → absolute `YYYY-MM-DD` using today. Never guess |
| `status` | `STATUS.ready` — refining is what makes a ticket ready to ship |

Move the ticket to `STATUS.ready` via `TOOL.setStatus`. Apply the priority + due date via `TOOL.updateFields` (one call; derive its argument names from the tool's schema).

Apply the project tag via `TOOL.addTag` (tag = `CONFIG.tracker.projectTag`) *(skip if unset or `TOOL.addTag` unmapped)*. If it fails (the tag doesn't exist in the space, or any error), capture under `tags-missing:` in the report and continue (user creates it in the tracker UI).

## 5 — Report

One line per applied change (skip non-applicable lines): `title`, `body`, `subtasks-folded`, `subtasks-not-folded`, `tags`, `tags-missing`, `priority`, `due_date`, `status`, `pr-title-mirror`, `pr-title-mismatch`. End — the user invokes `/ship <id>` next.

## Rules

- **Title:** verb-led imperative, under 80 chars; no commit prefix, no `Phase N`, no app-name prefix, no unicode arrows, no trailing period.
- **PR-title-mirror:** after renaming, mirror onto the single matching open PR.
- **Subtasks:** fold every subtask's `## Outcome` into the parent and delete them via `TOOL.deleteTicket` — never leave a parent/subtask tree. If `TOOL.deleteTicket` is unmapped, still fold the outcomes but leave the subtasks and note `subtasks-not-folded:` (don't error).
- **Missing tags:** never swallow tag errors silently — emit under `tags-missing:`.
- **Single unit:** one ticket → one branch → one PR. Leave the ticket self-contained.
- Never invent dates. This skill moves a refined draft to `STATUS.ready` (`pending`); `/ship` owns the rest of the lifecycle. No assignee, no time-tracking.
