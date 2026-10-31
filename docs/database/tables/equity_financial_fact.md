# Table: equity_financial_fact

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_financial_fact` |
| Purpose | Projection of `fact` records: one reported financial value, or a stated reason it is unavailable, of one metric in one statement. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 12. Equities library |
| Created By | `infra/migrations/0014_equities.sql` |
| Primary Key | `owner_id`, `fact_id` |
| Storage | `WITHOUT ROWID` |
| Code | None since ADR-0048 (was `packages/adapters/src/sql/equities.ts`, `packages/adapters/src/sql/equityTables.ts`, removed with the import) |
| Update Strategy | Retired: not written since ADR-0048 (under ADR-0041: insert-only; `ON CONFLICT DO NOTHING` when an import repeats an identical record) |
| Data Retention | Rows kept unchanged since ADR-0048; removing them is a separate administrative operation (export first) |

**Retired (ADR-0048).** No code writes or reads this table since migration 0021 replaced the owner import of ADR-0041 with the SEC/EDINET sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md); its tables are [`equity_company`](equity_company.md), [`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md) and [`equity_metric_value`](equity_metric_value.md)). An installation that imported files keeps its rows unchanged; export them with `wrangler d1 export` ([database operations](../operations.md)) before removing them through a separate administrative operation. The rest of this document records how the ADR-0041 import used the table.

Like every `equity_*` projection, it holds a few fields of the `fact` records in the immutable `equity_record` ledger: an owner import writes each record body there and copies these columns here in the same D1 batch, and the row is never updated or deleted ([equity_record](equity_record.md)). The value (`valueDecimal`, an exact decimal string), dimensions, reported precision, share basis and actual/estimate flag are only in the body. `listFacts` (`GET /api/v1/equities/issuers/:issuerId/facts`) returns every eligible fact of an issuer with its statement, metric, filing and document; `listIssuers` counts an issuer's facts.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `fact_id` | TEXT | No | - | Fact id (`body.factId`); equals the record's `equity_record.record_id`. `listFacts` orders and keyset-pages by it. |
| `statement_id` | TEXT | No | - | The statement that reports the fact. |
| `metric_definition_id` | TEXT | No | - | The metric the value measures. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `fact_id` | - | One fact per id; `listFacts` pages on it (`fact_id > after`). |
| (unnamed) | FOREIGN KEY | `owner_id`, `metric_definition_id` | `equity_metric_definition (owner_id, metric_definition_id) ON DELETE RESTRICT` | The metric definition must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `statement_id` | `equity_statement (owner_id, statement_id) ON DELETE RESTRICT` | The statement must exist. |
| (unnamed) | FOREIGN KEY | `owner_id`, `fact_id` | `equity_record (owner_id, record_id) ON DELETE RESTRICT` | The `fact` record must exist in `equity_record`; it is inserted earlier in the same batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_equity_financial_fact__owner_id_statement_id_fact_id` | `owner_id`, `statement_id`, `fact_id` | No | A statement's facts: `listFacts` and the fact count in `listIssuers` join statements to facts on `(owner_id, statement_id)` with a covering index read. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `metric_definition_id` | `equity_metric_definition` | `owner_id`, `metric_definition_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `statement_id` | `equity_statement` | `owner_id`, `statement_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `owner_id`, `fact_id` | `equity_record` | `owner_id`, `record_id` | One-to-one | Foreign key, ON DELETE RESTRICT |

## Data Lifecycle

### Insert

Never since ADR-0048. Under ADR-0041: `createEquityRepository().commit` inserts one row per `fact` record of an owner import (`POST /api/v1/equities/imports` → `createEquityService().import`), in the same D1 batch as the `equity_import` and `equity_record` rows. The statement is generated from the `EQUITY_TABLES` entry for `fact`: an `INSERT … SELECT` over `json_each` of the file's `facts` records that copies `$.body.*` fields with `json_extract`. It writes only if the batch's `equity_import` row was inserted, and `ON CONFLICT (owner_id, fact_id) DO NOTHING` skips a record the owner already holds.

### Update

Never: rows are immutable. Reusing a record id with different content is rejected (409 `CONFLICT`).

### Delete

Never: no code path deletes rows, and no table references this one.

### Synchronization

Not applicable: retired by ADR-0048. Financial statements now arrive through the SEC/EDINET sync ([`equity_report_filing`](equity_report_filing.md), [`equity_reported_fact`](equity_reported_fact.md), [`equity_metric_value`](equity_metric_value.md)).

### Retention

No rows are added since ADR-0048; the stored ones are kept. Under ADR-0041: kept indefinitely. Growth is bounded per import: at most 1,000 `facts` records, 2,000 records in all (`equityImportSchema`).

## Notes

- `listFacts` keeps a fact only if all seven contributing records (fact, statement, filing, metric, document, issuer, source) came from imports within `ingestionVersion` and, when given, `ingestionCutoff`.
- Disagreeing facts are all returned; no query selects or aggregates one latest value. Fact id order says nothing about financial recency.
