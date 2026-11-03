# Table: stock_company_summary

## Overview

| Property | Value |
|---|---|
| Table Name | `stock_company_summary` |
| Purpose | One row per stock the server has queued an AI-written company summary for: when it was queued and, once written, the description and investment themes in English and Japanese, the agent and model that wrote them and when (ADR-0060); and the company overview (事業概要) with its evidence and references (ADR-0064); and the shown themes' names, which the theme search reads (ADR-0066). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 9. Stock directory |
| Created By | `infra/migrations/0028_stock_company_summary.sql`; overview columns added by `infra/migrations/0029_company_overview.sql`; `theme_names` and its triggers by `infra/migrations/0030_company_theme_names.sql` |
| Primary Key | `owner_id`, `market`, `symbol` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/companySummary.ts` (`createCompanySummaryRepository`, `companySummaryStatements`), `packages/application/src/companySummary.ts` (`createCompanySummaryService`), `packages/application/src/stockPages.ts` (`profile`, `themeSearch`), `scripts/poc/companyDescription/` (the overview writer, `run.ts --store`) |
| Update Strategy | `queued_at` upserted when the scheduler queues a `company-summary` job; the summary columns overwritten by a `company-summarized` completion, in the job's guarded batch; the overview columns overwritten together by the overview writer; `theme_names` derived by the triggers |
| Data Retention | One row per stock that was on the Watchlist while an AI agent was chosen; kept when the stock leaves the Watchlist |

The Stocks page's Company tab shows the summary (`GET /api/v1/stocks/:stockId` returns it as `summary`, `companySummaryViewSchema`) above the listing, labelled as written by AI with the model and date. The owner's AI agent (Settings → AI agent) writes it in a `company-summary` runner job from the stored facts the claim carries — the directory names and listing, a Japanese stock's J-Quants sectors and the start of a US stock's annual-report business section — with no tools and no network. Beside the summary, the row can hold the company overview (事業概要, ADR-0064): an entry laid out like a 会社四季報 company entry in which every field written by the model carries evidence (a source id and a word-for-word quote, checked before it is stored), the facts the server filled in (listing, sector, fiscal year end, annual figures) and the numbered references. The Company tab shows it under 事業概要 instead of the summary when one is stored (`overview`, `companyOverviewViewSchema`). The row is owner data like the directory: no foreign key, so a summary stays when its stock leaves the Watchlist or the stock list.

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
| `overview_json` | TEXT | Yes | - | The overview entry (`companyOverviewEntrySchema`): 【特色】, 【事業内容】, 【連結事業】, 【海外】, 【テーマ】 and the stated 会社概要 facts, each with its evidence, in English and Japanese; at most 60,000 characters; NULL while no overview is stored. |
| `overview_facts_json` | TEXT | Yes | - | What the server filled in when the overview was written (`companyOverviewFactsSchema`): listing, Japanese sector, fiscal year end, up to four annual figures, and the source each cites; at most 4,000 characters. |
| `overview_references_json` | TEXT | Yes | - | The numbered sources (`overviewReferenceSchema`, S1–S9): title in both languages, publisher, date, https link and note; at most 16,000 characters. |
| `overview_agent_id` | TEXT | Yes | - | The agent backend that wrote the overview (`claude-api`, …). |
| `overview_model` | TEXT | Yes | - | The model that wrote it; NULL when the backend's default was used. |
| `overview_generated_at` | TEXT | Yes | - | ISO-8601 UTC time the overview was written; NULL while none is stored. |
| `theme_names` | TEXT | Yes | - | The themes the Company tab shows, as `[["en", "ja"], ...]`: the overview's 【テーマ】 labels when an overview is stored, else the summary's themes; NULL while neither is stored. Derived by the triggers below, never written by the application; the theme search (`GET /api/v1/stocks/theme-search`, ADR-0066) reads it. At most 4,000 characters. |

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
| (unnamed) | CHECK | `overview_json` | `overview_json IS NULL OR (json_valid(overview_json) AND length(overview_json) <= 60000)` | Stored JSON within its bound; its shape is checked by the contract on read. |
| (unnamed) | CHECK | `overview_facts_json` | `overview_facts_json IS NULL OR (json_valid(overview_facts_json) AND length(overview_facts_json) <= 4000)` | Stored JSON within its bound. |
| (unnamed) | CHECK | `overview_references_json` | `overview_references_json IS NULL OR (json_valid(overview_references_json) AND length(overview_references_json) <= 16000)` | Stored JSON within its bound. |
| (unnamed) | CHECK | `overview_agent_id` | `overview_agent_id IS NULL OR length(overview_agent_id) BETWEEN 2 AND 32` | The agent id's bound. |
| (unnamed) | CHECK | `overview_model` | `overview_model IS NULL OR length(overview_model) BETWEEN 1 AND 100` | The model's bound. |
| (unnamed) | CHECK | `theme_names` | `theme_names IS NULL OR (json_valid(theme_names) AND length(theme_names) <= 4000)` | Stored JSON within its bound (8 themes of 40 characters per language, escaped). |
| (unnamed) | CHECK | `overview_json`, `overview_facts_json`, `overview_references_json`, `overview_agent_id`, `overview_model`, `overview_generated_at` | `(overview_json IS NULL) = (overview_generated_at IS NULL) AND (overview_facts_json IS NULL) = (overview_generated_at IS NULL) AND (overview_references_json IS NULL) = (overview_generated_at IS NULL) AND (overview_agent_id IS NULL) = (overview_generated_at IS NULL) AND (overview_model IS NULL OR overview_generated_at IS NOT NULL)` | An overview is stored whole or not at all (on `overview_generated_at`, the last column). |
| (unnamed) | CHECK | `description_en`, `description_ja`, `themes_json`, `agent_id`, `model`, `generated_at` | `(description_en IS NULL) = (generated_at IS NULL) AND (description_ja IS NULL) = (generated_at IS NULL) AND (themes_json IS NULL) = (generated_at IS NULL) AND (agent_id IS NULL) = (generated_at IS NULL) AND (model IS NULL OR generated_at IS NOT NULL)` | A summary is stored whole or not at all. |

## Indexes

None besides the primary key: the Stocks read is one key seek, and the schedule and the theme search read the owner's whole range (`owner_id` prefix; one row per stock ever queued, at most the Watchlist's stocks), the search testing `instr(lower(theme_names), ?)` on each row.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `market`, `symbol` | `watchlist_stocks` | `owner_id`, `stock_id` | One-to-one (optional) | Application-enforced: queued only for Watchlist stocks, no foreign key (a summary outlives its stock's place on the Watchlist) |

## Triggers

| Trigger | Event | Body | Description |
|---|---|---|---|
| `stock_company_summary_theme_names_insert` | AFTER INSERT | `UPDATE stock_company_summary SET theme_names = CASE WHEN stock_company_summary.overview_json IS NOT NULL THEN ( SELECT json_group_array(json_array(json_extract(t.value, '$.label.en'), json_extract(t.value, '$.label.ja'))) FROM json_each(stock_company_summary.overview_json, '$.themes') AS t ) WHEN stock_company_summary.themes_json IS NOT NULL THEN ( SELECT json_group_array(json_array(json_extract(t.value, '$.en'), json_extract(t.value, '$.ja'))) FROM json_each(stock_company_summary.themes_json) AS t ) END WHERE owner_id = NEW.owner_id AND market = NEW.market AND symbol = NEW.symbol;` | Derives `theme_names` for a new row (NULL for a row only queued). |
| `stock_company_summary_theme_names_update` | AFTER UPDATE OF themes_json, overview_json | `UPDATE stock_company_summary SET theme_names = CASE WHEN stock_company_summary.overview_json IS NOT NULL THEN ( SELECT json_group_array(json_array(json_extract(t.value, '$.label.en'), json_extract(t.value, '$.label.ja'))) FROM json_each(stock_company_summary.overview_json, '$.themes') AS t ) WHEN stock_company_summary.themes_json IS NOT NULL THEN ( SELECT json_group_array(json_array(json_extract(t.value, '$.en'), json_extract(t.value, '$.ja'))) FROM json_each(stock_company_summary.themes_json) AS t ) END WHERE owner_id = NEW.owner_id AND market = NEW.market AND symbol = NEW.symbol;` | Derives `theme_names` again whenever the summary's themes or the overview change, whoever writes them; an update of other columns leaves it. |

## Data Lifecycle

### Insert

When the claim's schedule queues a `company-summary` job for a Watchlist stock (`POST /api/v1/runner/jobs/claim`): an upsert that sets `queued_at` to the queue time, the summary columns NULL on a new row.

### Update

The same upsert moves `queued_at` on every later queue and leaves a stored summary as it is. A `company-summarized` completion (`POST /api/v1/runner/jobs/:id/complete`) writes the description, themes, agent, model and `generated_at` over the row in the job's guarded batch (an `INSERT … ON CONFLICT DO UPDATE`, so a row lost meanwhile is created again).

The overview writer upserts the six overview columns together (a new row gets `queued_at` = the write time) and leaves the summary columns as they are; a `company-summarized` completion leaves the overview columns as they are.

The triggers rewrite `theme_names` in the same statement's transaction after each insert and after each update of `themes_json` or `overview_json`; migration 0030 filled it once for the rows stored before it.

### Delete

Never by the application. The rollback of migration 0030 drops the two triggers, then `theme_names`; that of 0029 drops the overview columns; that of 0028 drops the table.

### Synchronization

The server's schedule, at claim time (ADR-0051, ADR-0054, ADR-0060): while an AI agent is chosen in Settings and no `company-summary` job is unfinished, it queues one for the first Watchlist stock with no row, or whose row has no summary or one older than 90 days and was queued more than 24 hours ago. One agent turn per stock: on a plan-limited backend it uses the plan's quota; on a metered one it costs the turn's tokens.

### Retention

Kept until the table is dropped; bounded by the stocks that were ever on the Watchlist.
