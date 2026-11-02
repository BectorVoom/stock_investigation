# Table: stock_price_market

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_price_market` |
| Purpose | One row per market records the newest day the runner's split check covered completely: the `adjustmentsSince` of that market's next `stock-prices-sync` claim (ADR-0058 §2 "Splits"). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0024_stock_price_days.sql` |
| Primary Key | `owner_id`, `market` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/stockPrices.ts` (`getSplitCheckedOn`, `stockPriceStatements`) |
| Update Strategy | Upsert per `stock-prices-synced` completion that reports `splitCheckedThrough`; only moves forward |
| Data Retention | For the life of the owner; two rows |

A split effective after the newest day whose bars are stored makes the older stored bars inconsistent. The claim carries `adjustmentsSince` (this row's `split_checked_on`, null when the market was never checked); the runner lists the splits after it and reports how far its check got (`splitCheckedThrough`, null when a rate limit ended the check). The service clamps that day to the claim's window end before it is stored here.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `split_checked_on` | TEXT | No | - | ISO date (YYYY-MM-DD, the market's local date): every split effective on or before it has been found. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market` | - | One watermark per market; the upsert's conflict target and the claim's one-key read. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two directory markets. |

## Indexes

None besides the primary key: the only read is one key.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market` | `stock_directory_meta` | `owner_id`, `market` | Many-to-one | Logical |

## Data Lifecycle

### Insert

The first `stock-prices-synced` completion of a market whose split check finished inserts the row — guarded on the job compare-and-set, in the same batch as the bars.

### Update

A later completion sets `split_checked_on = max(stored, reported)`: an older job finishing last never re-opens checked days.

### Delete

Never by the application.

### Synchronization

Follows the split listings of Massive (`GET /stocks/v1/splits`) and J-Quants (`AdjFactor ≠ 1` on fetched days) through `stock-prices-sync` jobs.

### Retention

Kept. Dropping it (rollback of 0024) costs one wider split check on the next job.
