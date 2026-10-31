# Table: workspace_notebook_revisions

## Overview

| Property | Value |
|---|---|
| Table Name | `workspace_notebook_revisions` |
| Purpose | One row keeps one earlier version of a conversation's notebook body, so undo can restore it. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 5. Notebooks |
| Created By | `infra/migrations/0009_notebooks.sql` |
| Primary Key | `owner_id`, `workspace_id`, `version` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createNotebookRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`notebookStatements`, conversation delete) |
| Update Strategy | Insert-only, in the same batch as the notebook write; pruned in that batch |
| Data Retention | The 20 newest versions per conversation (`NOTEBOOK_LIMITS.maxRevisions`) |

Every successful write of `workspace_notebooks` inserts the new body here under its new version and deletes all but the 20 newest rows of that conversation. The first write also stores the empty notebook as version 0, so undo at version 1 restores "no widgets yet". Undo at version N reads version N - 1 and writes it back as version N + 1.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `workspace_id` | TEXT | No | - | The conversation whose notebook this body belongs to. |
| `version` | INTEGER | No | - | The `workspace_notebooks.version` this body had; 0 is the empty notebook stored by the first write. |
| `body_json` | TEXT | No | - | JSON of the notebook body at that version, validated by `notebookSchema` (`packages/contracts/src/notebook.ts`). An unreadable body is treated as not kept. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `workspace_id`, `version` | - | One body per conversation and version; serves `getRevision` and the prune's newest-first scan. |

## Indexes

None. The primary key serves every read: `getRevision` by full key, and the prune's `ORDER BY version DESC LIMIT 20` over the `(owner_id, workspace_id)` prefix.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `workspace_id` | `workspace_notebooks` | `owner_id`, `workspace_id` | Many-to-one | Logical |
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`createNotebookRepository().put` (owner save and undo) and `notebookStatements` (a `notebook-assist` completion) insert the new version with `INSERT ... SELECT ... WHERE` a guard that requires `workspace_notebooks.last_mutation_id` to equal this write's id, so only the write that won the compare-and-set adds a revision. When the base version is 0, the same batch also inserts version 0 with the empty notebook.

### Update

Never: rows are immutable once inserted.

### Delete

The same notebook write batch deletes every row of the conversation outside the 20 newest versions, under the same guard. `deleteWorkspace` deletes all of a conversation's rows when the conversation is deleted.

### Synchronization

Not applicable: rows are copies of the application's own notebook writes.

### Retention

At most 20 rows per conversation (`NOTEBOOK_LIMITS.maxRevisions`), the current version included, removed with the conversation. Undo is one step, not a walk back through the 20: undo at version N restores version N - 1 as N + 1, so a second undo reads version N (the body before the first undo) and toggles back. The older rows are kept but no code path reads them today.

## Notes

- Storage per conversation stays under about 21 MB in the worst case (the current body plus 20 revisions of under 1 MB each); ordinary notebooks are a few KB per version ([database operations](../operations.md#0009--notebooks)).
