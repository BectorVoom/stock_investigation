# ADR-0038: The Task result widget — a scheduled task's latest answer on Home

**Status:** Accepted · **Date:** 2026-10-25 · **Owner request:** "Please
modify to display scheduled tasks result in widgets on Home."

## Context

ADR-0033 added scheduled tasks and the `scheduled-tasks` widget. That
widget lists the tasks — schedule, next run, the last run's *state*
("Completed", "Failed") and a link to the chat — but never the answer a run
produced. To read what a task found, the owner had to open its chat.

Asked on 2026-10-25, the owner chose:

- a **new widget type bound to one task**, showing that task's latest
  answer, when it ran and its verification status, with an Open chat link
  (over an excerpt added to each row of the existing list widget);
- **answer text only**: charts and tables a run placed on its canvas stay
  in the chat.

## Decision

### 1. The widget type `task-result`

A new type of the one widget specification (ADR-0024), on Home and in the
Notebook, after `scheduled-tasks` in the add menu. Its only content field
is `taskId` (an `idSchema` id). No market series: every series walk treats
it as zero series. Sizes Small, Medium, Large; default Medium. The stored
`title` is the task's title when the widget was added: the frame hides it
(ADR-0024), it stays the accessible name. The body always shows the task's
*current* title.

The widget has no `Edit…` item: which task it shows is chosen when it is
added. To show another task, the owner adds another widget.

### 2. Which answer is "the latest result"

The latest assistant answer in the task's own conversation that a
`research` run produced (message `<runId>_answer`, joined to
`research_jobs` with `kind = 'research'`, so notebook-assistant replies
never count). The conversation is the task's (ADR-0033 §1), so a follow-up
question the owner asks in that chat is part of its thread and its answer
counts as the latest result — the widget names the time it was answered,
so this is never hidden.

A run that is still unfinished, or failed without an answer, does not
replace the previous answer: the widget keeps showing it and says, in its
status line, that a run is in progress or that the last run failed (the
state comes from the task list's `lastRun`).

### 3. API

```text
GET /api/v1/scheduled-tasks/:id/result   → { result: TaskResult | null }  (conditional ETag)
```

`TaskResult` = `{ runId, text, answeredAt, verificationStatus }`
(`taskResultResponseSchema` in `packages/contracts/src/scheduledTasks.ts`).
A task id the owner does not have answers 404 `NOT_FOUND`. One indexed
query: it walks the conversation's messages newest first on the
`(owner_id, workspace_id, seq)` key and joins the run by primary key.

The answer (up to 6 000 characters) is *not* added to the task list: 30
tasks would make every list poll carry up to 180 KB. The widget refetches
the result only when its task's `lastRun` (run id and state) changes in the
shared list the page already polls, and the ETag turns an unchanged answer
into a 304 — so the widget adds no poll of its own.

### 4. What the widget shows

After the Apple widget guidelines — glanceable, one task, no chrome:

- the task's title;
- a status line: when the shown answer was given (relative within a day),
  its verification status, and — when it applies — "Running now" or "Last
  run failed" (with the run state words the Tasks page uses), or the last
  skip;
- the answer as **plain text** (agent output is data, never markup —
  UI-005), clamped by size: Small a few lines, Medium more, Large all of it
  with the frame's scroll;
- **Open chat** (the task's conversation) and **Run now**.

States: loading; no answer yet ("No result yet — the first run is at
<next run>" or the state of the run in progress); the task deleted ("This
task was deleted" — the owner removes the widget from its menu); a load
failure with Retry.

### 5. Adding one

- **Add menu** (Home and Notebook): "Task result" opens a small dialog
  listing the owner's tasks (title and schedule in words); choosing one
  places the widget. With no tasks, the dialog says so and links to the
  Tasks page.
- **Tasks page**: each task offers **Show result on Home**, which appends a
  Task result widget for it to Home (or says it is already there).

### 6. Agents

Agents (the notebook assistant, the Home MCP server) may move, resize and
remove a `task-result` widget like any other, but cannot add one or change
its `taskId`: they have no way to look tasks up, and a widget naming a task
that is not the owner's would only show "deleted". Adding one answers
`INVALID_WIDGET` naming the rule.

### 7. What does not change

- No migration: the query reads `chat_messages` and `research_jobs` as
  they are.
- Both runners are unchanged except that the Rust contracts learn the new
  widget type, because notebook bodies the runner validates may hold one.
- The `scheduled-tasks` list widget is unchanged.

## Consequences

- One more widget type; `PAGES.md`, the design-conformance test and the
  widget specification list it.
- Deleting a task leaves its Task result widgets in place, showing "This
  task was deleted"; deleting the conversation deletes the task (ADR-0033
  §5), with the same effect.
- Rollback: remove the type and the route. Stored widgets of the type
  would then fail validation, so a rollback also removes `task-result`
  widgets from Home and notebook bodies.
