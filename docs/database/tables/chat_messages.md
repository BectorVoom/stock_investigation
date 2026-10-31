# Table: chat_messages

## Overview

| Property | Value |
|---|---|
| Table Name | `chat_messages` |
| Purpose | One row per chat message of a conversation: the owner's questions and the assistant's answers, in sequence. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 2. Conversations (workspaces) |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `message_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`appendMessageStatement`, `enqueueResearch`, `commitCompletion`, `importWorkspace`, `deleteWorkspace`), `packages/adapters/src/sql/repositories.ts` (`createChatRepository`), `packages/adapters/src/sql/scheduledTasks.ts` (`LATEST_RESULT_SQL`), `packages/adapters/src/sql/rows.ts` (`toChatMessage`) |
| Update Strategy | Insert-only (`INSERT OR IGNORE` at the next `seq`) |
| Data Retention | Kept until the owner deletes the conversation |

An owner message is written in the same batch as the research or notebook-assist job it starts. The assistant's answer is written in the batch that commits the run's completion. The Chat page reads the newest messages and pages backwards by `seq`. The runner's claim reads the messages before the run's anchor as conversation context. The conversation list and the task result widget read the latest message.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `message_id` | TEXT | No | - | Owner messages: `msg_` plus random hex. Assistant answers: `<runId>_answer`. Imported messages: re-keyed to `<importRunId>_<n>`. |
| `workspace_id` | TEXT | No | - | The conversation the message belongs to. |
| `seq` | INTEGER | No | - | Position in the conversation, from 0: `max(seq) + 1` computed inside the insert. Imports keep the file's values. |
| `role` | TEXT | No | - | `owner` or `assistant` (`chatMessageSchema`). |
| `text` | TEXT | No | - | Message text, at most 6,000 characters; assistant answers are cut to 6,000. |
| `run_id` | TEXT | Yes | - | Owner message: the run it started. Assistant message: the run that answered. Imported messages carry the import's synthetic run id (`imp_...`). |
| `claim_ids_json` | TEXT | No | - | JSON array of the `claims.claim_id` values the answer cites (`answerClaimIds`); `[]` for owner messages and notebook-assist replies. |
| `created_at` | TEXT | No | - | ISO-8601 UTC time: the job's creation time for an owner message, the completion time for an answer. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `message_id` | - | Identifies one message. With the deterministic `<runId>_answer` id, `INSERT OR IGNORE` makes a replayed completion a no-op. |
| (unnamed) | UNIQUE | `owner_id`, `workspace_id`, `seq` | - | One message per position. Serves `ChatRepository.list` (`seq < ? ORDER BY seq DESC`), the `max(seq)` lookup of every append, the per-conversation aggregate of `listConversations` and `LATEST_RESULT_SQL`. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_chat_messages__owner_id_workspace_id_run_id` | `owner_id`, `workspace_id`, `run_id` | No | `ChatRepository.findByRunId`: the owner message of a notebook-assist run, returned when the instruction is queued and when a request with the same idempotency key is replayed. Added by 0009 (`chat_messages_by_run`), renamed by 0020. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

- `enqueueResearch` appends the owner message (`appendMessageStatement`) in the job-insert batch. Callers are research runs (`POST /api/v1/research-runs`), scheduled task runs and notebook-assist instructions (`POST /api/v1/workspaces/:id/notebook/assist`). The append is guarded on the job insert. The same batch stamps the message's `seq` on the job as `context_anchor_seq`.
- `commitCompletion` appends the assistant answer for a research completion or a notebook-assist completion, guarded on the job compare-and-set. It is skipped when the conversation no longer exists.
- `importWorkspace` inserts the imported messages with their original `seq` (`POST /api/v1/workspaces/import`).

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` deletes every message of the conversation in its guarded batch (`DELETE /api/v1/workspaces/:id`).

### Synchronization

Not applicable: no external source.

### Retention

Kept for the conversation's life. Reads are bounded instead of the table: the Chat page pages by `seq`, a claim reads at most `CONVERSATION_CONTEXT_LIMITS.maxMessages` rows before the anchor, and an export reads at most 2,000 messages.

## Notes

- A notebook-assist run has two messages with its `run_id` (the owner's instruction and the reply), but `findByRunId` has no `ORDER BY`. A replayed instruction after the reply exists may therefore return either message.
- The `seq` is computed inside the `INSERT` (`coalesce(max(seq) + 1, 0)`), in the same statement that writes the row. Because the append uses `OR IGNORE`, a collision on the UNIQUE key would skip the message silently rather than fail the batch.
