# Table: stock_company_summary

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_company_summary` |
| Purpose | One row per stock the server has queued an AI-written company summary for: when it was queued and, once written, the description and investment themes in English and Japanese, the agent and model that wrote them and when (ADR-0060). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 9. Stock directory |
| Created By | `infra/migrations/0028_stock_company_summary.sql` |
| Primary Key | `owner_id`, `market`, `symbol` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/companySummary.ts` (`createCompanySummaryRepository`, `companySummaryStatements`), `packages/application/src/companySummary.ts` (`createCompanySummaryService`), `packages/application/src/stockPages.ts` (`profile`) |
| Update Strategy | `queued_at` upserted when the scheduler queues a `company-summary` job; the summary columns overwritten by a `company-summarized` completion, in the job's guarded batch |
| Data Retention | One row per stock that was on the Watchlist while an AI agent was chosen; kept when the stock leaves the Watchlist |

The Stocks page's Company tab shows the summary (`GET /api/v1/stocks/:stockId` returns it as `summary`, `companySummaryViewSchema`) above the listing, labelled as written by AI with the model and date. The owner's AI agent (Settings → AI agent) writes it in a `company-summary` runner job from the stored facts the claim carries — the directory names and listing, a Japanese stock's J-Quants sectors and the start of a US stock's annual-report business section — with no tools and no network. The row is owner data like the directory: no foreign key, so a summary stays when its stock leaves the Watchlist or the stock list.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `market` | TEXT | No | - | `'US'` or `'JP'`, the stock's market. |
| `symbol` | TEXT | No | - | The stock's symbol (`AAPL`, `7203`), as in its stock id. |
| `queued_at` | TEXT | No | - | ISO-8601 UTC time the server last queued a `company-summary` job for the stock; the stock is not queued again within 24 hours of it. |
| `description_en` | TEXT | Yes | - | The English description (1–1,000 characters); NULL before the first summary. |
| `description_ja` | TEXT | Yes | - | The Japanese description (1–1,000 characters); NULL before the first summary. |
| `themes_json` | TEXT | Yes | - | The investment themes, `[{"en": "...", "ja": "..."}, ...]` (1–8, each 1–40 characters per language; `companySummaryThemeSchema`); NULL before the first summary. |
| `agent_id` | TEXT | Yes | - | The agent backend that wrote the summary (`claude-code`, `opencode`, …); NULL before the first summary. |
| `model` | TEXT | Yes | - | The model chosen in Settings when the job was queued; NULL when the backend's default was used or before the first summary. |
| `generated_at` | TEXT | Yes | - | ISO-8601 UTC time the completion that wrote the summary was stored; NULL before the first summary. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `market`, `symbol` | - | One summary per stock; the Stocks read's key seek. |
| (unnamed) | CHECK | `market` | `market IN ('US', 'JP')` | The two markets. |
| (unnamed) | CHECK | `symbol` | `length(symbol) BETWEEN 1 AND 16` | The stock id's symbol bound. |
| (unnamed) | CHECK | `description_en` | `description_en IS NULL OR length(description_en) BETWEEN 1 AND 1000` | The contract's description bound. |
| (unnamed) | CHECK | `description_ja` | `description_ja IS NULL OR length(description_ja) BETWEEN 1 AND 1000` | The contract's description bound. |
| (unnamed) | CHECK | `themes_json` | `themes_json IS NULL OR json_valid(themes_json)` | Stored JSON; its shape is checked by the contract on read. |
| (unnamed) | CHECK | `agent_id` | `agent_id IS NULL OR length(agent_id) BETWEEN 2 AND 32` | The agent id's bound. |
| (unnamed) | CHECK | `model` | `model IS NULL OR length(model) BETWEEN 1 AND 100` | The model's bound. |
| (unnamed) | CHECK | `description_en`, `description_ja`, `themes_json`, `agent_id`, `model`, `generated_at` | `(description_en IS NULL) = (generated_at IS NULL) AND (description_ja IS NULL) = (generated_at IS NULL) AND (themes_json IS NULL) = (generated_at IS NULL) AND (agent_id IS NULL) = (generated_at IS NULL) AND (model IS NULL OR generated_at IS NOT NULL)` | A summary is stored whole or not at all. |

## Indexes

None besides the primary key: the Stocks read is one key seek, and the schedule reads the owner's whole range (one row per Watchlist stock at most).

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market`, `symbol` | `watchlist_stocks` | `owner_id`, `stock_id` | One-to-one (optional) | Application-enforced: queued only for Watchlist stocks, no foreign key (a summary outlives its stock's place on the Watchlist) |

## Data Lifecycle

### Insert

When the claim's schedule queues a `company-summary` job for a Watchlist stock (`POST /api/v1/runner/jobs/claim`): an upsert that sets `queued_at` to the queue time, the summary columns NULL on a new row.

### Update

The same upsert moves `queued_at` on every later queue and leaves a stored summary as it is. A `company-summarized` completion (`POST /api/v1/runner/jobs/:id/complete`) writes the description, themes, agent, model and `generated_at` over the row in the job's guarded batch (an `INSERT … ON CONFLICT DO UPDATE`, so a row lost meanwhile is created again).

### Delete

Never by the application. The rollback of migration 0028 drops the table.

### Synchronization

The server's schedule, at claim time (ADR-0051, ADR-0054, ADR-0060): while an AI agent is chosen in Settings and no `company-summary` job is unfinished, it queues one for the first Watchlist stock with no row, or whose row has no summary or one older than 90 days and was queued more than 24 hours ago. One agent turn per stock: on a plan-limited backend it uses the plan's quota; on a metered one it costs the turn's tokens.

### Retention

Kept until the table is dropped; bounded by the stocks that were ever on the Watchlist.
