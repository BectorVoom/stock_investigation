# Table: equity_sync_meta

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_sync_meta` |
| Purpose | One row per owner recording when the proof-of-concept companies (`EQUITY_DEFAULT_STOCK_IDS`) were added, so removing one is not undone by the next runner claim (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0021_equity_financial_sync.sql` |
| Primary Key | `owner_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`probe`, `seedDefaults`) |
| Update Strategy | Insert once per owner (`ON CONFLICT DO NOTHING`) |
| Data Retention | Kept indefinitely, one row per owner |

The once-per-owner marker of default seeding. The claim-time scheduler probes for the row; when it is missing (and seeding is on — tests switch it off), `seedDefaults` inserts the row and, in the same batch and only if this batch wrote it, the six default companies and their sync states. Afterwards the owner's choices stand: an untracked default stays untracked.

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

None. The primary key serves the only read, the probe's `EXISTS` on the owner's row.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

The first runner claim of an owner with seeding on (`materializeDue` → `seedDefaults`), in one batch with the default companies.

### Update

Never.

### Delete

Never by the application.

### Synchronization

Not applicable: an internal marker.

### Retention

Kept indefinitely; one row per owner.
