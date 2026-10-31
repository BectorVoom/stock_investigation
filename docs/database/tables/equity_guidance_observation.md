# Table: equity_guidance_observation

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_guidance_observation` |
| Purpose | Projection of `guidance` records: one management forecast, revision or withdrawal for an issuer's metric over a target period. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `guidance_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `guidance` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Target period, scope, standard, currency, bounds and status are in the body. A revision is a new row whose `supersedes_guidance_id` names an earlier guidance of the same issuer and metric. `listIssuerRecords` returns an issuer's guidance.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `guidance_id` | TEXT | No | - | Guidance id (`body.guidanceId`); equals the record's `equity_record.record_id`. |
| `issuer_id` | TEXT | No | - | The issuer that gave the guidance. |
| `source_document_id` | TEXT | No | - | The document that states it. |
| `metric_definition_id` | TEXT | No | - | The metric guided. |
| `supersedes_guidance_id` | TEXT | Yes | - | The earlier guidance this one revises or withdraws: same issuer (foreign key) and same metric (service check), already stored or earlier in the file. NULL for a first forecast. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `guidance_id` | - | One guidance row per id. |
| (unnamed) | UNIQUE | `owner_id`, `issuer_id`, `guidance_id` | - | Target of the supersedes foreign key, so guidance can only supersede guidance of the same issuer. Also serves `listIssuerRecords`' issuer filter. |
| (unnamed) | FOREIGN KEY | `owner_id`, `issuer_id`, `supersedes_guidance_id` | `equity_guidance_observation (owner_id, issuer_id, guidance_id) ON DELETE RESTRICT` | A revision references existing guidance of the same issuer. |
| (unnamed) | FOREIGN KEY | `owner_id`, `metric_definition_id` | `equity_metric_definition (owner_id, metric_definition_id) ON DELETE RESTRICT` | The metric definition must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_document_id` | `equity_source_document (owner_id, source_document_id) ON DELETE RESTRICT` | The citing source document must exist (projected earlier in the batch). |
| (unnamed) | FOREIGN KEY | `owner_id`, `issuer_id` | `equity_issuer (owner_id, issuer_id) ON DELETE RESTRICT` | The issuer must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `guidance_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `guidance` record must exist in `equity_record`; it is inserted earlier in the same batch. |
| (unnamed) | CHECK | `guidance_id`, `supersedes_guidance_id` | `supersedes_guidance_id IS NULL OR supersedes_guidance_id <> guidance_id` | Guidance cannot supersede itself. |

## Indexes

None. `UNIQUE (owner_id, issuer_id, guidance_id)` serves `listIssuerRecords`' `(owner_id, issuer_id)` filter, and the primary key serves the foreign-key checks. Migration 0020 dropped `equity_guidance_observation_by_issuer`, an exact duplicate of that unique index.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `issuer_id`, `supersedes_guidance_id` | `equity_guidance_observation` | `owner_id`, `issuer_id`, `guidance_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `metric_definition_id` | `equity_metric_definition` | `owner_id`, `metric_definition_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `source_document_id` | `equity_source_document` | `owner_id`, `source_document_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `issuer_id` | `equity_issuer` | `owner_id`, `issuer_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `guidance_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `guidance` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `guidance`: an `INSERT … SELECT` over `json_each` of the file's `guidance` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, guidance_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); a revision or withdrawal is a new row with `supersedes_guidance_id`.

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from superseding guidance would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 200 `guidance` records, 2,000 records in all (`equityImportSchema`).

## Notes

The service checks each row: `targetStart` is not after `targetEnd`; a `withdrawal` has no bounds and other statuses at least one; low, base and high are ordered; guidance on a currency metric names a currency.
