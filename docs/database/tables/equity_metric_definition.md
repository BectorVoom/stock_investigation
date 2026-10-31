# Table: equity_metric_definition

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_metric_definition` |
| Purpose | Projection of `metric` records: one versioned metric definition (code, version, label, unit, definition text) that facts and guidance refer to. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `metric_definition_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `metric` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). A `(metric_code, version)` pair has one definition id per owner, checked within the file and inside the import batch. Facts and guidance reference definitions by foreign key; `listFacts` returns the definition body with each fact.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `metric_definition_id` | TEXT | No | - | Definition id (`body.metricDefinitionId`); equals the record's `equity_record.record_id`. |
| `metric_code` | TEXT | No | - | Metric code, lowercase kebab-case (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, at most 80 characters). |
| `version` | INTEGER | No | - | Definition version, a positive integer; a changed definition is a new version with a new id. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `metric_definition_id` | - | One definition per id. |
| (unnamed) | UNIQUE | `owner_id`, `metric_code`, `version` | - | One definition id per `(metric_code, version)`. The first statement of `commit` uses its index to write nothing when an incoming metric's code and version are stored under another id. |
| (unnamed) | FOREIGN KEY | `owner_id`, `metric_definition_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `metric` record must exist in `equity_record`; it is inserted earlier in the same batch. |
| (unnamed) | CHECK | `version` | `version > 0` | Versions start at 1. |

## Indexes

None. The primary key serves the foreign-key checks from facts and guidance; the `UNIQUE (owner_id, metric_code, version)` index serves the import guard.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `metric_definition_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `metric` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `metric`: an `INSERT … SELECT` over `json_each` of the file's `metrics` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, metric_definition_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`).

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_financial_fact` and `equity_guidance_observation` would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 100 `metrics` records, 2,000 records in all (`equityImportSchema`).

## Notes

The body's `unit` drives validation: a fact with a value of a `currency-per-share` or `shares` metric needs a `shareBasis`, and guidance on a `currency` or `currency-per-share` metric needs a currency.
