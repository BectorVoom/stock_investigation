# Table: market_observations

## Overview

| Property | Value |
|---|---|
| Table Name | `market_observations` |
| Purpose | One row holds one dated value of one market series — with the day's open, high, low and volume when the provider reported them (ADR-0056) — as Home, the notebooks and the Stocks page chart and show it. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0006_market_data.sql`; bar columns `0023_market_observation_bars.sql` |
| Primary Key | `owner_id`, `series_id`, `observed_on` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/repositories.ts` (`createMarketRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`marketStatements`), `packages/adapters/src/sql/stockPrices.ts` (`stockPriceStatements`, ADR-0058 §2) |
| Update Strategy | Set-based delete of replaced rows, upsert of answered points, prune; all in one guarded completion batch |
| Data Retention | The 1,500 newest observations per series refreshed by `market-refresh` (`MARKET_LIMITS.maxStoredObservations`); a directory stock's bars are not pruned (see Retention) |

Each `market-refresh` completion merges the runner's answer into the stored history: rows the answer replaces but does not hold are deleted, every answered point is upserted, and each series is pruned to its newest 1,500 rows. The stored result equals the domain's `mergeHistory` (ADR-0044). Since ADR-0058 §2 every directory stock's daily bars are written by `stock-prices-sync` completions instead (Massive for US, J-Quants for JP), under the stock's existing price series id (`twelve-data:AAPL`, `twelve-data:1380:JPX` — a legacy namespace, not the source), so the widgets, the chart viewer and the Stocks page read them unchanged. Reads take the newest N rows per series for the widgets and the per-series refresh state for the next claim.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `series_id` | TEXT | No | - | The series (`market_series.series_id`), `<provider>:<symbol>`. |
| `observed_on` | TEXT | No | - | Observation date, `YYYY-MM-DD`. |
| `value` | REAL | No | - | Observed value as reported by the provider, in the series' unit; the close when the row has a bar. |
| `open_value` | REAL | Yes | - | The day's open (Twelve Data `open`, Massive `o`, J-Quants `O`); NULL when the answer carried no bar (FRED, a runner from before ADR-0056, a row the runner's bar check dropped). Added by `0023_market_observation_bars.sql`. |
| `high_value` | REAL | Yes | - | The day's high; set exactly when `open_value` is. Added by `0023`. |
| `low_value` | REAL | Yes | - | The day's low; set exactly when `open_value` is. Added by `0023`. |
| `volume` | REAL | Yes | - | Traded volume of the day, ≥ 0; NULL without a bar and when the provider reports none (currency and metal pairs). REAL, not INTEGER: the wire number is a JSON number and a fractional volume (crypto) must round-trip. Added by `0023`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `series_id`, `observed_on` | - | One value per series and date; the upsert's conflict target, and (in a `WITHOUT ROWID` table) the table itself, so a series' history is one contiguous key range. |
| (unnamed) | CHECK | `open_value`, `high_value`, `low_value` | `(open_value IS NULL AND high_value IS NULL AND low_value IS NULL) OR (open_value IS NOT NULL AND high_value IS NOT NULL AND low_value IS NOT NULL)` | A bar is whole or absent (on `low_value`, the last price column `0023` adds, so it can name all three). |
| (unnamed) | CHECK | `low_value`, `volume` | `volume IS NULL OR (volume >= 0 AND low_value IS NOT NULL)` | A volume belongs to a bar and is never negative. |

## Indexes

None. The primary key serves every read: `getObservations` (newest N per series; Home, the notebooks and the Stocks page's Chart tab, ADR-0049), `getRefreshState` (`max(observed_on)` and the 32-row backward seek for the anchor) and the completion's replace and prune deletes are all key range seeks on `(owner_id, series_id)`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `series_id` | `market_series` | `owner_id`, `series_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`marketStatements` in `commitCompletion` for a `market-refresh` completion upserts the answered points, each with its bar or NULLs, in chunks of `json_each` JSON (each well under 1 MB of bound text), guarded on the job compare-and-set. `stockPriceStatements` does the same for a `stock-prices-synced` completion: every bar of its stored days, then of its stored histories (which win a shared date), in chunks of 4,000 (a full 10-day US completion, ~110,000 bars, is 28 statements); each statement joins `stock_directory`, so only directory stocks' bars are stored and the series id is computed in SQL from the directory row.

### Update

The same upsert's `ON CONFLICT (owner_id, series_id, observed_on) DO UPDATE` sets the value and the four bar columns from the answer and rewrites a row only when one of them differs (`<>` for the value, `IS NOT` for the nullable bar columns). A newer answer for a day therefore replaces that day's stored bar, with NULLs when it carries none (a runner from before ADR-0056).

### Delete

Four paths. A history write first deletes, per chunk of series, the stored rows from `replaceFrom` on that the answer does not hold (withdrawn or superseded points). The last statement of the completion prunes each series to its newest 1,500 rows. A `stock-prices-synced` history answered `stored` deletes the stock's rows in its `[from, to]` window that the answer does not hold (a split refetch replaces the window). `deleteSeriesNotIn` deletes the observations of the `market_series` rows it deletes (found through those rows, one key range each), in the same batch — never a directory stock's price series (ADR-0058 §2).

### Synchronization

Incremental (ADR-0044): the claim sends each series' anchor, the 32nd newest stored observation. The runner fetches the window from the anchor's date; when the answer holds the anchor with the same value, the completion replaces only rows from that date on. When it does not (a split re-adjusted older closes, a revision), and every 7 days, the series is fetched and replaced in full. A failed series keeps its stored observations.

### Retention

At most 1,500 rows per `market-refresh` series, kept while the series is tracked. A directory stock's bars are kept while the stock is in the directory and are not pruned: `stock-prices-sync` adds about 250 a year per stock to a two-year backfill (≈ 11,400 stocks × 520 days ≈ 6 M rows at first, ≈ 70 B each). A prune for them is recorded technical debt, needed after about four years when a series passes 1,500 rows.

## Notes

- Why column CHECKs and no table rebuild (ADR-0056 §3): SQLite accepts a CHECK in `ALTER TABLE ... ADD COLUMN` and tests it against the existing rows, which all hold NULL, so `0023` enforces the invariants without copying the table. The bar's consistency with its close (`low ≤ open, close ≤ high`) is not a CHECK: the contract refuses an inconsistent bar at the API boundary (`isConsistentBar`), and a failed CHECK would roll back the whole completion over a comparison of re-parsed floating-point text.
- `0023` also cleared `market_series.history_checked_at` of every Twelve Data series, so each one's next sync is a full fetch that stores the bars of its newest 800 days; older rows may stay close-only.

- Performance: the replace delete uses a `MATERIALIZED` CTE and `EXCEPT` instead of a row-value `NOT IN` (measured 25 s for 30 x 1,500 rows otherwise), and the prune seeks one cutoff per series (3 ms instead of 54 ms for 60 x 1,500 rows). A full completion of every tracked series (110 x 800) costs at most 29 statements here (22 of them upserts of 4,000 points each, every point a 7-element JSON array so the bar adds no key text), within the D1 query budget.
- No secondary index on purpose: on D1 every index entry is an extra billed row write.
- Materials observations live in `metal_observation`; `getObservations` merges them in with `UNION ALL`.
