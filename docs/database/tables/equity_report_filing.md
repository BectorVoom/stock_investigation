# Table: equity_report_filing

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_report_filing` |
| Purpose | One row per annual filing a sync has seen for a tracked company (10-K, 10-K/A, 有価証券報告書 and its 訂正): its form, dates, standard, amendment link, source link and whether its facts are recorded (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0021_equity_financial_sync.sql` |
| Primary Key | `owner_id`, `filing_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`equitySyncStatements`, `claimContext`, `listFilings`), `packages/application/src/equitySync.ts` (`planCompletionFilings`) |
| Update Strategy | Insert-or-ignore from a guarded completion; afterwards only `facts_status` moves pending → extracted / unavailable (with `fact_count`, `primary_scope`, `recorded_at` and a missing standard) |
| Data Retention | Kept indefinitely, superseded originals included |

Every filing a `financial-synced` completion reports is inserted once, in the job's guarded batch; its metadata is never rewritten afterwards. A filing whose facts were deferred by a job's download cap, or are not available yet (SEC company facts and EDINET's XBRL-to-CSV lag the filing), is `pending`: the next claim offers it again with its stored metadata, which the runner echoes. Its facts (`equity_reported_fact`) are recorded once, and its `primary_scope` with them. The claim builder reads a company's filings newest first (known and pending documents), the cited filings come with every statement read, and `GET /api/v1/equities/companies/:companyId/filings` lists them all.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `filing_id` | TEXT | No | - | `<company_id>:<provider>:<source_document_id>` (`equityFilingId`): per company, because SEC co-registrants share one accession across issuers. |
| `company_id` | TEXT | No | - | The company the filing was synced for (`equity_company`). |
| `provider` | TEXT | No | - | `'sec'` or `'edinet'`, the company's provider. |
| `source_document_id` | TEXT | No | - | The permanent public id: SEC accession (`0000320193-24-000123`) or EDINET docID (`S100TR7I`). |
| `form` | TEXT | No | - | `'10-K'`, `'10-K/A'`, `'securities-report'` (有価証券報告書, docTypeCode 120) or `'amended-securities-report'` (訂正, 130). |
| `filed_on` | TEXT | No | - | Filing date, YYYY-MM-DD (SEC `filingDate`; EDINET date of `submitDateTime`). The selection's "latest filing" order, with `filing_id`. |
| `submitted_at` | TEXT | Yes | - | SEC acceptance / EDINET submission instant, ISO-8601, when the source states it. |
| `period_start` | TEXT | Yes | - | The report's own fiscal period start, YYYY-MM-DD, when stated. |
| `period_end` | TEXT | No | - | The report's fiscal period end, YYYY-MM-DD; the EDINET backfill plan reads the original reports' ends. |
| `accounting_standard` | TEXT | Yes | - | `'US-GAAP'`, `'JGAAP'` or `'IFRS'`; NULL until the facts say (a pending filing learns it when extracted). |
| `amends_source_document_id` | TEXT | Yes | - | The document the filing amends, when the source names it (EDINET `parentDocID`). |
| `source_url` | TEXT | No | - | The filing's public page: the SEC archive document (or folder) or the EDINET viewer page. |
| `facts_status` | TEXT | No | - | `'pending'` (offered again by the next claim), `'extracted'` (facts recorded) or `'unavailable'` (no machine-readable facts 7 days after filing — SEC — or after first seen — EDINET). |
| `fact_count` | INTEGER | No | 0 | Annual facts stored from the filing (`equity_reported_fact` rows). |
| `primary_scope` | TEXT | Yes | - | The scope the filing's values come from: `'consolidated'` when it reports any consolidated fact, else `'separate'` (a filer without subsidiaries). Set exactly when extracted; the projection reads only facts of this scope, so a consolidated filer never shows a parent-only figure. |
| `first_seen_at` | TEXT | No | - | ISO-8601 UTC time of the completion that inserted the row. An EDINET filing reported not available stays pending until 7 days after this date. |
| `recorded_at` | TEXT | No | - | ISO-8601 UTC time the row's status was last decided (insert, or the move from pending). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `filing_id` | - | One row per company and source document; the target of the insert's `ON CONFLICT DO NOTHING`. |
| (unnamed) | FOREIGN KEY | `owner_id`, `company_id` | `equity_company (owner_id, company_id) ON DELETE RESTRICT` | A filing belongs to a stored company. |
| (unnamed) | CHECK | `provider` | `provider IN ('sec', 'edinet')` | Only the two implemented providers. |
| (unnamed) | CHECK | `form` | `form IN ('10-K', '10-K/A', 'securities-report', 'amended-securities-report')` | Only annual reports and their amendments. |
| (unnamed) | CHECK | `accounting_standard` | `accounting_standard IN ('US-GAAP', 'JGAAP', 'IFRS')` | The standards the registry knows. |
| (unnamed) | CHECK | `facts_status` | `facts_status IN ('pending', 'extracted', 'unavailable')` | The three extraction states. |
| (unnamed) | CHECK | `fact_count` | `fact_count >= 0` | A count. |
| (unnamed) | CHECK | `primary_scope` | `primary_scope IN ('consolidated', 'separate')` | The two statement scopes. |
| (unnamed) | CHECK | `facts_status`, `primary_scope` | `(facts_status = 'extracted') = (primary_scope IS NOT NULL)` | The primary scope is known exactly when the facts are recorded. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_report_filing__owner_id_company_id_filed_on_filing_id` | `owner_id`, `company_id`, `filed_on`, `filing_id` | No | A company's filings newest first (`claimContext`, `listFilings`: the index scanned backwards, no temporary sort) and the company list's filing count (a covering range). Every column is immutable after insert. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `company_id` | `equity_company` | `owner_id`, `company_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

A `financial-synced` completion (`POST /api/v1/runner/jobs/:id/complete`): `planCompletionFilings` decides each new filing's status — extracted; pending when deferred, or not available within 7 days (`filingStaysPending`) of its filing date for SEC or of when it was first seen for EDINET (an unreadable download may be transient); else unavailable — and `equitySyncStatements` inserts them with `INSERT … SELECT … FROM json_each(?) … ON CONFLICT DO NOTHING`, guarded on the job's compare-and-set (a stale lease writes nothing).

### Update

Only a stored `pending` filing changes, once: a later completion moves it to `extracted` (with `fact_count`, `primary_scope` and the standard where it was NULL) or `unavailable`, by an `UPDATE … WHERE facts_status = 'pending'` in the guarded batch. A final filing is never touched again.

### Delete

Never by the application; `equity_reported_fact` references it with `ON DELETE RESTRICT`. The re-extract procedure (equities guide, Limitations) resets `extracted` rows to `pending` instead of deleting them.

### Synchronization

Follows the providers incrementally: SEC submissions (10-K / 10-K/A filed in the last 6 years) and EDINET's per-date document lists. A known filing is not reported again; a pending one is offered again until it is final.

### Retention

Kept indefinitely; a few annual filings per company per year.
