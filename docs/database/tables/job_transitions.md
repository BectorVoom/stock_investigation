# Table: job_transitions

## Overview

| Property | Value |
|---|---|
| Table Name | `job_transitions` |
| Purpose | Append-only audit trail of job state transitions: one row per state change of a `research_jobs` row, with who made it and why. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 3. Research jobs |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `transition_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`jobWriteStatements`), `packages/adapters/src/sql/unitOfWork.ts` (`deleteWorkspace`) |
| Update Strategy | Append-only |
| Data Retention | Deleted with the job's conversation; transitions of jobs without a conversation are kept indefinitely |

Every job write that changes state carries `TransitionAudit` entries. `jobWriteStatements` turns each into an `INSERT ... SELECT` from the job row, conditional on the job's compare-and-set having stamped this write's `last_mutation_id`. A lost race therefore records nothing. The application never reads the table; it is an audit record, also used by tests and `scripts/profileRuns.ts`.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `transition_id` | INTEGER | No | - | `AUTOINCREMENT` row id; orders a run's transitions. |
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004); copied from the job row. |
| `run_id` | TEXT | No | - | The job that changed state; copied from the job row. |
| `from_state` | TEXT | No | - | State before the change (one of `JOB_STATES`). |
| `to_state` | TEXT | No | - | State after the change; always a legal successor in `JOB_TRANSITIONS`. |
| `lease_generation` | INTEGER | No | - | The job's `lease_generation` after the write, read from the job row in the same statement. |
| `actor` | TEXT | No | - | `owner` (cancel, approve) or `runner:<credentialId>` (claim, progress, release, completion, claim-time refusals). |
| `reason` | TEXT | No | - | Fixed text such as `claimed`, `lease expired`, `runner progress`, `cancelled by owner`, `approved by owner`, `released on runner shutdown`, or `completion: <outcome>`. Completions may append counts only (Google sync counts, directory size, dropped series or stocks), never provider text or tokens. |
| `at` | TEXT | No | - | ISO-8601 UTC time of the job write (`JobWrite.at`). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `transition_id` | `AUTOINCREMENT` | A monotonically increasing id per row; never reused, so ids follow insertion order. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_job_transitions__owner_id_run_id_transition_id` | `owner_id`, `run_id`, `transition_id` | No | One run's transitions in order. The application uses it only for `deleteWorkspace`'s `DELETE ... WHERE owner_id = ? AND run_id IN (...)`; tests and `scripts/profileRuns.ts` read by run. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`jobWriteStatements` appends one row per `TransitionAudit` of a job write, in the same batch and guarded on the write's `last_mutation_id`. Sources:
- Runner: claim (`POST /api/v1/runner/jobs/claim`, two rows when it recovers an expired lease: `→ pending`, `pending → claimed`), state events (`/events`), release (`/release`) and completion (`/complete`).
- Owner: cancel and approve (`POST /api/v1/research-runs/:id/cancel`, `/approve`).

Heartbeats, a cancel request on a live lease and the initial insert write no row.

### Update

Never: the table is append-only.

### Delete

`deleteWorkspace` deletes the transitions of every run the conversation owns in its guarded batch (`DELETE /api/v1/workspaces/:id`). The rollback notes of migrations 0007, 0008 and 0011 delete rows by job kind; those are manual steps, not code paths.

### Synchronization

Not applicable: no external source.

### Retention

Rows of conversation-bound jobs go with the conversation. Rows of news-ingest and refresh jobs are kept indefinitely, growing by a few rows per job (technical debt).

## Notes

- The only table in sections 1–4 whose primary key does not start with `owner_id`; the index provides the owner-scoped access path instead.
- The creation of a job (`pending`) has no transition row; a run's history starts at its first claim or cancel.
