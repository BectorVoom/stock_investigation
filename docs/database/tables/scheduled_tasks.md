# Table: scheduled_tasks

## Overview

| Property | Value |
|---|---|
| Table Name | `scheduled_tasks` |
| Purpose | One row per scheduled task: a research question that runs on a schedule in its own conversation (ADR-0033). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 8. Scheduled tasks |
| Created By | `infra/migrations/0010_scheduled_tasks.sql` |
| Primary Key | `owner_id`, `task_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/scheduledTasks.ts`, `packages/adapters/src/sql/unitOfWork.ts` |
| Update Strategy | Compare-and-set on `version`; guarded insert with the count limits in the same batch |
| Data Retention | Kept until the owner deletes the task or its conversation; at most 30 tasks per owner |

The Tasks page creates, edits, pauses, resumes and deletes tasks through `createScheduledTaskService` (`packages/application/src/scheduledTasks.ts`). Every runner claim calls `materializeDue`, which reads the due tasks, creates one research run per due occurrence and advances `next_run_at`, or records a skip when the run service refuses. A task owns one conversation (`workspace_id`), created in the same batch as the task; every run's question and answer land there. JSON columns are validated against the shared contracts on write and on read, so a stored task is always one the API can return.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `task_id` | TEXT | No | - | `task_` plus a SHA-256 prefix of the create request's `Idempotency-Key`, so a replayed create answers the same task. |
| `workspace_id` | TEXT | No | - | The task's own conversation (`workspaces.workspace_id`), created in the same batch as the task. |
| `title` | TEXT | No | - | Task title, 1–120 characters after trimming (`taskTitleSchema`); also the conversation's title at creation. |
| `question` | TEXT | No | - | The research question each run asks, 3–2,000 characters after trimming (`taskQuestionSchema`). |
| `horizon_years` | INTEGER | No | - | Research horizon in years: 3, 4 or 5. |
| `markets_json` | TEXT | No | - | JSON array of 1–2 markets (`'JP'`, `'US'`; `marketSchema`). |
| `schedule_json` | TEXT | No | - | JSON `TaskSchedule` (`taskScheduleSchema`): `once` (date, time), `daily` (time), `weekly` (ascending days 0–6, time) or `monthly` (day 1–31, time); times are `HH:MM` local to `time_zone`. |
| `time_zone` | TEXT | No | - | IANA time zone the schedule's wall-clock times are in (`timeZoneSchema`, e.g. `Asia/Tokyo`). |
| `spend_consent_json` | TEXT | Yes | - | JSON `taskSpendConsentSchema` (`agentId`, `model`, `maxSpendUsd`): the owner's consent for a metered backend; NULL when none was given. |
| `status` | TEXT | No | - | `'active'`, `'paused'` or `'completed'` (`taskStatusSchema`); a new task is `'active'`, a `once` task becomes `'completed'` when it fires. |
| `next_run_at` | TEXT | Yes | - | ISO-8601 UTC instant the next occurrence is due; NULL unless the task is active. |
| `last_run_id` | TEXT | Yes | - | The latest run queued for the task (`research_jobs.run_id`), by schedule or "Run now"; NULL before the first. |
| `last_slot_at` | TEXT | Yes | - | ISO-8601 UTC slot the last run was queued for; NULL for a "Run now" run or before the first run. |
| `last_queued_at` | TEXT | Yes | - | ISO-8601 UTC time the last run was created. |
| `last_skip_code` | TEXT | Yes | - | Refusal code of the last skipped occurrence (`TASK_SKIP_CODES`: `RATE_LIMITED`, `AGENT_NOT_CONFIGURED`, `VALIDATION_FAILED`, `SPEND_CONSENT_REQUIRED`, `UNKNOWN_AGENT`, `NOT_FOUND`); NULL when there is none or a later occurrence fired. |
| `last_skip_slot_at` | TEXT | Yes | - | ISO-8601 UTC slot that was skipped; set together with `last_skip_code`. |
| `last_skip_at` | TEXT | Yes | - | ISO-8601 UTC time of the claim that skipped the slot; set together with `last_skip_code`. |
| `version` | INTEGER | No | - | Compare-and-set version: starts at 0 and every `write` increments it. |
| `created_at` | TEXT | No | - | ISO-8601 UTC creation time. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last write. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `task_id` | - | One row per task; `get`, `write` and `delete` address a task by this key. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_scheduled_tasks__owner_id_next_run_at_task_id` | `owner_id`, `next_run_at`, `task_id` | No | The due scan of `listDue` on every runner claim: a range `next_run_at <= now` (NULL unless active), read in `(next_run_at, task_id)` order without a sort. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |
| `owner_id`, `last_run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`POST /api/v1/scheduled-tasks` → `createScheduledTaskService.create` → `unitOfWork.createScheduledTask`: one batch inserts the conversation (guarded on fewer than 30 tasks, fewer than 10 active ones, and no task with this id) and the task (`insertScheduledTaskStatement`, guarded on that conversation insert's mutation stamp). If the guard fails, nothing is written and the API answers that the limit is reached.

### Update

`write` is one `UPDATE … WHERE version = ?` that increments `version` and sets `updated_at`. The owner's edit, pause and resume (`PATCH /api/v1/scheduled-tasks/:id`) change the editable fields, `status` and `next_run_at`; making a task active is refused in the same statement when 10 tasks are already active. The claim-time `materializeDue` sets `status`, `next_run_at` and either the last-run columns (clearing the skip) or the skip columns. "Run now" (`POST …/:id/run`) sets `last_run_id`, `last_queued_at` and a NULL `last_slot_at`, retrying the compare-and-set up to 4 times.

### Delete

`DELETE /api/v1/scheduled-tasks/:id` deletes the task and keeps its conversation. Deleting the conversation (`unitOfWork` workspace delete) deletes its tasks in the same batch (`DELETE FROM scheduled_tasks WHERE owner_id = ? AND workspace_id = ?`).

### Synchronization

Not applicable: no external source. Tasks fire only when a runner claims work; there is no cron trigger (ADR-0004).

### Retention

Kept until deleted. `SCHEDULED_TASK_LIMITS` bounds the table to 30 tasks per owner (10 active); `list` reads at most 30 rows.

## Notes

- Every missed slot collapses into one run strictly after now, and a task whose last run is unfinished waits; at most one run per task is unfinished.
- A crash between creating the run and advancing the task is safe: the run's idempotency key is `task_<sha256(taskId, slot)>`, so the next claim replays the same run.
- `list` joins `research_jobs` on `last_run_id` to show the last run's state in one query (no N+1).
- The guards count rows with `count(*)` subqueries over the owner's tasks, which the 30-task cap keeps small.
