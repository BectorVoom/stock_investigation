# ADR-0045: One canonical schema file and enforced SQL conventions

Status: accepted, 2026-10-31.

## Context

The owner asked (2026-10-31) to standardize the database layer: one canonical initialization file `db/schema.sql`, consistent table and column aliases, and index names of the form `idx_<table>__<columns>` / `uq_<table>__<columns>`, chosen from the real query patterns, with redundant indexes removed — while preserving every row and every API contract.

Before this change the schema existed only as the sum of 19 migrations (`infra/migrations/0001`–`0019`); indexes were named `<table>_by_<path>`; queries used `SELECT *`, aliases without `AS` (`FROM equity_record r`), different aliases for the same table (`l`, `m`, `s`, `n`), camelCase output names in one query, and mixed `COUNT(`/`count(` case.

## Decision

1. **`db/schema.sql` is the complete current schema** (tables, constraints, indexes, triggers, reference rows), for fresh databases only. `initializeSqlSchema` (node:sqlite) runs it in one transaction on an empty database, refuses any database that already has schema objects, and records the migrations as applied. D1 databases are still initialized by Wrangler applying the migrations, because Wrangler tracks applied migrations in its own table.
2. **Migrations stay the upgrade path**, unchanged and append-only. Every schema change adds a migration and edits `db/schema.sql`; `canonicalSchema.test.ts` compares both paths object by object. The `api-sqlite` test project now builds its database from `db/schema.sql` while the workerd project keeps building it from the migrations, so the whole API suite runs on both paths.
3. **Migration 0020 renames and reviews the indexes** (indexes only — no table, column or row changes): four dropped (unused or duplicate), three extended with their `ORDER BY` tie-breaker, the article index reordered to index order, one added for "latest job of a kind" (measured 9.6 ms → 1.0 ms at 20,000 jobs). Details in [DATABASE_CONVENTIONS.md](../DATABASE_CONVENTIONS.md#index-review-of-2026-10-31-migration-0020).
4. **SQL conventions are written down and tested**: canonical table aliases with `AS` (`TABLE_ALIASES`), qualified columns in multi-table statements, no `SELECT *` (`columnList` over `TABLE_COLUMNS`), snake_case output names, uppercase keywords and lowercase functions. `tests/architecture/sqlConventions.test.ts` scans every SQL string in the adapters and scripts.

## Consequences

- Index names are not read by any code, so the version-19 release runs against a version-20 database; rollback needs no data restore.
- A query that reads a whole row now names its columns through `columnList`; adding a column changes those queries' results in the same, deliberate way as before (the list follows the schema), while explicit column lists elsewhere no longer change silently.
- Table names were not changed (plural research tables, singular `equity_*`/`metal_*`): renaming tables would rewrite stored data paths for no behavior gain.
- `equity_record`'s redundant `UNIQUE (owner_id, record_type, record_id)` is kept until a migration rebuilds that table for another reason (every equity projection references it by foreign key).

## Alternatives considered

- **Generate `db/schema.sql` by dumping a migrated database.** SQLite stores `ALTER TABLE ADD COLUMN` by splicing text into the original `CREATE TABLE`, and drops comments; the dump would be unreadable. A hand-maintained file plus an equivalence test keeps it readable and still exact.
- **Initialize D1 from `db/schema.sql` and insert rows into `d1_migrations` by hand.** Couples the launcher to Wrangler's internal bookkeeping table; rejected.
- **A SQL formatter/linter dependency.** The SQL lives in TypeScript template literals, which off-the-shelf SQL formatters do not read; a focused test covers the rules that matter.
