# Table: stock_directory_meta

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_directory_meta` |
| Purpose | One row per owner and market describing the stored stock directory list: row count, source date, download time and the fold version of its search keys (ADR-0034). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 9. Stock directory |
| Created By | `infra/migrations/0011_stock_directory.sql` |
| Primary Key | `owner_id`, `market` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`stockDirectoryStatements`), `packages/adapters/src/sql/repositories.ts` (`createStockDirectoryRepository`) |
| Update Strategy | Upsert on each `stock-directory-refreshed` completion; compare-and-set on `fold_version` after a re-key |
| Data Retention | One row per downloaded market (at most 2 per owner), kept indefinitely |

The completion that replaces a market's `stock_directory` rows upserts this row in the same guarded batch, so the count and dates always describe the stored list. `GET /api/v1/watchlist/directory` reads it to report each market's status, and every search reads it first to find markets whose keys were computed with an older fold and re-key them. A market without a row was never downloaded.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `entry_count` | INTEGER | No | - | Number of `stock_directory` rows stored for the market by the last completion. |
| `as_of` | TEXT | Yes | - | The date the source says its list is effective (JPX, when every kept row states the same date); NULL for SEC. |
| `retrieved_at` | TEXT | No | - | ISO-8601 UTC time the runner downloaded the stored list; the Watchlist treats a list older than 7 days as stale. |
| `fold_version` | INTEGER | No | - | The `STOCK_SEARCH_FOLD_VERSION` the market's `*_key` columns were computed with (2 today). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market` | - | One row per owner and market; the target of the completion's `ON CONFLICT (owner_id, market)` upsert. |

## Indexes

None. The primary key serves every read: `listMeta` reads the owner's prefix range (at most 2 rows) and `storeKeys` updates one full key.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

The first successful `stock-directory-refreshed` completion of a market (`POST /api/v1/runner/jobs/:id/complete`) inserts the row with `INSERT … ON CONFLICT DO UPDATE`, guarded on the job's compare-and-set and in the same batch as the market's `stock_directory` rows.

### Update

Each later completion of the market overwrites `entry_count`, `as_of`, `retrieved_at` and `fold_version` with the same upsert. `storeKeys` sets `fold_version` to the current version after re-keying, with `WHERE fold_version = ?` (the version it read) so a concurrent change is not overwritten.

### Delete

Never: no code path deletes rows. Only the rollback of migration 0011 drops the table.

### Synchronization

Follows the runner's full downloads: one upsert per successful market refresh. A failed refresh leaves the row as it was.

### Retention

Kept indefinitely; the key bounds the table to two rows per owner (US and JP).
