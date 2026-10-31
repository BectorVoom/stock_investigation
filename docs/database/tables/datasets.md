# Table: datasets

## Overview

| Property | Value |
|---|---|
| Table Name | `datasets` |
| Purpose | One row per tabular dataset a research run published (titled columns and up to 300 rows of sourced cells), shown by canvas components. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 4. Research results |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `dataset_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`recordStatements`, `deleteWorkspace`), `packages/adapters/src/sql/repositories.ts` (`createResearchRecordRepository`) |
| Update Strategy | Insert-only, in the completion (or import) batch |
| Data Retention | Deleted with the owning conversation unless another conversation's canvas still shows it |

A research completion stores its bundle's datasets in the batch that commits the job, tagged with the run and its conversation. Canvas components reference datasets by id, so `resolve` loads them for the canvas view and to validate UI commands. Export reads all datasets of a conversation (`datasetsForWorkspace`). Dataset cells cite evidence by `sourceId`, which keeps that evidence alive when a conversation is deleted.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `dataset_id` | TEXT | No | - | Dataset id; run-scoped, `<runId>_...` (`checkBundleIntegrity`). Imports re-key ids to `<importRunId>_<n>`. Copied from `body_json.datasetId`. |
| `run_id` | TEXT | Yes | - | The run (or import) that stored the row. Always set by the current code. |
| `workspace_id` | TEXT | Yes | - | The conversation the run answered. NULL when the conversation no longer existed at completion (no assistant message is written then). |
| `body_json` | TEXT | No | - | The dataset as JSON (`Dataset`, validated by `datasetSchema` on read): `title`, 1–16 `columns` (key, label, kind, unit; number columns need a unit), at most 300 `rows` of cells, and `createdAt`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `dataset_id` | - | Identifies one dataset; serves `resolve` (lookup by ids). A plain `INSERT` of an existing id fails the whole completion batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_datasets__owner_id_workspace_id` | `owner_id`, `workspace_id` | No | `datasetsForWorkspace`: all datasets of one conversation for export (`ORDER BY dataset_id`). |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`recordStatements` inserts the bundle's datasets with one `INSERT ... SELECT FROM json_each`. Callers: `commitCompletion` for a `completed` or `partial` research completion (guarded on the job compare-and-set) and `importWorkspace` (`POST /api/v1/workspaces/import`).

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` (`DELETE /api/v1/workspaces/:id`) deletes datasets of the conversation's runs except those another conversation's canvas still references (the keep list). The delete is by `run_id`, not `workspace_id`.

### Synchronization

Not applicable: no external source.

### Retention

Kept for the life of the conversation that owns the run, and longer while another conversation's canvas shows it.

## Notes

- No index covers `run_id`: `deleteWorkspace`'s delete by run and the surviving-dataset check in its evidence delete scan the owner's datasets. The second also expands every row and cell with `json_each`.
- A kept dataset keeps the `workspace_id` of the deleted conversation, so `datasetsForWorkspace` no longer finds it under any live conversation.
