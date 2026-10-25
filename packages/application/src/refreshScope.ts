import type { RefreshScope } from "@research/contracts";
import type { AuditLog, Clock, JobRecord, JobRepository, RefreshScopeJobRequest } from "./ports.ts";

/**
 * Refresh scope of market and earnings refresh jobs (ADR-0039): one rule for
 * what a job stores, how a replay recognises its request, and when a
 * request for everything widens a queued partial job. Shared by the market
 * (`researchRuns.ts`) and earnings (`watchlist.ts`) use cases and read back
 * by the claim (`runnerJobs.ts`).
 */

export type ScopedRefreshKind = "market-refresh" | "earnings-refresh";

/** The stored request: null for everything, so rows written before the scope keep their meaning. */
export function refreshScopeRequest(scope: RefreshScope): RefreshScopeJobRequest | null {
	return scope === "all" ? null : { scope };
}

/** The scope a stored market or earnings refresh job covers. */
export function storedRefreshScope(job: Pick<JobRecord, "request">): RefreshScope {
	return job.request !== null && "scope" in job.request ? job.request.scope : "all";
}

/**
 * The idempotency fingerprint: the bare kind for everything (the value every
 * key used before the scope was stored with), the kind and scope otherwise,
 * so one key cannot stand for two different scopes.
 */
export function refreshFingerprint(kind: ScopedRefreshKind, scope: RefreshScope): string {
	return scope === "all" ? kind : `${kind}:${scope}`;
}

/**
 * Compare-and-set attempts for a widening that races a claim. A lost race
 * re-reads the active job: once claimed it is returned as it is.
 */
const WIDEN_ATTEMPTS = 3;

/**
 * The owner's active job of the kind, after widening it when the request
 * asks for everything and the active job is a queued `"unrefreshed"` one: no
 * runner has claimed it yet, so it can still cover everything instead of
 * queueing a second job (one active job per kind). A claimed job is
 * returned unchanged; its claim already chose what it fetches. Null when no
 * job of the kind is active.
 */
export async function activeRefreshJob(
	deps: { readonly jobs: JobRepository; readonly audit: AuditLog; readonly clock: Clock },
	ownerId: string,
	kind: ScopedRefreshKind,
	scope: RefreshScope,
): Promise<JobRecord | null> {
	for (let attempt = 0; attempt < WIDEN_ATTEMPTS; attempt += 1) {
		const active = await deps.jobs.findActiveByKind(ownerId, kind);
		if (
			active === null ||
			scope !== "all" ||
			active.state !== "pending" ||
			storedRefreshScope(active) === "all"
		) {
			return active;
		}
		const at = deps.clock.nowIso();
		const widened = await deps.jobs.write(ownerId, {
			runId: active.runId,
			expectedVersion: active.version,
			patch: { request: refreshScopeRequest("all") },
			audits: [],
			at,
		});
		if (widened) {
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action:
					kind === "market-refresh" ? "run.widen_market_refresh" : "run.widen_earnings_refresh",
				resource: active.runId,
				detail: "scope=unrefreshed->all",
				at,
			});
		}
		// Either way the next read sees the job as it is now: widened, claimed
		// by a runner in between, or already ended.
	}
	return deps.jobs.findActiveByKind(ownerId, kind);
}
