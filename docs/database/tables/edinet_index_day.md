# Table: edinet_index_day

## Overview

| Property | Value |
|---|---|
| Table Name | `edinet_index_day` |
| Purpose | One row per EDINET day whose document list an `edinet-index` job read in full, for every company at once, so the day planner never asks for it again (ADR-0058 §4). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0026_edinet_document_index.sql` |
| Primary Key | `owner_id`, `listed_on` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/edinetIndex.ts` (`listedDays`, `edinetIndexStatements`), `packages/application/src/edinetIndex.ts` (`planEdinetIndexDays`) |
| Update Strategy | Insert-only (`ON CONFLICT DO NOTHING`): a listed day is final |
| Data Retention | Kept indefinitely; about 261 rows a year (the weekdays) |

EDINET has no per-company search: its documents API lists every document submitted on one date. The shared index lists each date once for every company. The plan (`planEdinetIndexDays` over the domain's `planSyncDays`) takes the weekdays from `backfillYears` (6) before yesterday in Japan up to yesterday, newest first, at most 40 a job, leaving out every day stored here. Only days already over in Japan are stored: a day of today may still grow. The day's annual reports are in `edinet_document_index`.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `listed_on` | TEXT | No | - | The listed date, YYYY-MM-DD in Japan Standard Time. |
| `checked_at` | TEXT | No | - | ISO-8601 time the runner read the list (the completion's `fetchedAt`). |
| `document_count` | INTEGER | No | - | How many annual reports (docTypeCode 120 / 130 with a securities code) the day listed; 0 for a day without any (a holiday, most days outside June). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `listed_on` | - | A day is stored once; the insert's `ON CONFLICT DO NOTHING` target, and the plan's range read. |
| (unnamed) | CHECK | `listed_on` | `length(listed_on) = 10` | A YYYY-MM-DD date. |
| (unnamed) | CHECK | `document_count` | `document_count >= 0` | A count. |

## Indexes

None. The primary key serves the only read: `listedDays` reads the owner's days of the plan's window as one key range.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

`edinet_document_index` references a day by (`owner_id`, `listed_on`).

## Data Lifecycle

### Insert

An `edinet-indexed` completion (`POST /api/v1/runner/jobs/:runId/complete`) inserts each day it listed in full and that is before today in Japan, with `INSERT … SELECT … FROM json_each(?) … ON CONFLICT DO NOTHING`, guarded on the job's compare-and-set, before the day's reports. A day the runner could not list is not reported and is planned again.

### Update

Never: a listed day is final.

### Delete

Never by the application.

### Synchronization

The checkpoint of the shared EDINET index (ADR-0058 §4). The claim-time schedule (`createEdinetIndexService.materializeDue`) queues one `edinet-index` job per owner when the Japanese stock list is stored, no such job is active, the last one was created at least `SYNC_MIN_GAP_MS` ago (`SYNC_RETRY_MS` after one that did not complete) and a day of the window is not stored here; the claim plans the days again when it is leased.

### Retention

Kept indefinitely: the six-year window is about 1,560 rows, growing by one row a weekday.
