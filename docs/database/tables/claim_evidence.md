# Table: claim_evidence

## Overview

| Property | Value |
|---|---|
| Table Name | `claim_evidence` |
| Purpose | One row per evidence link of a claim (claim → evidence edge), kept relational so "which claims rest on this evidence" needs no JSON scan. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 4. Research results |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `claim_id`, `ordinal` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`recordStatements`, `deleteWorkspace`) |
| Update Strategy | Insert-only, written with its claims |
| Data Retention | Deleted with its claim |

The edges mirror each claim's `body_json.links` and are written in the same statement group as the claims. The application reads them in one place: when a conversation is deleted, evidence that a remaining edge still references is kept. Claim and citation reads use the claim's own `links` JSON instead.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `claim_id` | TEXT | No | - | The claim the link belongs to. |
| `evidence_id` | TEXT | No | - | The evidence the claim cites. |
| `relation` | TEXT | No | - | `supports`, `contradicts` or `context` (`evidenceRelationSchema`), copied from the link. |
| `ordinal` | INTEGER | No | - | Position of the link in the claim's `links` array, from 0. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `claim_id`, `ordinal` | - | One row per link position of a claim; serves the delete by `claim_id IN (...)`. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_claim_evidence__owner_id_evidence_id` | `owner_id`, `evidence_id` | No | "Does any claim still rest on this evidence?": the `NOT EXISTS` check in `deleteWorkspace`'s evidence delete. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `claim_id` | `claims` | `owner_id`, `claim_id` | Many-to-one | Logical |
| `owner_id`, `evidence_id` | `evidence` | `owner_id`, `evidence_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`recordStatements` flattens every claim's `links` into edges and inserts them with one `INSERT ... SELECT FROM json_each`, right after the claims. Callers: `commitCompletion` for a `completed` or `partial` research completion (guarded on the job compare-and-set) and `importWorkspace` (`POST /api/v1/workspaces/import`). Claims without links add no rows.

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` (`DELETE /api/v1/workspaces/:id`) first deletes the edges of the claims it removes. Kept claims keep their edges, so their evidence survives the evidence delete that follows in the same batch.

### Synchronization

Not applicable: no external source.

### Retention

Exactly as long as its claim: at most 12 rows per claim (`claimSchema.links`).

## Notes

- `relation` is written but no query reads it; the relation shown to the owner comes from the claim's `body_json.links`.
- No UNIQUE key on `(claim_id, evidence_id)`: a claim may cite the same evidence at two positions.
