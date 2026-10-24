# ADR-0033: Scheduled tasks — research questions that run on a schedule

**Status:** Accepted · **Date:** 2026-10-24 · **Owner request:** "Please
support Scheduled Tasks widgets like chatgpt function."

## Context

ChatGPT's Tasks let a user save a prompt with a schedule ("every weekday at
08:00 summarise …"); the prompt then runs by itself and the answers collect
in a conversation, and a list shows what is scheduled. This app had no
scheduler: every run started from an owner action (ADR-0004 rejected cron:
expired leases are detected lazily when a runner next claims).

Asked on 2026-10-24, the owner chose:

- a task runs a **research question** (not a notebook-assistant
  instruction);
- tasks are managed on a **Tasks page**, and a **Scheduled tasks widget**
  on Home and in the Notebook shows them at a glance with quick actions;
- when the runner was off at a due time, the task **runs once on return**:
  missed times collapse into one run.

## Decision

### 1. The task

A scheduled task (owner-scoped, `packages/contracts/src/scheduledTasks.ts`)
holds:

- `title` (1–120 characters) and the research `question` (3–2000), its
  `horizonYears` (3/4/5) and `markets` (JP, US) — the composer's fields;
- a `schedule` in the owner's local time plus an IANA `timeZone`:
  - `once` — a local date and time;
  - `daily` — a time;
  - `weekly` — one or more weekdays (0 = Sunday … 6 = Saturday, ascending,
    no repeats) and a time; the UI's "Weekdays" preset is `weekly` Mon–Fri;
  - `monthly` — a day of the month 1–31 and a time; a month without that
    day runs on its last day;
  times are `HH:MM` (24 h);
- `status`: `active`, `paused` or `completed` (a `once` task that fired);
- `nextRunAt` (UTC instant, null unless active), the last run it queued
  (`lastRunId`, `lastSlotAt`) and the last skipped occurrence
  (`lastSkip`: code, time, slot);
- `spendConsent` — `{ agentId, model, maxSpendUsd }` or null (§4);
- its own conversation (`workspaceId`), created with the task and titled
  with it; every run's question and answer land there.

Limits: at most **10 active** tasks and **30 tasks** in all
(`SCHEDULED_TASK_LIMITS`); a create or resume over a limit answers
`VALIDATION_FAILED` with detail `TASKS_FULL`.

### 2. When a task fires — no cron

A task fires **when a runner asks for work**: `POST /runner/jobs/claim`
first materialises the owner's due tasks, then scans claim candidates as
before, so a fired task's run is claimed in the same request. The runner
polls every ≤ 15 s while idle, so a task starts within seconds of its time
while the runner is online and idle; while the runner runs another job, it
starts when that job ends. Nothing runs while no runner polls — which is
also when nothing could execute a run. ADR-0004 stands: no scheduled
Worker, no cron trigger.

The decision is pure (`packages/domain/src/schedule/`):

- `nextLocalSlot(schedule, afterLocalMinute)` — the first local wall-clock
  minute strictly after the given one that the schedule names (none for a
  `once` already passed);
- `nextRunAtMs(schedule, timeZone, afterMs)` — the same as a UTC instant,
  strictly after `afterMs`. Local → UTC follows Temporal's `compatible`
  disambiguation: a time skipped by a daylight-saving jump runs that many
  minutes later (02:30 in a 02:00→03:00 gap runs at 03:30), and a repeated
  time runs at its first occurrence;
- `decideTaskTick({ status, nextRunAtMs, hasUnfinishedRun }, nowMs, nextAfter)` — `idle` (paused,
  completed or not yet due), `wait` (due, but the task's last run has not
  finished), or `fire` with the slot and the next `nextRunAt`, computed
  **strictly after now** — so every missed slot collapses into this one run
  ("run once on return") and the same slot never fires twice.

At most one run per task is unfinished at any time: a due task whose last
run is still pending or running waits, and fires (once) when it ends.

A successful fire clears `lastSkip`. A materialiser failure never fails
the claim: it is contained and logged as `scheduled_tasks_materialize_failed`
(error class only), and the claim scans candidates as usual. Audit actions:
`scheduled_task.create`, `.update`, `.delete`, `.run_now` (actor `owner`),
`scheduled_task.fire`, `.skip` (actor `scheduler`).

The materialiser creates the run through the research-run service with
idempotency key `task_<sha256(taskId, slot)>` and then advances the task
with compare-and-set on its version. A crash between the two replays the
same key (no duplicate run); two concurrent claims insert one run and
advance once. Its cost is one indexed read per claim
(`scheduled_tasks_due (owner_id, next_run_at)`), plus writes only when a
task is due.

### 3. Refused occurrences are skipped, not retried

A due occurrence the run service refuses — hourly run allowance or the
five-unfinished-run cap reached (`RATE_LIMITED`), no backend saved
(`AGENT_NOT_CONFIGURED`), a model required (`VALIDATION_FAILED`), metered
backend without matching consent (`SPEND_CONSENT_REQUIRED`), backend not
registered (`UNKNOWN_AGENT`) — is recorded as `lastSkip` and the schedule
advances as if it had fired. Retrying on every claim would burn the hourly
allowance the owner's own questions need. The widget and the Tasks page
show the skip with its reason and the fix (Settings → AI agent).

### 4. Which agent, and spend consent

