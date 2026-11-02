# Table: equity_sync_state

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_sync_state` |
| Purpose | One row per tracked company holding its sync schedule, last check, success and failure and the time its values last changed (ADR-0048, ADR-0058 §3). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and J-Quants |
| Created By | `infra/migrations/0021_equity_financial_sync.sql`; rebuilt without `edinet_phase` by `0027_jquants_financials.sql` (ADR-0059) |
| Primary Key | `owner_id`, `company_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`probe`, `trackListings`, `untrackDelisted`, `reschedule`, `equitySyncStatements`, `recordFailure`), `packages/application/src/equitySync.ts` |
| Update Strategy | Upsert: track / re-track set `next_due_at`; the scheduler holds it while a job runs; each job end rewrites the row in its guarded batch |
| Data Retention | One row per company, kept as long as the company |

The scheduler's input and the company view's sync status. Every directory stock is tracked (ADR-0058 §3). Every runner claim probes the due tracked company — one never checked (`last_checked_at` NULL) before every company being refreshed, then the earliest `next_due_at <= now` — and queues one `financial-sync` job for it, holding `next_due_at` a day ahead while the job runs. The job's end writes the next time (`equityCompletionDelayMs`): now when the completion said `more` or a deferred filing waits; now + 30 days (`notFoundRetryDays`) for a company with no annual report at all (none stored or found: an SEC fund or SPAC, a Japanese ETF or REIT J-Quants has no earnings summary for); now + 24 h while a filing waits as pending or for a Watchlist company; else now + 7 days (`directorySyncIntervalHours`). After the n-th consecutive failure: now + 30 min × 2^(n−1) (at most 24 h), or 30 days for an identity conflict or a company SEC does not know. A re-track after the job was created (`sync_requested_at`) keeps its earlier time. US and Japanese companies are scheduled alike (ADR-0059 §2). No page makes a company due. `data_updated_at` is the read ETag basis.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `company_id` | TEXT | No | - | The company (`equity_company`). |
| `next_due_at` | TEXT | Yes | - | ISO-8601 UTC time the company is next due; NULL while it is off the schedule (a company the reconcile untracked). Set by track and re-track (the directory reconcile, ADR-0058 §3: the batch's order, a Watchlist stock a day earlier); held at queue time + 24 h while a scheduler job runs (`equitySyncHeldNextDueAt`, a safety net for a job that ends without writing the state); a job's end writes its own next time, or the request time when `sync_requested_at` is newer than the job and earlier. |
| `sync_requested_at` | TEXT | Yes | - | ISO-8601 UTC time of the company's last track or re-track by the directory reconcile (before ADR-0054 also the owner's "Sync now"). A job's end compares it with the job's creation time, so a request during any `financial-sync` job — queued by the scheduler or an owner's retry — is kept. NULL for rows written before and never re-tracked, and for the Japanese companies migration 0027 reset. |
| `last_checked_at` | TEXT | Yes | - | ISO-8601 UTC time of the last check: a job end (success or terminal failure). NULL until the first: such a company is served first (ADR-0058 §3). Migration 0027 set it NULL for every Japanese company, so all of them sync from J-Quants before any company is refreshed. |
| `last_succeeded_at` | TEXT | Yes | - | ISO-8601 UTC time of the last successful completion. |
| `failure_code` | TEXT | Yes | - | Stable code of the last terminal failure (`EQUITY_SYNC_FAILURE_CODES` from the runner, or an API-side code of `EQUITY_SYNC_API_FAILURE_CODES`: `FINANCIAL_IDENTITY_CONFLICT`, `RETRY_CEILING_REACHED`, `INTERNAL`); cleared by a success. |
| `failure_upstream_status` | INTEGER | Yes | - | The provider's HTTP status of that failure, unchanged (ADR-0037); NULL when none. |
| `failure_at` | TEXT | Yes | - | ISO-8601 UTC time of that failure; the status reads `failed` while it is newer than `last_succeeded_at`. |
| `consecutive_failures` | INTEGER | No | 0 | Terminal failures since the last success; drives the backoff. |
| `more_pending` | INTEGER | No | 0 | 1 when the last completion said `more` (it was cut at 60 filings / 3,000 facts): run again at once, SEC with `fullCheck`. |
| `data_updated_at` | TEXT | Yes | - | ISO-8601 UTC time a completion last changed an `equity_metric_value` row; the read ETag basis. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `company_id` | - | One schedule per company; the target of every upsert. |
| (unnamed) | FOREIGN KEY | `owner_id`, `company_id` | `equity_company (owner_id, company_id) ON DELETE RESTRICT` | A state belongs to a stored company. |
| (unnamed) | CHECK | `consecutive_failures` | `consecutive_failures >= 0` | A count. |
| (unnamed) | CHECK | `more_pending` | `more_pending IN (0, 1)` | `more_pending` is a boolean. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_sync_state__owner_id_next_due_at` | `owner_id`, `next_due_at` WHERE next_due_at IS NOT NULL | No | The due company of every runner claim (`probe`), in (`next_due_at`, `company_id`) order straight from the index: one row read instead of every state row plus a temporary sort. Rewritten once per sync, against a probe at every claim. |
| `idx_equity_sync_state__owner_id_last_checked_at_next_due_at` | `owner_id`, `last_checked_at`, `next_due_at` WHERE last_checked_at IS NULL AND next_due_at IS NOT NULL | No | The never-checked due company (`probe`, ADR-0058 §3, migration 0026), read before the refresh range above, in (`next_due_at`, `company_id`) order. Only never-checked rows are entries; a company leaves with its first check. 0.07 ms per probe at 11,400 companies. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `company_id` | `equity_company` | `owner_id`, `company_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`trackListings` (the claim-time directory reconcile, ADR-0058 §3) inserts the row in the batch that tracks the company, due at its place in the batch; any later upsert also inserts it when missing. Migration 0027 inserted a fresh never-checked row for every Japanese company (due at the migration, a Watchlist stock a day earlier; `next_due_at` NULL when untracked; `data_updated_at` the migration time, as its values were deleted).

### Update

A re-track sets `next_due_at` and `sync_requested_at` to now; the reconcile's untrack of a delisted company sets `next_due_at` NULL in the batch that untracks it. The claim-time scheduler (`materializeDue`) holds `next_due_at` at queue time + 24 h when it queues a job, sets it 5 minutes ahead when the queue refuses the job for the owner's unfinished-run cap (`EQUITY_REFUSED_JOB_RETRY_MS`; nothing when another `financial-sync` job won the race); neither records a check (`reschedule`). A job's end — completion, failed completion, retry ceiling or a claim refused as failed — upserts the row in its guarded batch (or directly, for claim-time failures).

### Delete

Never by the application.

### Synchronization

Records the sync's own progress; nothing external.

### Retention

One row per company, kept as long as the company.
