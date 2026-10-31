# Table: equity_edinet_scanned_day

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_edinet_scanned_day` |
| Purpose | One row per EDINET date whose document list a sync fully read for a Japanese company, so the scan plan never lists that date again (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0021_equity_financial_sync.sql` |
| Primary Key | `owner_id`, `company_id`, `scanned_on` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`equitySyncStatements`, `claimContext`), `packages/application/src/equitySync.ts` (`edinetPlanOf`) |
| Update Strategy | Insert-only (`ON CONFLICT DO NOTHING`) |
| Data Retention | Kept indefinitely; a few hundred dates per Japanese company |

EDINET has no per-company search: its documents API lists every document of one date. The API plans which dates a job lists (`edinetScanPlan`: discovery, backfill windows, then every weekday since the newest report), and a completion records the dates the runner listed. Only dates already over in Japan are recorded (a list of today may still grow). The claim builder reads a company's dates in order to plan the next job.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `company_id` | TEXT | No | - | The Japanese company (`equity_company`, provider `edinet`). |
| `scanned_on` | TEXT | No | - | The listed date, YYYY-MM-DD in Japan Standard Time. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `company_id`, `scanned_on` | - | A date is recorded once per company; the insert's `ON CONFLICT DO NOTHING` target. |
| (unnamed) | FOREIGN KEY | `owner_id`, `company_id` | `equity_company (owner_id, company_id) ON DELETE RESTRICT` | A date belongs to a stored company. |

## Indexes

None. The primary key serves the only read: `claimContext` reads one company's dates in order (a key range).

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `company_id` | `equity_company` | `owner_id`, `company_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

A `financial-synced` completion of an EDINET company inserts its `scannedDays` that are before today in Japan, with `INSERT … SELECT … FROM json_each(?) … ON CONFLICT DO NOTHING`, guarded on the job's compare-and-set.

### Update

Never: rows are immutable.

### Delete

Never by the application.

### Synchronization

The checkpoint of the EDINET date scan: a job lists at most 40 dates, and the next claim plans only dates not stored here.

### Retention

Kept indefinitely; discovery plus six backfill windows plus the weekdays since — a few hundred rows per company, growing by about 260 a year.
