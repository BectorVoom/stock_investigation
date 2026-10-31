# Table: runner_credentials

## Overview

| Property | Value |
|---|---|
| Table Name | `runner_credentials` |
| Purpose | One row per runner bearer credential: expiring, renewable by the runner and revocable by the owner; only a SHA-256 of the token is stored (SEC-005). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 10. Owner settings and runner |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `credential_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createRunnerCredentialRepository`), `packages/adapters/src/sql/rows.ts` (`toRunnerCredential`) |
| Update Strategy | Conditional single-row updates: revoke once, rotate while not revoked, stamp `last_used_at` on authentication |
| Data Retention | Kept indefinitely, including revoked and expired rows |

The owner issues credentials under Settings (`POST /api/v1/runner-credentials`); `bun run dev` / `bun run prod` (`scripts/launch.ts`) issues one the same way and keeps the token in a file only the owner can read. Every runner request resolves its bearer token to `(owner_id, credential_id)` through `authenticate`, which also stamps `last_used_at`. The runner renews its token before expiry (`POST /api/v1/runner/credentials/renew`), which swaps the hash in place, and the owner revokes a credential with `DELETE /api/v1/runner-credentials/:id`.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004); the identity a runner request acts for. |
| `credential_id` | TEXT | No | - | Credential id (`rc` prefix from the id generator); the runner identity in audit actors (`runner:<credential_id>`). |
| `token_hash` | TEXT | No | - | Hex SHA-256 of the 256-bit random bearer token; the token itself is shown once and never stored. Replaced on renewal. |
| `label` | TEXT | No | - | Owner-given name (`shortTextSchema`), e.g. the launcher's credential label. |
| `created_at` | TEXT | No | - | ISO-8601 UTC issue time; the list is ordered by it, newest first. |
| `expires_at` | TEXT | No | - | ISO-8601 UTC expiry: issue or renewal time plus 1–90 days (`expiresInDays`). |
| `revoked_at` | TEXT | Yes | - | ISO-8601 UTC revocation time; NULL while not revoked. A revoked credential cannot authenticate or renew. |
| `last_used_at` | TEXT | Yes | - | ISO-8601 UTC time of the last successful authentication; NULL until first use. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `credential_id` | - | One row per credential; `list` reads the owner's prefix, `revoke` and `rotate` update one key. |
| (unnamed) | UNIQUE | `token_hash` | - | No two credentials share a token hash; its automatic index serves `authenticate`, which looks a token up without knowing the owner. |

## Indexes

None. The primary key serves the owner's `list`, `revoke` and `rotate`; the automatic index of `UNIQUE (token_hash)` serves `authenticate`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`POST /api/v1/runner-credentials` → `createRunnerCredentialService.issue` inserts the row with NULL `revoked_at` and `last_used_at`, then writes the audit row `runner-credential.issue`. Issuing is refused (`CONFLICT`) while the owner already has 5 live (unrevoked, unexpired) credentials.

### Update

`authenticate` sets `last_used_at` on every authenticated runner request (`UPDATE … WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? RETURNING …`). `renew` (`rotate`) replaces `token_hash` and `expires_at` while the credential is not revoked; the old token stops working at once. `revoke` sets `revoked_at` only if it is still NULL, then writes the audit row `runner-credential.revoke`.

### Delete

Never: revocation stamps `revoked_at` instead of deleting.

### Synchronization

Not applicable: credentials are issued by this API, not copied from an external source.

### Retention

Kept indefinitely; revoked and expired rows stay and are listed under Settings. Issuing is capped at 5 live credentials, but the total row count is not bounded.

## Notes

- A plain SHA-256 lookup hash suffices because tokens are 256-bit random secrets; there is no low-entropy password to stretch.
- `authenticate` is one statement per runner request: the lookup and the `last_used_at` write together. On D1 this makes every runner call (claim, heartbeat, events) a billed row write.
- Revoked and expired rows are never pruned; `list` returns all of them.
