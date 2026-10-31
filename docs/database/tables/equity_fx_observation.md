# Table: equity_fx_observation

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_fx_observation` |
| Purpose | Projection of `fx` records: one exchange-rate observation (base and quote currency, exact rate) from a source document. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `fx_id` |
| Storage | `WITHOUT ROWID` |
| Code | None since ADR-0048 (was `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts`, removed with the import) |
| Update Strategy | Retired: not written since ADR-0048 (under ADR-0041: insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record) |
| Data Retention | Rows kept unchanged since ADR-0048; removing them is a separate administrative operation (export first) |

**Retired (ADR-0048).** No code writes or reads this table since migration 0021 replaced the owner import of ADR-0041 with the SEC/EDINET sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md); its tables are [`equity_company`](equity_company.md), [`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md) and [`equity_metric_value`](equity_metric_value.md)). An installation that imported files keeps its rows unchanged; export them with `wrangler d1 export` ([database operations](../operations.md)) before removing them through a separate administrative operation. The rest of this document records how the ADR-0041 import used the table.

Like every `equity_*` projection, it holds a few fields of the `fx` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Currencies, rate and fixing kind are in the body. FX records belong to no issuer, so issuer pages don't show them; `listRecords` (`GET /api/v1/equities/records?recordType=fx`) reads them from `equity_record`. The projection enforces the document reference.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `fx_id` | TEXT | No | - | FX observation id (`body.fxId`); equals the record's `equity_record.record_id`. |
| `source_document_id` | TEXT | No | - | The document the rate comes from. |
| `observed_at` | TEXT | No | - | Observation instant (`equityInstantSchema`, UTC milliseconds). No query reads it. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `fx_id` | - | One observation per id. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_document_id` | `equity_source_document (owner_id, source_document_id) ON DELETE RESTRICT` | The citing source document must exist (projected earlier in the batch). |
| (unnamed) | FOREIGN KEY | `owner_id`, `fx_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `fx` record must exist in `equity_record`; it is inserted earlier in the same batch. |

## Indexes

None. No query reads this table; the primary key serves the foreign-key insert. FX records are listed from `equity_record`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `source_document_id` | `equity_source_document` | `owner_id`, `source_document_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `fx_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

Never since ADR-0048. Under ADR-0041: `createEquityRepository().commit` inserts one row per `fx` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `fx`: an `INSERT … SELECT` over `json_each` of the file's `fx` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, fx_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`).

### Delete

Never: no code path deletes rows, and no table references this one.

### Synchronization

Not applicable: retired by ADR-0048. Financial statements now arrive through the SEC/EDINET sync ([`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md), [`equity_metric_value`](equity_metric_value.md)).

### Retention

No rows are added since ADR-0048; the stored ones are kept. Under ADR-0041: kept indefinitely. Growth is bounded per import: at most 500 `fx` records, 2,000 records in all (`equityImportSchema`).

## Notes

The service requires a positive rate and different base and quote currencies.