A scheduled run uses the agent choice **explicitly saved** in **Settings →
AI agent at the moment it fires** (not a carried-over default the page may
show before the first save; with nothing saved each occurrence is skipped
as `AGENT_NOT_CONFIGURED`, as for the notebook assistant) — backend, model, effort, web access — under the
fixed limits (ADR-0029), exactly like Retry (`retryRequest`). A metered
backend needs the owner's consent, which a run nobody watches cannot ask
for: the task editor shows a consent checkbox ("Allow this task to spend up
to $X per run on <backend> <model>") whenever the saved backend is metered,
and stores `spendConsent`. A metered occurrence fires only while backend,
model and ceiling equal the consent (AGT-012); otherwise it is skipped with
`SPEND_CONSENT_REQUIRED`. Plan-limited backends need no consent.

### 5. Run now, pause, edit, delete

- **Run now** queues one run at once (`POST …/:id/run`, `Idempotency-Key`),
  without moving the schedule; while the task's last run is unfinished it
  answers that run instead of a second one.
- **Pause** clears `nextRunAt`; **Resume** computes it from now (a missed
  slot while paused never runs). Resuming a `once` task whose time has
  passed, or creating one, answers `VALIDATION_FAILED` / `SCHEDULE_IN_PAST`.
- **Edit** (title, question, horizon, markets, schedule, time zone,
  consent) recomputes `nextRunAt` for an active task only when the
  schedule, the time zone or the status changes — an edit of the question
  keeps a due occurrence that waits for the last run; compare-and-set on
  `expectedVersion` (409 `VERSION_CONFLICT`). Pausing a completed task
  answers `TASK_COMPLETED`; a completed `once` task resumes with a new
  future date.
- **Create** is idempotent: the task id is derived from the
  `Idempotency-Key`, so a repeated key answers the task it created. The
  task's conversation counts against the 50-conversation cap (`CONFLICT`).
- **Delete** removes the task and keeps its conversation (the answers are
  the owner's). Deleting the conversation deletes its tasks in the same
  atomic batch.

### 6. API

```text
GET    /api/v1/scheduled-tasks              list (conditional ETag)
POST   /api/v1/scheduled-tasks              create (Idempotency-Key) → task + its conversation
PATCH  /api/v1/scheduled-tasks/:id          edit / pause / resume (expectedVersion)
DELETE /api/v1/scheduled-tasks/:id          delete (keeps the conversation)
POST   /api/v1/scheduled-tasks/:id/run      run now (Idempotency-Key)
```

The list carries, per task, its last run's state and failure code (one
join, no N+1) and the limits.

### 7. Storage

Migration `0010_scheduled_tasks.sql`: one table `scheduled_tasks`
(primary key `(owner_id, task_id)`, `version` for compare-and-set, the
schedule as validated JSON) and one index for the due scan. Creating a task
inserts its conversation and the task in one guarded batch (the count
limits are checked inside the INSERT).

### 8. The Tasks page — `#/tasks`

A sixth page, "Tasks", between Watchlist and Chat: the task list (title,
schedule in words, next run in local time, last run state with "Open chat",
last skip with its reason), **New task** and **Edit** in one editor dialog
(title, question, horizon, markets, schedule kind with its fields, time
zone defaulting to the browser's, the consent checkbox when needed), and
per task Pause/Resume, Run now and Delete (with confirmation). An empty
state explains what a task is.

### 9. The widget — `scheduled-tasks`

A new widget type of the one specification (ADR-0024), on Home and in the
Notebook. It has no content fields (no `Edit…` item; size is in the menu).
Glanceable after the Apple widget guidelines: the tasks ordered by next run
(active first, then paused, then completed), each with its title, schedule
in words and next run (relative when within a day), the last run state
(link to its chat) and Pause/Resume and Run now icon buttons; a header line
with **New task** (the Tasks page editor dialog) and **Open Tasks**; an
empty state with New task. Small shows the next task only; Medium up to
four; Large up to eight, then "N more". It polls the list with the ETag
while visible, slowly (30 s), faster (5 s) while a task's run is unfinished.

Agents (the notebook assistant, the Home MCP server) may place the widget
like any other type; they cannot create, edit or run tasks.

### 10. What does not change

- Both runners are unchanged: a scheduled run is an ordinary `research`
  job. The Rust runner's contracts learn the new widget type only, because
  notebook bodies it validates may hold one.
- No notifications beyond the widget and the page (no browser
  notifications, no e-mail).

## Formal verification

`formal/ResearchFormal/Schedule.lean` models `nextLocalSlot` over local
minutes and `decideTaskTick`: the slot is strictly after its input and
matches the schedule, no matching minute lies between them (minimality), a
fire's next run is strictly after now (missed slots coalesce), and a task
with an unfinished run never fires. Time-zone resolution (Intl offsets,
DST) is outside the model and covered by unit tests over fixed zones.
Vectors in `formal/vectors.json`, replayed by `tests/formal/`.

## Consequences

- One more page and one more widget type; `PAGES.md`, the design
  conformance test and the page split test list them.
- Scheduled runs count against the same hourly allowance and unfinished-run
  cap as the owner's own questions.
- A task's time is local wall-clock time in its zone; travelling does not
  move it (the zone is the task's, not the browser's).
- Rollback: drop the routes and the page; `DROP TABLE scheduled_tasks`.
  Stored widgets of the type would then fail validation, so a rollback also
  removes `scheduled-tasks` widgets from Home and notebook bodies.
