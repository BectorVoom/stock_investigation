# Table: equity_statement

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_statement` |
| Purpose | Projection of `statement` records: one financial statement (income, balance sheet, cash flow, equity, notes) in a filing, for one period. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `statement_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `statement` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Financial facts belong to statements. `listFacts` and the fact count in `listIssuers` join filings → statements → facts; standard, scope, reporting currency and period are in the body, which `listFacts` returns with each fact.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `statement_id` | TEXT | No | - | Statement id (`body.statementId`); equals the record's `equity_record.record_id`. |
| `filing_id` | TEXT | No | - | The filing that contains the statement. |
| `period_end` | TEXT | No | - | Last day of the reporting period (`YYYY-MM-DD`, inclusive; `body.periodEnd`). No query reads it. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `statement_id` | - | One statement per id. |
| (unnamed) | FOREIGN KEY | `owner_id`, `filing_id` | `equity_filing (owner_id, filing_id) ON DELETE RESTRICT` | The filing must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `statement_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `statement` record must exist in `equity_record`; it is inserted earlier in the same batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_statement__owner_id_filing_id_statement_id` | `owner_id`, `filing_id`, `statement_id` | No | A filing's statements: `listFacts` and the fact count in `listIssuers` join `equity_filing` to statements on `(owner_id, filing_id)`. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `filing_id` | `equity_filing` | `owner_id`, `filing_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `statement_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `statement` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `statement`: an `INSERT … SELECT` over `json_each` of the file's `statements` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, statement_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`).

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_financial_fact` would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 200 `statements` records, 2,000 records in all (`equityImportSchema`).
