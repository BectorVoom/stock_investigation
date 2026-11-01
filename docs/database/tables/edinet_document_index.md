# Table: edinet_document_index

## Overview

| Property | Value |
|---|---|
| Table Name | `edinet_document_index` |
| Purpose | One row per annual securities report (有価証券報告書, docTypeCode 120) or its amendment (訂正, 130) a listed EDINET day holds, for every company: the shared index a Japanese company's `financial-sync` downloads from (ADR-0058 §4). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0026_edinet_document_index.sql` |
| Primary Key | `owner_id`, `doc_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/edinetIndex.ts` (`edinetIndexStatements`), `packages/adapters/src/sql/equitySync.ts` (`claimContext`, `trackListings`), `packages/application/src/equitySync.ts` (`edinetIndexedPlan`) |
| Update Strategy | Insert-only (`ON CONFLICT DO NOTHING`) |
| Data Retention | Kept indefinitely; about 5,000 rows a year |

Each row is EDINET's own statement of one report, as its day list gave it (`GET /api/v2/documents.json?date=&type=2`, see [EDINET](../../external-apis/apis/edinet.md)). A Japanese company's `financial-sync` is due when the index holds a report of its securities code that it has not stored; the claim names those reports (`indexedFilings`, oldest first, at most 20), with the EDINET viewer link as the filing's page, and the runner downloads them. An amendment's row states no period (EDINET API spec §3-1-2-2 *3); the claim takes its original's from the stored filing or the original's row.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `doc_id` | TEXT | No | - | EDINET's document id (`docID`, `S` and seven characters): the report's permanent public identifier. |
| `sec_code` | TEXT | No | - | EDINET's five-character securities code (`secCode`): the JPX local code plus a check `0` (`edinetSecuritiesCode`). |
| `edinet_code` | TEXT | No | - | The filer's EDINET code (`E` and five digits); a company not resolved yet takes it in its claim. |
| `filer_name` | TEXT | No | - | The filer's name as EDINET states it (`filerName`), at most 200 characters. |
| `doc_type_code` | TEXT | No | - | `120` annual securities report, `130` its amendment. |
| `period_start` | TEXT | Yes | - | The report's period start, YYYY-MM-DD; NULL on an amendment. |
| `period_end` | TEXT | Yes | - | The report's period end, YYYY-MM-DD; NULL on an amendment. |
| `submitted_at` | TEXT | No | - | The submission instant (`submitDateTime`, JST) as ISO-8601 with its offset; the filing date is its date in Japan. |
| `parent_doc_id` | TEXT | Yes | - | The report an amendment amends (`parentDocID`); NULL on an original report. |
| `listed_on` | TEXT | No | - | The day whose list held the row (`edinet_index_day`). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `doc_id` | - | A report is indexed once, whichever day lists it; the insert's `ON CONFLICT DO NOTHING` target. |
| (unnamed) | CHECK | `doc_id` | `length(doc_id) = 8` | EDINET's document id length. |
| (unnamed) | CHECK | `sec_code` | `length(sec_code) = 5` | EDINET's securities code length. |
| (unnamed) | CHECK | `edinet_code` | `length(edinet_code) = 6` | EDINET's filer code length. |
| (unnamed) | CHECK | `filer_name` | `length(filer_name) BETWEEN 1 AND 200` | `EDINET_INDEX_LIMITS.maxFilerNameChars`. |
| (unnamed) | CHECK | `doc_type_code` | `doc_type_code IN ('120', '130')` | Only annual reports and their amendments are indexed. |
| (unnamed) | CHECK | `doc_type_code`, `period_end` | `doc_type_code = '130' OR period_end IS NOT NULL` | An original annual report states its period. |
| (unnamed) | FOREIGN KEY | `owner_id`, `listed_on` | `edinet_index_day (owner_id, listed_on) ON DELETE RESTRICT` | A report belongs to a listed day. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_edinet_document_index__owner_id_sec_code_submitted_at` | `owner_id`, `sec_code`, `submitted_at` | No | A Japanese company's reports in submission order (`claimContext`, one range seek at 30,000 rows: 0.28 ms with the company's other reads), and the tracking batch's test whether a new JP company has an indexed report (a seek per company). Immutable columns: one index write per report. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `listed_on` | `edinet_index_day` | `owner_id`, `listed_on` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `sec_code` | `equity_company` | `owner_id`, `symbol` (+ `0`) | Many-to-one, for companies with `market = 'JP'` | Logical |
| `owner_id`, `doc_id` | `equity_report_filing` | `owner_id`, `source_document_id` | One-to-many (each company that stored it; filing ids are per company) | Logical |

## Data Lifecycle

### Insert

An `edinet-indexed` completion inserts every report of the days it stores, after the days, with `INSERT … SELECT … FROM json_each(?) … ON CONFLICT DO NOTHING`, chunked by bytes, guarded on the job's compare-and-set. In the same batch, every tracked Japanese company whose securities code got a report it has not stored is made due at once (`equity_sync_state.next_due_at` and `sync_requested_at`).

### Update

Never: a row is EDINET's statement of the report.

### Delete

Never by the application.

### Synchronization

Written by the `edinet-index` job (ADR-0058 §4); read by the `financial-sync` claim and scheduler of a Japanese company (a company with nothing unstored here, no pending filing and no business description to read gets no job), and by the directory reconcile, which makes a new Japanese company due only when it has an indexed report.

### Retention

Kept indefinitely: about 4,000 annual reports and 1,000 amendments a year, 30,000 rows over the six-year window.
