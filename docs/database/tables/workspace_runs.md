# Table: workspace_runs

## Overview

| Property | Value |
|---|---|
| Table Name | `workspace_runs` |
| Purpose | Links a conversation to each run (or import) that stored research records for it; drives export and deletion. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 2. Conversations (workspaces) |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `workspace_id`, `run_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`recordStatements`, `deleteWorkspace`), `packages/adapters/src/sql/repositories.ts` (`createResearchRecordRepository.runIdsForWorkspace`) |
| Update Strategy | Insert-only (`INSERT OR IGNORE`) |
| Data Retention | Kept until the owner deletes the conversation |

Whenever research records are stored for a conversation, the same batch links the run to it. An import has no job row, so this link is the only place its synthetic run id is recorded. Export reads the linked runs to collect their records. Deletion uses the jobs of the conversation plus these links to find the records it removes.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `workspace_id` | TEXT | No | - | The conversation the run's records belong to. |
| `run_id` | TEXT | No | - | A research run (`run_...`, a `research_jobs` row) or an import's synthetic run id (`imp_...`, no job row). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `workspace_id`, `run_id` | - | One link per run per conversation; `INSERT OR IGNORE` makes a repeated link a no-op. |

## Indexes

None. The primary key serves every read: `runIdsForWorkspace` (`ORDER BY run_id`), the run list of `deleteWorkspace` and the delete by conversation all filter on its `owner_id`, `workspace_id` prefix.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`recordStatements` adds the link whenever it stores records under a conversation, guarded like the records themselves. This happens in `commitCompletion` for a research completion with a bundle when the conversation still exists, and in `importWorkspace` (`POST /api/v1/workspaces/import`, unguarded batch).

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` deletes the conversation's links in its guarded batch (`DELETE /api/v1/workspaces/:id`), after using them to find the records to delete.

### Synchronization

Not applicable: no external source.

### Retention

Kept for the conversation's life; one row per contributing run.

## Notes

- `run_id` of an import does not resolve to a `research_jobs` row; code that joins it to jobs must expect no match.
