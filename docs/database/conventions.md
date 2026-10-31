# Database conventions

How this repository defines, initializes, upgrades and queries its database. Applies to every table and every SQL statement in the codebase. Vocabulary specific to the equities and materials libraries (entity prefixes, financial terms, contract and route names) is in [naming conventions](naming.md); operating procedures (applying migrations, rollback, switching engines) in [database operations](operations.md); persistence architecture in [ADR-0004](../adr/0004-d1-write-model-and-free-tier-limits.md) and [ADR-0008](../adr/0008-switchable-persistence.md).

**Engine and dialect.** Cloudflare D1 (SQLite) in production, local and deployed; `node:sqlite` as the second engine that proves portability (ADR-0008). All SQL is the SQLite dialect: `json_each`, `json_extract`, `ON CONFLICT`, `INSERT OR IGNORE`, `RETURNING`, `WITHOUT ROWID`, row values. Foreign keys are enforced on every connection.

## 1. Files

| Path | What it is | Runs when |
| --- | --- | --- |
| `db/schema.sql` | **The canonical schema**: the complete current schema — tables, keys, constraints, indexes, triggers and the reference rows the app needs — in one file. | Once, against an empty database (fresh initialization). |
| `infra/migrations/NNNN_name.sql` | The upgrade history. Each file moves an existing database one version forward. | By Wrangler (`bun run dev`, `bun run prod`, `bun run db:migrate:*`) and by `applySqlMigrations` on `node:sqlite`. |
| `packages/adapters/src/sql/columns.ts` | `TABLE_COLUMNS` (every table's columns in schema order) and `TABLE_ALIASES` (canonical aliases). | Imported by the repositories. |
| `docs/database/tables/<table>.md` | One table definition document per table: columns, constraints, indexes, relationships, data lifecycle (section 10). Index: `docs/database/README.md`. | Read by people and agents; checked by `tableDocs.test.ts`. |

No application code creates or alters schema objects. The only `CREATE TABLE` outside these files is the `node:sqlite` runner's own `schema_migrations` bookkeeping table.

## 2. Initialization

- **Fresh database, `node:sqlite`:** `initializeSqlSchema(db, readSqlSchema("db/schema.sql"), readSqlMigrations("infra/migrations"))` runs the schema in one transaction and records every existing migration as applied, so later migrations upgrade the database like any other. It refuses a database that already has any table, index, view or trigger, and changes nothing in that case. The `api-sqlite` test project initializes its database this way.
- **Fresh database, D1 (Wrangler):** Wrangler tracks applied migrations in its own `d1_migrations` table, so the launcher initializes a new D1 database by applying the migrations. This yields the same schema as `db/schema.sql` (proven below). Do not `wrangler d1 execute --file db/schema.sql` against a database that Wrangler will later migrate: the migrations would not be marked applied.
- **Never** run `db/schema.sql` against an existing database. Every statement is a plain `CREATE` (no `IF NOT EXISTS`, no `DROP`), so a mistaken run fails on the first statement instead of touching data.
- Order inside `db/schema.sql`: tables before the indexes and triggers that depend on them, parents before children for foreign keys, grouped in numbered feature sections.

## 3. Migrations

- `db/schema.sql` is the current state; `infra/migrations/` is the history. Applied migrations are never edited, renamed or deleted: deployed databases recorded them by name.
- **Every schema change lands in both places in the same commit:** a new migration `NNNN_descriptive_name.sql` (next zero-padded number) and the matching edit to `db/schema.sql` — together with the table's definition document (section 10). A column added by `ALTER TABLE ... ADD COLUMN` goes at the **end** of its table in `db/schema.sql`, after the columns added by earlier migrations, because that is where SQLite puts it.
- `packages/adapters/test/sqlite/canonicalSchema.test.ts` fails when the two paths differ: it compares, object by object, every table's normalized definition (columns, CHECK expressions), columns, foreign keys, `WITHOUT ROWID`, indexes (with column order and direction) and triggers, plus the reference rows.
- A migration's header states what changes, why, which rows it touches and how to roll back (see `0020_index_conventions.sql`). Destructive statements (`DROP TABLE`, a table rebuild) need an explicit data-preserving strategy in the same migration and a test that seeds rows before it and checks them after it.
- Migrations are applied by the launcher after a backup ([database operations](operations.md#migrations-and-rollback)).

## 4. Naming

| Object | Rule | Example |
| --- | --- | --- |
| Table | `snake_case`. Existing names are kept (plural for the research workspace, singular `equity_*` / `metal_*` for the libraries); new feature tables follow their feature's existing form. | `research_jobs`, `equity_filing` |
| Column | `snake_case`, with the suffixes below. Primary keys name the entity. Every key starts with `owner_id`. | `owner_id`, `issuer_id`, `retrieved_at` |
| Index | `idx_<table>__<column1>_<column2>...` — every key column, in index order, double underscore after the table. | `idx_research_jobs__owner_id_kind_created_at_run_id` |
| Unique index | `uq_<table>__<columns>`. A uniqueness rule that is part of the table's definition (and every composite foreign-key target) stays an inline `UNIQUE (...)` constraint. | `uq_companies__ticker_exchange` |
| Trigger | `<table>_<invariant>_<event>` | `metal_series_immutable_update` |
| Migration | `NNNN_descriptive_name.sql` | `0020_index_conventions.sql` |

SQLite has no practical identifier length limit, so index names are never abbreviated. The index name rule is checked by `canonicalSchema.test.ts`.

**Column suffixes and types.** Columns use the SQLite storage classes `TEXT`, `INTEGER` and `REAL`.

| Suffix | Meaning |
| --- | --- |
| `_id` | An entity id or a reference to one. Ids are opaque strings; never use ticker symbols, names or array positions as durable identity. |
| `_at` | A UTC instant, ISO-8601 text. `published_at`, `retrieved_at` and `committed_at` mean different things and are never interchangeable. |
| `_on` | A calendar date, `YYYY-MM-DD`. |
| `_json` (also `body_json`) | JSON text, parsed with zod at the boundary on write and on read. |
| `_decimal` | Exact canonical decimal text (never a float). |
| `_code` | A controlled code from a closed list. |
| `_sha256` | Lowercase SHA-256 hex. |
| `_version` | An explicit contract or definition version (a compare-and-set counter is the bare column `version`). |
| `_count` | An integer count. |

**Keys, references and writes.**

- `owner_id` is the id of the single owner (ADR-0002); there is no owners table. Every primary key and every query starts with it (API-004). The only table without it is the reference table `earnings_sources`.
- Foreign keys are enforced on every connection (`PRAGMA foreign_keys = ON`). Only the equities and materials libraries declare them; elsewhere tables reference each other by id only, and the table documents list those references as *Logical* relationships.
- Constraints are unnamed (inline `PRIMARY KEY`, `UNIQUE`, `CHECK`); indexes are named as above.
- Writes go through the repositories in `packages/adapters/src/sql/` as D1 batches (ADR-0004). Concurrent writers are fenced with compare-and-set `version` columns, lease generations or idempotency keys; each table document says which.

## 5. Table aliases

Single-table statements need no alias. When a statement names a table more than once or joins tables, **every** table gets its canonical alias with an explicit `AS`, and **every** column is qualified with it.

- Aliases are lowercase, 1–4 letters, derived from the table name's words, and the same in every query (`TABLE_ALIASES` in `columns.ts` is the source of truth).
- The same table twice in one scope: suffix the canonical alias with the row's role — `erc_fact`, `erc_metric`, `eim_issuer`, `wls_guard`.
- Table-valued functions (`json_each`), derived tables and CTEs take a descriptive `snake_case` name with `AS`: `json_each(?3) AS incoming`, `(...) AS latest_message`. Never `t1`, `temp`, `data`, `x`.

| Table | Alias | Table | Alias |
| --- | --- | --- | --- |
| `articles` | `a` | `job_events` | `je` |
| `audit_log` | `al` | `job_transitions` | `jt` |
| `calendar_feeds` | `cf` | `market_observations` | `mo` |
| `chat_messages` | `cm` | `market_series` | `ms` |
| `claim_evidence` | `ce` | `metal_observation` | `mto` |
| `claims` | `cl` | `metal_series` | `mts` |
| `datasets` | `ds` | `news_sources` | `ns` |
| `earnings_events` | `ee` | `notebook_turns` | `nt` |
| `earnings_sources` | `es` | `owner_settings` | `os` |
| `equity_corporate_action` | `eca` | `rate_limits` | `rl` |
| `equity_data_source` | `eds` | `research_jobs` | `rj` |
| `equity_filing` | `ef` | `research_records` | `rr` |
| `equity_financial_fact` | `eff` | `runner_credentials` | `rc` |
| `equity_fx_observation` | `efx` | `runner_status` | `rs` |
| `equity_guidance_observation` | `ego` | `scheduled_tasks` | `st` |
| `equity_import` | `eim` | `stock_directory` | `sd` |
| `equity_issuer` | `eis` | `stock_directory_meta` | `sdm` |
| `equity_issuer_identifier` | `eii` | `watchlist_list_stocks` | `wls` |
| `equity_listing` | `el` | `watchlist_lists` | `wl` |
| `equity_metric_definition` | `emd` | `watchlist_stocks` | `ws` |
| `equity_price_bar` | `epb` | `workspace_commands` | `wc` |
| `equity_record` | `erc` | `workspace_notebook_revisions` | `wnr` |
| `equity_security` | `esc` | `workspace_notebooks` | `wn` |
| `equity_source_document` | `esd` | `workspace_runs` | `wr` |
| `equity_statement` | `est` | `workspaces` | `w` |
| `evidence` | `e` | | |

A new table adds its alias to `TABLE_ALIASES` and to this table.

## 6. Column references and output names

- No `SELECT *` or `RETURNING *` in application code: name the columns. To read a whole row, use `columnList("table")` (or `columnList("table", "alias")` in a join), which lists `TABLE_COLUMNS` in schema order.
- Calculated values always get an explicit `AS` with a descriptive `snake_case` name: `COUNT(*) AS active_count`, `max(cm.seq) AS max_seq`. Output names are `snake_case` even when the TypeScript property is camelCase; the adapter maps them (`series_id` → `seriesId`).
- No alias for a plain column read under its own name.

## 7. Formatting

- SQL keywords are UPPERCASE (`SELECT`, `LEFT JOIN`, `ON CONFLICT`, `IS NOT NULL`, `ASC`). Built-in function names are lowercase, as in the SQLite documentation (`count(*)`, `coalesce`, `json_extract`, `strftime`). Identifiers are `snake_case`.
- Major clauses start on their own line (`WITH`, `SELECT`, `FROM`, each `JOIN`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `ON CONFLICT`, `RETURNING`); a long select list or condition list puts one item per line, indented one level. A short single-table statement may stay on one line.
- `.sql` files indent with four spaces. SQL inside TypeScript template literals follows the file's tab indentation.
- Values are always bound (`?` or `?N` when one value is used several times). The only interpolated SQL text is fixed code: column lists from `columns.ts`, fixed column maps keyed by validated input, constant state lists, and shared guard fragments.

These rules — explicit `AS`, canonical aliases, no `SELECT *`, keyword and function case — are enforced by `tests/architecture/sqlConventions.test.ts`, which scans every SQL string in `packages/adapters/src/sql`, `packages/adapters/src/sqlite`, `scripts/bench.ts` and `scripts/profileRuns.ts`.

## 8. Index design

1. Index real query predicates, not columns. Each index's comment in `db/schema.sql` names the query it serves.
2. Composite order: equality columns first, then the range or `ORDER BY` columns, then the tie-breaker the `ORDER BY` uses (often the id). SQLite scans an index backwards for free, so `ORDER BY a DESC, b DESC` is served by `(a, b)`.
3. A key starts with `owner_id`, like every query.
4. An index whose columns are a prefix of another index, a `UNIQUE` constraint or the primary key is redundant — drop it (checked by `canonicalSchema.test.ts`). In a `WITHOUT ROWID` table every index already ends in the primary key.
5. Write cost counts. On D1 every index entry is a billed row write, and an index on a column that changes is rewritten on every change. Prefer indexes on columns that never change after insert. Do not index a foreign key no query joins or deletes through.
6. Uniqueness that the data requires is a constraint (`UNIQUE`/`PRIMARY KEY`), not an application check.
7. Before adding or changing an index: run `EXPLAIN QUERY PLAN` on the query with and without it, measure on realistic volume, and record the result in the migration header. Pin important plans in `canonicalSchema.test.ts` ("query plans of the indexed access paths").

### Index review of 2026-10-31 (migration 0020)

| Change | Index | Reason |
| --- | --- | --- |
| Dropped | `articles_by_source` | Never chosen by the planner: the only article query filters the source optionally. |
| Dropped | `audit_log_by_owner` | The application never reads `audit_log`. |
| Dropped | `equity_record_by_import` | Reverse foreign-key index with no reader; `equity_import` rows are never deleted or re-keyed. Saved one index write per imported record (up to 2,000 per import). |
| Dropped | `equity_guidance_observation_by_issuer` | Exact duplicate of `UNIQUE (owner_id, issuer_id, guidance_id)`. |
| Reordered | `idx_articles__owner_id_retrieved_at_article_id` | Was `(retrieved_at DESC, article_id)` against `ORDER BY retrieved_at DESC, article_id DESC`: a temporary sort. Now index order. |
| Extended | `idx_research_jobs__owner_id_workspace_id_created_at_run_id`, `idx_notebook_turns__owner_id_workspace_id_created_at_run_id`, `idx_scheduled_tasks__owner_id_next_run_at_task_id` | Added the `ORDER BY` tie-breaker; no temporary sort, same entry count. |
| Added | `idx_research_jobs__owner_id_kind_created_at_run_id` | Latest job of a kind (each Home and Watchlist read): 9.6 ms → 1.0 ms at 20,000 jobs, from a scan of all jobs plus a sort to an index range. Immutable columns: one write per job. |
| Renamed | all others | `idx_<table>__<columns>`. |

Known and kept: `equity_record`'s `UNIQUE (owner_id, record_type, record_id)` is implied by its primary key. Removing it needs a rebuild of the table every equity projection references by foreign key; deferred until a migration rebuilds `equity_record` for another reason.

Financial time-series paths and the index that serves each: an issuer's facts (`idx_equity_filing__owner_id_issuer_id_public_available_at_filing_id` → `idx_equity_statement__owner_id_filing_id_statement_id` → `idx_equity_financial_fact__owner_id_statement_id_fact_id`); a listing's prices by date (`idx_equity_price_bar__owner_id_listing_id_trading_on_price_bar_id`); a security's actions by date (`idx_equity_corporate_action__owner_id_security_id_effective_on_action_id`); a market series' history and newest observations (the `market_observations` primary key, a `WITHOUT ROWID` range); new imports and sync state (`idx_equity_import__owner_id_committed_at_import_id`, `market_series` primary key with `last_refreshed_at`/`history_checked_at`).

## 9. Adding a table or an index

1. Write migration `infra/migrations/NNNN_name.sql` with the header described in section 3.
2. Make the same change in `db/schema.sql`, in the right section, with a comment naming the query each index serves.
3. Add the table to `TABLE_COLUMNS` and `TABLE_ALIASES` (`packages/adapters/src/sql/columns.ts`) and to the alias table above.
4. Create or update the table's definition document and the index in `docs/database/` (section 10).
5. Write the queries following sections 5–7.
6. Run `bun run test` (schema equivalence, naming, redundancy, query plans, SQL conventions, table documents, and the API suite on both engines: workerd runs it on a migrated database, `api-sqlite` on one initialized from `db/schema.sql`) and `bun run bench` when the query is on a hot path.

## 10. Table definition documents

Every table in `db/schema.sql` has one definition document, `docs/database/tables/<table>.md`, written from [`docs/database/table-template.md`](table-template.md) and listed in the index [`docs/database/README.md`](README.md). `db/schema.sql` stays the source of truth for the structure; the document explains it: what a row is, what each column means, why each constraint and index exists, how the table relates to others, and how rows are inserted, updated, deleted, synchronized and retained ([ADR-0046](../adr/0046-table-definition-documents.md)).

**Mandatory with every schema change, in the same commit or pull request, reviewed together with the SQL:**

| Change | Documentation update |
| --- | --- |
| New table | New `docs/database/tables/<table>.md` from the template, and a row in the index. The table is not done without it. |
| New, changed or dropped column | The Columns section (and Overview, Data Lifecycle or Notes when the meaning or lifecycle changes). |
| New, changed or dropped index | The Indexes section, with the query the index serves. |
| Changed constraint or foreign key | The Constraints and Relationships sections. |
| New, changed or dropped trigger | The Triggers section, and Data Lifecycle when the trigger allows or forbids writes. |
| New or changed read/write path (no schema change) | The Data Lifecycle section when insert, update, delete, synchronization or retention behavior changes. |
| Renamed table | Rename the document, update its title, the index and every link to it (`rg "tables/<old>.md" docs`). |
| Dropped table | Move the document to `docs/database/archive/<table>.md` with a line naming the dropping migration, remove it from the active index, list it under "Archived tables", and update links. |

**Rules for the content.**

- Write from the schema and the code that reads and writes the table, never from assumptions. Copy names, types, constraint definitions and index column order from `db/schema.sql` exactly; conventions for each cell are at the top of the template.
- One document per table, named after the table. The full column, constraint and index tables of a table live only in its document; other documents (feature docs, ADRs) link to it instead of repeating them.
- Lifecycle text is specific to the table: name the operation, the route or job that triggers it, the batch it runs in and the bound on the table's size. Write "Never" or "Not applicable" with the reason when that is the truth.
- Logical relationships the schema does not enforce (most tables reference others by id only) are listed with Enforcement "Logical".

**Checked by `packages/adapters/test/sqlite/tableDocs.test.ts`** (part of `bun run test`): it builds a database from `db/schema.sql` and fails when a table has no document or a document has no table; when the index does not link every document exactly once; when a document lacks a mandatory section or still holds a `{{placeholder}}`; or when its columns (order, type, nullability, default), primary key, storage, constraints (primary key, unique, foreign key, CHECK expression), indexes (name, column order and direction, uniqueness), foreign-key relationships or triggers (timing, event, condition, body) differ from the schema. Definitions compare ignoring case and the spacing around punctuation, except inside quoted literals, which must match exactly; partial-index predicates, expression keys and generated-column expressions are compared too. Each failure prints the row the schema expects. Prose is not checked mechanically; it is reviewed with the change.

## 11. Source record update timestamp

`materials_source_updated_at` (`materialsSourceUpdatedAt` in contracts) is the instant at which the identified source last updated that specific record. It applies to source-backed data records (prices, facts, source documents), not to every internal catalog, join or operational table; mutable application state uses a separate `updated_at` where needed, which means something else.

- **Format:** nullable `TEXT`, exactly 24 ASCII characters of canonical UTC milliseconds, e.g. `2026-10-29T09:30:45.000Z`; whole seconds use `.000`. An explicit length/shape/calendar-round-trip CHECK enforces it (`TEXT(24)` alone imposes no length limit in SQLite; the long timestamp GLOB was removed because of SQLite/D1's short GLOB-pattern limit). The API validates the same format and a real calendar instant.
- **Source of the value:** only an explicit record-update timestamp from the source — never the runner's clock, retrieval time or database write time. When the source supplies only a date or omits its time zone, do not invent an instant: keep the original value and precision in provenance and leave the column NULL. Higher-resolution fractions and the original offset also belong in provenance. No current-time default and no fabricated migration backfill.
- **Pairing:** the timestamp belongs to the record's source identity (`source_id`, or the source of its source document). Several sources have separate records with separate timestamps; never overwrite one source's timestamp with another's or add a column per provider. Distinguish an original publisher from a distributor where applicable.
- **Independence:** publication time, retrieval time, assessment/reporting period and import commit sequence are kept separately. This column is not a price date, a refresh-attempt time, a revision id or an optimistic-lock token.
- **History:** records stay immutable. A source correction appends a revision with its own timestamp and provenance; an unchanged reread or idempotent replay does not alter stored timestamps. Revision ordering follows the explicit temporal-selection rules, not this column alone.
- **Indexes:** none is added without a query that needs it.

**Implemented** by migration `0015_materials_source_updated_at.sql` on [`equity_source_document`](tables/equity_source_document.md) and by `0016_material_series.sql` on [`metal_observation`](tables/metal_observation.md). Equities import documents accept optional nullable `materialsSourceUpdatedAt`; omitted legacy values project to SQL NULL without changing old JSON or idempotency hashes. Producers normalize the value to this format before import and keep any higher precision outside the database. Source-backed facts and prices reference their document, so records with different update timestamps need separate document snapshots. Materials observations carry the field per observation ([materials library guide](libraries/materials.md#bounds-and-storage)). The rule replaced the design's earlier blanket `updated_at TEXT NOT NULL` proposal (2026-10-29).
