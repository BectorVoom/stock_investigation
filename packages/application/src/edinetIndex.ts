/**
 * The shared EDINET index of annual securities reports (ADR-0058 §4): the
 * claim-time schedule of the `edinet-index` job, its claim (the days to
 * list) and the writes of its `edinet-indexed` completion.
 *
 * EDINET has no per-company search: its documents API lists every document
 * of one date. One `edinet-index` job per owner lists each day once for
 * every company — weekdays, newest first, back `backfillYears`
 * (`planSyncDays`, the day planner shared with `stock-prices-sync`); a day
 * is final once it is over in Japan, so a listed day is never asked again.
 * The completion stores each day's annual reports and makes due every
 * tracked Japanese company whose securities code got a report it has not
 * stored; that company's `financial-sync` then downloads only those reports
 * (`edinetIndexedPlan` in `equitySync.ts`).
 *
 * Without `EDINET_API_KEY` the job fails once and is retried after
 * `SYNC_RETRY_MS`: no company job is queued, so a missing key costs one job.
 */
import type { CompleteJobRequest } from "@research/contracts";
import { EDINET_INDEX_LIMITS, EQUITY_FINANCIAL_LIMITS } from "@research/contracts";
import {
	err,
	isoDateOfDayNumber,
	isoDayNumber,
	ok,
	planSyncDays,
	type Result,
	SYNC_MIN_GAP_MS,
	SYNC_RETRY_MS,
	shiftIsoDateYears,
} from "@research/domain";
import { type SyncCheckGate, scheduledJobRecord } from "./dataSync.ts";
import { jstDateOf, type OwnerMemo } from "./equitySync.ts";
import type { EdinetIndexEffects, EdinetIndexRepository } from "./equitySyncPorts.ts";
import type { UseCaseResult } from "./errors.ts";
import type {
	AuditLog,
	Clock,
	IdGenerator,
	JobRecord,
	JobRepository,
	StockDirectoryRepository,
} from "./ports.ts";
import { JOB_ADMISSION } from "./researchRuns.ts";

/** After a job the cap on unfinished runs refused: look again this much later. */
const REFUSED_RETRY_MS = 60_000;

/** The days the index covers: from `backfillYears` before yesterday in Japan to yesterday. */
export function edinetIndexWindow(nowMs: number): {
	readonly newest: string;
	readonly oldest: string;
} {
	const today = isoDayNumber(jstDateOf(nowMs)) ?? 0;
	const newest = isoDateOfDayNumber(today - 1);
	const oldest = shiftIsoDateYears(newest, -EQUITY_FINANCIAL_LIMITS.backfillYears) ?? newest;
	return { newest, oldest };
}

/**
 * The days an `edinet-index` job lists (ADR-0058 §4): the window's
 * weekdays not listed yet, newest first, at most `maxDaysPerJob`. Every
 * listed day is final (only days over in Japan are stored).
 */
export function planEdinetIndexDays(listedDays: readonly string[], nowMs: number): string[] {
	const window = edinetIndexWindow(nowMs);
	return planSyncDays({
		newest: window.newest,
		oldest: window.oldest,
		known: listedDays.map((day) => ({ day, final: true, retryAtMs: 0 })),
		nowMs,
		max: EDINET_INDEX_LIMITS.maxDaysPerJob,
	});
}

type EdinetIndexedRequest = Extract<CompleteJobRequest, { outcome: "edinet-indexed" }>;

/**
 * The writes of an `edinet-indexed` completion: the days it listed in full
 * and their reports. A day of today or later in Japan is left out (its list
 * may still grow; the plan never asks for one).
 */
export function edinetIndexEffectsOf(
	request: Pick<EdinetIndexedRequest, "days" | "fetchedAt">,
	nowMs: number,
): EdinetIndexEffects {
	const today = jstDateOf(nowMs);
	const days = request.days.filter((day) => day.date < today);
	return {
		days: days.map((day) => ({ listedOn: day.date, documentCount: day.documents.length })),
		documents: days.flatMap((day) =>
			day.documents.map((document) => ({ ...document, listedOn: day.date })),
		),
		checkedAt: request.fetchedAt,
		at: new Date(nowMs).toISOString(),
	};
}

export interface EdinetIndexServiceDeps {
	readonly edinetIndex: EdinetIndexRepository;
	readonly jobs: Pick<JobRepository, "insert" | "findActiveByKind" | "findLatestByKind">;
	/** The index is built only once the Japanese stock list is stored. */
	readonly stockDirectory: Pick<StockDirectoryRepository, "listMeta">;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly audit: AuditLog;
	/** False switches the schedule off (`SERVER_DATA_SYNC=off`, API tests). */
	readonly enabled: boolean;
	/** How often one owner's schedule is read at most (claims in between skip it). */
	readonly gate: SyncCheckGate;
	/**
	 * The window's newest day for which the owner's plan was empty: until
	 * the date in Japan moves on nothing can be due, so the listed days are
	 * not read again. Losing it costs one read.
	 */
	readonly settled: OwnerMemo;
	readonly log: (event: string, fields: Readonly<Record<string, string | number>>) => void;
}

