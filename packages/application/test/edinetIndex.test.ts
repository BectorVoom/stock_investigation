import { EDINET_INDEX_LIMITS } from "@research/contracts";
import { EMPTY_USAGE, SYNC_MIN_GAP_MS, SYNC_RETRY_MS } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createSyncCheckGate, scheduledJobRecord } from "../src/dataSync.ts";
import {
	createEdinetIndexService,
	type EdinetIndexServiceDeps,
	edinetIndexEffectsOf,
	edinetIndexWindow,
	planEdinetIndexDays,
} from "../src/edinetIndex.ts";
import { createOwnerMemo } from "../src/equitySync.ts";
import type { JobRecord, LatestJobOfKind } from "../src/ports.ts";

/** Monday 2026-11-02, 09:00 in Japan: yesterday there was Sunday 1 November. */
const AT = "2026-11-02T00:00:00.000Z";
const NOW = Date.parse(AT);

const INDEX_JOB = scheduledJobRecord({
	ownerId: "owner",
	kind: "edinet-index",
	request: null,
	runId: "run_active",
	at: AT,
});

function weekday(day: string): boolean {
	const weekdayNumber = new Date(`${day}T00:00:00Z`).getUTCDay();
	return weekdayNumber !== 0 && weekdayNumber !== 6;
}

describe("the EDINET index plan (ADR-0058 §4)", () => {
	it("covers backfillYears up to yesterday in Japan", () => {
		expect(edinetIndexWindow(NOW)).toEqual({ newest: "2026-11-01", oldest: "2020-11-01" });
		// 15:00 UTC is already the next day in Japan.
		expect(edinetIndexWindow(Date.parse("2026-11-02T15:00:00.000Z")).newest).toBe("2026-11-02");
	});

	it("lists weekdays newest first, never a listed day, at most maxDaysPerJob", () => {
		const first = planEdinetIndexDays([], NOW);
		expect(first).toHaveLength(EDINET_INDEX_LIMITS.maxDaysPerJob);
		expect(first[0]).toBe("2026-10-30");
		expect(first.every(weekday)).toBe(true);
		expect([...first].sort().reverse()).toEqual(first);
		const second = planEdinetIndexDays(first, NOW);
		expect(second.some((day) => first.includes(day))).toBe(false);
		expect(second[0]).toBeDefined();
		expect((second[0] ?? "") < (first.at(-1) ?? "")).toBe(true);
	});

	it("is empty once every weekday of the window is listed", () => {
		let listed: string[] = [];
		for (let jobs = 0; jobs < 100; jobs += 1) {
			const days = planEdinetIndexDays(listed, NOW);
			if (days.length === 0) break;
			listed = [...listed, ...days];
		}
		expect(planEdinetIndexDays(listed, NOW)).toEqual([]);
		// About 261 weekdays a year.
		expect(listed.length).toBeGreaterThan(6 * 255);
		expect(listed.length).toBeLessThan(6 * 265);
	});

	it("stores only days over in Japan, each report with the day that listed it", () => {
		const document = {
			docId: "S100ABCD",
			secCode: "79740",
			edinetCode: "E02367",
			filerName: "任天堂株式会社",
			docTypeCode: "120" as const,
			periodStart: "2025-04-01",
			periodEnd: "2026-03-31",
			submittedAt: "2026-06-26T15:30:00+09:00",
			parentDocId: null,
		};
		const effects = edinetIndexEffectsOf(
			{
				fetchedAt: AT,
				days: [
					{ date: "2026-10-30", documents: [document] },
					{ date: "2026-11-02", documents: [] },
				],
			},
			NOW,
		);
		expect(effects).toEqual({
			days: [{ listedOn: "2026-10-30", documentCount: 1 }],
			documents: [{ ...document, listedOn: "2026-10-30" }],
			checkedAt: AT,
			at: AT,
		});
	});
});

