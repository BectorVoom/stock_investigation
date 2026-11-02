# Table: equity_sync_meta

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_sync_meta` |
| Purpose | Unused since ADR-0054: one row per owner recording when the proof-of-concept default companies were added (ADR-0048). The companies now follow the Watchlist, so nothing reads or writes it. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and J-Quants |
| Created By | `infra/migrations/0021_equity_financial_sync.sql` |
| Primary Key | `owner_id` |
| Storage | `WITHOUT ROWID` |
| Code | None since ADR-0054 (formerly `packages/adapters/src/sql/equitySync.ts`, `probe` and `seedDefaults`) |
| Update Strategy | None since ADR-0054 (was: insert once per owner, `ON CONFLICT DO NOTHING`) |
| Data Retention | Kept indefinitely, one row per owner |

The former once-per-owner marker of default seeding. Under ADR-0048 the claim-time scheduler probed for the row and, when it was missing, inserted it with the six default companies. ADR-0054 removed the seeding (the tracked companies are the owner's Watchlist stocks), so the table is no longer read or written; existing rows stay. Kept in the schema to avoid a migration; dropping it is recorded technical debt for a later schema change.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `defaults_added_at` | TEXT | No | - | ISO-8601 UTC time the defaults were added; the seeding batch's guard (its companies are inserted only where this row carries the batch's own time). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id` | - | One marker per owner; a concurrent second seeding inserts nothing. |

## Indexes

None. Nothing reads it since ADR-0054 (the primary key served the former probe's `EXISTS`).

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

Never since ADR-0054. Before: the first runner claim of an owner with seeding on (`materializeDue` → `seedDefaults`), in one batch with the default companies.

### Update

Never.

### Delete

Never by the application.

### Synchronization

Not applicable: an internal marker.

### Retention

Kept indefinitely; one row per owner.
