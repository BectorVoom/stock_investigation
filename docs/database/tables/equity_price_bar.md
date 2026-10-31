# Table: equity_price_bar

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_price_bar` |
| Purpose | Projection of `price` records: one daily OHLC bar of a listing from a source document, optionally correcting an earlier bar of the same day. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `price_bar_id` |
| Storage | `WITHOUT ROWID` |
| Code | None since ADR-0048 (was `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts`, removed with the import) |
| Update Strategy | Retired: not written since ADR-0048 (under ADR-0041: insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record) |
| Data Retention | Rows kept unchanged since ADR-0048; removing them is a separate administrative operation (export first) |

**Retired (ADR-0048).** No code writes or reads this table since migration 0021 replaced the owner import of ADR-0041 with the SEC/EDINET sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md); its tables are [`equity_company`](equity_company.md), [`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md) and [`equity_metric_value`](equity_metric_value.md)). An installation that imported files keeps its rows unchanged; export them with `wrangler d1 export` ([database operations](../operations.md)) before removing them through a separate administrative operation. The rest of this document records how the ADR-0041 import used the table.

Like every `equity_*` projection, it holds a few fields of the `price` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Prices, volume, currency and price basis are exact values in the body. A correction is a new bar whose `supersedes_price_bar_id` names the earlier bar of the same listing and trading day; both rows remain. `listIssuerRecords` returns the bars of an issuer's listings.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `price_bar_id` | TEXT | No | - | Price bar id (`body.priceBarId`); equals the record's `equity_record.record_id`. |
| `listing_id` | TEXT | No | - | The listing traded. |
| `source_document_id` | TEXT | No | - | The document the bar comes from. |
| `trading_on` | TEXT | No | - | Trading date (`YYYY-MM-DD`); must lie within the listing's `listed_on` and `delisted_on`. No query reads it. |
| `supersedes_price_bar_id` | TEXT | Yes | - | The earlier bar this one corrects: same listing (foreign key) and same `trading_on` (service check), already stored or earlier in the file. NULL for an original. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `price_bar_id` | - | One bar per id. |
| (unnamed) | UNIQUE | `owner_id`, `listing_id`, `price_bar_id` | - | Target of the supersedes foreign key, so a bar can only correct a bar of the same listing. |
| (unnamed) | FOREIGN KEY | `owner_id`, `listing_id`, `supersedes_price_bar_id` | `equity_price_bar (owner_id, listing_id, price_bar_id) ON DELETE RESTRICT` | A correction references an existing bar of the same listing. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_document_id` | `equity_source_document (owner_id, source_document_id) ON DELETE RESTRICT` | The citing source document must exist (projected earlier in the batch). |
| (unnamed) | FOREIGN KEY | `owner_id`, `listing_id` | `equity_listing (owner_id, listing_id) ON DELETE RESTRICT` | The listing must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `price_bar_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `price` record must exist in `equity_record`; it is inserted earlier in the same batch. |
| (unnamed) | CHECK | `price_bar_id`, `supersedes_price_bar_id` | `supersedes_price_bar_id IS NULL OR supersedes_price_bar_id <> price_bar_id` | A bar cannot supersede itself. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_price_bar__owner_id_listing_id_trading_on_price_bar_id` | `owner_id`, `listing_id`, `trading_on`, `price_bar_id` | No | A listing's bars in trading-date order. `listIssuerRecords` uses its `(owner_id, listing_id)` prefix to find an issuer's bars; no query reads the `trading_on` order yet. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `listing_id`, `supersedes_price_bar_id` | `equity_price_bar` | `owner_id`, `listing_id`, `price_bar_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `source_document_id` | `equity_source_document` | `owner_id`, `source_document_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `listing_id` | `equity_listing` | `owner_id`, `listing_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `price_bar_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

Never since ADR-0048. Under ADR-0041: `createEquityRepository().commit` inserts one row per `price` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `price`: an `INSERT … SELECT` over `json_each` of the file's `prices` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, price_bar_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); a correction is a new bar with `supersedes_price_bar_id`.

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from correcting bars would block deleting a referenced row.

### Synchronization

Not applicable: retired by ADR-0048. Financial statements now arrive through the SEC/EDINET sync ([`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md), [`equity_metric_value`](equity_metric_value.md)).

### Retention

No rows are added since ADR-0048; the stored ones are kept. Under ADR-0041: kept indefinitely. Growth is bounded per import: at most 1,000 `prices` records, 2,000 records in all (`equityImportSchema`).

## Notes

The service checks each bar: currency equals the listing's `tradingCurrency`; low is non-negative and at most open and close, which are at most high; volume is non-negative; a basis other than `unadjusted` needs an adjustment description. No split adjustment is derived.
