/**
 * Retention of the server's sync jobs (ADR-0058 §3). With every directory
 * stock synced one company per job, a first pass is 11,400 `financial-sync`
 * jobs, and the market, price, index and news syncs add their own every
 * day: their rows, transitions and events are kept for
 * `SYNC_JOB_RETENTION_DAYS`, then deleted at claim time — at most once an
 * hour per owner, a bounded batch at a time. Research and notebook runs are
 * never pruned. The newest job of each kind, market, scope and state is
 * always kept (`SyncJobRetention`), so the schedule and the status lines
 * read what they read before.
 */
import type { JobKind } from "@research/contracts";
import type { SyncCheckGate } from "./dataSync.ts";
import type { AuditLog, Clock, SyncJobRetention } from "./ports.ts";

/** Terminal sync jobs older than this are deleted. */
export const SYNC_JOB_RETENTION_DAYS = 7;
/** Jobs one run deletes at most (three statements over at most this many runs). */
export const SYNC_JOB_RETENTION_BATCH = 500;
/** How often one owner's retention runs at most (`createSyncCheckGate(SYNC_JOB_RETENTION_PERIOD_MS)`). */
export const SYNC_JOB_RETENTION_PERIOD_MS = 60 * 60_000;

/** The kinds the server queues on its own; research and notebook runs are not among them. */
export const PRUNED_SYNC_JOB_KINDS = [
	"market-refresh",
	"earnings-refresh",
	"stock-directory-refresh",
	"news-ingest",
	"google-calendar",
	"financial-sync",
	"stock-prices-sync",
	"edinet-index",
] as const satisfies readonly JobKind[];

const DAY_MS = 24 * 60 * 60_000;

export interface JobRetentionServiceDeps {
	readonly retention: SyncJobRetention;
	readonly clock: Clock;
	readonly audit: AuditLog;
	/** At most one run per owner per `SYNC_JOB_RETENTION_PERIOD_MS`; lost with the isolate (one extra run). */
	readonly gate: SyncCheckGate;
	/** False switches retention off (`SERVER_DATA_SYNC=off`, API tests). */
	readonly enabled: boolean;
}

export function createJobRetentionService(deps: JobRetentionServiceDeps) {
	return {
		/** Deletes one batch of the owner's old terminal sync jobs when due; answers how many. */
		async pruneDue(ownerId: string): Promise<number> {
			if (!deps.enabled) return 0;
			const nowMs = deps.clock.nowMs();
			if (!deps.gate.take(ownerId, nowMs)) return 0;
			const before = new Date(nowMs - SYNC_JOB_RETENTION_DAYS * DAY_MS).toISOString();
			const deleted = await deps.retention.pruneTerminalJobs(
				ownerId,
				PRUNED_SYNC_JOB_KINDS,
				before,
				SYNC_JOB_RETENTION_BATCH,
			);
			if (deleted > 0) {
				await deps.audit.record({
					ownerId,
					actor: "scheduler",
					action: "run.prune_sync_jobs",
					resource: "research_jobs",
					detail: `count=${deleted} before=${before}`,
					at: deps.clock.nowIso(),
				});
			}
			return deleted;
		},
	};
}

export type JobRetentionService = ReturnType<typeof createJobRetentionService>;
