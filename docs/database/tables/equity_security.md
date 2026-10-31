# Table: equity_security

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_security` |
| Purpose | Projection of `security` records: one equity instrument (common, ordinary, ADR, preferred, REIT) issued by an issuer. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `security_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `security` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Instrument type, share class and ISIN stay in the body. Listings and corporate actions reference securities; `listIssuers` and `listIssuerRecords` go from an issuer to its securities and on to their listings, prices and actions.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `security_id` | TEXT | No | - | Security id (`body.securityId`); equals the record's `equity_record.record_id`. |
| `issuer_id` | TEXT | No | - | The issuing company. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `security_id` | - | One security per id. |
| (unnamed) | FOREIGN KEY | `owner_id`, `issuer_id` | `equity_issuer (owner_id, issuer_id) ON DELETE RESTRICT` | The issuer must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `security_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `security` record must exist in `equity_record`; it is inserted earlier in the same batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_security__owner_id_issuer_id_security_id` | `owner_id`, `issuer_id`, `security_id` | No | An issuer's securities: `listIssuers` (symbols and symbol search) and `listIssuerRecords` (`issuer_securities`) filter `(owner_id, issuer_id)` with a covering index read. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `issuer_id` | `equity_issuer` | `owner_id`, `issuer_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `security_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `security` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `security`: an `INSERT … SELECT` over `json_each` of the file's `securities` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, security_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`).

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_listing` and `equity_corporate_action` would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 100 `securities` records, 2,000 records in all (`equityImportSchema`).
