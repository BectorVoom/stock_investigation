import { err, ok, type Result } from "../result.ts";
import { isoToEpochMs } from "../time.ts";
import { isLeasedJobState, type JobState } from "./stateMachine.ts";

/**
 * Lease fencing (AGT-011). `leaseGeneration` increases on every claim, so a
 * runner whose lease was superseded is rejected even if its clock disagrees.
 */
export interface JobLeaseView {
	readonly state: JobState;
	readonly leaseGeneration: number;
	readonly leaseOwnerId: string | null;
	readonly leaseExpiresAt: string | null;
	/** Number of claims already granted for this job. */
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly cancelRequested: boolean;
}

export type ClaimDecision =
	| {
			readonly kind: "claim";
			readonly reason: "fresh" | "lease-expired";
			readonly nextAttempt: number;
			readonly nextLeaseGeneration: number;
	  }
	/** The retry ceiling is reached; the job must be failed rather than re-run. */
	| { readonly kind: "exhausted" }
	| { readonly kind: "not-eligible" };

function isLeaseExpired(job: JobLeaseView, nowMs: number): boolean {
	if (job.leaseExpiresAt === null) return true;
	const expiresMs = isoToEpochMs(job.leaseExpiresAt);
	// An unreadable expiry is treated as expired so a corrupt row cannot pin a job forever.
	return expiresMs === null || expiresMs <= nowMs;
}

export function decideClaim(job: JobLeaseView, nowMs: number): ClaimDecision {
	if (job.cancelRequested) return { kind: "not-eligible" };
	const fresh = job.state === "pending";
	const recoverable = isLeasedJobState(job.state) && isLeaseExpired(job, nowMs);
	if (!fresh && !recoverable) return { kind: "not-eligible" };
	if (job.attempt >= job.maxAttempts) return { kind: "exhausted" };
	return {
		kind: "claim",
		reason: fresh ? "fresh" : "lease-expired",
		nextAttempt: job.attempt + 1,
		nextLeaseGeneration: job.leaseGeneration + 1,
	};
}

export type LeaseError = "NOT_LEASED" | "STALE_LEASE" | "WRONG_RUNNER";

export interface LeaseProof {
	readonly runnerId: string;
	readonly leaseGeneration: number;
}

/**
 * Whether `proof` still owns the job. Expiry alone does not revoke ownership:
 * until another claim bumps the generation there is no competing writer, so a
 * late heartbeat or completion from the original runner is still safe to accept.
 */
export function checkLease(job: JobLeaseView, proof: LeaseProof): Result<void, LeaseError> {
	if (!isLeasedJobState(job.state) || job.leaseOwnerId === null) return err("NOT_LEASED");
	if (proof.leaseGeneration !== job.leaseGeneration) return err("STALE_LEASE");
	if (proof.runnerId !== job.leaseOwnerId) return err("WRONG_RUNNER");
	return ok(undefined);
}

/**
 * What a lease hand-back does (ADR-0036). A runner that is shutting down gives
 * its lease back instead of letting it run out:
 *
 * - `requeue`: the job returns to `pending` with the claim refunded
 *   (`nextAttempt = attempt - 1`, never below 0), no owner and no expiry. The
 *   generation is kept: the next claim increments it, and until then the job is
 *   not leased, so the released proof can never act again.
 * - `cancel`: the owner asked to cancel while the lease was held. Nobody holds
 *   a lease once it is handed back, and an owner cancel of a job without a live
 *   lease is immediate, so the job is cancelled now rather than parked in
 *   `pending` with a cancel request nobody would act on.
 */
export type ReleaseDecision =
	| { readonly kind: "requeue"; readonly nextAttempt: number }
	| { readonly kind: "cancel" };

/** Only the current lease holder, with the current generation, may hand the lease back. */
export function decideRelease(
	job: JobLeaseView,
	proof: LeaseProof,
): Result<ReleaseDecision, LeaseError> {
	const lease = checkLease(job, proof);
	if (!lease.ok) return lease;
	if (job.cancelRequested) return ok({ kind: "cancel" });
	return ok({ kind: "requeue", nextAttempt: Math.max(job.attempt - 1, 0) });
}

/**
 * The job's lease columns after a granted hand-back. Nobody owns it and it has
 * no expiry; the generation is unchanged (the next claim moves it).
 */
export function releasedLeaseView(job: JobLeaseView, decision: ReleaseDecision): JobLeaseView {
	const released = { ...job, leaseOwnerId: null, leaseExpiresAt: null };
	return decision.kind === "cancel"
		? { ...released, state: "cancelled", cancelRequested: false }
		: { ...released, state: "pending", attempt: decision.nextAttempt };
}

export function leaseExpiryIso(nowMs: number, leaseDurationMs: number): string {
	return new Date(nowMs + leaseDurationMs).toISOString();
}
