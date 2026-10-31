# Table: watchlist_lists

## Overview

| Property | Value |
|---|---|
| Table Name | `watchlist_lists` |
| Purpose | One row holds one titled list of watchlist stocks, which a Watchlist prices widget can show (ADR-0040). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 7. Watchlist and calendar |
| Created By | `infra/migrations/0013_watchlist_lists.sql` |
| Primary Key | `owner_id`, `list_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/watchlistLists.ts` (`createWatchlistListRepository`), `packages/adapters/src/sql/repositories.ts` (`createWatchlistRepository().removeStock`) |
| Update Strategy | Insert with an in-statement cap; `version` raised by every change to the list |
| Data Retention | Kept until the owner deletes the list; at most 20 lists per owner |

The owner creates, renames and deletes lists on the Watchlist page (`POST /watchlist/lists`, `PATCH` and `DELETE /watchlist/lists/:listId`). Every change to a list (rename, a member added or removed, including through removal of the stock from the watchlist) raises its `version`, which the `/watchlist` ETag covers. Lists are returned in creation order. Home and notebook `watchlist-prices` widgets name a list by `list_id`, and its members decide which price series a market refresh fetches.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `list_id` | TEXT | No | - | Server-generated id (prefix `list`), validated by `idSchema`. |
| `title` | TEXT | No | - | Owner-given title, trimmed, 1-80 characters, no control characters (`watchlistListTitleSchema`); the stored text must already be trimmed. Never written to audit rows. |
| `version` | INTEGER | No | - | Monotonic per list: 1 on creation, raised by 1 on every rename and every member added or removed. |
| `created_at` | TEXT | No | - | ISO-8601 UTC creation time; lists are ordered by `created_at`, then `list_id`. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last change to the list or its members. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `list_id` | - | One row per list; serves the by-id reads, updates and the membership guard. |

## Indexes

None. The primary key serves every read: `listLists` reads the owner's whole prefix (at most 20 rows) and sorts it, and every other access is by `(owner_id, list_id)`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`insertList` (`WatchlistService.createList`, `POST /watchlist/lists`) inserts the list at version 1. The cap of 20 (`WATCHLIST_LIST_LIMITS.maxLists`) is part of the `INSERT ... SELECT ... WHERE (SELECT count(*) ...) < ?` statement, so concurrent creates cannot exceed it.

### Update

`renameList` (`PATCH /watchlist/lists/:listId`) sets `title`, `version = version + 1` and `updated_at`. `addStock` and `removeStock` in `watchlistLists.ts` raise `version` and `updated_at` in the same batch as the membership insert or delete, under the same guard, so the version moves exactly when a member changes. `createWatchlistRepository().removeStock` raises the version of every list that held a removed watchlist stock, before deleting the memberships.

### Delete

`deleteList` (`DELETE /watchlist/lists/:listId`) deletes the list's `watchlist_list_stocks` rows and the list in one batch. The service then deletes price series no page tracks any more.

### Synchronization

Not applicable: the owner maintains the lists.

### Retention

Kept until the owner deletes the list; at most 20 lists per owner.

## Notes

- Deleting a list does not edit the Home or notebook widgets that name it; `membersOf` returns no entry for an unknown list id.
- No foreign key: `deleteList` removes the memberships set-based in the same batch.
