# Table: equity_business_description

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_business_description` |
| Purpose | One row per company holding the business section of its newest annual report read — "Item 1. Business" of a 10-K (SEC) or 事業の内容 of an annual securities report (EDINET) — as paragraphs, or that the report had no section the runner could read (ADR-0053). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0022_equity_business_description.sql` |
| Primary Key | `owner_id`, `company_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts`, `packages/application/src/equitySync.ts` (claim and completion), `packages/application/src/stockPages.ts` (profile read) |
| Update Strategy | Upsert in a `financial-synced` completion's guarded batch, only with a report at least as new as the stored one |
| Data Retention | One row per company, kept as long as the company (also after untracking) |

What the Stocks page's Company tab shows under "Business". Each `financial-sync` claim names the stored row's `source_document_id` (`describedDocumentId`); the runner reads a newer report's section and returns it in the completion's `description`. The API writes it when no row is stored or when the new report's (`period_end`, `filed_on`, `source_document_id`) is at least the stored one's, so an EDINET backfill of older reports never replaces the newest description. A `not-found` row records that the report was read and had no usable section, so the same report is not downloaded again.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `company_id` | TEXT | No | - | The company (`equity_company`). |
| `source_document_id` | TEXT | No | - | SEC accession number or EDINET document id of the report read (1–40 characters). |
| `form` | TEXT | No | - | `10-K` or `securities-report` (有価証券報告書); amendments are never read for a description. |
| `filed_on` | TEXT | No | - | The report's filing date, `YYYY-MM-DD`. |
| `period_end` | TEXT | No | - | The report's fiscal year end, `YYYY-MM-DD`. |
| `source_url` | TEXT | No | - | HTTPS link to the report (SEC primary document; EDINET document viewer), shown as "View filing". |
| `status` | TEXT | No | - | `extracted` (paragraphs hold the section) or `not-found` (the report had none the runner could read). |
| `paragraphs_json` | TEXT | No | - | JSON array of `{ "kind": "heading" \| "text", "text": string }` (`equityBusinessParagraphSchema`), at most 400 paragraphs and 20,000 UTF-16 units of text (`BUSINESS_DESCRIPTION_LIMITS`); `[]` when `not-found`. Parsed with zod on write and on read. |
| `truncated` | INTEGER | No | - | 1 when paragraphs were left out to fit the limits (the filing has the rest); 0 otherwise and always for `not-found`. |
| `fetched_at` | TEXT | No | - | ISO-8601 UTC time the runner read the report (the completion's `fetchedAt`). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `company_id` | - | One description per company; the target of the upsert. |
| (unnamed) | FOREIGN KEY | `owner_id`, `company_id` | `equity_company (owner_id, company_id) ON DELETE RESTRICT` | A description belongs to a stored company. |
| (unnamed) | CHECK | `source_document_id` | `length(source_document_id) BETWEEN 1 AND 40` | The contract's document id bound. |
| (unnamed) | CHECK | `form` | `form IN ('10-K', 'securities-report')` | Only original annual reports. |
| (unnamed) | CHECK | `status` | `status IN ('extracted', 'not-found')` | The two outcomes of a read. |
| (unnamed) | CHECK | `paragraphs_json` | `json_valid(paragraphs_json) AND length(paragraphs_json) <= 200000` | Valid JSON of bounded size (20,000 characters of text plus the JSON around it). |
| (unnamed) | CHECK | `truncated` | `truncated IN (0, 1)` | `truncated` is a boolean. |

## Indexes

None besides the primary key: every read and write names one company.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `company_id` | `equity_company` | `owner_id`, `company_id` | One-to-one (optional) | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

A `financial-synced` completion with a `description` inserts the row in the job's guarded batch when the company has none.

### Update

The same completion replaces every column when the new report's (`period_end`, `filed_on`, `source_document_id`) is greater than or equal to the stored one's; otherwise the row is left as it is.

### Delete

Never by the application.

### Synchronization

Read from SEC EDGAR (the 10-K's primary document, `www.sec.gov/Archives/…`) and EDINET (the XBRL-to-CSV row `jpcrp_cor:DescriptionOfBusinessTextBlock`) by the runner; see [SEC EDGAR](../../external-apis/apis/sec-edgar.md) and [EDINET](../../external-apis/apis/edinet.md).

### Retention

One row per company, kept as long as the company, also after untracking (the Company tab keeps showing it).
