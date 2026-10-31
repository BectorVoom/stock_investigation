# Table: equity_filing

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_filing` |
| Purpose | Projection of `filing` records: one disclosure (statutory filing, earnings release, guidance) by an issuer, with when it became public and which filing it amends. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `filing_id` |
| Storage | `WITHOUT ROWID` |
| Code | None since ADR-0048 (was `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts`, removed with the import) |
| Update Strategy | Retired: not written since ADR-0048 (under ADR-0041: insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record) |
| Data Retention | Rows kept unchanged since ADR-0048; removing them is a separate administrative operation (export first) |

**Retired (ADR-0048).** No code writes or reads this table since migration 0021 replaced the owner import of ADR-0041 with the SEC/EDINET sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md); its tables are [`equity_company`](equity_company.md), [`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md) and [`equity_metric_value`](equity_metric_value.md)). An installation that imported files keeps its rows unchanged; export them with `wrangler d1 export` ([database operations](../operations.md)) before removing them through a separate administrative operation. The rest of this document records how the ADR-0041 import used the table.

Like every `equity_*` projection, it holds a few fields of the `filing` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Statements belong to filings. `listFacts` starts from an issuer's filings, applies `informationCutoff` to `public_available_at`, and returns the filing body as provenance; `listIssuers` counts facts through filings and statements.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `filing_id` | TEXT | No | - | Filing id (`body.filingId`); equals the record's `equity_record.record_id`. |
| `issuer_id` | TEXT | No | - | The filing issuer. |
| `source_document_id` | TEXT | No | - | The document the filing was captured from; `listFacts` joins it for `retrieved_at` and the document body. |
| `public_available_at` | TEXT | Yes | - | When the filing became public (`equityInstantSchema`, UTC milliseconds); NULL exactly when the body's `availabilityPrecision` is `unknown`. With `informationCutoff`, `listFacts` excludes filings with a NULL or later value. A date-only source is bounded by the producer (`conservative-date-bound`). |
| `amendment_of_filing_id` | TEXT | Yes | - | The filing this one amends, of the same issuer; NULL for an original. The predecessor must already be stored or appear earlier in the file. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `filing_id` | - | One filing per id. |
| (unnamed) | UNIQUE | `owner_id`, `issuer_id`, `filing_id` | - | Target of the amendment foreign key, which ties an amendment to a filing of the same issuer. |
| (unnamed) | FOREIGN KEY | `owner_id`, `issuer_id`, `amendment_of_filing_id` | `equity_filing (owner_id, issuer_id, filing_id) ON DELETE RESTRICT` | An amendment references an existing filing of the same issuer. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_document_id` | `equity_source_document (owner_id, source_document_id) ON DELETE RESTRICT` | The citing source document must exist (projected earlier in the batch). |
| (unnamed) | FOREIGN KEY | `owner_id`, `issuer_id` | `equity_issuer (owner_id, issuer_id) ON DELETE RESTRICT` | The issuer must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `filing_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `filing` record must exist in `equity_record`; it is inserted earlier in the same batch. |
| (unnamed) | CHECK | `filing_id`, `amendment_of_filing_id` | `amendment_of_filing_id IS NULL OR amendment_of_filing_id <> filing_id` | A filing cannot amend itself. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_filing__owner_id_issuer_id_public_available_at_filing_id` | `owner_id`, `issuer_id`, `public_available_at`, `filing_id` | No | An issuer's filings by public availability, for point-in-time fact reads: `listFacts` filters `issuer_id` and, with `informationCutoff`, `public_available_at`. `listIssuerRecords` (`issuer_filings`) and the fact count in `listIssuers` also filter by issuer. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `issuer_id`, `amendment_of_filing_id` | `equity_filing` | `owner_id`, `issuer_id`, `filing_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `source_document_id` | `equity_source_document` | `owner_id`, `source_document_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `issuer_id` | `equity_issuer` | `owner_id`, `issuer_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `filing_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

Never since ADR-0048. Under ADR-0041: `createEquityRepository().commit` inserts one row per `filing` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `filing`: an `INSERT … SELECT` over `json_each` of the file's `filings` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, filing_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); an amendment is a new filing whose `amendment_of_filing_id` names the original.

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_statement` and amending filings would block deleting a referenced row.

### Synchronization

Not applicable: retired by ADR-0048. Financial statements now arrive through the SEC/EDINET sync ([`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md), [`equity_metric_value`](equity_metric_value.md)).

### Retention

No rows are added since ADR-0048; the stored ones are kept. Under ADR-0041: kept indefinitely. Growth is bounded per import: at most 100 `filings` records, 2,000 records in all (`equityImportSchema`).

## Notes

Amendments do not replace originals: `listFacts` returns facts from both and selects no latest value.
