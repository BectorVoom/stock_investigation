# Table: stock_earnings_calendar

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_earnings_calendar` |
| Purpose | One row is one upcoming earnings announcement of one stock-list stock, from its market's whole earnings calendar (ADR-0068): the Stocks page's next earnings date for every listed stock. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0031_stock_earnings_calendar.sql` |
| Primary Key | `owner_id`, `market`, `symbol`, `period_key` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/earningsCalendar.ts` (`earningsCalendarStatements`, `createEarningsCalendarRepository`) |
| Update Strategy | Replace per market: an `earnings-calendar-synced` completion deletes the market's rows and inserts the new ones |
| Data Retention | Until the market's next stored calendar |

US rows come from Finnhub's earnings calendar asked without a symbol, JP rows from every row of JPX's announcement workbooks; the runner writes each symbol in the stock list's form (`BH.A` → `BH-A`). Only symbols of the owner's `stock_directory` for the market are kept. Unlike `earnings_events` (the Watchlist's dates, fetched per stock), these rows feed no calendar export: the Google Calendar and the `.ics` files stay Watchlist-only.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'` (`watchMarketSchema`). |
| `symbol` | TEXT | No | - | The stock-list symbol (`stock_directory.symbol`), e.g. `KO`, `BH-A`, `7203`, `130A`. |
| `period_key` | TEXT | No | - | The fiscal period's stable key, as `earnings_events.period_key` (`2026-q3`; JPX `fy2027-03-31-second-quarter`). |
| `announcement_date` | TEXT | Yes | - | `YYYY-MM-DD`; NULL when the source lists the announcement as undecided (JPX 未定). |
| `fiscal_period_label` | TEXT | No | - | The period's label, `Q3 2026` form. |
| `fiscal_period_end` | TEXT | Yes | - | Last day of the fiscal year the period belongs to (JPX), `YYYY-MM-DD`; NULL from Finnhub. |
| `timing` | TEXT | No | - | `before-open`, `after-close`, `during-session` or `unknown` (JPX states none). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `symbol`, `period_key` | - | One row per stock and fiscal period; one stock's rows are a key range. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two stock-list markets. |
| (unnamed) | CHECK | `timing` | `timing IN ('before-open', 'after-close', 'during-session', 'unknown')` | `earningsTimingSchema`. |

## Indexes

None. The Stocks page reads one stock's rows as a primary-key range; the completion deletes one market's rows by the key's prefix.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market`, `symbol` | `stock_directory` | `owner_id`, `market`, `symbol` | Many-to-one | Logical (the insert keeps only stock-list symbols) |
| `owner_id`, `market` | `stock_earnings_calendar_market` | `owner_id`, `market` | Many-to-one | Logical |

## Data Lifecycle

### Insert

An `earnings-calendar-synced` completion inserts the market's rows in chunks of JSON (`json_each`), keeping rows whose symbol is in the owner's `stock_directory` for the market, guarded on the job compare-and-set and in the batch that deletes the old rows and upserts `stock_earnings_calendar_market`.

### Update

Never in place: a new calendar replaces the market's rows.

### Delete

Every `earnings-calendar-synced` completion deletes the market's rows before inserting the new ones. A failed sync deletes nothing: the last stored calendar stays.

### Synchronization

Follows Finnhub's `GET /api/v1/calendar/earnings` without `symbol` (US) and JPX's announcement workbooks (JP) through `earnings-calendar-sync` jobs, queued by the API once a market's last stored calendar is 24 hours old.

### Retention

Until the market's next stored calendar: about 185 days of announcements per market.
