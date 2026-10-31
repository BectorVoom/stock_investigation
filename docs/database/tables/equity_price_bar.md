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
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

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

`createEquityRepository().commit` inserts one row per `price` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `price`: an `INSERT … SELECT` over `json_each` of the file's `prices` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, price_bar_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); a correction is a new bar with `supersedes_price_bar_id`.

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from correcting bars would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 1,000 `prices` records, 2,000 records in all (`equityImportSchema`).

## Notes

The service checks each bar: currency equals the listing's `tradingCurrency`; low is non-negative and at most open and close, which are at most high; volume is non-negative; a basis other than `unadjusted` needs an adjustment description. No split adjustment is derived.
