import { describe, expect, it } from "vitest";
import {
	chunkObservationPoints,
	MARKET_OBSERVATION_CHUNK_POINTS,
	type MarketObservationPoint,
} from "../../src/sql/unitOfWork.ts";

/** One megabyte; every upsert chunk must stay well under this (S5). */
const ONE_MB = 1_000_000;

function maximalPoints(): MarketObservationPoint[] {
	// Worst case: 30 series x 800 observations with the longest legal ids.
	const points: MarketObservationPoint[] = [];
	for (let series = 0; series < 30; series += 1) {
		const seriesId = `fred:${"A".repeat(59)}${String(series).padStart(2, "0")}`.slice(0, 64);
		for (let day = 0; day < 800; day += 1) {
			points.push({
				seriesId,
				observedOn: `2024-${String((day % 12) + 1).padStart(2, "0")}-${String((day % 28) + 1).padStart(2, "0")}`,
				value: -12345.67890123,
			});
		}
	}
	return points;
}

describe("market completion observation chunking (S5)", () => {
	it("packs a maximal completion into chunks whose JSON stays well under 1 MB", () => {
		const points = maximalPoints();
		expect(points).toHaveLength(24_000);
		const chunks = chunkObservationPoints(points);
		expect(chunks).toHaveLength(6);
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
		expect(chunks[5]?.at(-1)).toEqual(points.at(-1));
	});

	it("emits no chunk for an empty completion and one chunk below the boundary", () => {
		expect(chunkObservationPoints([])).toEqual([]);
		const few: MarketObservationPoint[] = [
			{ seriesId: "fred:VIXCLS", observedOn: "2026-10-01", value: 15.2 },
		];
		expect(chunkObservationPoints(few)).toEqual([few]);
	});
});