export type EdinetIndexOutcome =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly runId: string; readonly days: number }
	| { readonly kind: "refused"; readonly reason: string };

/** Why a queued `edinet-index` job is cancelled at claim time instead of leased. */
export interface EdinetIndexClaimRefusal {
	readonly reason: string;
}

export function createEdinetIndexService(deps: EdinetIndexServiceDeps) {
	async function plannedDays(ownerId: string, nowMs: number): Promise<string[]> {
		const window = edinetIndexWindow(nowMs);
		return planEdinetIndexDays(await deps.edinetIndex.listedDays(ownerId, window.oldest), nowMs);
	}

	return {
		/**
		 * Queues the owner's `edinet-index` job when the Japanese stock list
		 * is stored, no such job is pending or leased, the last one was
		 * created at least `SYNC_MIN_GAP_MS` ago (`SYNC_RETRY_MS` after one
		 * that did not complete) and a day of the window is not listed yet.
		 * Outside the owner's `job-create` allowance, inside the cap on
		 * unfinished runs.
		 */
		async materializeDue(ownerId: string): Promise<EdinetIndexOutcome> {
			if (!deps.enabled) return { kind: "idle" };
			const nowMs = deps.clock.nowMs();
			if (!deps.gate.take(ownerId, nowMs)) return { kind: "idle" };
			const window = edinetIndexWindow(nowMs);
			if (deps.settled.get(ownerId) === window.newest) return { kind: "idle" };
			const [active, last] = await Promise.all([
				deps.jobs.findActiveByKind(ownerId, "edinet-index"),
				deps.jobs.findLatestByKind(ownerId, "edinet-index", { fullOnly: false }),
			]);
			if (active !== null) return { kind: "idle" };
			if (last !== null) {
				const gapMs = last.state === "completed" ? SYNC_MIN_GAP_MS : SYNC_RETRY_MS;
				const createdMs = Date.parse(last.createdAt);
				if (Number.isFinite(createdMs) && nowMs - createdMs < gapMs) return { kind: "idle" };
			}
			const metas = await deps.stockDirectory.listMeta(ownerId);
			if (!metas.some((meta) => meta.market === "JP" && meta.entryCount > 0)) {
				return { kind: "idle" };
			}
			const days = await plannedDays(ownerId, nowMs);
			if (days.length === 0) {
				deps.settled.set(ownerId, window.newest);
				return { kind: "idle" };
			}
			const job = scheduledJobRecord({
				ownerId,
				kind: "edinet-index",
				request: null,
				runId: deps.ids.newId("run"),
				at: deps.clock.nowIso(),
			});
			const outcome = await deps.jobs.insert(
				job,
				`sync_${job.runId}`.slice(0, 64),
				"edinet-index",
				JOB_ADMISSION.maxUnfinishedJobs,
			);
			if (outcome.kind !== "inserted") {
				deps.log("edinet_index_skipped", { reason: outcome.kind });
				if (outcome.kind === "at-capacity") deps.gate.defer(ownerId, nowMs + REFUSED_RETRY_MS);
				return { kind: "refused", reason: outcome.kind };
			}
			await deps.audit.record({
				ownerId,
				actor: "scheduler",
				action: "run.sync_edinet_index",
				resource: job.runId,
				detail: `days=${days.length} newest=${days[0] ?? ""}`,
				at: job.createdAt,
			});
			return { kind: "queued", runId: job.runId, days: days.length };
		},

		/**
		 * The days of a claimed `edinet-index` job, planned when it is claimed
		 * (a job that waited lists the days due now); a job with no day left
		 * (another job listed them) is cancelled instead of leased.
		 */
		async prepareClaim(
			ownerId: string,
			_job: JobRecord,
		): Promise<Result<{ readonly days: readonly string[] }, EdinetIndexClaimRefusal>> {
			const days = await plannedDays(ownerId, deps.clock.nowMs());
			if (days.length === 0) return err({ reason: "edinet index has no day to list" });
			return ok({ days });
		},

		/** The writes of an `edinet-indexed` completion (`edinetIndexEffectsOf`). */
		completionEffects(request: EdinetIndexedRequest): UseCaseResult<EdinetIndexEffects> {
			return ok(edinetIndexEffectsOf(request, deps.clock.nowMs()));
		},
	};
}

export type EdinetIndexService = ReturnType<typeof createEdinetIndexService>;
