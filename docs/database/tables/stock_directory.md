# Table: stock_directory

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_directory` |
| Purpose | One row per exchange-listed US or Japanese stock, a local copy of the SEC and JPX lists that the Watchlist's add-a-stock search reads (ADR-0034). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 9. Stock directory |
| Created By | `infra/migrations/0011_stock_directory.sql` |
| Primary Key | `owner_id`, `market`, `symbol` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`stockDirectoryStatements`), `packages/adapters/src/sql/repositories.ts` (`createStockDirectoryRepository`) |
| Update Strategy | Whole-market replace on each `stock-directory-refreshed` completion; in-place re-key when the fold version changes |
| Data Retention | Replaced on every successful refresh of the market; never pruned otherwise |

The runner downloads one market's list per `stock-directory-refresh` job (SEC for US, JPX for JP), and its completion replaces that market's rows all or nothing in the job's guarded batch. The folded search keys are computed in TypeScript at insert (`stockSearchKeys`, `stockSearchHaystack` in `packages/domain`), never in SQL, so the SQL ranking reads the same keys as the domain reference `rankStockSearch`. The Watchlist search reads the table on every query; adding a stock reads one row to take its company name.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `symbol` | TEXT | No | - | Ticker (US) or securities code (JP) as the source lists it. |
| `name` | TEXT | No | - | Company name: SEC's name for US rows; for JP rows JPX's English name, or the Japanese name when the English list lacks the code. |
| `local_name` | TEXT | Yes | - | Japanese company name (銘柄名) of a JP listing; NULL for US rows. |
| `listing` | TEXT | No | - | Where it trades (`stockListingSchema`): `nasdaq`, `nyse`, `cboe`, `txse` for US; `tse-prime`, `tse-standard`, `tse-growth` for JP. |
| `symbol_key` | TEXT | No | - | Folded `symbol` (NFKC, ASCII lower-case, hiragana to katakana, whitespace collapsed); decides tiers 0 and 1. |
| `name_key` | TEXT | No | - | Folded `name`; decides tier 2. |
| `local_name_key` | TEXT | No | - | Folded `local_name`, or `''` when `local_name` is NULL; decides tier 2. |
| `search_key` | TEXT | No | - | `symbol_key`, `name_key` and `local_name_key` joined by newlines: every query term must be a substring of it. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `symbol` | - | One row per listed symbol per market; `getEntry` seeks it, and `search`, `listEntries` and the replace read the owner's (or market's) prefix range. |

## Indexes

None. Every access path is a primary-key prefix: `search` reads the owner's rows as one contiguous range of the `WITHOUT ROWID` B-tree, `listEntries` and the completion's delete read one market, and `getEntry` reads one full key. A refresh writes thousands of rows, and on D1 each index entry would be one more billed row write.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market` | `stock_directory_meta` | `owner_id`, `market` | Many-to-one | Logical |

## Data Lifecycle

### Insert

A `stock-directory-refreshed` completion (`POST /api/v1/runner/jobs/:id/complete` → `runnerJobs.complete` → `unitOfWork`) inserts the market's rows with `INSERT … SELECT … FROM json_each(?)` in byte-bounded chunks (`chunkStockDirectoryRows`), each statement guarded on the job's compare-and-set. The refresh is queued by `POST /api/v1/watchlist/directory/refresh` ("Update stock list"), or by the Watchlist page once per visit when a market's list is missing or older than 7 days (not after a `DIRECTORY_NOT_CONFIGURED` failure).

### Update

`storeKeys` rewrites only the four `*_key` columns when `search` finds a market whose `stock_directory_meta.fold_version` differs from `STOCK_SEARCH_FOLD_VERSION`. Each chunked `UPDATE … FROM json_each(?)` matches on symbol, name and local name, so keys land only on the rows they were computed from. Other columns never change in place.

### Delete

The same completion batch first runs `DELETE FROM stock_directory WHERE owner_id = ? AND market = ?` (guarded), then re-inserts. No other code path deletes rows.

### Synchronization

Full snapshot per market, not incremental: each successful refresh replaces the market's rows atomically with the source's current list. A failed job, or a completion with fewer than 1,000 rows (`minEntriesPerMarket`, refused by contract), leaves the stored list untouched.

### Retention

Rows live until the next successful refresh of their market. The contract caps a market at 10,000 rows (`maxEntriesPerMarket`), so the table holds at most 20,000 rows per owner.

## Notes

- SEC requires `SEC_USER_AGENT`; without it the US job fails with `DIRECTORY_NOT_CONFIGURED` and the US rows stay as they were.
- A US completion of 7,691 rows costs 1 delete, 4 insert chunks and 1 meta upsert plus the job write and audit.
- One job per market keeps each completion under the 1,000,000-byte body cap (ADR-0010); US measured about 530 KB.
- The SQL ranking (`STOCK_SEARCH_SQL`) and the domain reference are run on the same rows in `apps/api/test/stockDirectory.test.ts` and must return identical results.
