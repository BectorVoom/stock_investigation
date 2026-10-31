import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	anchorConfirmed,
	firstHistoryFetch,
	HISTORY_FULL_CHECK_DAYS,
	type HistoryFetch,
	type HistoryPoint,
	type HistoryRefreshRequest,
	type HistoryWrite,
	historyOutcome,
	historyRefreshRequest,
	mergeHistory,
} from "../../src/market/historyRefresh.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 31, 12);

function points(...entries: readonly [string, number][]): HistoryPoint[] {
	return entries.map(([observedOn, value]) => ({ observedOn, value }));
}

describe("historyRefreshRequest (API side)", () => {
	const anchor = { observedOn: "2026-09-01", value: 10 };

	it("asks for everything without a full check when nothing is stored", () => {
		expect(historyRefreshRequest(null, null, NOW)).toEqual({ anchor: null, fullCheck: false });
		expect(historyRefreshRequest(null, NOW - 30 * DAY_MS, NOW)).toEqual({
			anchor: null,
			fullCheck: false,
		});
	});

	it("is due a full check when the series was never fetched in full", () => {
		expect(historyRefreshRequest(anchor, null, NOW)).toEqual({ anchor, fullCheck: true });
		expect(historyRefreshRequest(anchor, Number.NaN, NOW).fullCheck).toBe(true);
	});

	it("is due exactly HISTORY_FULL_CHECK_DAYS after the last full fetch, not a millisecond earlier", () => {
		const period = HISTORY_FULL_CHECK_DAYS * DAY_MS;
		expect(historyRefreshRequest(anchor, NOW - period, NOW).fullCheck).toBe(true);
		expect(historyRefreshRequest(anchor, NOW - period + 1, NOW).fullCheck).toBe(false);
		expect(historyRefreshRequest(anchor, NOW, NOW).fullCheck).toBe(false);
	});

	it("is not due for a stamp in the future (a clock step back)", () => {
		expect(historyRefreshRequest(anchor, NOW + DAY_MS, NOW).fullCheck).toBe(false);
	});
});

describe("firstHistoryFetch (runner side)", () => {
	const anchor = { observedOn: "2026-09-01", value: 10 };

	it("fetches from the anchor's date, or everything without an anchor or on a full check", () => {
		expect(firstHistoryFetch({ anchor, fullCheck: false })).toEqual({
			kind: "window",
			from: "2026-09-01",
		});
		expect(firstHistoryFetch({ anchor, fullCheck: true })).toEqual({ kind: "full" });
		expect(firstHistoryFetch({ anchor: null, fullCheck: false })).toEqual({ kind: "full" });
	});
});

describe("anchorConfirmed", () => {
	const answer = points(["2026-08-01", 1], ["2026-09-01", 10], ["2026-10-01", 3]);

	it("holds only for the anchor's date with exactly its value", () => {
		expect(anchorConfirmed({ observedOn: "2026-09-01", value: 10 }, answer)).toBe(true);
		expect(anchorConfirmed({ observedOn: "2026-09-01", value: 10.000001 }, answer)).toBe(false);
		expect(anchorConfirmed({ observedOn: "2026-09-02", value: 10 }, answer)).toBe(false);
		expect(anchorConfirmed({ observedOn: "2026-08-01", value: 1 }, answer)).toBe(true);
		expect(anchorConfirmed({ observedOn: "2026-10-01", value: 3 }, answer)).toBe(true);
		expect(anchorConfirmed({ observedOn: "2026-07-01", value: 1 }, answer)).toBe(false);
		expect(anchorConfirmed({ observedOn: "2026-11-01", value: 3 }, answer)).toBe(false);
		expect(anchorConfirmed({ observedOn: "2026-09-01", value: 10 }, [])).toBe(false);
	});

	it("treats 0 and -0 as the same stored number", () => {
		expect(
			anchorConfirmed({ observedOn: "2026-08-01", value: -0 }, points(["2026-08-01", 0])),
		).toBe(true);
	});
});

