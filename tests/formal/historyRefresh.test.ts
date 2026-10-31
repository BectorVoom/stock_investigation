import {
	anchorConfirmed,
	firstHistoryFetch,
	type HistoryFetch,
	type HistoryOutcome,
	type HistoryPoint,
	type HistoryRefreshRequest,
	type HistoryWrite,
	historyOutcome,
	historyRefreshRequest,
	mergeHistory,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import vectors from "../../formal/vectors.json";

/**
 * Conformance between the incremental history refresh
 * (`packages/domain/src/market/historyRefresh.ts`, ADR-0044) and the Lean 4
 * model in `formal/ResearchFormal/HistoryRefresh.lean`.
 *
 * `formal/Export.lean` evaluates the verified definitions over exhaustive
 * small grids — 24 claims around the 7-day full-check edge, 14 first fetches,
 * 270 anchor searches, 1,512 outcomes (every claim × fetch × ascending
 * date-unique answer over three dates and two values) and 5,120 merges (every
 * stored × fetched list over four dates × ten writes × two limits) — and every
 * vector is replayed here against the implementation. The model's dates are
 * day numbers; they become ISO dates here (an order-preserving map, as the
 * code compares dates as text).
 */
const day = z.number().int().nonnegative();
const point = z.tuple([day, z.number().int()]);
const request = z.object({ anchor: point.nullable(), fullCheck: z.boolean() });
const fetch = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("window"), from: day }),
	z.object({ kind: z.literal("full") }),
]);
const write = z
	.discriminatedUnion("mode", [
		z.object({ mode: z.literal("window"), replaceFrom: day }),
		z.object({ mode: z.literal("full"), replaceFrom: day.nullable() }),
	])
	.nullable();
const outcome = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("store"), write }),
	z.object({ kind: z.literal("refetch-full") }),
]);

const historyVectors = z.object({
	historyRequest: z.array(
		z.object({
			anchor: point.nullable(),
			now: z.number().int(),
			checkedAt: z.number().int().nullable(),
			request,
		}),
	),
	historyFirstFetch: z.array(z.object({ request, fetch })),
	historyConfirmed: z.array(
		z.object({ anchor: point, points: z.array(point), confirmed: z.boolean() }),
	),
	historyOutcome: z.array(z.object({ request, fetch, points: z.array(point), outcome })),
	historyMerge: z.array(
		z.object({
			stored: z.array(point),
			fetched: z.array(point),
			write,
			max: z.number().int().nonnegative(),
			merged: z.array(point),
		}),
	),
});

const parsed = historyVectors.parse(vectors);

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);

function isoOf(dayNumber: number): string {
	return new Date(EPOCH + dayNumber * DAY_MS).toISOString().slice(0, 10);
}

function toPoint([dayNumber, value]: z.infer<typeof point>): HistoryPoint {
	return { observedOn: isoOf(dayNumber), value };
}

function toRequest(row: z.infer<typeof request>): HistoryRefreshRequest {
	return { anchor: row.anchor === null ? null : toPoint(row.anchor), fullCheck: row.fullCheck };
}

function toFetch(row: z.infer<typeof fetch>): HistoryFetch {
	return row.kind === "window" ? { kind: "window", from: isoOf(row.from) } : { kind: "full" };
}

function toWrite(row: z.infer<typeof write>): HistoryWrite | null {
	if (row === null) return null;
	if (row.mode === "window") return { mode: "window", replaceFrom: isoOf(row.replaceFrom) };
	return { mode: "full", replaceFrom: row.replaceFrom === null ? null : isoOf(row.replaceFrom) };
}

function toOutcome(row: z.infer<typeof outcome>): HistoryOutcome {
	return row.kind === "store" ? { kind: "store", write: toWrite(row.write) } : row;
}

describe("incremental history refresh conforms to the Lean model (ADR-0044)", () => {
	it("decides the claim's full check like the model", () => {
		expect(parsed.historyRequest).toHaveLength(24);
		for (const row of parsed.historyRequest) {
			const anchor = row.anchor === null ? null : toPoint(row.anchor);
			expect(historyRefreshRequest(anchor, row.checkedAt, row.now), JSON.stringify(row)).toEqual(
				toRequest(row.request),
			);
		}
	});

	it("chooses the first fetch like the model", () => {
		expect(parsed.historyFirstFetch).toHaveLength(14);
		for (const row of parsed.historyFirstFetch) {
			expect(firstHistoryFetch(toRequest(row.request)), JSON.stringify(row)).toEqual(
				toFetch(row.fetch),
			);
		}
	});

	it("finds the anchor by binary search exactly where the model finds it", () => {
		expect(parsed.historyConfirmed).toHaveLength(270);
		for (const row of parsed.historyConfirmed) {
			expect(
				anchorConfirmed(toPoint(row.anchor), row.points.map(toPoint)),
				JSON.stringify(row),
			).toBe(row.confirmed);
		}
	});

	it("decides every outcome like the model", () => {
		expect(parsed.historyOutcome).toHaveLength(1512);
		for (const row of parsed.historyOutcome) {
			expect(
				historyOutcome(toRequest(row.request), toFetch(row.fetch), row.points.map(toPoint)),
				JSON.stringify(row),
			).toEqual(toOutcome(row.outcome));
		}
	});

	it("merges every stored and fetched history like the model", () => {
		expect(parsed.historyMerge).toHaveLength(5120);
		for (const row of parsed.historyMerge) {
			expect(
				mergeHistory(
					row.stored.map(toPoint),
					row.fetched.map(toPoint),
					toWrite(row.write),
					row.max,
				),
				JSON.stringify(row),
			).toEqual(row.merged.map(toPoint));
		}
	});
});
