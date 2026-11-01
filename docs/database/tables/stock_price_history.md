# Table: stock_price_refetch

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_price_refetch` |
| Purpose | One row records that one directory stock owes a history refetch: a `stock-prices-sync` job found its split but could not refetch its window within the job's history cap (ADR-0058 §2 "Splits"). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0024_stock_price_days.sql` |
| Primary Key | `owner_id`, `market`, `symbol` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/stockPrices.ts` (`listRefetchSymbols`, `stockPriceStatements`) |
| Update Strategy | Insert-if-absent per `stock-prices-synced` completion; deleted when a stored history of the stock arrives |
| Data Retention | Until the stock's refetch is stored; a few hundred rows at most |

Both providers return split-adjusted prices, adjusted as of the request, so a split makes a stock's older stored bars inconsistent. A `stock-prices-synced` completion lists every split it found (`splitSymbols`) but refetches at most `STOCK_PRICE_LIMITS.maxHistoriesPerJob` windows. Each listed stock it stored no history for gets a row here. The plan (`planStockPrices` in `packages/application/src/stockPrices.ts`) names these stocks first, oldest request first, before the stocks with no series — only once no day of the window is due.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `symbol` | TEXT | No | - | The directory symbol (`stock_directory.symbol`) whose window is refetched. |
| `requested_at` | TEXT | No | - | ISO-8601 UTC API time of the completion that first found the split without refetching it; a later completion keeps it, so the plan's order is first-come. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `symbol` | - | One owed refetch per stock; the insert's conflict target and the key range the plan reads. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two directory markets. |

## Indexes

None. `listRefetchSymbols` reads one market's rows as a primary-key range and sorts them by `requested_at` in a temporary B-tree: a few hundred rows at most (a 10-day window's splits are a few dozen), so an index would cost a write per row for no measurable gain.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market`, `symbol` | `stock_directory` | `owner_id`, `market`, `symbol` | Many-to-one | Logical |

## Data Lifecycle

### Insert

A `stock-prices-synced` completion inserts one row per `splitSymbols` stock it carries no stored history for, joined to the market's `stock_directory` (a symbol not listed is never stored), with `ON CONFLICT (owner_id, market, symbol) DO NOTHING` — guarded on the job compare-and-set, in the same batch as the bars.

### Update

Never: an existing row keeps its first `requested_at`.

### Delete

The same completion deletes the row of every stock it stored a history for, whatever the history's reason (`requested` or `split`): those bars are adjusted as of that job. The delete runs before the insert of the owed rows.

### Synchronization

Follows the split listings of Massive (`GET /v3/reference/splits`) and J-Quants (`AdjFactor ≠ 1`) through `stock-prices-sync` jobs; the runner reports the splits, the API keeps the queue.

### Retention

Until the refetch is stored. A row whose stock left the directory is no longer planned (`listRefetchSymbols` joins the directory) and stays until the stock returns and is refetched — bounded by the number of splits.
