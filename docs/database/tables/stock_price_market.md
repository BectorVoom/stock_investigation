# Table: stock_price_market

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_price_market` |
| Purpose | One row holds, for one market, the newest day the runner's split check covered completely: the next `stock-prices-sync` claim's `adjustmentsSince` (ADR-0058 §2 "Splits"). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0024_stock_price_days.sql` |
| Primary Key | `owner_id`, `market` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/stockPrices.ts` (`getSplitCheckedOn`, `stockPriceStatements`) |
| Update Strategy | Upsert per `stock-prices-synced` completion that reports `splitCheckedThrough`; only moves forward |
| Data Retention | Kept indefinitely; at most two rows per owner |

Both providers return split-adjusted prices, adjusted as of the request, so a split effective after a stock's stored bars makes them inconsistent. The claim carries `adjustmentsSince` (this row, null when there is none); the runner checks the splits after it — US: Massive's splits listing, JP: `AdjFactor ≠ 1` on a fetched day newer than it — and reports in `splitCheckedThrough` how far the check ran completely, null when it did not run or did not finish (a rate limit, a failed listing page). The watermark is kept apart from `stock_price_day` because a stored day does not prove its splits were checked.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `split_checked_on` | TEXT | No | - | YYYY-MM-DD in the market's zone: the newest day through which the market's splits were checked; never past the newest day of the job's claimed window. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market` | - | One watermark per market; the upsert's conflict target and the claim's key lookup. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two directory markets. |

## Indexes

None. The claim reads one full key (`getSplitCheckedOn`) and the completion upserts one.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market` | `stock_directory_meta` | `owner_id`, `market` | One-to-one | Logical |

## Data Lifecycle

### Insert

A `stock-prices-synced` completion whose `splitCheckedThrough` is not null inserts the market's row (`stockPriceStatements`), guarded on the job compare-and-set and in the same batch as the bars.

### Update

`ON CONFLICT (owner_id, market) DO UPDATE SET split_checked_on = max(stock_price_market.split_checked_on, excluded.split_checked_on)`: only forward, so an older job finishing last never re-opens checked days.

### Delete

Never: no code path deletes rows. Only the rollback of migration 0024 drops the table.

### Synchronization

Follows Massive's splits listing (`GET /stocks/v1/splits`) and J-Quants' `AdjFactor` through `stock-prices-sync` jobs.

### Retention

Kept indefinitely: one row per market.
