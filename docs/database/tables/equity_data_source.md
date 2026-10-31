# Table: equity_data_source

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_data_source` |
| Purpose | Projection of `source` records: one data publisher (SEC, EDINET, TDnet, issuer IR, market data, ...) and the terms its data is used under. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `source_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `source` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Only the id is projected: publisher, `sourceKind`, `termsUrl`, `rights` and `rightsPolicyVersion` stay in the body. The table gives `equity_source_document.source_id` an enforced target of the right record type.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `source_id` | TEXT | No | - | Source id (`body.sourceId`); equals the record's `equity_record.record_id`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `source_id` | - | One source per id; `equity_source_document` references it. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `source` record must exist in `equity_record`; it is inserted earlier in the same batch. |

## Indexes

None. No query reads this table. The primary key serves the foreign-key checks from `equity_source_document`; `listFacts` reads the source body by joining `equity_record` on `equity_source_document.source_id` directly.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `source_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `source` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `source`: an `INSERT … SELECT` over `json_each` of the file's `sources` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, source_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`).

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_source_document` would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 50 `sources` records, 2,000 records in all (`equityImportSchema`).