describe("historyOutcome", () => {
	const anchor = { observedOn: "2026-09-01", value: 10 };
	const window: HistoryFetch = { kind: "window", from: "2026-09-01" };
	const full: HistoryFetch = { kind: "full" };
	const windowRequest: HistoryRefreshRequest = { anchor, fullCheck: false };
	const checkRequest: HistoryRefreshRequest = { anchor, fullCheck: true };

	it("stores a window that reproduces the anchor, replacing from the anchor's date", () => {
		expect(
			historyOutcome(windowRequest, window, points(["2026-09-01", 10], ["2026-09-02", 11])),
		).toEqual({ kind: "store", write: { mode: "window", replaceFrom: "2026-09-01" } });
	});

	it("asks for the full history when the window changed, lacks or empties the anchor", () => {
		for (const answer of [
			points(["2026-09-01", 9], ["2026-09-02", 11]),
			points(["2026-09-02", 11]),
			[],
		]) {
			expect(historyOutcome(windowRequest, window, answer)).toEqual({ kind: "refetch-full" });
		}
	});

	it("replaces everything after a full fetch with nothing stored", () => {
		expect(
			historyOutcome({ anchor: null, fullCheck: false }, full, points(["2026-09-02", 11])),
		).toEqual({ kind: "store", write: { mode: "full", replaceFrom: null } });
	});

	it("replaces from the oldest fetched date after a full fetch that reproduces the anchor", () => {
		expect(
			historyOutcome(checkRequest, full, points(["2026-07-01", 7], ["2026-09-01", 10])),
		).toEqual({ kind: "store", write: { mode: "full", replaceFrom: "2026-07-01" } });
	});

	it("replaces everything after a full fetch that changed or lacks the anchor", () => {
		expect(
			historyOutcome(checkRequest, full, points(["2026-07-01", 7], ["2026-09-01", 9])),
		).toEqual({ kind: "store", write: { mode: "full", replaceFrom: null } });
		expect(historyOutcome(windowRequest, full, points(["2026-09-02", 11]))).toEqual({
			kind: "store",
			write: { mode: "full", replaceFrom: null },
		});
	});

	it("never replaces anything after an empty full answer", () => {
		expect(historyOutcome(checkRequest, full, [])).toEqual({ kind: "store", write: null });
		expect(historyOutcome({ anchor: null, fullCheck: false }, full, [])).toEqual({
			kind: "store",
			write: null,
		});
	});
});

describe("mergeHistory", () => {
	const stored = points(["2026-01-01", 1], ["2026-02-01", 2], ["2026-03-01", 3], ["2026-04-01", 4]);

	it("merges without dropping a stored row when the write is null", () => {
		expect(mergeHistory(stored, points(["2026-03-01", 30], ["2026-05-01", 5]), null, 10)).toEqual(
			points(
				["2026-01-01", 1],
				["2026-02-01", 2],
				["2026-03-01", 30],
				["2026-04-01", 4],
				["2026-05-01", 5],
			),
		);
	});

	it("drops a stored row on or after replaceFrom that the answer withdrew, and keeps older ones", () => {
		const write: HistoryWrite = { mode: "window", replaceFrom: "2026-02-01" };
		expect(mergeHistory(stored, points(["2026-02-01", 2], ["2026-04-01", 40]), write, 10)).toEqual(
			points(["2026-01-01", 1], ["2026-02-01", 2], ["2026-04-01", 40]),
		);
	});

	it("replaces every stored row on a full write without a date", () => {
		const write: HistoryWrite = { mode: "full", replaceFrom: null };
		expect(mergeHistory(stored, points(["2026-02-15", 9]), write, 10)).toEqual(
			points(["2026-02-15", 9]),
		);
	});

	it("keeps the newest maxStored rows (a non-integer or negative limit is truncated, at least 0)", () => {
		expect(mergeHistory(stored, [], null, 2)).toEqual(points(["2026-03-01", 3], ["2026-04-01", 4]));
		expect(mergeHistory(stored, [], null, 2.9)).toHaveLength(2);
		expect(mergeHistory(stored, [], null, 0)).toEqual([]);
		expect(mergeHistory(stored, [], null, -3)).toEqual([]);
	});
});

/* ---------- properties ---------- */

/** Dates as day numbers from 2026-01-01, so ordering and uniqueness are easy to generate. */
function isoOfDay(day: number): string {
	return new Date(Date.UTC(2026, 0, 1) + day * DAY_MS).toISOString().slice(0, 10);
}

/** Ascending, date-unique points over a small date range (collisions between lists are likely). */
const series = fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { maxLength: 16 }).chain((days) =>
	fc
		.array(fc.integer({ min: -3, max: 3 }), { minLength: days.length, maxLength: days.length })
		.map((values) =>
			[...days]
				.sort((a, b) => a - b)
				.map(
					(day, index): HistoryPoint => ({
						observedOn: isoOfDay(day),
						value: values[index] ?? 0,
					}),
				),
		),
);

const write: fc.Arbitrary<HistoryWrite | null> = fc.oneof(
	fc.constant(null),
	fc.constant<HistoryWrite>({ mode: "full", replaceFrom: null }),
	fc
		.integer({ min: 0, max: 40 })
		.map((day): HistoryWrite => ({ mode: "full", replaceFrom: isoOfDay(day) })),
	fc
		.integer({ min: 0, max: 40 })
		.map((day): HistoryWrite => ({ mode: "window", replaceFrom: isoOfDay(day) })),
);

