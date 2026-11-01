import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	decideSync,
	EARNINGS_SYNC_INTERVAL_MS,
	MARKET_SYNC_INTERVAL_MS,
	marketSyncIntervalMs,
	SYNC_MIN_GAP_MS,
	SYNC_RETRY_MS,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between the server-side sync schedule
 * (`packages/domain/src/market/syncSchedule.ts`, ADR-0051) and its Lean 4
 * model, `formal/ResearchFormal/SyncSchedule.lean`.
 *
 * `formal/Export.lean` evaluates the verified `decideSync` over two cadences
 * (retry equal to the interval, as for market data; retry shorter, as for
 * earnings dates) × active / empty / new / failed items × refresh stamps
 * around each threshold × last jobs and last full jobs, completed or not,
 * at, just before and after each waiting time; and `marketInterval` over
 * series counts around the point where the Twelve Data budget starts to
 * stretch the 30-minute interval. Every vector is replayed here.
 */

const job = z.object({ createdAtMs: z.number().int(), completed: z.boolean() }).nullable();
const decisionVector = z.object({
	cadence: z.object({
		intervalMs: z.number().int(),
		retryMs: z.number().int(),
		minGapMs: z.number().int(),
	}),
	nowMs: z.number().int(),
	activeJob: z.boolean(),
	items: z.number().int(),
	neverRefreshed: z.number().int(),
	retryable: z.number().int(),
	oldestRefreshMs: z.number().int().nullable(),
	lastJob: job,
	lastFullJob: job,
	decision: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("idle") }),
		z.object({
			kind: z.literal("queue"),
			scope: z.enum(["all", "unrefreshed"]),
			reason: z.enum(["stale", "new-items", "retry"]),
		}),
	]),
});
const vectorFile = z.object({
	syncDecision: z.array(decisionVector).min(1),
	syncInterval: z
		.array(z.object({ twelveDataSeries: z.number().int(), intervalMs: z.number().int() }))
		.min(1),
});

const vectors = vectorFile.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

describe("decideSync matches the Lean model", () => {
	it("on every exported state", () => {
		for (const vector of vectors.syncDecision) {
			const { cadence, nowMs, decision, ...state } = vector;
			expect(decideSync(state, cadence, nowMs), JSON.stringify(vector)).toEqual(decision);
		}
	});

	it("uses cadences the model's theorems cover (minGap ≤ retry, minGap ≤ interval)", () => {
		for (const intervalMs of [MARKET_SYNC_INTERVAL_MS, EARNINGS_SYNC_INTERVAL_MS]) {
			expect(SYNC_MIN_GAP_MS).toBeLessThanOrEqual(SYNC_RETRY_MS);
			expect(SYNC_MIN_GAP_MS).toBeLessThanOrEqual(intervalMs);
		}
	});
});

describe("marketSyncIntervalMs matches the Lean model", () => {
	it("on every exported series count", () => {
		for (const { twelveDataSeries, intervalMs } of vectors.syncInterval) {
			expect(marketSyncIntervalMs(twelveDataSeries)).toBe(intervalMs);
		}
	});
});
