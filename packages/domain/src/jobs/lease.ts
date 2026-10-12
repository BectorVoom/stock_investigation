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

export function leaseExpiryIso(nowMs: number, leaseDurationMs: number): string {
	return new Date(nowMs + leaseDurationMs).toISOString();
}
