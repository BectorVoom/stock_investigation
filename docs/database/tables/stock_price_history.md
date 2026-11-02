# Table: stock_price_history

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_price_history` |
| Purpose | One row records that one directory stock's whole-window price history is pending: it owes a refetch after a split the job could not refetch within its cap, and/or its last history answer was `unavailable` and it is backed off (ADR-0058 §2 "Per-stock history", "Splits"). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0024_stock_price_days.sql` |
| Primary Key | `owner_id`, `market`, `symbol` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/stockPrices.ts` (`listRefetchSymbols`, `listUnfilledSymbols`, `stockPriceStatements`) |
| Update Strategy | Upsert per `stock-prices-synced` completion; deleted when a history of the stock is settled (stored or not found) |
| Data Retention | Until the stock's history is settled; a few hundred rows at most |

Both providers return split-adjusted prices, adjusted as of the request, so a split makes a stock's older stored bars inconsistent. A `stock-prices-synced` completion lists every split it found (`splitSymbols`) but refetches at most `STOCK_PRICE_LIMITS.maxHistoriesPerJob` windows; each listed stock it settled no history for owes a refetch here. A history answered `unavailable` (the plan refused it, or the request failed for that stock) is backed off for `STOCK_HISTORY_BACKOFF_HOURS` (24 h), so the stocks behind it in the queue get their turn. The plan (`planStockPrices` in `packages/application/src/stockPrices.ts`) names owed refetches first, oldest request first, then the stocks never filled — only once no day of the window is due, and neither while backed off.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `symbol` | TEXT | No | - | The directory symbol (`stock_directory.symbol`) whose window history is pending. |
| `refetch_requested_at` | TEXT | Yes | - | ISO-8601 UTC API time of the completion that first found the stock's split without refetching it; a later completion keeps it, so the refetch order is first-come. Null when the stock owes no refetch (only backed off). |
| `retry_at` | TEXT | Yes | - | ISO-8601 UTC API time before which the stock is not named again, after an `unavailable` history answer. Null when not backed off. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `symbol` | - | One pending history per stock; the upserts' conflict target and the key range the plan reads. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two directory markets. |
| (unnamed) | CHECK | `refetch_requested_at`, `retry_at` | `refetch_requested_at IS NOT NULL OR retry_at IS NOT NULL` | A row always has a reason: a refetch request or a back-off. |

## Indexes

None. `listRefetchSymbols` reads one market's rows as a primary-key range and sorts them by `refetch_requested_at` in a temporary B-tree; `listUnfilledSymbols` probes it by primary key per directory row. A market holds a few hundred rows at most (a 10-day window's splits are a few dozen), so an index would cost a write per row for no measurable gain.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market`, `symbol` | `stock_directory` | `owner_id`, `market`, `symbol` | Many-to-one | Logical |

## Data Lifecycle

### Insert

A `stock-prices-synced` completion inserts one row per `splitSymbols` stock it settled no history for (`refetch_requested_at` = the completion's API time) and one row per stock answered `unavailable` (`retry_at` = API time + 24 h), joined to the market's `stock_directory` (a symbol not listed is never stored) — guarded on the job compare-and-set, in the same batch as the bars.

### Update

The owed-refetch upsert keeps an existing `refetch_requested_at` (`coalesce`), so a stock that keeps missing the cap moves to the front of the queue, never to its back. The back-off upsert replaces `retry_at`.

### Delete

The same completion deletes the row of every stock whose history it settled — stored (whatever the reason, `requested` or `split`: those bars are adjusted as of that job) or not found. The delete runs before the inserts.

### Synchronization

Follows the split listings of Massive (`GET /stocks/v1/splits`) and J-Quants (`AdjFactor ≠ 1`) and the history answers of `stock-prices-sync` jobs; the runner reports them, the API keeps the queue.

### Retention

Until the history is settled. A row whose stock left the directory is no longer planned (both reads join the directory) and stays until the stock returns and is settled — bounded by the number of splits and failures.
