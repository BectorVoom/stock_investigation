# Table: stock_earnings_calendar_market

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_earnings_calendar_market` |
| Purpose | One row holds when one market's earnings calendar (`stock_earnings_calendar`) was last stored and for which window (ADR-0068). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0032_stock_earnings_calendar.sql` |
| Primary Key | `owner_id`, `market` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/earningsCalendar.ts` (`earningsCalendarStatements`, `createEarningsCalendarRepository`) |
| Update Strategy | Upsert per `earnings-calendar-synced` completion |
| Data Retention | Kept indefinitely; at most two rows per owner |

The schedule queues a market's `earnings-calendar-sync` once `synced_at` is 24 hours old (or the row is missing), and the Stocks page tells a stock with no rows "none listed" only when this row exists ("not fetched yet" otherwise).

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `synced_at` | TEXT | No | - | ISO instant the runner fetched the calendar (`fetchedAt`). |
| `from_date` | TEXT | No | - | First day of the fetched window, `YYYY-MM-DD` (UTC). |
| `to_date` | TEXT | No | - | Last day of the fetched window, `YYYY-MM-DD` (UTC). |
| `event_count` | INTEGER | No | - | Rows the completion carried, before the stock-list filter. |
| `truncated_dates` | TEXT | No | - | JSON array of the days whose one-day Finnhub answer still hit the row cap (some announcements of those days may be missing); `[]` for JP. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market` | - | One row per market; the upsert's conflict target. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two stock-list markets. |
| (unnamed) | CHECK | `from_date`, `to_date` | `from_date <= to_date` | A window runs forward. |
| (unnamed) | CHECK | `event_count` | `event_count >= 0` | A count. |
| (unnamed) | CHECK | `truncated_dates` | `json_valid(truncated_dates) AND json_type(truncated_dates) = 'array'` | A JSON array. |

## Indexes

None. The schedule and the Stocks page read one full key.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market` | `stock_directory_meta` | `owner_id`, `market` | One-to-one | Logical |

## Data Lifecycle

### Insert

The first `earnings-calendar-synced` completion of a market inserts its row, guarded on the job compare-and-set and in the batch that replaces the market's `stock_earnings_calendar` rows.

### Update

Every later completion of the market overwrites every column (`ON CONFLICT (owner_id, market) DO UPDATE`).

### Delete

Never: no code path deletes rows. Only the rollback of migration 0032 drops the table.

### Synchronization

Written by `earnings-calendar-sync` jobs (Finnhub for US, JPX for JP).

### Retention

Kept indefinitely: one row per market.
