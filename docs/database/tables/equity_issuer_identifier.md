# Table: equity_issuer_identifier

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_issuer_identifier` |
| Purpose | Projection of `identifier` records: one official identifier (SEC CIK, EDINET code, LEI, Japanese corporate number) assigned to an issuer, with the document that states it. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `identifier_id` |
| Storage | `WITHOUT ROWID` |
| Code | None since ADR-0048 (was `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts`, removed with the import) |
| Update Strategy | Retired: not written since ADR-0048 (under ADR-0041: insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record) |
| Data Retention | Rows kept unchanged since ADR-0048; removing them is a separate administrative operation (export first) |

**Retired (ADR-0048).** No code writes or reads this table since migration 0021 replaced the owner import of ADR-0041 with the SEC/EDINET sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md); its tables are [`equity_company`](equity_company.md), [`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md) and [`equity_metric_value`](equity_metric_value.md)). An installation that imported files keeps its rows unchanged; export them with `wrangler d1 export` ([database operations](../operations.md)) before removing them through a separate administrative operation. The rest of this document records how the ADR-0041 import used the table.

Like every `equity_*` projection, it holds a few fields of the `identifier` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). A `(scheme, value)` may belong to only one issuer: the import checks this within the file (`importProblem`) and against stored rows inside the batch, through the `(scheme, value)` index. `listIssuerRecords` returns an issuer's identifiers.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `identifier_id` | TEXT | No | - | Identifier record id (`body.identifierId`); equals the record's `equity_record.record_id`. |
| `issuer_id` | TEXT | No | - | The issuer that holds the identifier. |
| `scheme` | TEXT | No | - | Identifier scheme: `cik`, `edinet`, `lei` or `jp-corporate-number` (`equityIdentifierSchema`). |
| `value` | TEXT | No | - | Identifier value, 1-64 characters. The service requires 10 digits for `cik` and `E` plus 5 digits for `edinet`. |
| `source_document_id` | TEXT | No | - | The document that states the assignment. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `identifier_id` | - | One identifier record per id. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_document_id` | `equity_source_document (owner_id, source_document_id) ON DELETE RESTRICT` | The citing source document must exist (projected earlier in the batch). |
| (unnamed) | FOREIGN KEY | `owner_id`, `issuer_id` | `equity_issuer (owner_id, issuer_id) ON DELETE RESTRICT` | The issuer must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `identifier_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `identifier` record must exist in `equity_record`; it is inserted earlier in the same batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_issuer_identifier__owner_id_scheme_value` | `owner_id`, `scheme`, `value` | No | Import guard: the first statement of `commit` looks up each incoming identifier's `(scheme, value)` and writes nothing if a stored row assigns it to a different issuer. Non-unique because the same assignment may be stated by several records. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `source_document_id` | `equity_source_document` | `owner_id`, `source_document_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `issuer_id` | `equity_issuer` | `owner_id`, `issuer_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `identifier_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

Never since ADR-0048. Under ADR-0041: `createEquityRepository().commit` inserts one row per `identifier` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `identifier`: an `INSERT … SELECT` over `json_each` of the file's `identifiers` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, identifier_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); identities are not reconciled or unified automatically.

### Delete

Never: no code path deletes rows, and no table references this one.

### Synchronization

Not applicable: retired by ADR-0048. Financial statements now arrive through the SEC/EDINET sync ([`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md), [`equity_metric_value`](equity_metric_value.md)).

### Retention

No rows are added since ADR-0048; the stored ones are kept. Under ADR-0041: kept indefinitely. Growth is bounded per import: at most 100 `identifiers` records, 2,000 records in all (`equityImportSchema`).

## Notes

No index leads with `issuer_id`: `listIssuerRecords` filters `(owner_id, issuer_id)` and scans the owner's identifiers by primary key.
