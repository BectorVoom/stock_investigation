# Table: job_events

## Overview

| Property | Value |
|---|---|
| Table Name | `job_events` |
| Purpose | One row per progress entry a runner reported for a job lease (state changes, notes, tool calls), shown as the run's progress log. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 3. Research jobs |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `run_id`, `lease_generation`, `seq` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createJobRepository.writeWithEvents`, `listProgress`), `packages/adapters/src/sql/unitOfWork.ts` (`deleteWorkspace`) |
| Update Strategy | Insert-only (`INSERT OR IGNORE`), in the batch of the job's compare-and-set |
| Data Retention | Deleted with the job's conversation; events of jobs without a conversation are kept indefinitely |

The runner posts its events in batches (`POST /api/v1/runner/jobs/:id/events`). `appendEvents` keeps the events above the job's `last_event_seq`, validates state changes, and `toProgressRows` maps them to rows. Usage, provider-session and sign-in-URL events produce no row. `writeWithEvents` stores the rows in the same batch as the job write. The run view reads the newest 100 rows (`GET /api/v1/research-runs/:id`).

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `run_id` | TEXT | No | - | The job the event belongs to. |
| `lease_generation` | INTEGER | No | - | The lease the event was reported under. Each claim restarts the runner's sequence, so the generation separates attempts. |
| `seq` | INTEGER | No | - | The runner's event sequence number within the lease. |
| `kind` | TEXT | No | - | `state`, `note` or `tool` (checked by `listProgress`). |
| `text` | TEXT | No | - | `state`: the new state name. `note`: the runner's note. `tool`: `<toolId>: <outcome> — <detail>`. At most 600 characters (`runProgressEntrySchema`). |
| `at` | TEXT | No | - | ISO-8601 UTC time the runner reported for the event. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `run_id`, `lease_generation`, `seq` | - | One row per event per lease; `INSERT OR IGNORE` makes a resent event a no-op. |

## Indexes

None. The primary key serves every read: `listProgress` reads `owner_id`, `run_id` and orders by `lease_generation DESC, seq DESC` (the key order, scanned backwards). `deleteWorkspace` deletes by its `owner_id`, `run_id` prefix.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`JobRepository.writeWithEvents`, called by `createRunnerJobService.appendEvents`. One `INSERT OR IGNORE ... FROM json_each` statement after the job's compare-and-set, guarded on its `last_mutation_id` (`JOB_GUARD_SQL`). Only events with a `seq` above the job's `last_event_seq` are submitted, and the job write advances `last_event_seq` in the same batch.

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` deletes the events of every run the conversation owns in its guarded batch (`DELETE /api/v1/workspaces/:id`).

### Synchronization

Not applicable: no external source. The runner resends unacknowledged events; the `seq` filter and `OR IGNORE` make resends idempotent.

### Retention

Rows of conversation-bound jobs go with the conversation. Rows of news-ingest and refresh jobs are kept indefinitely. Reads are bounded (100 newest per run), but the table is not pruned (technical debt).
