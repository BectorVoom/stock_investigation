# Table: {{table_name}}

<!--
Template for one table definition document (conventions.md, section 10).
Copy to docs/database/tables/<table_name>.md, replace every {{placeholder}}, and delete
these comments. `db/schema.sql` is the source of truth: copy names, types, constraint
definitions and index columns from it exactly. `packages/adapters/test/sqlite/tableDocs.test.ts`
compares the schema-derived parts with the database and prints the expected row when one differs.

Conventions used by the checker:
- Code spans (`name`) around identifiers; lists are comma-separated in key order.
- Nullable is "No" for NOT NULL columns and for primary-key columns SQLite enforces as not null
  (every column of a WITHOUT ROWID key, an INTEGER PRIMARY KEY); otherwise "Yes".
- Default is the declared DEFAULT expression, or "-". A generated column's Default is
  `GENERATED (<expression>) VIRTUAL` or `... STORED`.
- Constraints in this schema are unnamed; write "(unnamed)". Definition is "-" for PRIMARY KEY
  and UNIQUE (or `AUTOINCREMENT` for an AUTOINCREMENT key), `<table> (<columns>) ON DELETE <action>`
  for FOREIGN KEY, and the expression inside CHECK (...) on one line for CHECK. A CHECK's Columns
  are the table's columns the expression names.
- Indexes lists only CREATE INDEX indexes; PRIMARY KEY and UNIQUE create their own automatic
  indexes, listed under Constraints. Columns are the index keys as written in the schema
  (" DESC", COLLATE and expressions included); a partial index appends " WHERE <predicate>".
  With no secondary index, write "None." and say which key serves the reads.
- Relationships: Enforcement is "Foreign key, ON DELETE <action>" for an enforced foreign key and
  "Logical" for a reference the schema does not enforce. Every Referenced Table must exist.
- Triggers: keep the section only when the table has triggers. Event is the timing and event
  (plus "OF <columns>" and "WHEN <condition>" when present); Body is the statements between
  BEGIN and END on one line.
- Definition cells compare ignoring case and the spacing around punctuation outside quoted
  text (spacing between two words still separates them); quoted literals must match exactly.
  A definition that contains a backtick goes in a double-backtick code span: ``x <> 'a`b'``.
- Every unescaped `|` ends a table cell, even inside a code span: write a literal pipe as `\|`
  (`a \|\| b`). The checker fails a row whose cell count differs from its header.
-->

## Overview

| Property | Value |
|---|---|
| Table Name | `{{table_name}}` |
| Purpose | {{one sentence: what one row is and why the table exists}} |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | {{section number and title in db/schema.sql}} |
| Created By | `infra/migrations/{{NNNN_name}}.sql` |
| Primary Key | `{{owner_id}}`, `{{key_column}}` |
| Storage | {{Rowid table / `WITHOUT ROWID`}} |
| Code | {{repository or adapter file(s) that read and write the table}} |
| Update Strategy | {{e.g. insert-only; compare-and-set on version; upsert on refresh}} |
| Data Retention | {{e.g. kept until the owner deletes the conversation; pruned to N rows}} |

{{One paragraph: the table's responsibilities, who writes it, who reads it, and its lifecycle in brief.}}

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `{{column_name}}` | {{TEXT / INTEGER / REAL}} | {{No / Yes}} | {{- / default}} | {{meaning, format (ISO-8601 UTC for `_at`, YYYY-MM-DD for `_on`), allowed values, migration that added it}} |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `{{owner_id}}`, `{{key_column}}` | - | {{what the key identifies}} |
| (unnamed) | UNIQUE | `{{columns}}` | - | {{what duplicate it prevents}} |
| (unnamed) | FOREIGN KEY | `{{columns}}` | `{{parent_table}} ({{columns}}) ON DELETE RESTRICT` | {{what must exist first}} |
| (unnamed) | CHECK | `{{column}}` | `{{expression}}` | {{rule it enforces}} |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_{{table_name}}__{{column1}}_{{column2}}` | `{{column1}}`, `{{column2}}` | No | {{the query it serves and its access pattern}} |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `{{owner_id}}`, `{{parent_id}}` | `{{parent_table}}` | `{{owner_id}}`, `{{parent_id}}` | Many-to-one | Foreign key, ON DELETE RESTRICT |
| `{{owner_id}}`, `{{other_id}}` | `{{other_table}}` | `{{owner_id}}`, `{{other_id}}` | Many-to-one | Logical |

## Triggers

| Trigger | Event | Body | Description |
|---|---|---|---|
| `{{table_name}}_{{invariant}}_{{event}}` | {{BEFORE UPDATE}} | `{{SELECT RAISE(ABORT, '...');}}` | {{the invariant it protects}} |

## Data Lifecycle

### Insert

{{when, by which code path, and in which transaction rows are inserted}}

### Update

{{which columns change, how (compare-and-set, upsert), or "Never: rows are immutable"}}

### Delete

{{which operation deletes rows (and cascades), or "Never"}}

### Synchronization

{{how the table follows an external source incrementally, or "Not applicable" and why}}

### Retention

{{how long rows are kept and what bounds the table's size}}

## Notes

{{optional: business rules, known limitations, external API dependencies, performance
considerations; delete the section when there is nothing to add}}
