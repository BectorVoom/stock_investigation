# ADR-0004: D1 write model under Workers Free limits

**Status:** Accepted · Amended by ADR-0008 · **Date:** 2026-10-11

## Context

Queue semantics (section 5.2) need compare-and-set claims, lease fencing, idempotent completion and an audit trail. Workers Free allows roughly 50 D1 queries and 10 ms CPU per request, and D1 exposes no interactive transactions — only `batch()`, which runs its statements in one transaction but cannot branch on an earlier statement's result.

## Decision

- **Versioned rows.** `research_jobs` and `workspaces` carry `version` and `last_mutation_id`. A write is `UPDATE … WHERE version = ?`, stamping a fresh mutation id.
- **Guarded batches.** Every further statement in the same batch is `INSERT … SELECT … WHERE EXISTS (row with that mutation id)`. If the compare-and-set lost, the guards are false and the batch writes nothing. This gives all-or-nothing multi-table commits without interactive transactions. Job completion additionally requires the target workspace to still be at the version the new state was computed from.
- **Set-based inserts.** Bundles are inserted with `INSERT … SELECT … FROM json_each(?)`: one statement per table regardless of row count, so a full completion is about a dozen queries.
- **Lease fencing.** `lease_generation` increases on each claim; heartbeat, events and completion must present the current generation and the credential that holds it. `completed_generation` makes a duplicate completion a no-op replay.
- **No cron.** Expired leases are detected lazily when a runner next claims; no scheduled Worker is needed.
- **Generic record table.** Scenarios, securities, supplier links, observations, filings and pricing-power records are immutable JSON documents in `research_records`, validated by the shared schemas on write and on read. Evidence, claims and claim→evidence edges are relational because they are joined.

## Consequences

- Referential integrity between JSON records is enforced in the application layer (`checkRecordIntegrity`) rather than by foreign keys; it is covered by tests.
- A request body is capped at 1 MB and bundle sizes are bounded in the contracts so validation stays inside the CPU budget. If measured CPU time becomes a problem the remedy is Workers Paid, not a redesign.
- Rollback of the initial migration is "export, drop, re-apply" (`docs/OPERATIONS.md`).
