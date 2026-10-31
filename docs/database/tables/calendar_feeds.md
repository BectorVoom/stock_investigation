# Table: calendar_feeds

## Overview

| Property | Value |
|---|---|
| Table Name | `calendar_feeds` |
| Purpose | One row holds the SHA-256 of the owner's earnings-calendar subscription token, so a calendar app can fetch the `.ics` feed without a session (FR-018, ADR-0016). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 7. Watchlist and calendar |
| Created By | `infra/migrations/0007_watchlist_earnings.sql` |
| Primary Key | `owner_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createCalendarFeedRepository`) |
| Update Strategy | Upsert on issue (replaces the previous hash) |
| Data Retention | Kept until the owner revokes or replaces the link |

Issuing a link (`POST /watchlist/feed`) generates a `cal_` token, returns it once, and stores only its hash; issuing again replaces the hash, so the old link stops working at once. `GET /calendar-feed/:token/earnings.ics` hashes the presented token and looks up the owner by hash. Revoking (`DELETE /watchlist/feed`) deletes the row.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `token_hash` | TEXT | No | - | Lowercase hex SHA-256 of the subscription token (`cal_` + 64 hex characters). The token itself is never stored. |
| `created_at` | TEXT | No | - | ISO-8601 UTC time the current token was issued. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id` | - | One subscription link per owner; the upsert's conflict target and the key of `get` and `revoke`. |
| (unnamed) | UNIQUE | `token_hash` | - | A token hash maps to exactly one owner; its automatic index serves `findOwnerByTokenHash`. |

## Indexes

None. The primary key serves `get`, `put` and `revoke` by `owner_id`; the automatic index of the `token_hash` UNIQUE constraint serves `findOwnerByTokenHash`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`createCalendarFeedRepository().put` from `WatchlistService.issueFeed` (`POST /watchlist/feed`) inserts the hash with `ON CONFLICT (owner_id) DO UPDATE`.

### Update

The same upsert replaces `token_hash` and `created_at` when the owner issues a new link ("Replace link"); the old token stops resolving immediately.

### Delete

`revoke` from `WatchlistService.revokeFeed` (`DELETE /watchlist/feed`) deletes the owner's row; the feed URL then answers 404.

### Synchronization

Not applicable: the row is a credential the owner issues.

### Retention

At most one row per owner, kept until revoked.

## Notes

- Security: only the hash is stored, like runner credentials (ADR-0002, SEC-005). An unknown, revoked or malformed token gets the same 404, and the feed route never consults the owner session. Audit rows never carry the token.
- To revoke a leaked link without the UI, delete the owner's row ([database operations](../operations.md#0007--watchlist-and-earnings)).
