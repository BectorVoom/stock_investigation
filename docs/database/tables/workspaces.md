# Table: workspaces

## Overview

| Property | Value |
|---|---|
| Table Name | `workspaces` |
| Purpose | One row per conversation (workspace): its title and its current canvas state. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 2. Conversations (workspaces) |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `workspace_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createWorkspaceRepository`, `createChatRepository.listConversations`), `packages/adapters/src/sql/unitOfWork.ts` (`enqueueResearch`, `commitCompletion`, `importWorkspace`, `deleteWorkspace`, `createScheduledTask`), `packages/adapters/src/sql/rows.ts` (`toWorkspaceRecord`, `toWorkspaceSummary`) |
| Update Strategy | Compare-and-set on `version` for canvas writes; title-only updates for renames |
| Data Retention | Kept until the owner deletes the conversation; at most 50 per owner (`MAX_WORKSPACES`) |

A conversation is created empty by the owner, by an import, or together with a scheduled task. Its canvas changes through owner commands and through the UI operations of research completions. Each change replaces `state_json`, bumps `version` and appends `workspace_commands` rows in the same batch. Deleting the conversation removes it and everything it solely owns in one guarded batch. Every other conversation table (`chat_messages`, `workspace_commands`, `workspace_runs`, the notebook tables, `scheduled_tasks`) hangs off this row by `workspace_id`.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `workspace_id` | TEXT | No | - | Conversation id, `ws_` plus random hex (`IdGenerator.newId("ws")`). |
| `title` | TEXT | No | - | Conversation title. New conversations start as `New chat` (`DEFAULT_CONVERSATION_TITLE`); the first question renames an unrenamed one (`deriveConversationTitle`, at most 60 characters); the owner can rename it. Imports append ` (imported)`. |
| `version` | INTEGER | No | - | Canvas version, monotonic. Every canvas write is a compare-and-set on it; it always equals `state_json.version`. Renames and title changes do not move it. |
| `state_json` | TEXT | No | - | The canvas as JSON (`WorkspaceState`, validated by `workspaceStateSchema`): components, layout, focus, selection, last navigation. On read, withdrawn `image-gallery` components are dropped (`dropWithdrawnImageComponents`, migration 0005). |
| `last_mutation_id` | TEXT | No | - | Random UUID of the write that produced this row version. Later statements in the same batch check it (`WORKSPACE_GUARD_SQL`, the delete and scheduled-task guards) so they run only if this write won. |
| `created_at` | TEXT | No | - | ISO-8601 UTC creation (or import) time. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last canvas write, rename or first-question title. Sorts the workspace list. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `workspace_id` | - | Identifies one conversation; every read and write is by this key or by the owner prefix. |

## Indexes

None. The primary key serves every read: `get`, the guards and the existence checks are point lookups. `list`, `listRecords` and `listConversations` scan the owner's prefix and sort in memory. Creation stops at 50 conversations, but imports skip that cap (see Retention), so the scan is not strictly bounded.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

- `WorkspaceRepository.insert` from `createWorkspaceService.create` (`POST /api/v1/workspaces`), with an empty canvas at version 0, after the 50-conversation check.
- `ResearchUnitOfWork.importWorkspace` from the export import (`POST /api/v1/workspaces/import`), in one batch with the imported records and messages.
- `ResearchUnitOfWork.createScheduledTask` (`POST /api/v1/scheduled-tasks`): an `INSERT ... SELECT` whose `WHERE` checks the task limits, then the task insert guarded on this row's `last_mutation_id`.

### Update

- Canvas: `WorkspaceRepository.write` (owner command, `POST /api/v1/workspaces/:id/commands`) and `commitCompletion` (research UI operations) set `state_json`, `version`, `last_mutation_id` and `updated_at`. The write runs only when `version` still equals the expected version, and for owner commands only when none of the command ids is already stored.
- Title: `rename` (`PATCH /api/v1/workspaces/:id`) sets `title` and `updated_at` only. `enqueueResearch` sets the title from the first question while it is still `New chat` and the question is the conversation's only message, in the job's batch.
- `deleteWorkspace` first stamps a new `last_mutation_id` (no other change) when no run of the conversation is unfinished; the rest of the delete batch is guarded on that stamp.

### Delete

`ResearchUnitOfWork.deleteWorkspace` (`DELETE /api/v1/workspaces/:id`). One batch deletes, in order: the conversation's claim edges, claims, evidence, research records and datasets (except ids another conversation still cites), job events, job transitions, jobs, `workspace_runs`, chat messages, notebook turns, notebook revisions, the notebook, `workspace_commands`, scheduled tasks, and finally this row. The delete is refused (`has-unfinished`) while a run of the conversation is unfinished.

### Synchronization

Not applicable: the table holds owner data and has no external source.

### Retention

Kept until the owner deletes the conversation. `create` and the scheduled-task create refuse a 51st conversation; an import does not check the cap.

## Notes

- Renames deliberately skip the version compare-and-set, so a rename racing a canvas write never causes a version conflict.
- Stored states that still name `image-gallery` components are fixed on read, not rewritten; the next write persists the stripped state (migration 0005).
- `importWorkspace` does not check `MAX_WORKSPACES`, so imports can exceed the 50-conversation cap.
