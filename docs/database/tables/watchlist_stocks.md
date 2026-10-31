# Table: watchlist_stocks

## Overview

| Property | Value |
|---|---|
| Table Name | `watchlist_stocks` |
| Purpose | One row holds one US or Japanese stock on the owner's watchlist, with its earnings-refresh state (FR-018). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 7. Watchlist and calendar |
| Created By | `infra/migrations/0007_watchlist_earnings.sql` |
| Primary Key | `owner_id`, `stock_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createWatchlistRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`earningsStatements`), `packages/adapters/src/sql/watchlistLists.ts` (membership guards and joins) |
| Update Strategy | Insert with an in-statement cap; set-based `UPDATE ... FROM json_each` per `earnings-refresh` completion |
| Data Retention | Kept until the owner removes the stock; at most 50 rows per owner |

The owner adds a stock with `POST /watchlist/stocks` and removes it with `DELETE /watchlist/stocks/:stockId`. `earnings-refresh` runner jobs fetch each stock's upcoming earnings dates (Finnhub for US, JPX for Japan); their completions update the stock's name, stamps and failure code and replace its `earnings_events`. Watchlist lists, the calendar export, Google Calendar sync and the watchlist widgets all read these rows.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `stock_id` | TEXT | No | - | `<market lowercased>:<symbol>`, e.g. `us:AAPL`, `jp:7203` (`formatStockId` / `parseStockId`). |
| `market` | TEXT | No | - | `US` or `JP` (`watchMarketSchema`, checked on read). |
| `symbol` | TEXT | No | - | Ticker: a US symbol of 1-10 uppercase letters, digits, dots or dashes starting with a letter, or a 4-character JP code starting with a digit. |
| `name` | TEXT | Yes | - | Company name: the stock directory's English name when the stock is added (ADR-0034), else NULL; an earnings refresh that returns a name replaces it (at most 200 characters). |
| `added_at` | TEXT | No | - | ISO-8601 UTC time the stock was added; the watchlist order (`ORDER BY added_at, rowid`). |
| `last_refreshed_at` | TEXT | Yes | - | ISO-8601 UTC time of the last earnings fetch attempt (the runner's `fetchedAt`); NULL until the first refresh. |
| `retrieved_at` | TEXT | Yes | - | ISO-8601 UTC time of the last successful earnings fetch (including `NO_SCHEDULED_DATE`); NULL until one succeeds. |
| `unavailable_code` | TEXT | Yes | - | Code of the last attempt's outcome (`earningsUnavailableCodeSchema`: `NEVER_REFRESHED`, `SOURCE_NOT_CONFIGURED`, `SOURCE_AUTH_FAILED`, `SYMBOL_NOT_FOUND`, `PLAN_NOT_ENTITLED`, `RATE_LIMITED`, `NO_SCHEDULED_DATE`, `SOURCE_FAILED`); NULL after a dated success. |
| `unavailable_upstream_status` | INTEGER | Yes | - | HTTP status the earnings source answered with behind `unavailable_code`, unchanged (ADR-0037); NULL when no provider answer caused the failure. Added by `0012_upstream_status.sql`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `stock_id` | - | A stock is on the watchlist at most once; an idempotent re-add hits `ON CONFLICT DO NOTHING`. |

## Indexes

None. The primary key serves every read: `listStocks` and `countStocks` read the owner's prefix (at most 50 rows), `getStock`, the completion updates and the list-membership guards look up `(owner_id, stock_id)`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`createWatchlistRepository().insertStock` (`POST /watchlist/stocks`) inserts the stock with NULL stamps. The cap of 50 (`WATCHLIST_LIMITS.maxStocks`) is part of the `INSERT ... SELECT ... WHERE (SELECT count(*) ...) < ?` statement, so two concurrent adds cannot exceed it. `ON CONFLICT DO NOTHING` makes a re-add idempotent.

### Update

`earningsStatements` in an `earnings-refresh` completion, guarded on the job compare-and-set. A success or `NO_SCHEDULED_DATE` sets `last_refreshed_at`, `retrieved_at`, `unavailable_code` and `unavailable_upstream_status`, and `name = coalesce(new, stored)`. Any other failure sets only `last_refreshed_at`, `unavailable_code` and `unavailable_upstream_status`. Both are UPDATE-only, so a stock removed meanwhile is not re-created.

### Delete

`removeStock` (`DELETE /watchlist/stocks/:stockId`) runs one batch: it raises the version of every list holding the stock, deletes its `watchlist_list_stocks` rows, its `earnings_events` rows, and the stock row. The service then deletes price series no page tracks any more.

### Synchronization

Earnings dates follow Finnhub (US) and JPX's published schedule (JP) through `earnings-refresh` jobs (`POST /watchlist/refresh`, scope `all` or `unrefreshed`). An `unrefreshed` job fetches only stocks never refreshed or whose last fetch failed (ADR-0039).

### Retention

Kept until the owner removes the stock; at most 50 rows per owner.

## Notes

- The insertion order relies on `rowid` to break `added_at` ties, so the table must stay a rowid table.
- Earnings dates are personal-use vendor data and are not part of workspace export/import (ADR-0016).
