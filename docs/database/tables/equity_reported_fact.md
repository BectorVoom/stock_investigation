# Table: equity_reported_fact

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_reported_fact` |
| Purpose | The as-filed history: one row per annual fact of one filing (concept, scope, period, unit, value), as the source reported it, with the fiscal year and normalized metric it maps to (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0021_equity_financial_sync.sql` |
| Primary Key | `owner_id`, `filing_id`, `concept`, `scope`, `period_type`, `period_start`, `period_end`, `unit`, `value_decimal` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`equitySyncStatements`, `factsOfKeys`, `revisions`), `packages/application/src/equitySync.ts` (`equityFactRows`, `recomputeEquityValues`) |
| Update Strategy | Insert-only (`ON CONFLICT DO NOTHING`); never updated |
| Data Retention | Kept indefinitely: a restatement adds rows beside the earlier filing's |

The raw history the authoritative values (`equity_metric_value`) are computed from. A completion inserts the annual facts (`annualFactsOfFiling`) of each filing whose facts it recorded, once. A later filing that restates a year adds its own rows; the earlier ones stay, so every value ever reported keeps its filing. `metric_code` is denormalized at insert (from the reviewed mapping of the filing's provider and standard) so one metric-year's facts are one index range: the recompute reads only the touched keys, and the revisions read lists every as-filed value of one metric-year. Values are signed as reported.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `filing_id` | TEXT | No | - | The filing that reported the fact (`equity_report_filing`). |
| `concept` | TEXT | No | - | Taxonomy-qualified concept, e.g. `us-gaap:Revenues`, `jppfs_cor:NetSales`. |
| `scope` | TEXT | No | - | `'consolidated'` or `'separate'` (EDINET `_NonConsolidatedMember` contexts; SEC facts are consolidated). |
| `period_type` | TEXT | No | - | `'duration'` or `'instant'`. |
| `period_start` | TEXT | No | - | Duration start, YYYY-MM-DD; `''` for an instant (part of the key, so not NULL). |
| `period_end` | TEXT | No | - | Duration end or instant date, YYYY-MM-DD. |
| `unit` | TEXT | No | - | The source's unit: an ISO 4217 currency for monetary facts (`USD`, `JPY`). |
| `company_id` | TEXT | No | - | The filing's company, denormalized for the metric-year index. |
| `fiscal_year` | INTEGER | No | - | Fiscal year label, the year `period_end` falls in (`fiscalYearOfPeriodEnd`, computed by the API; 1-7 January ends belong to the year before). |
| `metric_code` | TEXT | Yes | - | The normalized metric the concept maps to under the filing's provider, standard and scope; NULL when unmapped (e.g. an IFRS filer). |
| `value_decimal` | TEXT | No | - | Exact canonical decimal text in base units, sign as reported. Part of the key: a filing that reports one key with two values keeps both. |
| `recorded_at` | TEXT | No | - | ISO-8601 UTC time of the completion that inserted the row. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `filing_id`, `concept`, `scope`, `period_type`, `period_start`, `period_end`, `unit`, `value_decimal` | - | One row per reported value: an exact repeat within a filing collapses (`ON CONFLICT DO NOTHING`), while two different values of one key are both kept, so the selection answers `ambiguous` rather than falling back to an older filing or a lower-ranked concept. |
| (unnamed) | FOREIGN KEY | `owner_id`, `filing_id` | `equity_report_filing (owner_id, filing_id) ON DELETE RESTRICT` | A fact belongs to a stored filing. |
| (unnamed) | CHECK | `scope` | `scope IN ('consolidated', 'separate')` | The two statement scopes. |
| (unnamed) | CHECK | `period_type` | `period_type IN ('duration', 'instant')` | The two period kinds. |
| (unnamed) | CHECK | `period_type`, `period_start` | `(period_type = 'instant') = (period_start = '')` | An instant has no start; a duration has one. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal` | `owner_id`, `company_id`, `metric_code`, `fiscal_year`, `value_decimal` WHERE metric_code IS NOT NULL | No | One metric-year's facts: `revisions` (one range) and `factsOfKeys` (one seek per touched key, driven from the keys by its `CROSS JOIN`). Covering, since every entry carries the primary key: without statistics the planner otherwise prefers the key's `owner_id` prefix and reads every fact of the owner (21.5 ms → 0.024 ms for a revisions read at 360,000 facts). Partial: unmapped facts cost no index write. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `filing_id` | `equity_report_filing` | `owner_id`, `filing_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `company_id` | `equity_company` | `owner_id`, `company_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

A `financial-synced` completion, for each filing whose facts it records now (new and extracted, or pending → extracted): `equityFactRows` re-applies the annual filter, computes `fiscal_year` and `metric_code`, collapses exact repeats, and `equitySyncStatements` inserts the rows from bound JSON chunks (`json_each`, at most 512 KiB each) with `ON CONFLICT DO NOTHING`, guarded on the job's compare-and-set.

### Update

Never: rows are immutable.

### Delete

Never by the application. The administrative re-extract procedure (equities guide, Limitations) deletes a company's rows so its filings are read again.

### Synchronization

Facts arrive with their filing, once: SEC company facts (only for new or pending accessions) and the EDINET XBRL-to-CSV of each new or pending document. Which of them feeds a value is decided by `equity_report_filing.primary_scope` and the selection (`selectMetricValue`).

### Retention

Kept indefinitely; about 60 annual facts per filing (at most 3,000 per completion).

## Notes

- Separate (parent-only) facts of a consolidated filing are kept as history but never feed a value (`primary_scope`); the revisions read still lists them with their scope.
- `metric_code` reflects the mapping registry when the row was inserted; a registry change applies to stored filings only after the re-extract procedure.
