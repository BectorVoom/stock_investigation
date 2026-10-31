# Table: audit_log

## Overview

| Property | Value |
|---|---|
| Table Name | `audit_log` |
| Purpose | One append-only row per security-relevant action (who did what to which resource, and when), kept for an operator's forensic reads. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 11. Audit and rate limits |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `audit_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createAuditLog`), `packages/adapters/src/sql/materials.ts`, `packages/adapters/src/sql/equities.ts` |
| Update Strategy | Insert-only |
| Data Retention | Kept indefinitely; never pruned by the application |

Application services call `AuditLog.record` for owner, scheduler and runner actions, for example `run.create`, `scheduled_task.fire`, `runner-credential.issue`, `settings.agent.update` and `notebook.assist.turn`. The materials and equities imports insert their audit row inside the import batch with `INSERT … SELECT`, so it commits or rolls back with the import. The application never reads the table; an operator reads it directly, newest first by `audit_id`.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `audit_id` | INTEGER | No | - | Rowid alias; `AUTOINCREMENT` keeps ids increasing and never reused, so id order is write order. |
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `actor` | TEXT | No | - | Who acted: `owner`, `scheduler` (scheduled-task firing), `runner:<credential_id>`, or the owner's id for materials and equities imports. |
| `action` | TEXT | No | - | Dotted action name, e.g. `run.create`, `scheduled_task.skip`, `runner-credential.revoke`, `materials.import`, `equities.import`. |
| `resource` | TEXT | No | - | Id of the affected resource (run id, task id, credential id, import id), or a fixed name such as `materials`. |
| `detail` | TEXT | No | - | Redacted detail: ids and codes only, never secrets, model names or licensed text (SEC-010); may be `''`. |
| `at` | TEXT | No | - | ISO-8601 UTC time of the action. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `audit_id` | `AUTOINCREMENT` | Identifies one entry; ids increase monotonically and are never reused, even after a delete. |

## Indexes

None. The application only inserts; an operator's forensic read walks `audit_id` (the rowid) backwards. Migration 0020 dropped `audit_log_by_owner` because no query used it and every index entry is a billed row write on D1.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`createAuditLog().record` inserts one row per call from the application services in `packages/application/src` (research runs, runner jobs, scheduled tasks, runner credentials, agent settings, workspaces, notebook, Home, refresh scope, watchlist, stock directory, sources and Google Calendar). `materials.import` and `equities.import` are inserted inside their import batches: the materials row under the same guard as the data rows (so an identical replay, which inserts no data, still adds an audit row), the equities row selected from the committed `equity_import` row.

### Update

Never: rows are immutable; no code path updates them.

### Delete

Never: the application has no delete path.

### Synchronization

Not applicable: internal record with no external source.

### Retention

Kept indefinitely. Nothing bounds the table's size; it grows by one row per audited action.

## Notes

- `resource` refers to rows of different tables depending on `action`, so no relationship is declared.
- Callers must redact `detail` before calling `record` (`AuditEntry` contract); the table does not enforce it.
