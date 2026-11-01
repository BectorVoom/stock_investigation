import { MARKET_LIMITS } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	chunkObservationPoints,
	MARKET_OBSERVATION_CHUNK_POINTS,
	type MarketObservationPoint,
} from "../../src/sql/unitOfWork.ts";

/** One megabyte; every upsert chunk must stay under this (S5). */
const ONE_MB = 1_000_000;

/** The longest JSON a finite number has (25 characters); the volume cannot be negative (24). */
const LONGEST = -0.0000012345678901234567;
const LONGEST_VOLUME = 0.0000012345678901234567;

function maximalPoints(): MarketObservationPoint[] {
	// Worst case: every tracked series x 800 observations with the longest
	// legal ids and a bar of the longest numbers on every point (ADR-0056).
	const points: MarketObservationPoint[] = [];
	for (let series = 0; series < MARKET_LIMITS.maxTrackedSeries; series += 1) {
		const seriesId = `fred:${"A".repeat(56)}${String(series).padStart(3, "0")}`;
		for (let day = 0; day < MARKET_LIMITS.maxObservationsPerResponse; day += 1) {
			points.push([
				seriesId,
				`2024-${String((day % 12) + 1).padStart(2, "0")}-${String((day % 28) + 1).padStart(2, "0")}`,
				LONGEST,
				LONGEST,
				LONGEST,
				LONGEST,
				LONGEST_VOLUME,
			]);
		}
	}
	return points;
}

describe("market completion observation chunking (S5)", () => {
	it("packs a maximal completion into chunks whose JSON stays under 1 MB", () => {
		const points = maximalPoints();
		expect(points[0]?.[0]).toHaveLength(64);
		expect(JSON.stringify(LONGEST)).toHaveLength(25);
		expect(points).toHaveLength(88_000);
		const chunks = chunkObservationPoints(points);
		expect(chunks).toHaveLength(22);
		let total = 0;
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(MARKET_OBSERVATION_CHUNK_POINTS);
			const json = JSON.stringify(chunk);
			expect(json.length).toBeLessThan(ONE_MB);
			total += chunk.length;
		}
		expect(total).toBe(points.length);
		// Order is preserved, so statement order in the batch is deterministic.
		expect(chunks[0]?.[0]).toEqual(points[0]);
		expect(chunks.at(-1)?.at(-1)).toEqual(points.at(-1));
	});

	it("emits no chunk for an empty completion and one chunk below the boundary", () => {
		expect(chunkObservationPoints([])).toEqual([]);
		const few: MarketObservationPoint[] = [
			["fred:VIXCLS", "2026-10-01", 15.2, null, null, null, null],
		];
		expect(chunkObservationPoints(few)).toEqual([few]);
	});
});
