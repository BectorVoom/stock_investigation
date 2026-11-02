# Table: equity_company

## Overview

| Property | Value |
|---|---|
| Table Name | `equity_company` |
| Purpose | One row per company tracked (or once tracked) for the annual financial statement sync — every stock of the owner's stock directory (ADR-0058 §3): the listing it was added by and, once a sync resolved it, the issuer's SEC CIK or J-Quants issue code (ADR-0048, ADR-0059). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 13. Financial statements synced from SEC and J-Quants |
| Created By | `infra/migrations/0021_equity_financial_sync.sql`; rebuilt by `0027_jquants_financials.sql` (provider `jquants`, ADR-0059) |
| Primary Key | `owner_id`, `company_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/equitySync.ts` (`createEquitySyncRepository`, `equitySyncStatements`), `packages/application/src/equitySync.ts` |
| Update Strategy | Inserted in batches by the claim-time reconcile with the stock directory; `tracked` flipped by its untrack / re-track; identity filled once by a guarded completion |
| Data Retention | Kept indefinitely: untracking keeps the row and every filing, fact and value of the company |

The root of the financial statement sync. The tracked companies are the stocks of the owner's stock directory, both markets (ADR-0058 §3, superseding ADR-0054 §1's Watchlist rule): at claim time (considered at most every 5 s per owner, run only when a stored directory changed since the last complete pass) `equitySync.materializeDue` tracks up to 500 directory stocks not yet tracked — Watchlist stocks first, then US before JP, then by symbol — and untracks the tracked companies whose listing left a stored directory (no page or endpoint tracks a company); every other `equity_*` sync table hangs off it. The company id is opaque: the listing (`market`, `symbol`) is only how the company was found, and the issuer's source id (`source_company_id`) is its durable identity once the first `financial-synced` completion reports it. Read by the company list and every Equities read, and by the scheduler's probe (`eco.tracked = 1`).

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `company_id` | TEXT | No | - | Opaque company id, `eqc_` plus 24 hex characters (`IdGenerator.newId("eqc")`). Never a ticker. |
| `market` | TEXT | No | - | `'US'` or `'JP'`: the listing's market, which decides the provider. |
| `symbol` | TEXT | No | - | The listing's ticker (US) or 4-character JPX code (JP) the company was tracked by, 1-16 characters. |
| `provider` | TEXT | No | - | `'sec'` (US, SEC EDGAR) or `'jquants'` (JP, J-Quants earnings summaries, ADR-0059); always the market's provider. Migration 0027 moved every `'edinet'` company to `'jquants'`. |
| `source_company_id` | TEXT | Yes | - | SEC CIK (10 digits) or the J-Quants issue code (the JPX code plus `0`, e.g. `72030`); NULL until a sync resolved it, then never rewritten. |
| `name` | TEXT | Yes | - | Company name: the stock directory's name when tracked (Japanese for JP), then the SEC entity name after each US sync (J-Quants states none, so a JP company keeps the directory's). |
| `fiscal_year_end` | TEXT | Yes | - | `MM-DD` from the source (SEC `fiscalYearEnd`; J-Quants `CurFYEn` of the newest full-year summary); NULL until known. |
| `tracked` | INTEGER | No | 1 | 1 while the listing is in the stock directory; 0 after the reconcile untracked it (the company is no longer synced, its data stays readable). |
| `tracked_at` | TEXT | No | - | ISO-8601 UTC time the company was tracked or last re-tracked; the company list's order. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `company_id` | - | Identifies one company; every other sync table references it. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | Only the two supported markets. |
| (unnamed) | CHECK | `symbol` | `length(symbol) BETWEEN 1 AND 16` | A listing symbol is 1-16 characters. |
| (unnamed) | CHECK | `provider` | `provider IN ('sec', 'jquants')` | Only the two implemented providers (ADR-0059; migration 0027's rebuild). |
| (unnamed) | CHECK | `tracked` | `tracked IN (0, 1)` | `tracked` is a boolean. |
| (unnamed) | CHECK | `market`, `provider` | `(market = 'US') = (provider = 'sec')` | US listings sync from SEC, Japanese ones from J-Quants. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `uq_equity_company__owner_id_market_symbol` | `owner_id`, `market`, `symbol` | Yes | One company per listing: the reconcile's directory pass and `findByListing` seek it (also for the Stocks page's News terms, ADR-0049), and a re-track finds the untracked row instead of adding a second. |
| `uq_equity_company__owner_id_provider_source_company_id` | `owner_id`, `provider`, `source_company_id` WHERE source_company_id IS NOT NULL | Yes | One company per resolved issuer: `findBySourceId` seeks it, and a completion whose issuer another company already holds is refused (`FINANCIAL_IDENTITY_CONFLICT`). |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`POST /api/v1/runner/jobs/claim` → `equitySync.materializeDue` → the directory reconcile: `untrackedDirectoryListings` (one pass over the owner's `stock_directory` rows, each with one seek of `uq_equity_company__owner_id_market_symbol`, at most `EQUITY_FINANCIAL_LIMITS.trackBatch` = 500) then `trackListings`, one batch per 512 KB of rows: an `INSERT … SELECT … FROM json_each(?) … ON CONFLICT DO NOTHING` of the new companies (ids generated by the API), the re-track `UPDATE`, and their `equity_sync_state` rows. 10 ms per 500-stock batch at 11,400 directory stocks on node:sqlite (`bun run bench`). One audit row per batch (`equity.track`, `equity.retrack`, detail `count=N`), actor `scheduler`. Before ADR-0054 the owner's `POST /api/v1/equities/companies` and the one-time default seeding inserted rows; both are removed.

### Update

The reconcile's `untrackDelisted` sets `tracked = 0` on tracked companies whose listing is not in its market's stored directory — only in a market whose directory is stored, so a missing list never untracks its market — and takes them off the schedule in the same batch (audited `equity.untrack`, `count=N`); its re-track (the listing is back) sets `tracked = 1` and `tracked_at`. A `financial-synced` completion, guarded on the job's compare-and-set, fills `source_company_id` where it is NULL and follows the source's `name` and `fiscal_year_end`, and touches the row only when something differs.

### Delete

Never: no code path deletes companies, and the other sync tables reference them with `ON DELETE RESTRICT`. Removing a company's data is a separate administrative operation (export first).

### Synchronization

The identity follows the provider: the first sync resolves the CIK (SEC ticker list) or the J-Quants issue code (the code the claim asked for) and it is never rewritten; a completion reporting a different issuer is refused rather than merged (`EQUITY_IDENTITY_CONFLICT_CODE`).

### Retention

Kept indefinitely; one tracked row per directory stock (about 11,400; bound `maxTrackedCompanies` = 20,000), plus the untracked ones of listings that left the directory.

## Notes

- Two listings of one issuer (GOOGL and GOOG, BRK-A and BRK-B) or a ticker that now names another issuer end in `FINANCIAL_IDENTITY_CONFLICT` for the second company, checked again after 30 days (`notFoundRetryDays`).
- Companies tracked by the Watchlist before ADR-0058 that are not in the directory stay tracked while their market's directory is not stored, and are untracked once it is.
- Migration 0027 (ADR-0059 §4) kept every Japanese company (same id, listing and tracked flag) but cleared its EDINET identity (`source_company_id`, `fiscal_year_end` NULL) and took its name again from the stored JP directory.