const anchorPoint = fc.option(
	fc.record({
		observedOn: fc.integer({ min: 0, max: 40 }).map(isoOfDay),
		value: fc.integer({ min: -3, max: 3 }),
	}),
	{ nil: null },
);

const request: fc.Arbitrary<HistoryRefreshRequest> = fc
	.tuple(anchorPoint, fc.boolean())
	.map(([anchor, fullCheck]) => ({ anchor, fullCheck: anchor !== null && fullCheck }));

const UNLIMITED = 1_000;

/** A map-based restatement of the write: the reference for the merge-based implementation. */
function referenceMerge(
	stored: readonly HistoryPoint[],
	fetched: readonly HistoryPoint[],
	target: HistoryWrite | null,
): HistoryPoint[] {
	const byDate = new Map<string, number>();
	for (const point of stored) {
		const kept =
			target === null || (target.replaceFrom !== null && point.observedOn < target.replaceFrom);
		if (kept) byDate.set(point.observedOn, point.value);
	}
	for (const point of fetched) byDate.set(point.observedOn, point.value);
	return [...byDate.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([observedOn, value]) => ({ observedOn, value }));
}

describe("history refresh properties (ADR-0044)", () => {
	it("mergeHistory equals the map-based reference, then keeps the newest maxStored", () => {
		fc.assert(
			fc.property(
				series,
				series,
				write,
				fc.integer({ min: 0, max: 40 }),
				(stored, fetched, target, max) => {
					const expected = referenceMerge(stored, fetched, target);
					expect(mergeHistory(stored, fetched, target, UNLIMITED)).toEqual(expected);
					expect(mergeHistory(stored, fetched, target, max)).toEqual(
						expected.slice(Math.max(0, expected.length - max)),
					);
				},
			),
		);
	});

	it("keeps every fetched point with its value, ascending and one row per date", () => {
		fc.assert(
			fc.property(series, series, write, (stored, fetched, target) => {
				const merged = mergeHistory(stored, fetched, target, UNLIMITED);
				for (const point of fetched) expect(merged).toContainEqual(point);
				for (let index = 1; index < merged.length; index += 1) {
					const previous = merged[index - 1];
					const current = merged[index];
					if (previous === undefined || current === undefined)
						throw new Error("index out of range");
					expect(previous.observedOn < current.observedOn).toBe(true);
				}
			}),
		);
	});

	it("keeps stored rows older than replaceFrom (all when the write is null) and drops newer unfetched ones", () => {
		fc.assert(
			fc.property(series, series, write, (stored, fetched, target) => {
				const merged = mergeHistory(stored, fetched, target, UNLIMITED);
				const mergedDates = new Set(merged.map((point) => point.observedOn));
				const fetchedDates = new Set(fetched.map((point) => point.observedOn));
				for (const point of stored) {
					if (fetchedDates.has(point.observedOn)) continue;
					const shouldSurvive =
						target === null ||
						(target.replaceFrom !== null && point.observedOn < target.replaceFrom);
					if (shouldSurvive) expect(merged).toContainEqual(point);
					else expect(mergedDates.has(point.observedOn)).toBe(false);
				}
			}),
		);
	});

	it("an outcome's write replaces from one of the answered dates, and an empty answer replaces nothing", () => {
		fc.assert(
			fc.property(request, series, (claim, answer) => {
				const first = firstHistoryFetch(claim);
				const outcome = historyOutcome(claim, first, answer);
				const dates = new Set(answer.map((point) => point.observedOn));
				if (outcome.kind === "refetch-full") {
					// Only a window fetch can ask for more (and only when its anchor did not hold).
					expect(first.kind).toBe("window");
					if (claim.anchor !== null) expect(anchorConfirmed(claim.anchor, answer)).toBe(false);
					return;
				}
				const target = outcome.write;
				if (answer.length === 0) {
					expect(target).toBeNull();
					return;
				}
				if (target === null) throw new Error("a non-empty answer always carries a write");
				if (target.mode === "window") {
					expect(target.replaceFrom).toBe(claim.anchor?.observedOn);
				}
				// The contract refuses any other replaceFrom (completeJobRequestSchema).
				if (target.replaceFrom !== null) expect(dates.has(target.replaceFrom)).toBe(true);
			}),
		);
	});

	it("a full fetch never asks for another, so a series costs at most two requests", () => {
		fc.assert(
			fc.property(request, series, (claim, answer) => {
				expect(historyOutcome(claim, { kind: "full" }, answer).kind).toBe("store");
			}),
		);
	});
});
