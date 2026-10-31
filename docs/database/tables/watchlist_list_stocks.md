# Table: watchlist_list_stocks

## Overview

| Property | Value |
|---|---|
| Table Name | `watchlist_list_stocks` |
| Purpose | One row records that one watchlist stock is a member of one watchlist list (ADR-0040). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 7. Watchlist and calendar |
| Created By | `infra/migrations/0013_watchlist_lists.sql` |
| Primary Key | `owner_id`, `list_id`, `stock_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/watchlistLists.ts` (`createWatchlistListRepository`), `packages/adapters/src/sql/repositories.ts` (`createWatchlistRepository().removeStock`) |
| Update Strategy | Insert and delete only, each in a batch that raises the list's `version` |
| Data Retention | Deleted when the stock leaves the list or the watchlist, or the list is deleted |

The owner adds a stock to a list with `POST /watchlist/lists/:listId/stocks` (which first adds it to the watchlist if needed) and removes it with `DELETE /watchlist/lists/:listId/stocks/:stockId`. Every member is a watchlist stock: the insert requires the `watchlist_stocks` row, and removing the stock from the watchlist deletes its memberships in the same batch. Members are returned in the order they were added.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `list_id` | TEXT | No | - | The list (`watchlist_lists.list_id`). |
| `stock_id` | TEXT | No | - | The member stock (`watchlist_stocks.stock_id`), e.g. `us:AAPL`, validated by `watchlistStockIdSchema` on read. |
| `added_at` | TEXT | No | - | ISO-8601 UTC time the stock joined the list; members are ordered by `added_at`, then `stock_id`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `list_id`, `stock_id` | - | A stock is in a list at most once; in a `WITHOUT ROWID` table it is the table, so a list's members are one key range. |

## Indexes

None. The primary key serves the list reads (`listLists`, `membersOf`) and the per-list count as `(owner_id, list_id)` ranges. Removing a stock from the watchlist finds its memberships by `stock_id` over the owner's range, at most 240 rows (20 lists x 12 stocks).

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `list_id` | `watchlist_lists` | `owner_id`, `list_id` | Many-to-one | Logical |
| `owner_id`, `stock_id` | `watchlist_stocks` | `owner_id`, `stock_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`addStock` (`WatchlistService.addListStock`) inserts the membership with `INSERT ... SELECT ... WHERE` a guard: the list exists, the stock is on the watchlist, and the list has fewer than 12 members (`WATCHLIST_LIST_LIMITS.maxStocksPerList`). `ON CONFLICT DO NOTHING` makes a re-add idempotent. The same batch raises the list's `version` under the same guard.

### Update

Never: a membership is inserted or deleted, not changed.

### Delete

`removeStock` in `watchlistLists.ts` (`DELETE /watchlist/lists/:listId/stocks/:stockId`) deletes one membership after raising the list's version in the same batch. `deleteList` deletes all of a list's memberships with the list. `createWatchlistRepository().removeStock` (`DELETE /watchlist/stocks/:stockId`) deletes all of a stock's memberships with the stock.

### Synchronization

Not applicable: the owner maintains the memberships.

### Retention

At most 12 members per list and 20 lists per owner.

## Notes

- `membersOf` joins each member to its `watchlist_stocks` row and fails closed (`StoredDataError`) if the row is missing or names another stock; the batches above keep that from happening without foreign keys.
- The caps live inside the writing statements, so concurrent requests cannot exceed them.
