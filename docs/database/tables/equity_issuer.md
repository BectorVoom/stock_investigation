# Table: equity_issuer

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_issuer` |
| Purpose | Projection of `issuer` records: one company (legal entity) with its names, for company search. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `issuer_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record |
| Data Retention | Kept indefinitely; no code path deletes rows |

Like every `equity_*` projection, it holds a few fields of the `issuer` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Securities, identifiers, filings and guidance reference issuers by foreign key. `listIssuers` (`GET /api/v1/equities/issuers`) searches and pages the owner's issuers here and returns each issuer's body from `equity_record` with its listing symbols and fact count.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `issuer_id` | TEXT | No | - | Issuer id (`body.issuerId`); equals the record's `equity_record.record_id`. |
| `legal_name` | TEXT | No | - | Legal name (`body.legalName`, 1-300 characters). `listIssuers` matches `q` as a substring, folding ASCII case only (`instr(lower(...))`). |
| `local_name` | TEXT | Yes | - | Name in the local script, e.g. Japanese (`body.localName`); NULL when not given. `listIssuers` matches `q` as a case-sensitive substring. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `issuer_id` | - | One issuer per id; `listIssuers` keyset-pages on it (`issuer_id > after`). |
| (unnamed) | FOREIGN KEY | `owner_id`, `issuer_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `issuer` record must exist in `equity_record`; it is inserted earlier in the same batch. |

## Indexes

None. The primary key serves `listIssuers`: an owner range ordered by `issuer_id` with the keyset on `after`. The name and symbol filters are evaluated while scanning, so search cost grows with the owner's issuer count.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `issuer_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit` inserts one row per `issuer` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `issuer`: an `INSERT … SELECT` over `json_each` of the file's `issuers` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, issuer_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); a legal-name change cannot be applied in place ([equities library guide](../libraries/equities.md)).

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_security`, `equity_issuer_identifier`, `equity_filing` and `equity_guidance_observation` would block deleting a referenced row.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 100 `issuers` records, 2,000 records in all (`equityImportSchema`).

## Notes

`domicileCountry` is only in the body. Search does no Unicode case folding or transliteration.
