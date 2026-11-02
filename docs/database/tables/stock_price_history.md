# Table: stock_price_history

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_price_history` |
| Purpose | One row records that one directory stock's whole-window price history is pending: it owes a refetch after a split the job could not refetch within its cap, or its last history answer was `unavailable` and it is backed off (ADR-0058 §2). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0024_stock_price_days.sql` |
| Primary Key | `owner_id`, `market`, `symbol` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/stockPrices.ts` (`listRefetchSymbols`, `listUnfilledSymbols`, `stockPriceStatements`) |
| Update Strategy | Upsert per `stock-prices-synced` completion; deleted when a stored or not-found history of the stock arrives |
| Data Retention | Until the stock's history is settled; a few hundred rows at most |

Once no day of a market's window is due, a `stock-prices-sync` claim names up to `STOCK_PRICE_LIMITS.maxHistoriesPerJob` stocks whose whole window the runner fetches (`planStockPrices` in `packages/application/src/stockPrices.ts`): first the stocks that owe a refetch (`refetch_requested_at`, oldest first), then the directory stocks with no filled price series (`market_series.history_checked_at` NULL), Watchlist stocks first. A row's `retry_at` keeps its stock out of both lists until then, so the stocks behind it in the queue get their turn.

Both providers return split-adjusted prices, adjusted as of the request, so a split makes a stock's older stored bars inconsistent. A completion lists every split it found (`splitSymbols`) but refetches at most the cap; each listed stock it stored no history for owes a refetch here.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `symbol` | TEXT | No | - | The directory symbol (`stock_directory.symbol`) whose window is pending. |
| `refetch_requested_at` | TEXT | Yes | - | ISO-8601 UTC API time of the completion that first found the stock's split without refetching it; NULL when the stock owes no refetch. A later completion keeps it, so the refetch queue is first-come. |
| `retry_at` | TEXT | Yes | - | ISO-8601 UTC API time before which the stock is not named (an `unavailable` history answer: completion time + `STOCK_HISTORY_BACKOFF_HOURS`); NULL when not backed off. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `symbol` | - | One pending history per stock; the upserts' conflict target and the key range the plan reads. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two directory markets. |
| (unnamed) | CHECK | `refetch_requested_at`, `retry_at` | `refetch_requested_at IS NOT NULL OR retry_at IS NOT NULL` | Every row has a reason: a refetch request, a back-off, or both. |

## Indexes

None. `listRefetchSymbols` reads one market's rows as a primary-key range and sorts them by `refetch_requested_at` in a temporary B-tree: a few hundred rows at most (a 10-day window's splits are a few dozen), so an index would cost a write per row for no measurable gain. `listUnfilledSymbols` checks one stock's back-off with a full-key seek.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market`, `symbol` | `stock_directory` | `owner_id`, `market`, `symbol` | Many-to-one | Logical |

## Data Lifecycle

### Insert

A `stock-prices-synced` completion inserts, joined to the market's `stock_directory` (a symbol not listed is never stored) and guarded on the job compare-and-set in the same batch as the bars: one row per `splitSymbols` stock it stored no history for (`refetch_requested_at` = the completion time), and one row per stock whose history answer was `unavailable` (`retry_at`).

### Update

The refetch upsert keeps an existing `refetch_requested_at` (`coalesce`): a stock that keeps missing the cap moves to the front of the queue, never to its back. The back-off upsert sets `retry_at` and keeps `refetch_requested_at`.

### Delete

The same completion deletes the row of every stock it stored, or found not to exist, a history for, whatever the history's reason (`requested` or `split`): those bars are adjusted as of that job. The delete runs before the inserts.

### Synchronization

Follows the split listings of Massive (`GET /stocks/v1/splits`) and J-Quants (`AdjFactor ≠ 1`) and the per-stock history answers, through `stock-prices-sync` jobs; the runner reports, the API keeps the queue.

### Retention

Until the history is settled. A row whose stock left the directory is no longer planned (both lists join the directory) and stays until the stock returns — bounded by the number of splits and back-offs.
