# ADR-0046: Database documentation in docs/database, one checked document per table

Status: accepted, 2026-10-31.

## Context

The owner asked (2026-10-31) for standard database table documentation: one definition document per table under `docs/`, created or updated whenever a table changes, with columns, constraints, indexes, relationships and data lifecycle, an index of all tables, a common template, rules in the development guidelines, and lightweight validation. The same day they asked to consolidate all database documentation, then scattered over ten files directly in `docs/` and three sections of `OPERATIONS.md`, under `docs/database/`, removing redundancy without losing information.

Before this change the 53 tables of `db/schema.sql` were described only by SQL comments, by feature documents that cover some tables (then `docs/EQUITIES_DATABASE*.md` and `docs/METALS_DATABASE*.md`) and by ADRs. The conventions, naming rules, migration notes and review records each lived in their own top-level file, and two designs carried the same timestamp specification word for word. Nothing said what most columns mean, which code writes a table, or how long its rows live, and nothing could notice when a description went stale.

## Decision

1. **`docs/database/` holds all database documentation.** `README.md` is the entry point and table index; `conventions.md` the rules (including the column-suffix vocabulary formerly in the naming guide and the one source-timestamp specification); `operations.md` migrations, rollback and engine switching (moved from `OPERATIONS.md`); `naming.md` the equities/materials vocabulary; `table-template.md` and `tables/<table>.md` the table documents; `libraries/` the equities and materials guides and designs; `reviews/` their review records. Documents of dropped tables move to `archive/`. The README's "Moved documents" table maps every old path, because migration headers are never edited and still name them. Non-database documents stay flat in `docs/`; ADRs stay in `docs/adr/`, the one numbered decision log, and the README lists the database ones.
2. **`db/schema.sql` stays the source of truth.** The documents explain the schema; they don't define it. The rules, and what each schema change must update, are in [conventions §10](../database/conventions.md#10-table-definition-documents). `AGENTS.md` links to them.
3. **The schema-derived parts are checked, not trusted.** `packages/adapters/test/sqlite/tableDocs.test.ts` builds a database from `db/schema.sql`, reads every table's structure from SQLite (`pragma_table_xinfo`, `pragma_index_list`/`_xinfo`, `pragma_foreign_key_list`, the CHECK expressions of the `CREATE TABLE` text, triggers) and compares it with the Markdown tables. It runs in `bun run test`, next to `canonicalSchema.test.ts`, which already proves that the migrations produce the same schema.
4. **Fixed cell formats** make the comparison exact without a parser dependency. Constraints in this schema are unnamed, so the Name column says `(unnamed)`. CHECK definitions are compared with whitespace removed. Unenforced references are listed as `Logical` relationships, and the checker verifies only that the referenced table exists.

## Consequences

- A schema change that forgets its document fails `bun run test` with the expected row printed, the same way a forgotten `TABLE_COLUMNS` entry already does.
- Prose (descriptions, lifecycle) can still go stale without a test failure. The rules require reviewing it together with the SQL change.
- Feature documents keep their design narrative. Tables' column-level detail is linked rather than repeated there, and shared rules (suffixes, keys, the source timestamp) live once in `conventions.md`.
- Code comments and documents link to the new paths; a test checks that relative links in the documentation resolve.

## Alternatives considered

- **Generate the documents from the schema on every change.** This keeps the structure current, but generated files invite editing the generated parts, and the descriptions, the actual value of the documents, would still be hand-written. A hand-written document plus a check gives the same guarantee for structure.
- **Keep the database documents flat in `docs/` with a prefix.** Ten-plus `DATABASE_*`/`EQUITIES_*` files beside unrelated documents had no entry point and already duplicated each other.
- **A documentation framework (SchemaSpy, tbls, dbdocs).** It adds a dependency and a second rendering of the schema, and none of these tools reads the lifecycle and ownership rules this repository needs. Rejected under "avoid unnecessary dependencies".
- **Put the definitions in the conventions document.** One 53-table file would be hard to review in a pull request and would mix rules with reference material.
