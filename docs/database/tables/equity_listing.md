# Table: equity_listing

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_listing` |
| Purpose | Projection of `listing` records: one listing episode of a security on a venue under a symbol, with optional listing and delisting dates. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `listing_id` |
| Storage | `WITHOUT ROWID` |
| Code | None since ADR-0048 (was `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts`, removed with the import) |
| Update Strategy | Retired: not written since ADR-0048 (under ADR-0041: insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record) |
| Data Retention | Rows kept unchanged since ADR-0048; removing them is a separate administrative operation (export first) |

**Retired (ADR-0048).** No code writes or reads this table since migration 0021 replaced the owner import of ADR-0041 with the SEC/EDINET sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md); its tables are [`equity_company`](equity_company.md), [`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md) and [`equity_metric_value`](equity_metric_value.md)). An installation that imported files keeps its rows unchanged; export them with `wrangler d1 export` ([database operations](../operations.md)) before removing them through a separate administrative operation. The rest of this document records how the ADR-0041 import used the table.

Like every `equity_*` projection, it holds a few fields of the `listing` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). Episodes of one `(venue_mic, symbol)` may not overlap, so a reused symbol needs a separate episode. Price bars reference listings; `listIssuers` builds `market:symbol` labels and matches symbols here.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `listing_id` | TEXT | No | - | Listing id (`body.listingId`); equals the record's `equity_record.record_id`. |
| `security_id` | TEXT | No | - | The listed security. |
| `market` | TEXT | No | - | `JP` or `US`; must match the venue's market in `EQUITY_VENUE_MARKETS` (`packages/contracts/src/equityVenues.ts`). `listIssuers` shows symbols as `market:symbol`. |
| `venue_mic` | TEXT | No | - | ISO 10383 MIC of the venue or segment, 4 characters; only venues in the reviewed `EQUITY_VENUE_MARKETS` registry are accepted. |
| `symbol` | TEXT | No | - | Trading symbol as text, 1-32 characters; JP codes may contain letters. `listIssuers` matches `q` against it, folding ASCII case. |
| `listed_on` | TEXT | Yes | - | First trading date (`YYYY-MM-DD`), inclusive; NULL when unknown, an open bound in the overlap check. |
| `delisted_on` | TEXT | Yes | - | Last trading date (`YYYY-MM-DD`), inclusive, not before `listed_on`; NULL while listed or when unknown. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `listing_id` | - | One listing episode per id. |
| (unnamed) | FOREIGN KEY | `owner_id`, `security_id` | `equity_security (owner_id, security_id) ON DELETE RESTRICT` | The security must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `listing_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `listing` record must exist in `equity_record`; it is inserted earlier in the same batch. |
| (unnamed) | CHECK | `market` | `market IN ('JP','US')` | Only the two supported markets. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_listing__owner_id_security_id_listing_id` | `owner_id`, `security_id`, `listing_id` | No | A security's listings: `listIssuers` and `listIssuerRecords` join securities to listings on `(owner_id, security_id)`. |
| `idx_equity_listing__owner_id_venue_mic_symbol` | `owner_id`, `venue_mic`, `symbol` | No | Import guard: the first statement of `commit` finds stored episodes of an incoming listing's `(venue_mic, symbol)` and writes nothing if one with another id overlaps its dates. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `security_id` | `equity_security` | `owner_id`, `security_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `listing_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

Never since ADR-0048. Under ADR-0041: `createEquityRepository().commit` inserts one row per `listing` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `listing`: an `INSERT … SELECT` over `json_each` of the file's `listings` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, listing_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`); a listing date cannot be corrected in place ([equities library guide](../libraries/equities.md)).

### Delete

Never: no code path deletes rows. `ON DELETE RESTRICT` foreign keys from `equity_price_bar` would block deleting a referenced row.

### Synchronization

Not applicable: retired by ADR-0048. Financial statements now arrive through the SEC/EDINET sync ([`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md), [`equity_metric_value`](equity_metric_value.md)).

### Retention

No rows are added since ADR-0048; the stored ones are kept. Under ADR-0041: kept indefinitely. Growth is bounded per import: at most 100 `listings` records, 2,000 records in all (`equityImportSchema`).

## Notes

- The body's `sourceDocumentId` is checked by the service but not projected, so unlike the other cited records a listing has no foreign key to `equity_source_document`.
- `tradingCurrency` and `exchangeTimezone` are in the body; price bars must use the listing's `tradingCurrency` and fall within its dates.
- Identity must not be inferred from ticker equality; historical ticker ownership is not resolved.
