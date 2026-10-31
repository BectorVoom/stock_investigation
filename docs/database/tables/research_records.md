# Table: research_records

## Overview

| Property | Value |
|---|---|
| Table Name | `research_records` |
| Purpose | Immutable typed research records a run published: demand scenarios, securities, supplier links, financial and position observations, investor filings and pricing-power assessments. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 4. Research results |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `record_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`recordRows`, `recordStatements`, `deleteWorkspace`), `packages/adapters/src/sql/repositories.ts` (`createResearchRecordRepository.recordsForRuns`) |
| Update Strategy | Insert-only, in the completion (or import) batch |
| Data Retention | Deleted with the conversation that owns the run |

One table holds seven record types, told apart by `record_type`. A research completion stores its bundle's typed records in one multi-row insert; an import stores the file's records under its synthetic run id. `recordsForRuns` reads them back for the run records view (`GET /api/v1/research-runs/:id/records`) and for export, grouped by type in bundle order.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `record_id` | TEXT | No | - | The record's own id (`scenarioId`, `securityId`, `supplierLinkId`, `observationId`, `filingId` or `pricingPowerId`); run-scoped, `<runId>_...` (`checkBundleIntegrity`). Imports re-key ids to `<importRunId>_<n>`. |
| `run_id` | TEXT | No | - | The run (or import) that stored the row. |
| `record_type` | TEXT | No | - | `scenario`, `security`, `supplier-link`, `financial-observation`, `position-observation`, `investor-filing` or `pricing-power` (`RecordType` in `repositories.ts`). |
| `ordinal` | INTEGER | No | - | Position of the record within its type in the bundle, from 0; keeps bundle order on read. |
| `body_json` | TEXT | No | - | The record as JSON, validated on read by the schema of its type: `demandScenarioSchema`, `securitySchema`, `supplierLinkSchema`, `financialObservationSchema`, `positionObservationSchema`, `investorFilingSchema` or `pricingPowerRecordSchema`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `record_id` | - | Identifies one record across all types. A plain `INSERT` of an existing id fails the whole completion batch. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_research_records__owner_id_run_id_record_type_ordinal` | `owner_id`, `run_id`, `record_type`, `ordinal` | No | `recordsForRuns`: all records of a set of runs in `ORDER BY run_id, record_type, ordinal` without a sort; also `deleteWorkspace`'s delete by run. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`recordStatements` inserts every typed record of the bundle with one `INSERT ... SELECT FROM json_each`; `recordRows` assigns `record_type` and `ordinal`. Callers: `commitCompletion` for a `completed` or `partial` research completion (guarded on the job compare-and-set, after `checkBundleIntegrity`) and `importWorkspace` (`POST /api/v1/workspaces/import`).

### Update

Never: rows are immutable.

### Delete

`deleteWorkspace` (`DELETE /api/v1/workspaces/:id`) deletes every record of the conversation's runs in its guarded batch. There is no keep list for typed records: canvases do not reference them by id.

### Synchronization

Not applicable: no external source.

### Retention

Kept for the life of the conversation that owns the run.
