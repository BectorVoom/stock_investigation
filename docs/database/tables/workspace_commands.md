# Table: workspace_commands

## Overview

| Property | Value |
|---|---|
| Table Name | `workspace_commands` |
| Purpose | One row per UI command applied to a conversation's canvas: the command history that makes command submission idempotent and feeds the canvas event poll. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 2. Conversations (workspaces) |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `workspace_id`, `command_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`insertCommandsStatement`, `createWorkspaceRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`commitCompletion`, `deleteWorkspace`), `packages/adapters/src/sql/rows.ts` (`toAppliedCommand`) |
| Update Strategy | Insert-only, in the same batch as the workspace compare-and-set |
| Data Retention | Kept until the owner deletes the conversation |

Every canvas change writes the new `workspaces.state_json` and its commands in one batch; the command insert is guarded on the workspace write having won. Owner commands come from the Chat page; agent commands come from the UI operations of a research completion. The history is read to answer a replayed command id and to send clients the commands after the version they hold (`GET /api/v1/workspaces/:id/events`).

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `workspace_id` | TEXT | No | - | The conversation the command changed. |
| `command_id` | TEXT | No | - | Client-chosen command id from the command envelope; makes submission idempotent. |
| `version` | INTEGER | No | - | Workspace version produced by applying the command (`workspaces.version` after it). |
| `command_json` | TEXT | No | - | The full command as JSON (`UiCommand`, validated by `uiCommandSchema` on read). Rows written before migration 0005 may name `image-gallery` components; they are kept verbatim. |
| `origin` | TEXT | No | - | `owner` (owner command) or `agent` (UI operation of a research completion). |
| `applied_at` | TEXT | No | - | ISO-8601 UTC time the command was applied. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `workspace_id`, `command_id` | - | One row per command id per conversation; serves `findCommand` (replay) and the duplicate-command check inside `WorkspaceRepository.write`. |
| (unnamed) | UNIQUE | `owner_id`, `workspace_id`, `version` | - | One command per produced version, so the history has no forks; serves `listCommandsAfter` (`version > ? ORDER BY version`). |

## Indexes

None. The primary key serves lookups by command id and the delete by conversation (its prefix). The UNIQUE key's automatic index serves the ordered event poll.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`insertCommandsStatement` (one `INSERT ... SELECT FROM json_each`, guarded on the workspace's `last_mutation_id`). It is called by `WorkspaceRepository.write` for an owner command (`POST /api/v1/workspaces/:id/commands`), with `origin = 'owner'`. It is also called by `commitCompletion` for a research completion whose UI operations changed the canvas (`POST /api/v1/runner/jobs/:id/complete`), with `origin = 'agent'`. The owner's workspace `UPDATE` refuses to run when any of the command ids already exists, so a replay writes nothing.

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` deletes the conversation's rows in its guarded batch (`DELETE /api/v1/workspaces/:id`).

### Synchronization

Not applicable: no external source. Clients follow the canvas by polling the rows after their version (`listCommandsAfter`, 100 per page).

### Retention

Kept for the conversation's life. Nothing prunes the history; each canvas change adds one row per command.
