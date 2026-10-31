# Table: equity_record

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_record` |
| Purpose | One immutable equities catalog record (issuer, listing, filing, fact, price, ...): its type, the import that first stored it, and its validated JSON body. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `record_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equities.ts` |
| Update Strategy | Insert-only; `ON CONFLICT DO NOTHING` when an identical record is imported again |
| Data Retention | Kept indefinitely; no code path deletes records |

The ledger of the equities library (ADR-0041). Every record of an owner import is stored here once under its owner-chosen id, unique across the 14 record types, and its full body (exact decimals as strings) lives only in `body_json`. For each type, a relational projection table (`equity_issuer`, `equity_listing`, `equity_financial_fact`, ...) copies the id and the few fields needed for foreign keys, indexes and filters; each projection's primary key is also a foreign key to this table. `commit` writes the record and its projection from the same JSON in one D1 batch (registry `EQUITY_TABLES` in `equityTables.ts`), and reads join back here for the body. Records are never updated or deleted; a correction is a new record with a new id that names its predecessor.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `record_id` | TEXT | No | - | Owner-supplied record id (`idSchema`: up to 96 characters of `[A-Za-z0-9_.:-]`, starting alphanumeric); equals the body's own id field (`issuerId`, `factId`, ...). |
| `record_type` | TEXT | No | - | Record kind, one of the 14 values in the CHECK; one per import collection (`issuers` → `issuer`, `facts` → `fact`, ...). |
| `import_id` | TEXT | No | - | The import that first stored the record. Re-importing an identical record leaves it unchanged, so the record keeps its original provenance: `listFacts` uses this import's `committed_at` and `commit_sequence`. |
| `body_json` | TEXT | No | - | Record body as JSON, validated on read with `equityRecordSchema` (the body schema of `record_type`, e.g. `equityFactSchema`). Decimals are canonical strings (`equityDecimalSchema`). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `record_id` | - | One record per id per owner, across all types. `getRecords`, `listRecords`, `listIssuerRecords` and every projection join read by it. |
| (unnamed) | UNIQUE | `owner_id`, `record_type`, `record_id` | - | Implied by the primary key, since `record_id` alone is unique; no foreign key references it and no query uses it (see Notes). |
| (unnamed) | FOREIGN KEY | `owner_id`, `import_id` | `equity_import (owner_id, import_id) ON DELETE RESTRICT` | The import must exist; it is inserted first in the same batch. |
| (unnamed) | CHECK | `record_type` | `record_type IN ('issuer','identifier','security','listing','source','document','filing','statement','metric','fact','price','action','fx','guidance')` | Only the 14 known record kinds. |
| (unnamed) | CHECK | `body_json` | `json_valid(body_json)` | `body_json` is valid JSON. |

## Indexes

None. The primary key serves every read: `getRecords` (ids from a JSON list), `listRecords` (keyset on `record_id`, the optional `record_type` filter applied while scanning), `listIssuerRecords`, and the joins in `listIssuers` and `listFacts`. Migration 0020 dropped `equity_record_by_import` because no query filters by `import_id`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `import_id` | `equity_import` | `owner_id`, `import_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

`createEquityRepository().commit`, the second statement of the import batch: an `INSERT … SELECT` over `json_each` of the file's records, guarded by `EXISTS` on the batch's `equity_import` row, with `ON CONFLICT (owner_id, record_id) DO NOTHING` for records already held. Before the batch, `createEquityService().import` reads the stored version of every incoming id and reference (`getRecords`) and rejects a reused id with different content (409 `CONFLICT`); the batch's first statement repeats that check against `body_json` inside the transaction.

### Update

Never: records are immutable. Corrections are new records whose projections carry `amendment_of_filing_id` or a `supersedes_*` id.

### Delete

Never: no code path deletes records, and every projection row references its record with `ON DELETE RESTRICT`.

### Synchronization

Not applicable: rows come only from owner-uploaded import files. There is no automatic download from SEC, EDINET or other providers ([equities library guide](../libraries/equities.md)).

### Retention

Kept indefinitely. Growth is bounded per import: at most 2,000 records and 750,000 bytes of payload.

## Notes

- `listFacts` joins the fact, statement, filing, metric, document, issuer and source records and their imports, to return full provenance and to apply `informationCutoff`, `ingestionCutoff` and `ingestionVersion` (`max` of the seven imports' `committed_at` and `commit_sequence`).
- Identity is compared as text: an incoming record conflicts when its `json_extract`ed body differs from the stored `body_json`. Both come from `JSON.stringify` of the zod-parsed body, so field order is the schema's.
- The redundant `UNIQUE (owner_id, record_type, record_id)` costs one extra index entry, a billed D1 row write, per record.
