# Table: earnings_events

## Overview

| Property | Value |
|---|---|
| Table Name | `earnings_events` |
| Purpose | One row holds one scheduled earnings announcement (one fiscal period) of one watchlist stock (FR-018, ADR-0016). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 7. Watchlist and calendar |
| Created By | `infra/migrations/0007_watchlist_earnings.sql` |
| Primary Key | `owner_id`, `stock_id`, `period_key` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/repositories.ts` (`getEvents`, `removeStock`), `packages/adapters/src/sql/unitOfWork.ts` (`earningsStatements`) |
| Update Strategy | Replaced set-based per stock on every successful `earnings-refresh` completion |
| Data Retention | Only the latest successful refresh's events; deleted with the stock |

A successful refresh of a stock deletes its stored events and inserts the fresh list in the same guarded completion batch; a failed refresh keeps them. The rows feed the Watchlist page, the `.ics` calendar and subscription feed, Google Calendar sync and the earnings widgets. `period_key` names the fiscal period, not the date, so a rescheduled announcement keeps its identity and calendar UID.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `stock_id` | TEXT | No | - | The watchlist stock (`watchlist_stocks.stock_id`), e.g. `us:AAPL`. |
| `period_key` | TEXT | No | - | Fiscal period identifier matching `[a-z0-9-]{1,48}` (`earningsEventSchema`). |
| `announcement_date` | TEXT | Yes | - | Announcement date, `YYYY-MM-DD`; NULL when the source lists the period with the date undecided. |
| `fiscal_period_label` | TEXT | No | - | Display label of the fiscal period, 1-80 characters. |
| `fiscal_period_end` | TEXT | Yes | - | Last day of the fiscal period, `YYYY-MM-DD`; NULL when the source does not give it. |
| `timing` | TEXT | No | - | `before-open`, `after-close`, `during-session` or `unknown` (`earningsTimingSchema`, checked on read). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `stock_id`, `period_key` | - | One event per stock and fiscal period; in a `WITHOUT ROWID` table it is the table, so a stock's events are one key range. |

## Indexes

None. The primary key serves every read: `getEvents` reads the requested stocks' key ranges and sorts at most 8 rows per stock, and the replace and remove deletes are `(owner_id, stock_id)` prefix ranges.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `stock_id` | `watchlist_stocks` | `owner_id`, `stock_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`earningsStatements` in an `earnings-refresh` completion inserts the fresh events of every succeeded stock from one `json_each` statement, guarded on the job compare-and-set and on the stock still being in `watchlist_stocks`, so no event is written for a stock removed meanwhile.

### Update

The insert's `ON CONFLICT (owner_id, stock_id, period_key) DO UPDATE` rewrites `announcement_date`, `fiscal_period_label`, `fiscal_period_end` and `timing`. It applies only to duplicates within one answer, because the same batch has already deleted the stock's old rows.

### Delete

The same completion first deletes all events of every stock whose refresh succeeded or returned `NO_SCHEDULED_DATE`, so periods that left the source vanish. `removeStock` (`DELETE /watchlist/stocks/:stockId`) deletes the stock's events in the same batch as the stock.

### Synchronization

Replaced from the source (Finnhub for US, JPX for Japan) on each successful refresh, within the refresh window of 185 days (`WATCHLIST_LIMITS.horizonDays`). A failed refresh keeps the stored events.

### Retention

At most 8 events per stock (`WATCHLIST_LIMITS.maxEventsPerStock`, enforced by the completion contract) and 50 stocks per owner.

## Notes

- No foreign key: the stock removal deletes the events set-based in the same batch.
- Earnings dates are personal-use vendor data and are not part of workspace export/import (ADR-0016).
