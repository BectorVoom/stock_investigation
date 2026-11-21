# Table: equity_metric_value

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_metric_value` |
| Purpose | The current authoritative value of one normalized metric of one company in one fiscal year, with the filing and concept it came from, or the reason it is unavailable (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and J-Quants |
| Created By | `infra/migrations/0021_equity_financial_sync.sql`; rebuilt unchanged by `0027_jquants_financials.sql` with the US companies' rows only (the Japanese values deleted, ADR-0059); screening support (`value_real`, its index) added by `0036_equity_metric_value_screening.sql` |
| Primary Key | `owner_id`, `company_id`, `fiscal_year`, `metric_code` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`equitySyncStatements`, `valueYears`, `valuesOfYears`, `valuesWithFilings`), `packages/application/src/equitySync.ts` (`recomputeEquityValues`) |
| Update Strategy | Upsert of only the touched (metric, year) keys whose selection changed (`ON CONFLICT … DO UPDATE … WHERE` a column differs) |
| Data Retention | Kept indefinitely, one row per company, metric and fiscal year with any evidence |

The read projection of `equity_reported_fact`: what the Stocks page's Financial statements and Company tabs and the financial widgets show. A completion recomputes only the keys its new facts touch (`selectFiscalYearMetrics` over every stored fact of that key whose scope is its filing's `primary_scope`) and writes a row only when the selection changed, so a sync with nothing new writes nothing here. A cell is a value with currency, filing, concept, scope, derived flag and how many different values were reported, or NULL with a reason — never 0 for a missing figure. A key with no row reads as `not-reported` (`not-derivable` for free cash flow).

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `company_id` | TEXT | No | - | The company (`equity_company`). |
| `metric_code` | TEXT | No | - | One of the 14 normalized metrics (`EQUITY_METRIC_CODES`, e.g. `revenue`, `free-cash-flow`). |
| `fiscal_year` | INTEGER | No | - | Fiscal year label (`fiscalYearOfPeriodEnd` of the period end). |
| `value_decimal` | TEXT | Yes | - | The normalized value (mapping sign applied) as exact decimal text in base units; NULL when unavailable. |
| `currency` | TEXT | Yes | - | ISO 4217 currency of the value; NULL when unavailable. |
| `unavailable_reason` | TEXT | Yes | - | Why there is no value: `not-reported`, `no-mapping-for-standard`, `ambiguous`, `unexpected-sign`, `unsupported-unit` or `not-derivable`; NULL with a value. |
| `filing_id` | TEXT | Yes | - | The filing the value came from (`equity_report_filing`); NULL when unavailable. |
| `concept` | TEXT | Yes | - | The concept selected (`derived:free-cash-flow` for the derived metric). |
| `scope` | TEXT | Yes | - | `'consolidated'` or `'separate'`: the scope of the selected fact. |
| `period_start` | TEXT | Yes | - | The selected fact's period start (NULL for an instant). |
| `period_end` | TEXT | Yes | - | The selected fact's period end, shown as the newest period end of a statement. |
| `derived` | INTEGER | No | 0 | 1 for a derived metric (free cash flow = operating cash flow − capital expenditures of one filing). |
| `reported_value_count` | INTEGER | No | 0 | How many different normalized values the filings reported for the key (2 or more: revised). |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the completion that last changed the row. |
| `value_real` | REAL | Yes | - | The `value_decimal` of a value row as an IEEE-754 double; NULL when there is no value or the decimal is not finite. The screening range and sort use it (migration 0036); never shown, never written alone. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `company_id`, `fiscal_year`, `metric_code` | - | One current value per company, year and metric; years first, so the newest-years read walks the key backwards and stops early. |
| (unnamed) | FOREIGN KEY | `owner_id`, `company_id` | `equity_company (owner_id, company_id) ON DELETE RESTRICT` | A value belongs to a stored company. |
| (unnamed) | CHECK | `scope` | `scope IN ('consolidated', 'separate')` | The two statement scopes. |
| (unnamed) | CHECK | `derived` | `derived IN (0, 1)` | `derived` is a boolean. |
| (unnamed) | CHECK | `reported_value_count` | `reported_value_count >= 0` | A count. |
| (unnamed) | CHECK | `value_decimal`, `currency`, `unavailable_reason`, `filing_id` | `(value_decimal IS NULL AND unavailable_reason IS NOT NULL AND filing_id IS NULL) OR (value_decimal IS NOT NULL AND unavailable_reason IS NULL AND filing_id IS NOT NULL AND currency IS NOT NULL)` | A row is either a value with its currency and filing, or no value with a reason. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real` | `owner_id`, `metric_code`, `fiscal_year`, `value_real` WHERE value_real IS NOT NULL | No | The screening read: one metric of one fiscal year across the companies, range on `value_real`, ordered by it without a temporary sort (a backwards index scan). Covering: an entry carries the primary key. Partial: rows without a value are not indexed (40.31 ms → 0.05 ms at 750,400 rows, node:sqlite, migration 0036). |

The primary key (owner, company, fiscal_year, metric) still serves every read: `valueYears` and the company list's latest year walk it backwards and stop early, and the per-year (`valuesOfYears`) and per-(year, metric) reads (`valuesWithFilings`) are key seeks.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `company_id` | `equity_company` | `owner_id`, `company_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `filing_id` | `equity_report_filing` | `owner_id`, `filing_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

A `financial-synced` completion inserts a key's first row when its selection has evidence (a mapped fact, an unmapped-standard filing for the year, or for free cash flow an input value), in the job's guarded batch, from bound JSON chunks. `value_real` is bound in the same row (the double of the `value_decimal`, or NULL outside double range).

### Update

The same upsert rewrites a stored row only when one of its columns differs from the new selection (`ON CONFLICT (owner_id, company_id, fiscal_year, metric_code) DO UPDATE … WHERE … IS NOT excluded…`, `value_real` included); `equity_sync_state.data_updated_at` moves only when a row changed.

### Delete

Never by the application. The administrative re-extract procedure (equities guide, Limitations) deletes a company's rows before its filings are read again.

### Synchronization

A projection, recomputed per completion for the touched keys only: an amendment or a later report restating a year becomes the current value while the earlier facts stay in `equity_reported_fact`.

### Retention

Kept indefinitely; at most 14 rows per company and fiscal year.

## Notes

- `value_real` is derived from `value_decimal` (`Number(value_decimal)`, finite check) and rewritten only with its row, so the two never drift apart; migration 0036 backfilled the stored rows the same way. Values beyond double range (or with no value) carry NULL and are invisible to the screening index. Values above 2^53 round to the nearest double — exact enough to filter and sort, which is all the column is for; every shown figure comes from `value_decimal`.
- Screening on absolute metrics compares amounts in the filing's reporting currency: filter or group by `currency` (or screen one market at a time); US and Japanese figures are not comparable in base units. Ratios worth screening (ROE, margins, growth) are quotients of two same-currency values and cancel the currency; they are computed from the stored values, never stored.
- The statement and metric reads list the newest fiscal years that have a value or a reason other than `not-reported`, so an IFRS filer's years appear with `no-mapping-for-standard` instead of looking unsynced.

For `basic-eps`, `value_decimal` is per share in the stated `currency`.
