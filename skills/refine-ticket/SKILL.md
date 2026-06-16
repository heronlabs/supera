---
name: refine-ticket
description: "Refine a draft ClickUp ticket: rename to a friendly human title, enforce the concise template, fold subtasks, fill project tag / priority / due date from .claude/supera.json, mirror the title onto any open PR, and move it to the 'ready' status so /ship can pick it up clean."
allowed-tools: Bash, Read  # also requires gh CLI and clickup_* MCP tools
---

Refine a draft ClickUp ticket so it matches the concise template and carries every field `/ship` needs to start work. Repo-agnostic: the project tag comes from this repo's `.claude/supera.json`.

## 0 — Load config

Read `.claude/supera.json` into `CONFIG` for `clickup.projectTag`. If absent, skip tagging (still refine title/body/fields).

Resolve `STATUS` once from `CONFIG.clickup?.statuses ?? {}` with defaults: `STATUS.ready = …?.ready ?? "pending"` (the only status this skill sets).

## 1 — Resolve the ticket

`$ARGUMENTS` is a ClickUp ticket ID (e.g. `86b9vh7n8`). If empty, ask the user.
```
clickup_get_task(task_id="<id>", subtasks=true)
```

## 2 — Rename to a friendly human title

Rewrite to a verb-led imperative English sentence:
```
clickup_update_task(task_id="<id>", name="<new title>")
```
Reject and rewrite any title with: a conventional-commit prefix (`feat(api): …`), a `Phase N —` prefix, an app-name prefix (`server-backend: …`), unicode arrows (`→ ⇒ ->`), a trailing period, or length over 80 chars.

Good: `Add invoices and transfers to the domain model` · `Adopt k6 for load testing`.

Mirror the new title onto any open PR linked to this ticket:
1. `gh pr list --search "<ticket-id>" --state open --json number,title,body`; also scan PR bodies for `https://app.clickup.com/t/<id>`. Dedupe both result sets by PR number — the same PR often matches both.
2. Exactly one match → `gh pr edit <num> --title "<new title>"`.
3. Zero → skip silently (`/ship` opens the PR later with the ticket title).
4. Multiple → list under `pr-title-mismatch:` in the report, leave untouched.

## 3 — Reformat the body and fold subtasks

Compare the current `description` against the template below. If it's missing `## Context` / `## Outcome`, rebuild from the template, preserving every existing fact (stray paragraphs → `## Notes`).

If the ticket has subtasks: for each, extract its `## Outcome` bullets (or its name + first paragraph if it has no template body), append to the parent's `## Outcome` (de-dupe exact matches). Then apply the body and delete each subtask:
```
clickup_update_task(task_id="<id>", markdown_description="<new body>")
clickup_delete_task(task_id="<subtask-id>")   # repeat per subtask
```
If the body already follows the template and there are no subtasks, skip this step.

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
| `tags` | Apply `CONFIG.clickup.projectTag` (this repo's project tag); skip if unset |
| `priority` | `urgent` if incident/outage/blocking · `high` if release blocker · `low` if cleanup/nice-to-have · else `normal` |
| `due_date` | Only if the body has an explicit date or "by <day>"; convert relative → absolute `YYYY-MM-DD` using today. Never guess |
| `status` | `STATUS.ready` — refining is what makes a ticket ready to ship |

Apply non-tag fields in one call:
```
clickup_update_task(task_id="<id>", status=STATUS.ready, priority="<priority>", due_date="<YYYY-MM-DD>")
```
Apply the project tag *(skip if unset)*:
```
clickup_add_tag_to_task(task_id="<id>", tag_name="<CONFIG.clickup.projectTag>")
```
If it fails (`The tag "X" does not exist in the space.` or any error), capture under `tags-missing:` in the report and continue (user creates it in the ClickUp UI).

## 5 — Report

One line per applied change (skip non-applicable lines): `title`, `body`, `subtasks-folded`, `tags`, `tags-missing`, `priority`, `due_date`, `status`, `pr-title-mirror`, `pr-title-mismatch`. End — the user invokes `/ship <id>` next.

## Rules

- **Title:** verb-led imperative, under 80 chars; no commit prefix, no `Phase N`, no app-name prefix, no unicode arrows, no trailing period.
- **PR-title-mirror:** after renaming, mirror onto the single matching open PR.
- **Subtasks:** fold every subtask's `## Outcome` into the parent and delete them — never leave a parent/subtask tree.
- **Missing tags:** never swallow tag errors silently — emit under `tags-missing:`.
- **Single unit:** one ticket → one branch → one PR. Leave the ticket self-contained.
- Never invent dates. This skill moves a refined draft to `STATUS.ready` (`pending`); `/ship` owns the rest of the lifecycle. No assignee, no time-tracking.
