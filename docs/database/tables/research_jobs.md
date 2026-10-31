# Table: research_jobs

## Overview

| Property | Value |
|---|---|
| Table Name | `research_jobs` |
| Purpose | One row per job (run) the local runner executes: research questions, notebook-assist turns, news ingest, market, earnings, calendar and stock-directory refreshes. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 3. Research jobs |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `run_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`insertJobStatement`, `enqueueOutcome`, `jobWriteStatements`, `createJobRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`enqueueResearch`, `commitCompletion`, `deleteWorkspace`), `packages/adapters/src/sql/scheduledTasks.ts` (task list and `LATEST_RESULT_SQL` joins), `packages/adapters/src/sql/rows.ts` (`toJobRecord`) |
| Update Strategy | Compare-and-set on `version`; batched statements are guarded on `last_mutation_id` |
| Data Retention | Jobs of a conversation are deleted with it; jobs without one are kept indefinitely |

The API inserts a job in state `pending`. The runner claims it, which grants a lease, reports progress through events and heartbeats, and completes, releases or fails it. Every state change goes through the transition matrix `JOB_TRANSITIONS` (`packages/domain/src/jobs/stateMachine.ts`, ARCH-015) and a compare-and-set on `version`. The same batch appends a `job_transitions` row per change. A completion commits the job row, its results and its side effects atomically (`commitCompletion`). Home, the Watchlist, Settings and the Chat page read the latest job of a kind or of a conversation to show status.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `run_id` | TEXT | No | - | Run id, `run_` plus random hex (`IdGenerator.newId("run")`); immutable. |
| `kind` | TEXT | No | - | `research`, `news-ingest`, `market-refresh`, `earnings-refresh`, `google-calendar`, `notebook-assist` or `stock-directory-refresh` (`jobKindSchema`); immutable. |
| `state` | TEXT | No | - | One of `JOB_STATES`: `pending`, `claimed`, `planning`, `collecting`, `analyzing`, `verifying`, `publishing`, `waiting_approval`, and the terminal `completed`, `failed`, `cancelled`, `partial`. Changes only along `JOB_TRANSITIONS`. |
| `idempotency_key` | TEXT | No | - | The request's `Idempotency-Key` header, or `task:<taskId>:<slot>` / `task-run:<taskId>` for scheduled-task runs; unique per owner. |
| `request_fingerprint` | TEXT | No | - | What the key stands for: SHA-256 hex of the research or notebook-assist request JSON, or a fixed string such as `news-ingest`, `retry:<runId>` or `market-refresh[:unrefreshed]`. A reused key with another fingerprint is refused (`IDEMPOTENCY_KEY_REUSED`). |
| `request_json` | TEXT | Yes | - | The job's request as JSON, validated on read by `jobRequestSchema` (`rows.ts`): a `ResearchRequest`, a google-calendar `{ action }`, a notebook-assist request, `{ market }` for a stock-directory refresh, or `{ scope: "unrefreshed" }` (ADR-0039). NULL for news ingest and for refreshes of everything. |
| `workspace_id` | TEXT | Yes | - | The conversation of a `research` or `notebook-assist` job; NULL for the other kinds. |
| `usage_json` | TEXT | No | - | Cumulative resource usage (`resourceUsageSchema`: agent steps, tool calls, input bytes, known cost, unmetered flag). Each report keeps the larger of stored and reported values (`cumulativeUsage`), so it never decreases. |
| `attempt` | INTEGER | No | - | Claims used: 0 at insert, +1 per claim, −1 on a lease hand-back (ADR-0036), reset to 0 when the owner approves a waiting run. |
| `max_attempts` | INTEGER | No | - | Claim ceiling, 3 (`MAX_JOB_ATTEMPTS`). A claim at the ceiling fails the job with `RETRY_CEILING_REACHED`. |
| `lease_generation` | INTEGER | No | - | 0 at insert, +1 per claim. Runner requests must carry the current generation (`checkLease`), which fences stale runners. |
| `lease_owner_id` | TEXT | Yes | - | `credential_id` of the runner credential that holds (or last held) the lease; NULL before the first claim and after a hand-back. |
| `lease_expires_at` | TEXT | Yes | - | ISO-8601 UTC lease expiry: claim or heartbeat time + 90 s (`LEASE_DURATION_MS`). NULL when not leased and on every terminal write. An expired lease makes the job claimable again. |
| `last_event_seq` | INTEGER | No | - | Highest runner event `seq` accepted in the current lease; −1 at insert and on each claim. Events at or below it are ignored. |
| `cancel_requested` | INTEGER | No | - | 1 when the owner asked to cancel while a runner held a live lease; the runner sees it in heartbeat and events answers. Cleared (0) when the job ends. |
| `failure_code` | TEXT | Yes | - | Failure code of a `failed` job, or of a `partial` result; free text up to 80 characters (some live codes carry an error class name). Cleared by a new claim and by success outcomes. |
| `approval_request_json` | TEXT | Yes | - | `{ reasonCode, detail }` (`approvalRequestSchema` in `rows.ts`) while the run waits for an owner decision (`waiting_approval`); NULL otherwise. |
| `retry_of_run_id` | TEXT | Yes | - | The run this one retries (`POST /api/v1/research-runs/:id/retry`); NULL otherwise. Immutable. |
| `verification_status` | TEXT | Yes | - | `verified`, `partially-verified` or `unverified` from a `completed` or `partial` research bundle; NULL otherwise. |
| `provider_model` | TEXT | Yes | - | Model that produced the published bundle (`provenance.providerModel`). |
| `provider_session_ref` | TEXT | Yes | - | Provider session reference from the runner's `provider-session` event. Stored but not read by application code. |
| `completed_generation` | INTEGER | Yes | - | Lease generation whose completion was accepted. A repeated completion from that generation and runner is answered as `replayed` without re-applying. |
| `provenance_json` | TEXT | Yes | - | Agent, prompt and tool versions and data cut-off of the published result (`bundleProvenanceSchema`, AGT-010). |
| `version` | INTEGER | No | - | 0 at insert, +1 on every write; every write is a compare-and-set on it. |
| `last_mutation_id` | TEXT | No | - | Random UUID of the write that produced this row version. Later statements of the same batch run only if it matches (`JOB_GUARD_SQL`), so a lost race writes nothing. |
| `created_at` | TEXT | No | - | ISO-8601 UTC creation time; immutable. Orders job lists and the claim scan. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last write; for terminal jobs, the completion time shown as "last refresh". |
| `context_anchor_seq` | INTEGER | Yes | - | `seq` of the owner message that asked the run's question, stamped in the enqueue batch; a retry inherits it. The claim's conversation context is read from before it. NULL for jobs without a conversation and rows older than 0003. Added by 0003. |
| `failure_detail` | TEXT | Yes | - | Stable code (`STABLE_FAILURE_CODE_PATTERN`) beside `ALL_TOOL_CALLS_FAILED` (most frequent tool error) or `NO_EVIDENCE_COLLECTED`. Any other value decodes to NULL. Added by 0004. |
| `failure_upstream_status` | INTEGER | Yes | - | Status the external service answered with, unchanged, beside `failure_code` (ADR-0037); read only when a code is present. Added by 0012. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `run_id` | - | Identifies one run; serves `get`, every compare-and-set and the guard subqueries. |
| (unnamed) | UNIQUE | `owner_id`, `idempotency_key` | - | One job per idempotency key: the insert uses `ON CONFLICT (owner_id, idempotency_key) DO NOTHING`, and `findJobByIdempotencyKey` answers a replay from the stored job (ARCH-016). |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_research_jobs__owner_id_kind_created_at_run_id` | `owner_id`, `kind`, `created_at`, `run_id` | No | Latest job of one kind: `findActiveJobByKind`, `findLatestSuccessAtByKind`, `findLatestFailedByKind`, `findLatestFailureByKind`, `findLatestResearchRequest` and the insert's one-active-refresh guards. Every column is immutable after insert, so it costs one index write per job. Added by 0020. |
| `idx_research_jobs__owner_id_state_created_at` | `owner_id`, `state`, `created_at` | No | State filters: `countUnfinished`, the insert's unfinished-job cap, and the runner's claim scan `listClaimCandidates` (pending or expired leased jobs, oldest first). |
| `idx_research_jobs__owner_id_workspace_id_created_at_run_id` | `owner_id`, `workspace_id`, `created_at`, `run_id` | No | Jobs of one conversation, newest first: `list` with a conversation, `findActiveNotebookAssist`, the one-active-notebook-assist guard, and `deleteWorkspace`'s unfinished-run check and run list. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `workspace_id` | `workspaces` | `owner_id`, `workspace_id` | Many-to-one | Logical |
| `owner_id`, `retry_of_run_id` | `research_jobs` | `owner_id`, `run_id` | Many-to-one | Logical |
| `owner_id`, `lease_owner_id` | `runner_credentials` | `owner_id`, `credential_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`insertJobStatement`, an `INSERT ... SELECT` whose `WHERE` re-checks atomically:
- the unfinished-job cap (5 per owner);
- that the named conversation still exists;
- at most one active `market-refresh`, `earnings-refresh` or `google-calendar` job per owner;
- at most one active `notebook-assist` job per conversation (ADR-0020);
- at most one active `stock-directory-refresh` job per market (ADR-0034).

