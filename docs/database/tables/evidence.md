# Table: evidence

## Overview

| Property | Value |
|---|---|
| Table Name | `evidence` |
| Purpose | One row per source document a research run collected and cites: URL, title, publisher, dates, excerpt and content checksum. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 4. Research results |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `evidence_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`recordStatements`, `deleteWorkspace`), `packages/adapters/src/sql/repositories.ts` (`createResearchRecordRepository`) |
| Update Strategy | Insert-only, in the completion (or import) batch |
| Data Retention | Deleted with the owning conversation unless something that survives still cites it |

A research completion stores its bundle's evidence under the run id, in the batch that commits the job; an import stores the file's evidence under its synthetic run id. Claims link to evidence through `claim_evidence`; canvas components, dataset cells and Notebook chart widgets cite it by id. Reads resolve evidence by id for the canvas view, the chat's citations and new UI commands. They also load all evidence of a set of runs for the run records and for export.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `evidence_id` | TEXT | No | - | Evidence id; run-scoped, `<runId>_...`, enforced by `checkBundleIntegrity` (`ID_NOT_RUN_SCOPED`). Imports re-key ids to `<importRunId>_<n>`. Copied from `body_json.evidenceId`. |
| `run_id` | TEXT | No | - | The run (or import) that stored the row. |
| `body_json` | TEXT | No | - | The evidence record as JSON (`Evidence`, validated by `evidenceSchema` on read): `sourceUrl`, `title`, `publisher`, `publishedAt`, `retrievedAt`, `effectiveAt`, `excerpt` (≤ 500 characters), `checksum` (SHA-256 hex) and `sourceClass`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `evidence_id` | - | Identifies one evidence record; serves `ResearchRecordRepository.resolve` (lookup by ids). A plain `INSERT` of an existing id fails the whole completion batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_evidence__owner_id_run_id` | `owner_id`, `run_id` | No | All evidence of a set of runs: `recordsForRuns` (run records and export, `ORDER BY run_id, evidence_id`) and `deleteWorkspace`'s delete by run. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`recordStatements` inserts the bundle's evidence with one `INSERT ... SELECT FROM json_each`. Two callers:
- `commitCompletion` for a `completed` or `partial` research completion (`POST /api/v1/runner/jobs/:id/complete`), guarded on the job compare-and-set, after `checkBundleIntegrity` accepted the bundle.
- `importWorkspace` (`POST /api/v1/workspaces/import`), unguarded, after `checkRecordIntegrity`.

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` (`DELETE /api/v1/workspaces/:id`) deletes evidence of the conversation's runs, except evidence that survives because something still cites it:
- the keep list: ids that other conversations' canvases cite, plus evidence cited by Notebook chart widgets (`listChartEvidenceIds`, ADR-0026);
- a remaining `claim_evidence` edge;
- a cell `sourceId` of a surviving dataset.

The statement runs after the claim and edge deletes in the same batch.

### Synchronization

Not applicable: rows are written once from a runner's bundle; re-fetching a source produces new rows under a new run.

### Retention

Kept for the life of the conversation that owns the run, and longer while a surviving conversation, claim, dataset or chart widget cites it.

## Notes

- The delete's dataset check expands every surviving dataset's `rows` and cells with `json_each` inside a `NOT EXISTS`, so its cost grows with the owner's total dataset size.
- A borrow that commits concurrently with a delete may leave a dangling evidence id; reads treat unknown ids as absent (`deleteWorkspace` comment).
