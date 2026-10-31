# Table: equity_corporate_action

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_corporate_action` |
| Purpose | Projection of `action` records: one corporate action (split, dividend, spinoff, merger, ...) of a security, effective on a date. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `action_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `action` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Action type, ex and payable dates, cash amount and split ratio are in the body. A correction is a new action whose `supersedes_action_id` names an earlier action of the same security. `listIssuerRecords` returns the actions of an issuer's securities.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `action_id` | TEXT | No | - | Action id (`body.actionId`); equals the record's `equity_record.record_id`. |
| `security_id` | TEXT | No | - | The affected security. |
| `source_document_id` | TEXT | No | - | The document that announces the action. |
| `effective_on` | TEXT | No | - | Effective date (`YYYY-MM-DD`). No query reads it. |
| `supersedes_action_id` | TEXT | Yes | - | The earlier action of the same security this one corrects, already stored or earlier in the file; NULL for an original. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `action_id` | - | One action per id. |
| (unnamed) | UNIQUE | `owner_id`, `security_id`, `action_id` | - | Target of the supersedes foreign key, so an action can only correct an action of the same security. |
| (unnamed) | FOREIGN KEY | `owner_id`, `security_id`, `supersedes_action_id` | `equity_corporate_action (owner_id, security_id, action_id) ON DELETE RESTRICT` | A correction references an existing action of the same security. |
| (unnamed) | FOREIGN KEY | `owner_id`, `source_document_id` | `equity_source_document (owner_id, source_document_id) ON DELETE RESTRICT` | The citing source document must exist (projected earlier in the batch). |
| (unnamed) | FOREIGN KEY | `owner_id`, `security_id` | `equity_security (owner_id, security_id) ON DELETE RESTRICT` | The security must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `action_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `action` record must exist in `equity_record`; it is inserted earlier in the same batch. |
| (unnamed) | CHECK | `action_id`, `supersedes_action_id` | `supersedes_action_id IS NULL OR supersedes_action_id <> action_id` | An action cannot supersede itself. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_corporate_action__owner_id_security_id_effective_on_action_id` | `owner_id`, `security_id`, `effective_on`, `action_id` | No | A security's actions in effective-date order. `listIssuerRecords` uses its `(owner_id, security_id)` prefix to find an issuer's actions; no query reads the `effective_on` order yet. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `security_id`, `supersedes_action_id` | `equity_corporate_action` | `owner_id`, `security_id`, `action_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `source_document_id` | `equity_source_document` | `owner_id`, `source_document_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `security_id` | `equity_security` | `owner_id`, `security_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `action_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `action` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `action`: an `INSERT … SELECT` over `json_each` of the file's `actions` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, action_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); a correction is a new action with `supersedes_action_id`.

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from correcting actions would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 200 `actions` records, 2,000 records in all (`equityImportSchema`).

## Notes

The service requires a positive ratio numerator and denominator for `split`, `reverse-split` and `stock-dividend`, and a non-negative `cashDecimal` with a currency for `cash-dividend`.