describe("the EDINET index schedule", () => {
	function setup(options: {
		readonly listed?: readonly string[];
		readonly active?: boolean;
		readonly last?: LatestJobOfKind | null;
		readonly jpStored?: boolean;
		readonly insert?: EdinetIndexServiceDeps["jobs"]["insert"];
		readonly enabled?: boolean;
	}) {
		const inserted: JobRecord[] = [];
		const audits: { action: string; detail: string }[] = [];
		const reads = { days: 0, jobs: 0 };
		let nowMs = NOW;
		const service = createEdinetIndexService({
			edinetIndex: {
				listedDays: async (_owner, fromDay) => {
					reads.days += 1;
					expect(fromDay).toBe(edinetIndexWindow(nowMs).oldest);
					return options.listed ?? [];
				},
			},
			jobs: {
				insert:
					options.insert ??
					(async (job) => {
						inserted.push(job);
						return { kind: "inserted" };
					}),
				findActiveByKind: async (_owner, kind) => {
					reads.jobs += 1;
					expect(kind).toBe("edinet-index");
					return options.active === true ? INDEX_JOB : null;
				},
				findLatestByKind: async () => options.last ?? null,
			},
			stockDirectory: {
				listMeta: async () =>
					options.jpStored === false
						? [{ market: "US", entryCount: 7_682, asOf: null, retrievedAt: AT, foldVersion: 1 }]
						: [{ market: "JP", entryCount: 3_700, asOf: null, retrievedAt: AT, foldVersion: 1 }],
			},
			clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
			ids: { newId: (prefix) => `${prefix}_1` },
			audit: {
				record: async (entry) => {
					audits.push({ action: entry.action, detail: entry.detail });
				},
			},
			enabled: options.enabled ?? true,
			gate: createSyncCheckGate(5_000),
			settled: createOwnerMemo(),
			log: () => undefined,
		});
		return {
			service,
			inserted,
			audits,
			reads,
			advance: (ms: number) => {
				nowMs += ms;
			},
		};
	}

	it("queues one job outside the owner's allowance once the JP list is stored", async () => {
		const run = setup({});
		expect(await run.service.materializeDue("owner")).toEqual({
			kind: "queued",
			runId: "run_1",
			days: EDINET_INDEX_LIMITS.maxDaysPerJob,
		});
		expect(run.inserted).toMatchObject([
			{ kind: "edinet-index", request: null, state: "pending", usage: EMPTY_USAGE },
		]);
		expect(run.audits).toEqual([
			{ action: "run.sync_edinet_index", detail: "days=40 newest=2026-10-30" },
		]);
	});

	it("waits for the JP list, an active job and the gap after the last job", async () => {
		expect(await setup({ jpStored: false }).service.materializeDue("owner")).toEqual({
			kind: "idle",
		});
		expect(await setup({ active: true }).service.materializeDue("owner")).toEqual({
			kind: "idle",
		});
		const justCompleted = {
			createdAt: new Date(NOW - SYNC_MIN_GAP_MS + 1).toISOString(),
			state: "completed" as const,
		};
		expect(await setup({ last: justCompleted }).service.materializeDue("owner")).toEqual({
			kind: "idle",
		});
		// A job that did not complete (a missing EDINET_API_KEY) waits SYNC_RETRY_MS.
		const failed = {
			createdAt: new Date(NOW - SYNC_MIN_GAP_MS).toISOString(),
			state: "failed" as const,
		};
		expect(await setup({ last: failed }).service.materializeDue("owner")).toEqual({ kind: "idle" });
		const failedLongAgo = {
			createdAt: new Date(NOW - SYNC_RETRY_MS).toISOString(),
			state: "failed" as const,
		};
		expect(await setup({ last: failedLongAgo }).service.materializeDue("owner")).toMatchObject({
			kind: "queued",
		});
	});

	it("reads the listed days once a day after the window is complete", async () => {
		let listed: string[] = [];
		for (;;) {
			const days = planEdinetIndexDays(listed, NOW);
			if (days.length === 0) break;
			listed = [...listed, ...days];
		}
		const run = setup({ listed });
		expect(await run.service.materializeDue("owner")).toEqual({ kind: "idle" });
		run.advance(5_000);
		expect(await run.service.materializeDue("owner")).toEqual({ kind: "idle" });
		expect(run.reads).toEqual({ days: 1, jobs: 1 });
		// The next day in Japan has a new day to list.
		run.advance(24 * 60 * 60_000);
		expect(await run.service.materializeDue("owner")).toMatchObject({ kind: "queued", days: 1 });
	});

	it("plans the claim's days when it is claimed, and cancels a job with none left", async () => {
		const job = INDEX_JOB;
		const fresh = await setup({}).service.prepareClaim("owner", job);
		expect(fresh.ok && fresh.value.days[0]).toBe("2026-10-30");
		let listed: string[] = [];
		for (;;) {
			const days = planEdinetIndexDays(listed, NOW);
			if (days.length === 0) break;
			listed = [...listed, ...days];
		}
		const done = await setup({ listed }).service.prepareClaim("owner", job);
		expect(done).toEqual({ ok: false, error: { reason: "edinet index has no day to list" } });
	});

	it("does nothing while switched off", async () => {
		const run = setup({ enabled: false });
		expect(await run.service.materializeDue("owner")).toEqual({ kind: "idle" });
		expect(run.reads).toEqual({ days: 0, jobs: 0 });
	});
});
