# Table: stock_price_day

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_price_day` |
| Purpose | One row records what a provider answered for one market's trading date in a `stock-prices-sync` job, so the day planner never asks a final date again and asks a not-yet-available one again later (ADR-0058 §2). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0024_stock_price_days.sql` |
| Primary Key | `owner_id`, `market`, `trading_on` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/stockPrices.ts` (`createStockPriceRepository`, `stockPriceStatements`) |
| Update Strategy | Upsert per `stock-prices-synced` completion; a final row is never overwritten |
| Data Retention | Kept indefinitely; at most one row per market and weekday (≈ 260 a year per market) |

Every directory stock's daily bars are fetched one market and one date per request (Massive's grouped daily bars for US, J-Quants' daily bars by date for JP). This table is the plan's memory: the claim-time schedule and the claim (`planStockPrices` in `packages/application/src/stockPrices.ts`) read one market's rows of the last `STOCK_PRICE_LIMITS.historyDays` days and hand them to the Lean-verified `planSyncDays`, which leaves out every `stored`, `no-trading` and `too-old` day and every `not-yet-available` day whose `retry_at` has not come. The newest `stored` row is also the claim's `adjustmentsSince` (split refetches). The bars themselves are in `market_observations`.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `trading_on` | TEXT | No | - | The trading date asked for, YYYY-MM-DD in the market's zone (America/New_York, Asia/Tokyo); always a weekday. |
| `outcome_code` | TEXT | No | - | `stored` (bars returned), `no-trading` (no bars for a day old enough to be final: a holiday), `not-yet-available` (no bars yet, or newer than the plan's delay), `too-old` (before the plan's history) — `stockPriceDayOutcomeSchema`. |
| `bar_count` | INTEGER | No | - | Bars the runner reported for the day, before the API kept only directory stocks; positive exactly for `stored`. |
| `checked_at` | TEXT | No | - | ISO-8601 UTC time the runner fetched the day (the completion's `fetchedAt`). |
| `retry_at` | TEXT | Yes | - | ISO-8601 UTC API time from which a `not-yet-available` day is due again (completion time + `STOCK_PRICE_LIMITS.retryHours`); NULL for the final outcomes. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `trading_on` | - | One outcome per market and date; the upsert's conflict target, and the key range the plan reads. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two directory markets. |
| (unnamed) | CHECK | `outcome_code` | `outcome_code IN ('stored', 'no-trading', 'not-yet-available', 'too-old')` | The four outcomes of ADR-0058 §2. |
| (unnamed) | CHECK | `outcome_code`, `bar_count` | `bar_count >= 0 AND ((outcome_code = 'stored') = (bar_count > 0))` | Only a stored day carries bars, and it carries at least one. |
| (unnamed) | CHECK | `outcome_code`, `retry_at` | `(outcome_code = 'not-yet-available') = (retry_at IS NOT NULL)` | Exactly a not-yet-available day has a retry time. |

## Indexes

None. The primary key serves every read: `listDays` reads one market's `[oldest, newest]` window as one key range (at most ~520 rows, newest first), and the completion's upsert targets full keys.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market` | `stock_directory_meta` | `owner_id`, `market` | Many-to-one | Logical |

## Data Lifecycle

### Insert

A `stock-prices-synced` completion (`POST /api/v1/runner/jobs/:id/complete`) inserts one row per reported day with one `json_each` statement in `stockPriceStatements`, guarded on the job compare-and-set and in the same batch as the day's bars and series rows.

### Update

The same statement upserts with `ON CONFLICT (owner_id, market, trading_on) DO UPDATE … WHERE stock_price_day.outcome_code = 'not-yet-available'`: only a not-yet-available day is overwritten (by its retry's answer); a final outcome stays as it is even if a stale duplicate job reports the day again.

### Delete

Never: no code path deletes rows. Only the rollback of migration 0024 drops the table.

### Synchronization

Follows Massive (US) and J-Quants (JP) through `stock-prices-sync` jobs the API queues at claim time (`materializeDue` in `packages/application/src/dataSync.ts`): one job per market while no job of that market is active, the market's directory is stored and a day is due, at most `STOCK_PRICE_LIMITS.maxDaysPerJob` days per job, newest first. A failed job stores nothing; the next one is queued `SYNC_RETRY_MS` later.

### Retention

Kept indefinitely. Rows older than the planning window are never read again; the table grows by about 260 rows a year per market.

## Notes

- `trading_on` follows the `_on` convention for calendar dates (conventions §4); the ADR-0058 brief called the column `trade_date`.
- External dependencies: Massive (`MASSIVE_API_KEY`) and J-Quants (`JQUANTS_API_KEY`) on the runner. Without a key the job fails `SOURCE_NOT_CONFIGURED`, no row is written, and the market is tried again after `SYNC_RETRY_MS`.
