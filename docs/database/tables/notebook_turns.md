# Table: notebook_turns

## Overview

| Property | Value |
|---|---|
| Table Name | `notebook_turns` |
| Purpose | One row records one notebook-assistant turn (one `notebook-assist` run) for the chat card. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 5. Notebooks |
| Created By | `infra/migrations/0009_notebooks.sql` |
| Primary Key | `owner_id`, `run_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createNotebookRepository().listTurns`), `packages/adapters/src/sql/unitOfWork.ts` (`notebookTurnStatement`, conversation delete) |
| Update Strategy | Insert-only (`INSERT OR IGNORE` on the run) |
| Data Retention | Kept until the owner deletes the conversation |

A `notebook-assist` completion writes one row in its guarded completion batch, whether the turn changed the notebook, changed nothing, or failed (for example `NOTEBOOK_CHANGED`). The notebook response returns the 30 newest turns of the conversation, oldest first.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `run_id` | TEXT | No | - | The `notebook-assist` run (`research_jobs.run_id`) that produced the turn. |
| `workspace_id` | TEXT | No | - | The conversation whose notebook the turn targeted. |
| `base_version` | INTEGER | No | - | Notebook version the turn was computed against; copy of `baseVersion` in `body_json`. |
| `applied_version` | INTEGER | Yes | - | Notebook version the turn wrote; NULL when nothing was applied (no change or a failure). Copy of `appliedVersion` in `body_json`. |
| `body_json` | TEXT | No | - | JSON of the turn (changes, proposed removals, failure), validated by `notebookTurnSchema` (`packages/contracts/src/notebook.ts`); the source of truth for reads. |
| `created_at` | TEXT | No | - | ISO-8601 UTC completion time of the turn (`createdAt` in `body_json`). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `run_id` | - | One turn per run; makes a replayed completion a no-op through `INSERT OR IGNORE`. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_notebook_turns__owner_id_workspace_id_created_at_run_id` | `owner_id`, `workspace_id`, `created_at`, `run_id` | No | `listTurns`: a conversation's newest turns, `ORDER BY created_at DESC, run_id DESC LIMIT 30`, read backwards without a sort. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | One-to-one | Logical |
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`notebookTurnStatement` inserts the row with `INSERT OR IGNORE ... SELECT ... WHERE` the job compare-and-set guard, inside `commitCompletion` for a `notebook-assisted` completion (`notebookAssistedEffects` builds the turn).

### Update

Never: rows are immutable once inserted.

### Delete

Only when the conversation is deleted: `deleteWorkspace` deletes the conversation's turns in the same batch as its notebook and the `workspaces` row.

### Synchronization

Not applicable: rows record the application's own runs.

### Retention

Kept for the life of the conversation; nothing prunes old turns. Reads return only the 30 newest (`NOTEBOOK_LIMITS.maxTurnsReturned`).

## Notes

- `base_version` and `applied_version` are written but no query reads them; reads decode only `body_json`.
- The table grows by one row per assistant turn without a bound; the index keeps the read at 30 rows regardless.
