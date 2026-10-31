# Database documentation

Everything about the application database in one place: the rules for changing it, how to operate it, one definition document per table, the equities and materials libraries built on it, and their review records. The database is Cloudflare D1 (SQLite), with `node:sqlite` as the second, portable engine ([ADR-0008](../adr/0008-switchable-persistence.md)).

**Source of truth:** [`db/schema.sql`](../../db/schema.sql) defines the current structure and [`infra/migrations/`](../../infra/migrations/) the upgrade history. The documents here explain them; they don't define them.

## Contents

| Document | What it covers |
| --- | --- |
| [conventions.md](conventions.md) | The rules: schema and migration files, initialization, naming (tables, column suffixes, keys, indexes), aliases, SQL formatting, index design, adding a table, table documents (§10), the source record update timestamp (§11). |
| [operations.md](operations.md) | Applying migrations and rolling back, per-migration operational notes, switching the database engine. |
| [naming.md](naming.md) | Vocabulary of the equities and materials libraries: table prefixes, contracts, financial terms, routes. |
| [table-template.md](table-template.md) | The template for a new table document, with the cell conventions the checker relies on. |
| [tables/](#tables) | One definition document per table; index below. |
| [libraries/equities.md](libraries/equities.md) | Equities library: what is implemented, the import format, HTTP API, operations. |
| [libraries/equities-design.md](libraries/equities-design.md) | Equities database design: the full target model and roadmap beyond what is implemented. |
| [libraries/materials.md](libraries/materials.md) | Materials (metals) library: import API, bounds, storage, widgets. |
| [libraries/materials-design.md](libraries/materials-design.md) | Metals and minerals price database design: the full target model and roadmap. |
| [reviews/](reviews/) | Review and validation records: [equities design](reviews/equities-design-review.md), [equities implementation](reviews/equities-implementation-review.md), [materials](reviews/materials-review.md), [widget data through the database](reviews/widget-database-review.md). |

Related elsewhere: where the database files live and how to back them up ([OPERATIONS.md](../OPERATIONS.md#what-is-stored-where)); decisions in [`docs/adr/`](../adr/), which stays the one numbered decision log:

| Decision | Topic |
| --- | --- |
| [ADR-0004](../adr/0004-d1-write-model-and-free-tier-limits.md) | D1 write model under Workers Free limits |
| [ADR-0008](../adr/0008-switchable-persistence.md) | Switchable persistence behind two seams |
| [ADR-0010](../adr/0010-data-volume-budget.md) | Data-volume budget |
| [ADR-0041](../adr/0041-equities-library-and-naming.md) | Equities library and naming |
| [ADR-0042](../adr/0042-material-database-widget-series.md) | Imported material series in market widgets |
| [ADR-0043](../adr/0043-widget-data-through-database.md) | Widget data is read back from the database |
| [ADR-0044](../adr/0044-indicator-charts-and-incremental-history.md) | Incremental market-history refresh |
| [ADR-0045](../adr/0045-canonical-schema-and-sql-conventions.md) | Canonical schema file and SQL conventions |
| [ADR-0046](../adr/0046-table-definition-documents.md) | Database documentation in `docs/database/`, one checked document per table |

## Tables

Grouped as in `db/schema.sql`. Conventions shared by every table (`owner_id`, column suffixes, foreign keys, unnamed constraints, write fencing) are in [conventions §4](conventions.md#4-naming), so the documents don't repeat them.

- **New table:** copy [`table-template.md`](table-template.md) to `tables/<table>.md`, fill it in from the schema and the code, and add it to the list below in the same commit as the migration ([conventions §10](conventions.md#10-table-definition-documents)).
- **Check:** `packages/adapters/test/sqlite/tableDocs.test.ts` (in `bun run test`) compares every document with the schema — columns, keys, constraints, indexes, foreign keys and triggers — and checks that this index links every table.

<!-- table-index:start -->

### 1. Sources and articles

| Table | Purpose |
|---|---|
| [`news_sources`](tables/news_sources.md) | One row per news feed the owner subscribes to; the runner fetches every non-paused source on a news-ingest or research claim. |
| [`articles`](tables/articles.md) | One row per news article retrieved from a subscribed source, deduplicated by URL and by content fingerprint (FR-003). |

### 2. Conversations (workspaces)

| Table | Purpose |
|---|---|
| [`workspaces`](tables/workspaces.md) | One row per conversation (workspace): its title and its current canvas state. |
| [`workspace_commands`](tables/workspace_commands.md) | One row per UI command applied to a conversation's canvas: the command history that makes command submission idempotent and feeds the canvas event poll. |
| [`chat_messages`](tables/chat_messages.md) | One row per chat message of a conversation: the owner's questions and the assistant's answers, in sequence. |
| [`workspace_runs`](tables/workspace_runs.md) | Links a conversation to each run (or import) that stored research records for it; drives export and deletion. |

### 3. Research jobs

| Table | Purpose |
|---|---|
| [`research_jobs`](tables/research_jobs.md) | One row per job (run) the local runner executes: research questions, notebook-assist turns, news ingest, market, earnings, calendar and stock-directory refreshes. |
| [`job_transitions`](tables/job_transitions.md) | Append-only audit trail of job state transitions: one row per state change of a `research_jobs` row, with who made it and why. |
| [`job_events`](tables/job_events.md) | One row per progress entry a runner reported for a job lease (state changes, notes, tool calls), shown as the run's progress log. |

### 4. Research results

| Table | Purpose |
|---|---|
| [`evidence`](tables/evidence.md) | One row per source document a research run collected and cites: URL, title, publisher, dates, excerpt and content checksum. |
| [`claims`](tables/claims.md) | One row per claim a research run published: a statement with its type, verification status, evidence links and issues. |
| [`claim_evidence`](tables/claim_evidence.md) | One row per evidence link of a claim (claim → evidence edge), kept relational so "which claims rest on this evidence" needs no JSON scan. |
| [`research_records`](tables/research_records.md) | Immutable typed research records a run published: demand scenarios, securities, supplier links, financial and position observations, investor filings and pricing-power assessments. |
| [`datasets`](tables/datasets.md) | One row per tabular dataset a research run published (titled columns and up to 300 rows of sourced cells), shown by canvas components. |

### 5. Notebooks

| Table | Purpose |
|---|---|
| [`workspace_notebooks`](tables/workspace_notebooks.md) | One row holds the current notebook (widget list) of one conversation (ADR-0020). |
| [`workspace_notebook_revisions`](tables/workspace_notebook_revisions.md) | One row keeps one earlier version of a conversation's notebook body, so undo can restore it. |
| [`notebook_turns`](tables/notebook_turns.md) | One row records one notebook-assistant turn (one `notebook-assist` run) for the chat card. |

### 6. Home and market data

| Table | Purpose |
|---|---|
| [`home_dashboards`](tables/home_dashboards.md) | One row holds the owner's Home page arrangement: its widgets and their content (FR-017). |
| [`market_series`](tables/market_series.md) | One row holds the metadata and refresh state of one FRED or Twelve Data market series that Home, a notebook or a watchlist list tracks. |
| [`market_observations`](tables/market_observations.md) | One row holds one dated value of one market series, as Home and notebook widgets chart and show it. |

### 7. Watchlist and calendar

| Table | Purpose |
|---|---|
| [`watchlist_stocks`](tables/watchlist_stocks.md) | One row holds one US or Japanese stock on the owner's watchlist, with its earnings-refresh state (FR-018). |
| [`earnings_events`](tables/earnings_events.md) | One row holds one scheduled earnings announcement (one fiscal period) of one watchlist stock (FR-018, ADR-0016). |
| [`calendar_feeds`](tables/calendar_feeds.md) | One row holds the SHA-256 of the owner's earnings-calendar subscription token, so a calendar app can fetch the `.ics` feed without a session (FR-018, ADR-0016). |
| [`google_calendar_links`](tables/google_calendar_links.md) | One row holds the owner's Google Calendar sync state: connection status, the dedicated calendar's id, and the last sync and failure (FR-019, ADR-0018). |
| [`watchlist_lists`](tables/watchlist_lists.md) | One row holds one titled list of watchlist stocks, which a Watchlist prices widget can show (ADR-0040). |
| [`watchlist_list_stocks`](tables/watchlist_list_stocks.md) | One row records that one watchlist stock is a member of one watchlist list (ADR-0040). |

### 8. Scheduled tasks

| Table | Purpose |
|---|---|
| [`scheduled_tasks`](tables/scheduled_tasks.md) | One row per scheduled task: a research question that runs on a schedule in its own conversation (ADR-0033). |

### 9. Stock directory

| Table | Purpose |
|---|---|
| [`stock_directory`](tables/stock_directory.md) | One row per exchange-listed US or Japanese stock, a local copy of the SEC and JPX lists that the Watchlist's add-a-stock search reads (ADR-0034). |
| [`stock_directory_meta`](tables/stock_directory_meta.md) | One row per owner and market describing the stored stock directory list: row count, source date, download time and the fold version of its search keys (ADR-0034). |

### 10. Owner settings and runner

| Table | Purpose |
|---|---|
| [`owner_settings`](tables/owner_settings.md) | One row per owner holding the saved Settings → AI agent defaults for new questions. |
| [`runner_credentials`](tables/runner_credentials.md) | One row per runner bearer credential: expiring, renewable by the runner and revocable by the owner; only a SHA-256 of the token is stored (SEC-005). |
| [`runner_status`](tables/runner_status.md) | One row per owner holding what the runner last reported on a job claim: when it was seen, its version and its agent backends. |

### 11. Audit and rate limits

| Table | Purpose |
|---|---|
| [`rate_limits`](tables/rate_limits.md) | One row per owner, bucket and fixed time window, counting the requests admitted in that window. |
| [`audit_log`](tables/audit_log.md) | One append-only row per security-relevant action (who did what to which resource, and when), kept for an operator's forensic reads. |

### 12. Equities library

| Table | Purpose |
|---|---|
| [`equity_import`](tables/equity_import.md) | One committed owner import of a normalized equities JSON file: its idempotency key, content hash, commit order and original payload. |
| [`equity_record`](tables/equity_record.md) | One immutable equities catalog record (issuer, listing, filing, fact, price, ...): its type, the import that first stored it, and its validated JSON body. |
| [`equity_issuer`](tables/equity_issuer.md) | Projection of `issuer` records: one company (legal entity) with its names, for company search. |
| [`equity_data_source`](tables/equity_data_source.md) | Projection of `source` records: one data publisher (SEC, EDINET, TDnet, issuer IR, market data, ...) and the terms its data is used under. |
| [`equity_source_document`](tables/equity_source_document.md) | Projection of `document` records: one captured source document (a filing, release or data file) with its publication and retrieval times. |
| [`equity_issuer_identifier`](tables/equity_issuer_identifier.md) | Projection of `identifier` records: one official identifier (SEC CIK, EDINET code, LEI, Japanese corporate number) assigned to an issuer, with the document that states it. |
| [`equity_security`](tables/equity_security.md) | Projection of `security` records: one equity instrument (common, ordinary, ADR, preferred, REIT) issued by an issuer. |
| [`equity_listing`](tables/equity_listing.md) | Projection of `listing` records: one listing episode of a security on a venue under a symbol, with optional listing and delisting dates. |
| [`equity_filing`](tables/equity_filing.md) | Projection of `filing` records: one disclosure (statutory filing, earnings release, guidance) by an issuer, with when it became public and which filing it amends. |
| [`equity_statement`](tables/equity_statement.md) | Projection of `statement` records: one financial statement (income, balance sheet, cash flow, equity, notes) in a filing, for one period. |
| [`equity_metric_definition`](tables/equity_metric_definition.md) | Projection of `metric` records: one versioned metric definition (code, version, label, unit, definition text) that facts and guidance refer to. |
| [`equity_financial_fact`](tables/equity_financial_fact.md) | Projection of `fact` records: one reported financial value, or a stated reason it is unavailable, of one metric in one statement. |
| [`equity_price_bar`](tables/equity_price_bar.md) | Projection of `price` records: one daily OHLC bar of a listing from a source document, optionally correcting an earlier bar of the same day. |
| [`equity_corporate_action`](tables/equity_corporate_action.md) | Projection of `action` records: one corporate action (split, dividend, spinoff, merger, ...) of a security, effective on a date. |
| [`equity_fx_observation`](tables/equity_fx_observation.md) | Projection of `fx` records: one exchange-rate observation (base and quote currency, exact rate) from a source document. |
| [`equity_guidance_observation`](tables/equity_guidance_observation.md) | Projection of `guidance` records: one management forecast, revision or withdrawal for an issuer's metric over a target period. |

### 13. Materials (metals)

| Table | Purpose |
|---|---|
| [`metal_series`](tables/metal_series.md) | One row per owner-imported physical-material price series version (`materials:<ID>`): an immutable source snapshot with its provenance, charted by the shared market widgets (ADR-0042). |
| [`metal_observation`](tables/metal_observation.md) | One row per assessment date of an imported material series: the exact price as decimal text and the source's own update instant. |

### 14. Reference data

| Table | Purpose |
|---|---|
| [`earnings_sources`](tables/earnings_sources.md) | One row per market naming the source of its earnings dates (publisher and link), shown as attribution by the Watchlist, earnings widgets and calendar exports. |

<!-- table-index:end -->

## Archived tables

Documents of dropped tables move to `docs/database/archive/` and are listed here with the migration that dropped them. None yet.

## Moved documents

Database documents used to sit directly in `docs/`. Older commits, migration headers (which are never edited) and review records still name the old paths:

| Old path | Now |
| --- | --- |
| `docs/DATABASE_CONVENTIONS.md` | [conventions.md](conventions.md) |
| `docs/NAMING_CONVENTIONS.md` | [naming.md](naming.md) (general SQL naming moved to [conventions §4](conventions.md#4-naming)) |
| `docs/EQUITIES_DATABASE.md` | [libraries/equities.md](libraries/equities.md) |
| `docs/EQUITIES_DATABASE_DESIGN.md` | [libraries/equities-design.md](libraries/equities-design.md) |
| `docs/METALS_DATABASE.md` | [libraries/materials.md](libraries/materials.md) |
| `docs/METALS_DATABASE_DESIGN.md` | [libraries/materials-design.md](libraries/materials-design.md) |
| `docs/EQUITIES_DATABASE_REVIEW.md` | [reviews/equities-design-review.md](reviews/equities-design-review.md) |
| `docs/EQUITIES_IMPLEMENTATION_REVIEW.md` | [reviews/equities-implementation-review.md](reviews/equities-implementation-review.md) |
| `docs/METALS_DATABASE_REVIEW.md` | [reviews/materials-review.md](reviews/materials-review.md) |
| `docs/WIDGET_DATABASE_REVIEW.md` | [reviews/widget-database-review.md](reviews/widget-database-review.md) |
| `docs/OPERATIONS.md` — "Migrations and rollback", "Switching the database", "Widget database readback (migration 0018)" | [operations.md](operations.md) |
| "Source record update timestamp" in both designs, "Source update timestamp" in the equities guide | [conventions §11](conventions.md#11-source-record-update-timestamp) |
