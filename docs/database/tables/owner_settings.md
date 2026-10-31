# Table: owner_settings

## Overview

| Property | Value |
|---|---|
| Table Name | `owner_settings` |
| Purpose | One row per owner holding the saved Settings → AI agent defaults for new questions. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 10. Owner settings and runner |
| Created By | `infra/migrations/0002_owner_settings.sql` |
| Primary Key | `owner_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createSettingsRepository`), `packages/adapters/src/sql/rows.ts` (`toStoredAgentSettings`) |
| Update Strategy | Upsert that replaces the whole record; last write wins |
| Data Retention | One row per owner, kept indefinitely |

Saves from Settings → AI agent (`PUT /api/v1/settings/agent`) go through `createAgentSettingsService.update`, which replaces the record. Research runs, the notebook assistant and scheduled tasks read it when they start a run; a scheduled occurrence fires only with explicitly saved settings (ADR-0033 §4). With no row, `GET /api/v1/settings/agent` falls back to the owner's latest research request or the contract defaults.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `agent_settings_json` | TEXT | No | - | JSON `AgentSettings` (`agentSettingsSchema`): `defaultAgentId`, per-backend `models`, `effort`, `budget` (only `maxSpendUsd` is the owner's cap) and `webAccess`; validated on read. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last save. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id` | - | One settings record per owner; the target of the save's `ON CONFLICT (owner_id)` upsert. |

## Indexes

None. The primary key serves every read: `getAgentSettings` reads one row by `owner_id`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

The owner's first save in Settings → AI agent (`createAgentSettingsService.update` → `putAgentSettings`) inserts the row; an audit row `settings.agent.update` follows.

### Update

Each later save overwrites `agent_settings_json` and `updated_at` with `INSERT … ON CONFLICT (owner_id) DO UPDATE`. There is no version check: a single owner edits one form.

### Delete

Never: no code path deletes rows.

### Synchronization

Not applicable: the owner's own settings, with no external source.

### Retention

Kept indefinitely; one row per owner.

## Notes

- The request body is validated against `agentSettingsSchema` at the API boundary; `putAgentSettings` stores it with `JSON.stringify` and reads parse it again (`parseJsonColumn`).
- The audit detail holds only the backend id and effort, never model names (SEC-010).
