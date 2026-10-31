# Table: claims

## Overview

| Property | Value |
|---|---|
| Table Name | `claims` |
| Purpose | One row per claim a research run published: a statement with its type, verification status, evidence links and issues. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 4. Research results |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `claim_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`recordStatements`, `deleteWorkspace`), `packages/adapters/src/sql/repositories.ts` (`createResearchRecordRepository`) |
| Update Strategy | Insert-only, in the completion (or import) batch |
| Data Retention | Deleted with the owning conversation unless another conversation's canvas still presents it |

A research completion stores its bundle's claims, and their evidence edges in `claim_evidence`, in the batch that commits the job. The assistant's answer cites claims through `chat_messages.claim_ids_json`, and canvas components present claims with their status. The Chat page loads the cited claims (`claimsByIds`); run records and export load all claims of a set of runs.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `claim_id` | TEXT | No | - | Claim id; run-scoped, `<runId>_...` (`checkBundleIntegrity`). Imports re-key ids to `<importRunId>_<n>`. Copied from `body_json.claimId`. |
| `run_id` | TEXT | No | - | The run (or import) that stored the row. |
| `status` | TEXT | No | - | `supported`, `unsupported` or `conflicting` (`claimStatusSchema`), copied from `body_json.status` at insert. No query reads this column; reads use `body_json`. |
| `body_json` | TEXT | No | - | The claim as JSON (`Claim`, validated by `claimSchema` on read): `text` (≤ 1,000 characters), `claimType`, `status`, `links` (≤ 12 evidence links with relation and quote) and `issues`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `claim_id` | - | Identifies one claim; serves `claimsByIds` and `resolve`. A plain `INSERT` of an existing id fails the whole completion batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_claims__owner_id_run_id` | `owner_id`, `run_id` | No | All claims of a set of runs: `recordsForRuns` (`ORDER BY run_id, claim_id`), and `deleteWorkspace`'s claim delete and the subquery that finds the edges to delete. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`recordStatements` inserts the claims with one `INSERT ... SELECT FROM json_each`, followed by their `claim_evidence` edges. Callers: `commitCompletion` for a `completed` or `partial` research completion (guarded on the job compare-and-set) and `importWorkspace` (`POST /api/v1/workspaces/import`).

### Update

Never: rows are immutable. A claim's status is fixed when the run publishes it.

### Delete

`deleteWorkspace` (`DELETE /api/v1/workspaces/:id`) deletes claims of the conversation's runs except those another conversation's canvas still presents (the keep list from `workspaceReferences`). Their `claim_evidence` edges are deleted first in the same batch.

### Synchronization

Not applicable: no external source.

### Retention

Kept for the life of the conversation that owns the run, and longer while another conversation presents the claim.

## Notes

- `status` duplicates `body_json.status` and is never queried; it costs storage only.
