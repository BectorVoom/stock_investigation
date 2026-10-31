# Table: equity_source_document

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_source_document` |
| Purpose | Projection of `document` records: one captured source document (a filing, release or data file) with its publication and retrieval times. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `source_document_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `document` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Each row is one immutable capture: retrieving the same external document again gives a new row with its own id. Identifiers, filings, prices, corporate actions, FX and guidance cite a document by foreign key; `listFacts` reads `retrieved_at` here for `ingestionCutoff`. URL, title, external id and content hash are in the body.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `source_document_id` | TEXT | No | - | Document id (`body.sourceDocumentId`); equals the record's `equity_record.record_id`. |
| `source_id` | TEXT | No | - | The source that published the document (`body.sourceId`). |
| `published_at` | TEXT | Yes | - | When the source published the document (`body.publishedAt`, ISO-8601 UTC with milliseconds, `equityInstantSchema`); NULL when unknown. No query reads it. |
| `retrieved_at` | TEXT | No | - | When the owner's producer retrieved the document (`equityInstantSchema`). The service rejects a value later than the import's receive time. With `ingestionCutoff`, `listFacts` drops facts whose filing document was retrieved later. |
| `materials_source_updated_at` | TEXT | Yes | - | The source's own record-update instant (`body.materialsSourceUpdatedAt`, `materialsSourceUpdatedAtSchema`): canonical UTC milliseconds, exactly 24 characters, not later than `retrieved_at`. NULL when unknown or omitted, with no backfill. No query reads it (added by 0015). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `source_document_id` | - | One document per id; six projection tables reference it. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_id` | `equity_data_source (owner_id, source_id) ON DELETE RESTRICT` | The source must exist (projected earlier in the batch). |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_document_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `document` record must exist in `equity_record`; it is inserted earlier in the same batch. |
| (unnamed) | CHECK | `materials_source_updated_at` | `materials_source_updated_at IS NULL OR (typeof(materials_source_updated_at) = 'text' AND length(materials_source_updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') = materials_source_updated_at)` | `materials_source_updated_at` is NULL or a canonical 24-character UTC millisecond instant that round-trips through `strftime`. |

## Indexes

None. The primary key serves the only read, `listFacts`' join from `equity_filing.source_document_id`, and the foreign-key checks of the citing tables.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `source_id` | `equity_data_source` | `owner_id`, `source_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `source_document_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `document` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `document`: an `INSERT … SELECT` over `json_each` of the file's `documents` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, source_document_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); a corrected or re-retrieved document is a new record with a new id.

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_issuer_identifier`, `equity_filing`, `equity_price_bar`, `equity_corporate_action`, `equity_fx_observation` and `equity_guidance_observation` would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 100 `documents` records, 2,000 records in all (`equityImportSchema`).

## Notes

- The database keeps the URL and an optional content hash, not the document bytes.
- Migration 0015 added `materials_source_updated_at` without a default; older import payloads omit `materialsSourceUpdatedAt`, which projects to NULL without changing their hash. `metal_observation` has its own column of the same name; materials code does not touch this table.
