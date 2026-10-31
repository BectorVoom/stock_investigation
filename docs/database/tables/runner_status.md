# Table: runner_status

## Overview

| Property | Value |
|---|---|
| Table Name | `runner_status` |
| Purpose | One row per owner holding what the runner last reported on a job claim: when it was seen, its version and its agent backends. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 10. Owner settings and runner |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createRunnerStatusRepository`) |
| Update Strategy | Upsert on every runner claim; last report wins |
| Data Retention | One row per owner, overwritten in place, never deleted |

`runnerJobs.claim` upserts the row at the start of every `POST /api/v1/runner/jobs/claim`, so it doubles as the runner's heartbeat. `GET /api/v1/agents` reads it to list the backends and to show the runner as online when `last_seen_at` is less than 60 seconds old. The research-run service reads `agents_json` to decide whether a backend is registered and whether it is metered or plan-limited.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | Yes | - | The single owner's id (API-004); the owner of the credential that made the claim. |
| `last_seen_at` | TEXT | No | - | ISO-8601 UTC time of the last claim. |
| `runner_version` | TEXT | No | - | Version string the runner sent with the claim (1–40 characters). |
| `agents_json` | TEXT | No | - | JSON array of `AgentDescriptor` (`agentDescriptorSchema`): `agentId`, `displayName`, `capabilities`, `costModel`, `toolIsolation`, `availability`; validated on read. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id` | - | One status row per owner; the target of the claim's `ON CONFLICT (owner_id)` upsert. |

## Indexes

None. The primary key serves every read: `get` reads one row by `owner_id`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

The owner's first runner claim (`POST /api/v1/runner/jobs/claim` → `runnerJobs.claim` → `put`) inserts the row.

### Update

Every later claim overwrites `last_seen_at`, `runner_version` and `agents_json` with `INSERT … ON CONFLICT (owner_id) DO UPDATE`. With several runners, the last claim wins.

### Delete

Never: no code path deletes rows.

### Synchronization

Follows the runner's own reports: each claim replaces the row with the runner's current state. Nothing else writes it.

### Retention

Kept indefinitely; one row per owner. An old `last_seen_at` only makes the runner show as offline.

## Notes

- `owner_id` is a plain `TEXT PRIMARY KEY` without `NOT NULL`, so SQLite would accept a NULL key; the code always binds the authenticated owner.
- A claim polls often, and each one is a billed row write on D1.
