# Table: market_observations

## Overview

| Property | Value |
|---|---|
| Table Name | `market_observations` |
| Purpose | One row holds one dated value of one market series, as Home and notebook widgets chart and show it. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0006_market_data.sql` |
| Primary Key | `owner_id`, `series_id`, `observed_on` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/repositories.ts` (`createMarketRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`marketStatements`) |
| Update Strategy | Set-based delete of replaced rows, upsert of answered points, prune; all in one guarded completion batch |
| Data Retention | The 1,500 newest observations per series (`MARKET_LIMITS.maxStoredObservations`) |

Each `market-refresh` completion merges the runner's answer into the stored history: rows the answer replaces but does not hold are deleted, every answered point is upserted, and each series is pruned to its newest 1,500 rows. The stored result equals the domain's `mergeHistory` (ADR-0044). Reads take the newest N rows per series for the widgets and the per-series refresh state for the next claim.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `series_id` | TEXT | No | - | The series (`market_series.series_id`), `<provider>:<symbol>`. |
| `observed_on` | TEXT | No | - | Observation date, `YYYY-MM-DD`. |
| `value` | REAL | No | - | Observed value as reported by the provider, in the series' unit. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `series_id`, `observed_on` | - | One value per series and date; the upsert's conflict target, and (in a `WITHOUT ROWID` table) the table itself, so a series' history is one contiguous key range. |

## Indexes

None. The primary key serves every read: `getObservations` (newest N per series), `getRefreshState` (`max(observed_on)` and the 32-row backward seek for the anchor) and the completion's replace and prune deletes are all key range seeks on `(owner_id, series_id)`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `series_id` | `market_series` | `owner_id`, `series_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`marketStatements` in `commitCompletion` for a `market-refresh` completion upserts the answered points in chunks of `json_each` JSON (each well under 1 MB of bound text), guarded on the job compare-and-set.

### Update

The same upsert's `ON CONFLICT (owner_id, series_id, observed_on) DO UPDATE SET value = excluded.value WHERE excluded.value <> market_observations.value` rewrites a row only when the provider revised its value.

### Delete

Three paths. A history write first deletes, per chunk of series, the stored rows from `replaceFrom` on that the answer does not hold (withdrawn or superseded points). The last statement of the completion prunes each series to its newest 1,500 rows. `deleteSeriesNotIn` deletes all observations of untracked series in the same batch as their `market_series` rows.

### Synchronization

Incremental (ADR-0044): the claim sends each series' anchor, the 32nd newest stored observation. The runner fetches the window from the anchor's date; when the answer holds the anchor with the same value, the completion replaces only rows from that date on. When it does not (a split re-adjusted older closes, a revision), and every 7 days, the series is fetched and replaced in full. A failed series keeps its stored observations.

### Retention

At most 1,500 rows per series, kept while the series is tracked.

## Notes

- Performance: the replace delete uses a `MATERIALIZED` CTE and `EXCEPT` instead of a row-value `NOT IN` (measured 25 s for 30 x 1,500 rows otherwise), and the prune seeks one cutoff per series (3 ms instead of 54 ms for 60 x 1,500 rows). A full 60-series completion costs at most 17 statements here, within the D1 query budget.
- No secondary index on purpose: on D1 every index entry is an extra billed row write.
- Materials observations live in `metal_observation`; `getObservations` merges them in with `UNION ALL`.