When it inserts nothing, `enqueueOutcome` says why. Research and notebook-assist jobs are inserted by `enqueueResearch` with the owner's chat message, the context anchor and the first-question title in one batch. Callers: `POST /api/v1/research-runs`, scheduled tasks (`createForTask`), and `POST /api/v1/workspaces/:id/notebook/assist`. Other kinds use `JobRepository.insert`: news ingest (`POST /api/v1/sources/refresh`), market refresh (`POST /api/v1/home/refresh`), earnings refresh (`watchlist.ts`), Google Calendar actions (`googleCalendar.ts`), stock-directory refresh (`POST /api/v1/watchlist/directory/refresh`) and retries (`POST /api/v1/research-runs/:id/retry`). Inserting a job writes no `job_transitions` row.

### Update

All updates go through `jobWriteStatements`, a compare-and-set on `version` that bumps it and stamps `last_mutation_id` and `updated_at`:
- **Claim** (`POST /api/v1/runner/jobs/claim`): `state = claimed` and new `attempt`, `lease_generation`, `lease_owner_id`, `lease_expires_at`; failure fields cleared and `last_event_seq = -1`. Cancelled, exhausted or unrunnable candidates are ended instead.
- **Heartbeat**: `lease_expires_at` only.
- **Events**: `state` along the matrix, `usage_json`, `provider_session_ref` and `last_event_seq`. Progress rows go to `job_events` in the same batch.
- **Release** (ADR-0036): back to `pending` with the attempt refunded, or `cancelled` when cancellation was requested.
- **Complete**: terminal or `waiting_approval` state, usage, `completed_generation`, failure and approval fields, verification, model and provenance. Committed with all completion effects by `commitCompletion`.
- **Owner actions**: cancel, approve (new budget in `request_json`, `attempt = 0`), and widening a pending `unrefreshed` refresh to everything (`activeRefreshJob`).
- **Enqueue batch**: sets `context_anchor_seq`.

### Delete

`deleteWorkspace` deletes the conversation's jobs (`workspace_id = ?`) with their events and transitions in its guarded batch (`DELETE /api/v1/workspaces/:id`). It refuses while any of them is unfinished. Jobs without a conversation are never deleted.

### Synchronization

Not applicable as storage of an external source. The table is the work queue the runner polls: a claim scans at most 5 candidates (pending, or leased with an expired lease) oldest first, and every runner request is fenced by `lease_generation` and the runner's credential.

### Retention

Research and notebook-assist jobs live as long as their conversation. News-ingest, market, earnings, Google Calendar and stock-directory jobs are never pruned. They grow by one row per refresh (technical debt; with them their `job_transitions` and `job_events`).

## Notes

- `state` changes write the state index on every transition; the kind index was designed with immutable columns only, so it costs one write per job (migration 0020 measured 9.6 ms → 1.0 ms at 20,000 jobs for the latest-of-kind read).
- Admission control (30 jobs per hour per owner, the `job-create` bucket in `rate_limits`) runs before the insert. A replayed idempotency key is answered before it and does not consume the allowance.
- `failure_code`, `failure_detail` and `failure_upstream_status` are always written together, so a later success never shows an earlier attempt's failure (finding 11).
