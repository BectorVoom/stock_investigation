# Table: equity_company

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_company` |
| Purpose | One row per company the owner tracks (or tracked) for the annual financial statement sync: the listing it was added by and, once a sync resolved it, the issuer's SEC CIK or EDINET code (ADR-0048). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and EDINET |
| Created By | `infra/migrations/0021_equity_financial_sync.sql` |
| Primary Key | `owner_id`, `company_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`createEquitySyncRepository`, `equitySyncStatements`), `packages/application/src/equitySync.ts` |
| Update Strategy | Insert on track or default seeding; `tracked` flipped by untrack / re-track; identity filled once by a guarded completion |
| Data Retention | Kept indefinitely: untracking keeps the row and every filing, fact and value of the company |

The root of the financial statement sync. The owner adds a row with `POST /api/v1/equities/companies` (or the claim-time scheduler adds the six default companies once, `EQUITY_DEFAULT_STOCK_IDS`); every other `equity_*` sync table hangs off it. The company id is opaque: the listing (`market`, `symbol`) is only how the company was found, and the issuer's source id (`source_company_id`) is its durable identity once the first `financial-synced` completion reports it. Read by the company list and every Equities read, and by the scheduler's probe (`eco.tracked = 1`).

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `company_id` | TEXT | No | - | Opaque company id, `eqc_` plus 24 hex characters (`IdGenerator.newId("eqc")`). Never a ticker. |
| `market` | TEXT | No | - | `'US'` or `'JP'`: the listing's market, which decides the provider. |
| `symbol` | TEXT | No | - | The listing's ticker (US) or 4-character JPX code (JP) the company was tracked by, 1-16 characters. |
| `provider` | TEXT | No | - | `'sec'` (US, SEC EDGAR) or `'edinet'` (JP, EDINET API v2); always the market's provider. |
| `source_company_id` | TEXT | Yes | - | SEC CIK (10 digits) or EDINET code (`E` + 5 digits); NULL until a sync resolved it, then never rewritten. |
| `name` | TEXT | Yes | - | Company name: the stock directory's name when tracked, then the source's (SEC entity name, EDINET filer name) after each sync. |
| `fiscal_year_end` | TEXT | Yes | - | `MM-DD` from the source (SEC `fiscalYearEnd`, EDINET period end of an original 有価証券報告書); NULL until known. |
| `tracked` | INTEGER | No | 1 | 1 while tracked; 0 after untrack (the company is no longer synced, its data stays readable). |
| `tracked_at` | TEXT | No | - | ISO-8601 UTC time the company was tracked or last re-tracked; the company list's order. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `company_id` | - | Identifies one company; every other sync table references it. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | Only the two supported markets. |
| (unnamed) | CHECK | `symbol` | `length(symbol) BETWEEN 1 AND 16` | A listing symbol is 1-16 characters. |
| (unnamed) | CHECK | `provider` | `provider IN ('sec', 'edinet')` | Only the two implemented providers. |
| (unnamed) | CHECK | `tracked` | `tracked IN (0, 1)` | `tracked` is a boolean. |
| (unnamed) | CHECK | `market`, `provider` | `(market = 'US') = (provider = 'sec')` | US listings sync from SEC, Japanese ones from EDINET. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `uq_equity_company__owner_id_market_symbol` | `owner_id`, `market`, `symbol` | Yes | One company per listing: `track` and `findByListing` seek it, and a re-track finds the untracked row instead of adding a second. |
| `uq_equity_company__owner_id_provider_source_company_id` | `owner_id`, `provider`, `source_company_id` WHERE source_company_id IS NOT NULL | Yes | One company per resolved issuer: `findBySourceId` seeks it, and a completion whose issuer another company already holds is refused (`FINANCIAL_IDENTITY_CONFLICT`). |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`POST /api/v1/equities/companies` → `createEquitySyncService().track` → `track`: an `INSERT … SELECT` that writes only while the owner tracks fewer than 20 companies (`EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies`), batched with the company's `equity_sync_state` row due now. The claim-time scheduler's `seedDefaults` inserts the default companies once per owner, in the batch that writes the owner's `equity_sync_meta` row.

### Update

`untrack` sets `tracked = 0` only where it is 1 (a repeat writes nothing and no audit row); a re-track sets `tracked = 1` and `tracked_at`, within the cap. A `financial-synced` completion, guarded on the job's compare-and-set, fills `source_company_id` where it is NULL and follows the source's `name` and `fiscal_year_end`, and touches the row only when something differs.

### Delete

Never: no code path deletes companies, and the other sync tables reference them with `ON DELETE RESTRICT`. Removing a company's data is a separate administrative operation (export first).

### Synchronization

The identity follows the provider: the first sync resolves the CIK (SEC ticker list) or EDINET code (document list) and it is never rewritten; a completion reporting a different issuer is refused rather than merged (`EQUITY_IDENTITY_CONFLICT_CODE`).

### Retention

Kept indefinitely; at most 20 tracked rows per owner, plus the untracked ones the owner added before.

## Notes

- Two listings of one issuer (GOOGL and GOOG) or a ticker that now names another issuer end in `FINANCIAL_IDENTITY_CONFLICT` for the second company; the owner untracks one of them.
- Tracking a stock that is not in `stock_directory` is allowed: the directory may not be downloaded yet.
