# Table: rate_limits

## Overview

| Property | Value |
|---|---|
| Table Name | `rate_limits` |
| Purpose | One row per owner, bucket and fixed time window, counting the requests admitted in that window. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 11. Audit and rate limits |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `bucket`, `window_start` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createRateLimiter`) |
| Update Strategy | Upsert that increments `count`; older windows pruned in the same batch |
| Data Retention | Current and previous window per bucket; older windows deleted on the next `consume` |

`createRateLimiter().consume` implements a fixed-window counter: one batch increments the current window's row and deletes the bucket's windows older than the previous one, and the request is admitted while the returned count is within the limit. Services call it before queuing work: every job creation (research runs, notebook assistant turns, market, earnings and calendar refreshes, stock directory refreshes) shares the `job-create` bucket, and source fetches use `source-fetch`.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `bucket` | TEXT | No | - | Name of the limited action: `job-create` (30 per hour) or `source-fetch` (40 per hour). |
| `window_start` | INTEGER | No | - | Start of the window in epoch milliseconds: `floor(nowMs / windowMs) * windowMs`. |
| `count` | INTEGER | No | - | Requests counted in the window, including refused ones; starts at 1. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `bucket`, `window_start` | - | One counter per owner, bucket and window; the target of `consume`'s `ON CONFLICT … DO UPDATE SET count = count + 1`, and its prefix serves the prune. |

## Indexes

None. The primary key serves both statements of `consume`: the upsert on the full key and the prune as a range on `window_start` within `(owner_id, bucket)`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

The first `consume` call of a bucket in a new window inserts the row with `count = 1`. Callers: `researchRuns` (`create`, `createForTask`, `createIngest`, `createMarketRefresh`, `retry`), `notebook`, `watchlist` (earnings refresh), `stockDirectory` (directory refresh), `googleCalendar` (calendar sync) and `sources` (source fetch).

### Update

Each further `consume` in the same window increments `count` by 1 and returns it (`RETURNING count`); the caller refuses with `RATE_LIMITED` when it exceeds the limit.

### Delete

The second statement of every `consume` batch deletes the bucket's rows with `window_start` older than the previous window (`window_start < current - windowMs`).

### Synchronization

Not applicable: an internal counter with no external source.

### Retention

At most two windows (current and previous) per bucket survive a `consume`. A bucket that is no longer used keeps its last rows until its next call.

## Notes

- A refused request still increments `count`, so retries inside a window stay refused.
- A fixed window allows up to twice the limit across a window boundary.
