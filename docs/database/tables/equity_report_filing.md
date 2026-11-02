# Table: equity_report_filing

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_report_filing` |
| Purpose | One row per annual filing a sync has seen for a tracked company (SEC: 10-K, 20-F and 40-F with their amendments; J-Quants: a full-year earnings summary, 決算短信, and its corrections): its form, dates, standard, amendment link, source link and whether its facts are recorded (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and J-Quants |
| Created By | `infra/migrations/0021_equity_financial_sync.sql`; rebuilt with every row by `0025_sec_foreign_annual_forms.sql` (the wider `form` CHECK); rebuilt by `0027_jquants_financials.sql` (provider `jquants`, the earnings-report forms; the EDINET rows deleted, ADR-0059) |
| Primary Key | `owner_id`, `filing_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`equitySyncStatements`, `claimContext`, `listFilings`), `packages/application/src/equitySync.ts` (`planCompletionFilings`) |
| Update Strategy | Insert-or-ignore from a guarded completion; afterwards only `facts_status` moves pending → extracted / unavailable (with `fact_count`, `primary_scope`, `recorded_at` and a missing standard) |
| Data Retention | Kept indefinitely, superseded originals included |

Every filing a `financial-synced` completion reports is inserted once, in the job's guarded batch; its metadata is never rewritten afterwards. A filing whose facts were deferred by a job's download cap, or are not available yet (SEC company facts lag the filing), is `pending`: the next claim offers it again with its stored metadata, which the runner echoes. Its facts (`equity_reported_fact`) are recorded once, and its `primary_scope` with them. A J-Quants summary carries its figures, so it is always `extracted`. The claim builder reads a company's filings newest first (SEC: known and pending accessions; J-Quants: every stored disclosure number, `knownDisclosures`), the cited filings come with every statement read, and `GET /api/v1/equities/companies/:companyId/filings` lists them all.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `filing_id` | TEXT | No | - | `<company_id>:<provider>:<source_document_id>` (`equityFilingId`): per company, because SEC co-registrants share one accession across issuers. |
| `company_id` | TEXT | No | - | The company the filing was synced for (`equity_company`). |
| `provider` | TEXT | No | - | `'sec'` or `'jquants'`, the company's provider. |
| `source_document_id` | TEXT | No | - | The permanent id: SEC accession (`0000320193-24-000123`) or J-Quants disclosure number (`DiscNo`, 14 digits, e.g. `20260508533000`). |
| `form` | TEXT | No | - | SEC: `'10-K'`, `'10-K/A'`, `'20-F'`, `'20-F/A'`, `'40-F'` or `'40-F/A'` (20-F and 40-F: foreign private issuers, ADR-0058 §5, migration 0025); J-Quants: `'earnings-report'` (the first full-year summary of a fiscal year, `DocType` `FYFinancialStatements_…`) or `'amended-earnings-report'` (a later full-year summary of the same fiscal year, a correction; ADR-0059 §2, migration 0027). |
| `filed_on` | TEXT | No | - | Filing date, YYYY-MM-DD (SEC `filingDate`; J-Quants `DiscDate`). The selection's "latest filing" order, with `filing_id`. |
| `submitted_at` | TEXT | Yes | - | SEC acceptance / J-Quants disclosure instant (`DiscDate` + `DiscTime`, Asia/Tokyo), ISO-8601 UTC, when the source states it. |
| `period_start` | TEXT | Yes | - | The report's own fiscal period start, YYYY-MM-DD, when stated (J-Quants `CurFYSt`). |
| `period_end` | TEXT | No | - | The report's fiscal period end, YYYY-MM-DD (J-Quants `CurFYEn`). |
| `accounting_standard` | TEXT | Yes | - | `'US-GAAP'`, `'JGAAP'` or `'IFRS'`; NULL until the facts say (a pending filing learns it when extracted). SEC: the company-facts taxonomy the filing's facts came from (`us-gaap` → US-GAAP, `ifrs-full` → IFRS), decided per filing — an issuer that moved from US GAAP to IFRS keeps both kinds (ADR-0058 §5). J-Quants: the `DocType` suffix (`_JP` → JGAAP, `_IFRS` → IFRS, `_US` → US-GAAP, any other such as `_JMIS` → NULL). |
| `amends_source_document_id` | TEXT | Yes | - | The document the filing amends: for an `amended-earnings-report`, the `DiscNo` of the full-year summary of the same fiscal year disclosed before it. |
| `source_url` | TEXT | No | - | The filing's source: the SEC archive document (or folder), or the J-Quants query that answers the summary (`https://api.jquants.com/v2/fins/summary?code=<code>&date=<DiscDate>`; J-Quants keeps no public document page). |
| `facts_status` | TEXT | No | - | `'pending'` (offered again by the next claim), `'extracted'` (facts recorded) or `'unavailable'` (no machine-readable facts 7 days after filing; SEC only). |
| `fact_count` | INTEGER | No | 0 | Annual facts stored from the filing (`equity_reported_fact` rows). |
| `primary_scope` | TEXT | Yes | - | The scope the filing's values come from: `'consolidated'` when it reports any consolidated fact, else `'separate'` (a filer without subsidiaries). Set exactly when extracted; the projection reads only facts of this scope, so a consolidated filer never shows a parent-only figure. |
| `first_seen_at` | TEXT | No | - | ISO-8601 UTC time of the completion that inserted the row. |
| `recorded_at` | TEXT | No | - | ISO-8601 UTC time the row's status was last decided (insert, or the move from pending). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `filing_id` | - | One row per company and source document; the target of the insert's `ON CONFLICT DO NOTHING`. |
| (unnamed) | FOREIGN KEY | `owner_id`, `company_id` | `equity_company (owner_id, company_id) ON DELETE RESTRICT` | A filing belongs to a stored company. |
| (unnamed) | CHECK | `provider` | `provider IN ('sec', 'jquants')` | Only the two implemented providers. |
| (unnamed) | CHECK | `form` | `form IN ( '10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A', 'earnings-report', 'amended-earnings-report' )` | Only annual reports and their amendments. Widened by migration 0025, the EDINET forms replaced by J-Quants' by 0027 (table rebuilds: SQLite cannot alter a CHECK). |
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

A `financial-synced` completion (`POST /api/v1/runner/jobs/:id/complete`): `planCompletionFilings` decides each new filing's status — extracted; pending when deferred, or not available within 7 days (`filingStaysPending`) of its filing date; else unavailable — and `equitySyncStatements` inserts them with `INSERT … SELECT … FROM json_each(?) … ON CONFLICT DO NOTHING`, guarded on the job's compare-and-set (a stale lease writes nothing).

### Update

Only a stored `pending` filing changes, once: a later completion moves it to `extracted` (with `fact_count`, `primary_scope` and the standard where it was NULL) or `unavailable`, by an `UPDATE … WHERE facts_status = 'pending'` in the guarded batch. A final filing is never touched again.

### Delete

Never by the application; `equity_reported_fact` references it with `ON DELETE RESTRICT`. The re-extract procedure (equities guide, Limitations) resets `extracted` rows to `pending` instead of deleting them.

### Synchronization

Follows the providers incrementally: SEC submissions (10-K, 20-F, 40-F and their amendments filed in the last 6 years) and J-Quants' earnings summaries of the company (`GET /v2/fins/summary?code=`, about two fiscal years on the Free plan). A known filing is not reported again; a pending one is offered again until it is final.

### Retention

Kept indefinitely; a few annual filings per company per year.
