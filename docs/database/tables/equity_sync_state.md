# Table: equity_sync_state

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_sync_state` |
| Purpose | One row per tracked company holding its sync schedule, last check, success and failure, EDINET scan phase and the time its values last changed (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0021_equity_financial_sync.sql` |
| Primary Key | `owner_id`, `company_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`probe`, `track`, `requestSync`, `reschedule`, `equitySyncStatements`, `recordFailure`), `packages/application/src/equitySync.ts` |
| Update Strategy | Upsert: track / Sync now set `next_due_at`; the scheduler holds it while a job runs; each job end rewrites the row in its guarded batch |
| Data Retention | One row per company, kept as long as the company |

The scheduler's input and the company view's sync status. Every runner claim probes the tracked company with the earliest `next_due_at <= now` and queues one `financial-sync` job for it, holding `next_due_at` a day ahead while the job runs. The job's end writes the next time — now + 24 h after a success (or now when the completion said `more`, a deferred filing waits or the EDINET plan still has dates), now + 30 min × 2^(n−1) (at most 24 h) after the n-th consecutive failure — unless the owner pressed "Sync now" after the job was created (`sync_requested_at`), whose earlier time is kept. `data_updated_at` is the read ETag basis.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `company_id` | TEXT | No | - | The company (`equity_company`). |
| `next_due_at` | TEXT | Yes | - | ISO-8601 UTC time the company is next due. Set to now by track, re-track and "Sync now"; held at queue time + 24 h while a scheduler job runs (`equitySyncHeldNextDueAt`, a safety net for a job that ends without writing the state); a job's end writes its own next time, or the press time when `sync_requested_at` is newer than the job and earlier. |
| `sync_requested_at` | TEXT | Yes | - | ISO-8601 UTC time of the owner's last "Sync now" (or track / re-track) that was recorded. A job's end compares it with the job's creation time, so a press during any `financial-sync` job — queued by the scheduler or an owner's retry — is kept. Not recorded while the company's job is still pending (that job, not claimed yet, serves the press). NULL when never pressed. |
| `last_checked_at` | TEXT | Yes | - | ISO-8601 UTC time of the last job end (success or terminal failure). |
| `last_succeeded_at` | TEXT | Yes | - | ISO-8601 UTC time of the last successful completion. |
| `failure_code` | TEXT | Yes | - | Stable code of the last terminal failure (`EQUITY_SYNC_FAILURE_CODES` from the runner, or an API-side code of `EQUITY_SYNC_API_FAILURE_CODES`: `FINANCIAL_IDENTITY_CONFLICT`, `RETRY_CEILING_REACHED`, `INTERNAL`); cleared by a success. |
| `failure_upstream_status` | INTEGER | Yes | - | The provider's HTTP status of that failure, unchanged (ADR-0037); NULL when none. |
| `failure_at` | TEXT | Yes | - | ISO-8601 UTC time of that failure; the status reads `failed` while it is newer than `last_succeeded_at`. |
| `consecutive_failures` | INTEGER | No | 0 | Terminal failures since the last success; drives the backoff. |
| `more_pending` | INTEGER | No | 0 | 1 when the last completion said `more` (it was cut at 60 filings / 3,000 facts): run again at once, SEC with `fullCheck`. |
| `edinet_phase` | TEXT | Yes | - | EDINET scan phase (`edinetScanPlan`): `discovery`, `backfill`, `forward`, `idle` or `not-found`; NULL for SEC. |
| `data_updated_at` | TEXT | Yes | - | ISO-8601 UTC time a completion last changed an `equity_metric_value` row; the read ETag basis. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `company_id` | - | One schedule per company; the target of every upsert. |
| (unnamed) | FOREIGN KEY | `owner_id`, `company_id` | `equity_company (owner_id, company_id) ON DELETE RESTRICT` | A state belongs to a stored company. |
| (unnamed) | CHECK | `consecutive_failures` | `consecutive_failures >= 0` | A count. |
| (unnamed) | CHECK | `more_pending` | `more_pending IN (0, 1)` | `more_pending` is a boolean. |
| (unnamed) | CHECK | `edinet_phase` | `edinet_phase IN ('discovery', 'backfill', 'forward', 'idle', 'not-found')` | The scan plan's phases. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_sync_state__owner_id_next_due_at` | `owner_id`, `next_due_at` WHERE next_due_at IS NOT NULL | No | The due company of every runner claim (`probe`), in (`next_due_at`, `company_id`) order straight from the index: one row read instead of every state row plus a temporary sort. Rewritten once per sync, against a probe at every claim. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `company_id` | `equity_company` | `owner_id`, `company_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`track` (and `seedDefaults`) inserts the row due now in the batch that tracks the company; any later upsert also inserts it when missing.

### Update

`requestSync` ("Sync now") and a re-track set `next_due_at` and `sync_requested_at` to now; "Sync now" writes nothing while the company's job is pending (not claimed yet). The claim-time scheduler (`materializeDue`) holds `next_due_at` at queue time + 24 h when it queues a job, sets it 5 minutes ahead when the queue refuses the job for the owner's unfinished-run cap (`EQUITY_REFUSED_JOB_RETRY_MS`; nothing when another `financial-sync` job won the race), and for an EDINET company with nothing to scan sets it 24 h (idle) or 7 days (not found) ahead with the phase. A job's end — completion, failed completion, retry ceiling or a claim refused as failed — upserts the row in its guarded batch (or directly, for claim-time failures).

### Delete

Never by the application.

### Synchronization

Records the sync's own progress; nothing external.

### Retention

One row per company, kept as long as the company.
