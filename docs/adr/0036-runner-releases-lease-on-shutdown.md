# ADR-0036: The runner hands its lease back on shutdown

Status: accepted (2026-10-25)

## Context

Profiling the owner's last 14 development research runs: 42% of all wall time
was lost because the runner was stopped (SIGTERM) in the middle of a job. The
development launcher restarts the runner on every rebuild, and production
restarts it on deploy. On shutdown the runner logged `job_abandoned` (reason
`shutdown`) and exited without telling the API. The job stayed leased until
its 90-second lease ran out (`LEASE_DURATION_MS`). The next claim then
recovered it as `lease-expired`, which used up an attempt. One run
(`run_a4b85e21c1ffbcceecc87230` in the development D1) failed with
`RETRY_CEILING_REACHED` only because of restarts.

## Decision

The owner chose "hand the lease back":

1. **Release endpoint.** `POST /api/v1/runner/jobs/:id/release` takes
   `{ leaseGeneration, usage }` (`releaseJobRequestSchema`) and answers
   `{ state: "pending" | "cancelled" }`. Its authentication, validation and
   use-case mapping are the same as the heartbeat's. The decision is the pure
   `decideRelease(job, proof)` in `packages/domain/src/jobs/lease.ts`, with a
   Rust twin in `research-domain`.
2. **Only the holder releases.** A release is accepted only when
   `checkLease` passes: the job is leased, the generation is current and the
   runner holds the lease. Any other proof gets the lease check's
   `STALE_LEASE` answer (with detail `NOT_LEASED`, `STALE_LEASE` or
   `WRONG_RUNNER`).
3. **Requeue with the claim refunded.** The job goes back to `pending` with
   `attempt - 1` (never below 0), no lease owner and no lease expiry. The
   lease generation does not change. The next claim increments it, and until
   then the job is not leased, so the released proof can never act again. The
   next runner claims the job within one poll (the idle claim poll is 1 s) as
   a *fresh* claim with the same attempt number as before. The audit reason is
   `released on runner shutdown`.
4. **A requested cancel wins.** If the owner asked to cancel while the lease
   was held, the release cancels the job (`cancelRequested` cleared, audit
   `cancel requested; lease released on runner shutdown`) and restores the
   Google link as any cancel does. This matches the owner's cancel: once
   nobody holds a live lease, a cancel takes effect immediately. Parking the
   job in `pending` with a cancel request would create a state nothing else
   produces, and the job would be cancelled only on the next claim scan.
5. **Usage travels with the release.** Once shutdown starts, the runner does
   not flush its event queue. The release therefore carries the run's usage
   so far, merged like an events usage (it only grows). The next attempt
   starts from it (`priorUsage`), so budgets still apply to the whole run
   (AGT-008).
6. **Runners.** On a `shutdown` stop, both runners (Rust default, TypeScript
   rollback) release before logging `job_abandoned`. They log `job_released`
   (with the resulting state) or `release_failed` (with the code, or
   `TIMEOUT`). A release is sent once, with no retry or backoff. It is bounded
   to 2 s, well inside the launcher's 8 s grace, which the job's wind-down
   also uses. The runner never releases after `lease-lost`, because a lost
   lease is not its to give back. It also does not release when shutdown cut
   off a completion already in flight: that completion may have landed, and
   the grace is spent. A failed release leaves the lease to run out, as
   before.
7. **Google connect.** Releasing a `connect` job clears the stored sign-in
   link. That link points at the stopped runner's loopback port, and the next
   runner opens a new sign-in. A fresh claim is not treated as an abandoned
   sign-in. The claim-time failure of a lease-expired connect
   (`GOOGLE_AUTH_TIMEOUT`) still applies to runners that vanish without
   releasing.
8. **Proof.** `formal/ResearchFormal/Lease.lean` models `decideRelease` and
   the released job. It proves the following:
   - Only the holder with the current generation can release.
   - A release never raises the attempt count and refunds exactly one claim.
   - A claim followed by a release restores the attempt count, and a second
     claim is fresh with the same attempt number.
   - The requeued job is claimed fresh unless it is at the ceiling.
   - Every proof is refused after a release, and a release cannot be repeated.
   - Release then claim strictly raises the generation, so the released proof
     stays fenced.
   - Both outcomes are legal state-machine transitions.

   The vectors (`decideRelease`, 1,152 cases) are replayed by
   `tests/formal/conformance.test.ts` and
   `crates/research-domain/tests/lean_vectors.rs`. The state machine already
   allowed every leased state to move to `pending` and to `cancelled`, so the
   transition table did not change.

## Consequences

- An owner restart costs nothing: an interrupted job is picked up within about
  a second, and its attempt is not counted. Restarts alone can no longer
  produce `RETRY_CEILING_REACHED`.
- A job that keeps being interrupted by orderly restarts is retried
  indefinitely, never failed. The retry ceiling still applies to crashes, lost
  leases and runners that vanish without releasing, because those paths still
  go through lease expiry.
- The interrupted attempt's spend stays in the run's usage, so a metered
  run's cost and its spending cap include the work that was thrown away.
- The work the interrupted attempt did is redone. Progress is not
  checkpointed.
- A compromised runner credential can now return its owner's leased jobs to
  the queue at will. This delays those jobs but never completes, loses or
  re-attributes them. It is no worse than holding the lease with heartbeats,
  which it could already do.
- After shutdown, the runner sends exactly one request: the release, with a
  short bound. Every other request in flight is still cancelled at shutdown.
