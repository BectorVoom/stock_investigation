# Table: market_series

## Overview

| Property | Value |
|---|---|
| Table Name | `market_series` |
| Purpose | One row holds the metadata and refresh state of one FRED or Twelve Data market series that Home, a notebook or a watchlist list tracks. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0006_market_data.sql` |
| Primary Key | `owner_id`, `series_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createMarketRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`marketStatements`) |
| Update Strategy | Set-based upsert per `market-refresh` completion |
| Data Retention | Deleted when no page tracks the series any more |

The runner fetches series for `market-refresh` jobs, and each completion upserts one row per series it handled: metadata and both stamps on success, only the failure code and attempt time on failure. The market-refresh claim reads the refresh state (`last_refreshed_at`, `unavailable_code`, `history_checked_at`) to decide which series to fetch and whether a full history fetch is due (ADR-0039, ADR-0044). Home and the notebooks read the metadata beside the observations. Series that no page tracks are deleted after Home saves and watchlist list changes.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `series_id` | TEXT | No | - | `<provider>:<symbol>`, parsed by `parseMarketSeriesId` (e.g. `fred:DGS10`, `twelve-data:AAPL`, `twelve-data:7203:JPX`). |
| `provider` | TEXT | No | - | `fred` or `twelve-data`; materials series live in `metal_series` and are only merged in at read time. |
| `symbol` | TEXT | No | - | Provider symbol, the part of `series_id` after the provider. |
| `title` | TEXT | No | - | Series title from the provider; the symbol for a series whose first fetch failed. |
| `unit` | TEXT | No | - | Unit text from the provider; empty for a series whose first fetch failed. |
| `frequency` | TEXT | No | - | `daily`, `weekly`, `monthly`, `quarterly`, `annual` or `unknown` (checked on read); `unknown` for a series whose first fetch failed. |
| `publisher` | TEXT | No | - | Data publisher shown as the source; empty for a series whose first fetch failed. |
| `source_url` | TEXT | No | - | Source page URL; for a failed first fetch, the FRED series page or `https://twelvedata.com/`. |
| `last_refreshed_at` | TEXT | Yes | - | ISO-8601 UTC time of the last fetch attempt (the runner's `fetchedAt`), success or failure. |
| `retrieved_at` | TEXT | Yes | - | ISO-8601 UTC time of the last successful fetch; NULL until one succeeds. |
| `unavailable_code` | TEXT | Yes | - | Failure code of the last attempt (`NEVER_REFRESHED`, `SOURCE_NOT_CONFIGURED`, `SOURCE_AUTH_FAILED`, `SERIES_NOT_FOUND`, `PLAN_NOT_ENTITLED`, `RATE_LIMITED`, `NO_DATA`, `SOURCE_FAILED`); NULL after a success. |
| `unavailable_upstream_status` | INTEGER | Yes | - | HTTP status the provider answered with behind `unavailable_code`, unchanged (ADR-0037); NULL when no provider answer caused the failure. Set and cleared with the code. Added by `0012_upstream_status.sql`. |
| `history_checked_at` | TEXT | Yes | - | ISO-8601 UTC API time of the last completion that stored the series with a `full` history write; NULL until one happens. A full fetch is due when it is NULL or 7 days old (`HISTORY_FULL_CHECK_DAYS`). Added by `0019_market_history_check.sql`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `series_id` | - | One row per series; the upsert's conflict target and the lookup key of every read. |

## Indexes

None. The primary key serves every read: `getSeriesMeta` and `getRefreshState` look up a list of series ids by `(owner_id, series_id)`, and `deleteSeriesNotIn` walks the `owner_id` prefix.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`marketStatements` in `commitCompletion` for a `market-refresh` completion. A succeeded series is inserted with its metadata from one `json_each` statement; a series whose first fetch failed gets a placeholder row (title = symbol, empty unit and publisher, `unknown` frequency) so the failure is visible instead of `NEVER_REFRESHED`. Both statements are guarded on the job compare-and-set.

### Update

The same statements upsert with `ON CONFLICT (owner_id, series_id) DO UPDATE`. A success rewrites the metadata, sets `last_refreshed_at` and `retrieved_at`, clears `unavailable_code` and `unavailable_upstream_status`, and sets `history_checked_at` to the completion time only for a `full` history write (`coalesce` keeps the old stamp otherwise). A failure sets only `last_refreshed_at`, `unavailable_code` and `unavailable_upstream_status`.

### Delete

`createMarketRepository().deleteSeriesNotIn` deletes every series (and, first in the same batch, its observations) that the keep list does not name. The keep list is every series Home, any notebook or any listed watchlist list tracks (`ownerSeries().keep`). It runs after `PUT /home/dashboard`, `POST /home/dashboard/reset`, removing a watchlist stock, deleting a list and removing a stock from a list.

### Synchronization

Follows FRED and Twelve Data through `market-refresh` runner jobs (`POST /home/refresh`, scope `all` or `unrefreshed`). The claim sends each tracked series with its newest stored date, its history anchor (the 32nd newest observation) and whether a full fetch is due, so the runner fetches only the recent window except every 7 days (ADR-0044). An `unrefreshed` job fetches only series never refreshed or without data (ADR-0039).

### Retention

Kept while a page tracks the series. A claim fetches at most 60 tracked series (`MARKET_LIMITS.maxTrackedSeries`).

## Notes

- A notebook save or a conversation delete does not run the clean-up, so a series only a removed notebook widget named stays until the next Home save or list change.
- No foreign key from `market_observations`: `deleteSeriesNotIn` deletes the children first in the same batch.
- External dependencies: FRED and Twelve Data (API keys on the runner). Market data is personal-use vendor data and is not part of workspace export/import (ADR-0014).
