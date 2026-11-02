# Table: stock_company_profile

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_company_profile` |
| Purpose | One row per Japanese directory stock holding its company profile from J-Quants' Listed Issue Master: English name, TSE 17- and 33-sector classification, scale category and market segment, as of the master's date (ADR-0059 §3). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 9. Stock directory |
| Created By | `infra/migrations/0027_jquants_financials.sql` |
| Primary Key | `owner_id`, `market`, `symbol` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`stockDirectoryStatements`), `packages/adapters/src/sql/repositories.ts` (`createStockDirectoryRepository`: `getCompanyProfile`, `listMeta`), `packages/application/src/stockPages.ts` (`profile`) |
| Update Strategy | Replaced per market by a JP `stock-directory-refreshed` completion that carries `profiles`, in the job's guarded batch |
| Data Retention | One row per JP directory stock J-Quants lists (about 3,700); kept until the next completion with `profiles` replaces them |

J-Quants has no business description text, so a Japanese stock's Company tab on the Stocks page shows this profile in place of the 事業の内容 (`GET /api/v1/stocks/:stockId` returns it as `companyProfile`, `stockCompanyProfileViewSchema`, with `retrievedAt`; its `business` is `not-provided`). The JP `stock-directory-refresh` job asks J-Quants `GET /v2/equities/master` (every page) when `JQUANTS_API_KEY` is set; its completion's `profiles` holds one `stockCompanyProfileSchema` per listed issue whose 5-character code ends in `0` (common stock; the symbol is the code without it), or null when the key is missing or the request failed. The rows are owner data like the directory: no foreign key, since the directory's rows are replaced on every refresh.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | Always `'JP'`: J-Quants lists Japanese issues only. |
| `symbol` | TEXT | No | - | The 4-character JPX code (`7203`, `130A`): J-Quants' `Code` without its trailing `0`, the `stock_directory` symbol. |
| `name_en` | TEXT | Yes | - | `CoNameEn`, the English company name; NULL when J-Quants states none. |
| `sector17_code` | TEXT | No | - | `S17`, the TSE 17-sector code (e.g. `6`). |
| `sector17_name` | TEXT | No | - | `S17Nm`, its Japanese name (e.g. `自動車・輸送機`). |
| `sector33_code` | TEXT | No | - | `S33`, the TSE 33-sector code (e.g. `3700`). |
| `sector33_name` | TEXT | No | - | `S33Nm`, its Japanese name (e.g. `輸送用機器`). |
| `scale_category` | TEXT | Yes | - | `ScaleCat`, the TOPIX size group (e.g. `TOPIX Core30`); NULL for J-Quants' `-` (none). |
| `market_segment_code` | TEXT | No | - | `Mkt`, the market segment code (e.g. `0111`). |
| `market_segment_name` | TEXT | No | - | `MktNm`, its Japanese name (e.g. `プライム`). |
| `as_of` | TEXT | No | - | `Date`, `YYYY-MM-DD`: the day the master states the issue's information for (about 12 weeks ago on the Free plan). |
| `retrieved_at` | TEXT | No | - | ISO-8601 UTC time the runner fetched the master (the completion's `fetchedAt`). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `symbol` | - | One profile per stock; the Stocks read's key seek and the completion's market range. |
| (unnamed) | CHECK | `market` | `market = 'JP'` | Profiles exist for Japanese stocks only. |
| (unnamed) | CHECK | `symbol` | `length(symbol) = 4` | A JPX local code. |
| (unnamed) | CHECK | `name_en` | `name_en IS NULL OR length(name_en) BETWEEN 1 AND 200` | The contract's name bound. |
| (unnamed) | CHECK | `sector17_code` | `length(sector17_code) BETWEEN 1 AND 8` | The contract's code bound. |
| (unnamed) | CHECK | `sector17_name` | `length(sector17_name) BETWEEN 1 AND 200` | The contract's name bound. |
| (unnamed) | CHECK | `sector33_code` | `length(sector33_code) BETWEEN 1 AND 8` | The contract's code bound. |
| (unnamed) | CHECK | `sector33_name` | `length(sector33_name) BETWEEN 1 AND 200` | The contract's name bound. |
| (unnamed) | CHECK | `scale_category` | `scale_category IS NULL OR length(scale_category) BETWEEN 1 AND 200` | The contract's name bound. |
| (unnamed) | CHECK | `market_segment_code` | `length(market_segment_code) BETWEEN 1 AND 8` | The contract's code bound. |
| (unnamed) | CHECK | `market_segment_name` | `length(market_segment_name) BETWEEN 1 AND 200` | The contract's name bound. |
| (unnamed) | CHECK | `as_of` | `length(as_of) = 10` | A calendar date. |

## Indexes

None besides the primary key: `getCompanyProfile` is one key seek, `listMeta`'s `EXISTS` (whether the market has any profile, for the schedule) stops at the first key of the `(owner_id, market)` range, and a completion deletes the market's rows as one key range.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market`, `symbol` | `stock_directory` | `owner_id`, `market`, `symbol` | One-to-one (optional) | Application-enforced: written only for symbols of the stored list (a join), no foreign key |

## Data Lifecycle

### Insert

A JP `stock-directory-refreshed` completion whose `profiles` is not null (`POST /api/v1/runner/jobs/:id/complete`): after the market's new `stock_directory` rows, in the same guarded batch, `stockDirectoryStatements` deletes the owner's JP profiles and inserts the new ones with `INSERT … SELECT … FROM json_each(?) JOIN stock_directory …` — a profile whose symbol is not in the list just stored is dropped — `retrieved_at` the completion's `fetchedAt`. About 4,400 profiles are two 512 KB chunks.

### Update

Never in place: a completion with `profiles` replaces every JP row.

### Delete

The same completion deletes the market's rows before inserting the new ones (an empty `profiles` list leaves none). A completion with `profiles` null (no `JQUANTS_API_KEY`, or the master request failed) and every US completion leave the rows as they are. The rollback of migration 0027 drops the table.

### Synchronization

Follows the JP stock-directory refresh (ADR-0034, the server's schedule, ADR-0054): one J-Quants `GET /v2/equities/master` per refresh, counted against the plan's limit (pacer key `jquants`). While the market has no row, the schedule downloads the JP list again after 24 hours instead of 7 days (`DIRECTORY_PROFILES_SYNC_INTERVAL_MS`, ADR-0059 §3), so profiles arrive within a day of an upgrade or of a J-Quants key being added.

### Retention

Kept until replaced; bounded by the JP directory (one row per listed common stock).
