# Table: earnings_sources

## Overview

| Property | Value |
|---|---|
| Table Name | `earnings_sources` |
| Purpose | One row per market naming the source of its earnings dates (publisher and link), shown as attribution by the Watchlist, earnings widgets and calendar exports. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 14. Reference data |
| Created By | `infra/migrations/0018_widget_earnings_sources.sql` |
| Primary Key | `market` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/repositories.ts` (`createEarningsRepository.getSources`) |
| Update Strategy | Seeded by migration 0018 and `db/schema.sql`; read-only to the application |
| Data Retention | Two fixed rows (US, JP), kept permanently |

The two rows are seeded by the schema itself: US earnings come from Finnhub, JP earnings from the JPX announcement schedule. `getSources` reads both rows whenever the Watchlist response, the `.ics` calendar document or the Google Calendar sync is assembled, and each stock takes the publisher and link of its market. A missing row for a watched stock's market is an `INTERNAL` error ("Stored earnings source metadata is missing."), not a silent fallback to a constant.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`); matches `watchlist_stocks.market`. |
| `source` | TEXT | No | - | Source id: `'finnhub'` (US) or `'jpx'` (JP) (`earningsSourceIdSchema`). |
| `publisher` | TEXT | No | - | Publisher name shown as attribution, 1–200 characters on read (`Finnhub`, `Japan Exchange Group (JPX)`). |
| `source_url` | TEXT | No | - | HTTPS link to the source shown beside the dates, validated on read (`httpsUrlSchema`). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `market` | - | One source per market. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | Only the two supported markets. |
| (unnamed) | CHECK | `source` | `source IN ('finnhub', 'jpx')` | Only the two implemented earnings sources. |

## Indexes

None. The primary key serves the only read: `getSources` reads both rows in `market` order.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

Only at schema creation: `infra/migrations/0018_widget_earnings_sources.sql` (existing databases) and `db/schema.sql` (fresh databases) insert the US and JP rows. No application code inserts.

### Update

Never by the application. Changing a publisher or link is a schema change: a new migration and the matching edit of the seed in `db/schema.sql`.

### Delete

Never by the application.

### Synchronization

Not applicable: static reference data.

### Retention

Kept permanently; the CHECK on `market` bounds the table to two rows.

## Notes

- The table has no `owner_id`: it is global reference data shared by every owner, the one exception to "every key starts with `owner_id`" (API-004).
- `apps/api/test/widgetDatabase.test.ts` checks that the Watchlist takes its attribution from this table rather than from provider constants in code, and that a missing row answers the typed `INTERNAL` error.
