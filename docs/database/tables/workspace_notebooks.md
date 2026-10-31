# Table: workspace_notebooks

## Overview

| Property | Value |
|---|---|
| Table Name | `workspace_notebooks` |
| Purpose | One row holds the current notebook (widget list) of one conversation (ADR-0020). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 5. Notebooks |
| Created By | `infra/migrations/0009_notebooks.sql` |
| Primary Key | `owner_id`, `workspace_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createNotebookRepository`, `createChartEvidenceReferences`), `packages/adapters/src/sql/unitOfWork.ts` (`notebookStatements`, conversation delete) |
| Update Strategy | Compare-and-set on `version`; each write also inserts a revision in the same batch |
| Data Retention | Kept until the owner deletes the conversation |

The row is created by the first save of a conversation's notebook, either an owner `PUT` or a `notebook-assist` run's completion. A conversation without a row has an empty notebook at version 0. Every write raises `version` by one and stores the new body in `workspace_notebook_revisions` in the same batch, so undo can restore an earlier body. Other services scan every stored body for the market series, watchlist lists and chart evidence the notebooks name.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `workspace_id` | TEXT | No | - | The conversation (`workspaces.workspace_id`) this notebook belongs to. |
| `body_json` | TEXT | No | - | JSON of the notebook `{ widgets: [...] }`, validated by `notebookSchema` (`packages/contracts/src/notebook.ts`) on write and on read; at most 200 widgets. A body that no longer parses is reported as `STORED_NOTEBOOK_UNREADABLE`, never replaced. |
| `version` | INTEGER | No | - | Monotonic version, 1 on the first write and raised by 1 on every write; all writes are compare-and-set on it. The API reports 0 when no row exists. |
| `last_mutation_id` | TEXT | No | - | Random UUID of the write that produced this row version. The revision insert and prune statements of the same batch run only when it matches, so a write that lost the compare-and-set changes nothing. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last write. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `workspace_id` | - | One notebook per conversation; serves every read and the compare-and-set update. |

## Indexes

None. The primary key serves every read: `get` and the compare-and-set writes by `(owner_id, workspace_id)`, and the body scans (`listMarketSeriesIds`, `listWatchlistListIds`, `listChartEvidenceIds`) as an `owner_id` prefix range.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | One-to-one | Logical |

## Data Lifecycle

### Insert

`createNotebookRepository().put` with `expectedVersion` 0 (`PUT /workspaces/:id/notebook`) inserts the row at version 1 with `INSERT ... ON CONFLICT DO UPDATE ... WHERE version = 0`. A `notebook-assist` completion whose base version is 0 inserts it through `notebookStatements` in `commitCompletion`, guarded by `NOT EXISTS` and the job compare-and-set. Both batches also store revision 0 (the empty notebook) and revision 1.

### Update

`put` with `expectedVersion` > 0 (owner save, and `POST /workspaces/:id/notebook/undo`, which writes the restored body as a new version) runs `UPDATE ... WHERE version = ?` and sets `body_json`, `version = version + 1`, `last_mutation_id` and `updated_at`. A `notebook-assist` completion does the same inside its guarded completion batch. When no row matched, the caller gets a version conflict and nothing else in the batch is written.

### Delete

Only when the conversation is deleted: `createResearchUnitOfWork().deleteWorkspace` deletes the row in the same batch as the conversation's revisions, turns, messages, jobs and the `workspaces` row.

### Synchronization

Not applicable: the owner and the notebook assistant write the table; it follows no external source.

### Retention

One row per conversation, kept as long as the conversation exists. Size is bounded by `notebookSchema` (200 widgets; under 1 MB per body, [database operations](../operations.md#0009--notebooks)).

## Notes

- No foreign key: the conversation delete removes the notebook set-based in application code, like every other conversation table.
- Notebooks are not part of workspace export/import yet (ADR-0020).
- The body scans read every notebook body of the owner with `json_each`; bodies that are not valid JSON are skipped through `json_valid`.
