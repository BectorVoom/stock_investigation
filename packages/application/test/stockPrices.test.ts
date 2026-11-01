import { type CompleteJobRequest, completeJobRequestSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { ownerTrackedSeries } from "../src/dataSync.ts";
import type {
	StockPriceRepository,
	StockPricesClaimRecord,
	StoredStockPriceDay,
} from "../src/ports.ts";
import {
	claimRecordOf,
	marketToday,
	planStockPrices,
	STOCK_HISTORY_BACKOFF_HOURS,
	stockPricesEffects,
} from "../src/stockPrices.ts";

/** ADR-0058 §2: the stock-price plan, the completion's writes, and what Twelve Data leaves. */

const OWNER = "owner_1";
/** Sunday 2026-10-11 00:00 UTC: Saturday 20:00 in New York, Sunday 09:00 in Tokyo. */
const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const HOUR = 3_600_000;
const NOW_ISO = new Date(NOW).toISOString();

function repository(
	days: readonly StoredStockPriceDay[],
	unfilled: readonly string[] = [],
	owed: readonly string[] = [],
	splitCheckedOn: string | null = null,
): Pick<
	StockPriceRepository,
	"listDays" | "getSplitCheckedOn" | "listRefetchSymbols" | "listUnfilledSymbols"
> & {
	readonly calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		listDays: async (_owner, market, oldest, newest) => {
			calls.push(`days ${market} ${oldest}..${newest}`);
			return days;
		},
		getSplitCheckedOn: async () => splitCheckedOn,
		listRefetchSymbols: async (_owner, market, nowIso, limit) => {
			calls.push(`refetch ${market} ${nowIso} ${limit}`);
			return owed.slice(0, limit);
		},
		listUnfilledSymbols: async (_owner, market, nowIso, limit) => {
			calls.push(`unfilled ${market} ${nowIso} ${limit}`);
			return unfilled.slice(0, limit);
		},
	};
}

/** Every day of the JP window answered and final, so no day is due. */
function everyDayAnswered(): StoredStockPriceDay[] {
	const every: StoredStockPriceDay[] = [];
	for (let offset = 0; offset <= 730; offset += 1) {
		const day = new Date(NOW - offset * 24 * HOUR).toISOString().slice(0, 10);
		every.push({ day, outcome: offset === 3 ? "stored" : "too-old", retryAt: null });
	}
	return every;
}

describe("marketToday", () => {
	it("is the market's local date", () => {
		expect(marketToday("US", NOW)).toBe("2026-10-10");
		expect(marketToday("JP", NOW)).toBe("2026-10-11");
		// 04:59 UTC is still the previous day in New York (EDT, UTC−4 → 00:59).
		expect(marketToday("US", Date.parse("2026-10-12T03:59:00.000Z"))).toBe("2026-10-11");
		expect(marketToday("US", Date.parse("2026-10-12T04:00:00.000Z"))).toBe("2026-10-12");
		expect(marketToday("JP", Date.parse("2026-10-11T14:59:00.000Z"))).toBe("2026-10-11");
		expect(marketToday("JP", Date.parse("2026-10-11T15:00:00.000Z"))).toBe("2026-10-12");
	});
});

describe("planStockPrices", () => {
	it("plans the due days — any day with a retry time is not final — and reads no directory while one is due", async () => {
		const later = new Date(NOW + HOUR).toISOString();
		const repo = repository(
			[
				{ day: "2026-10-09", outcome: "not-yet-available", retryAt: later },
				// A stored day that has not settled waits for its retry; a no-trading day nothing proves yet too.
				{ day: "2026-10-08", outcome: "stored", retryAt: later },
				{ day: "2026-10-07", outcome: "not-yet-available", retryAt: NOW_ISO },
				// An unreadable retry time is due, never stuck.
				{ day: "2026-10-06", outcome: "not-yet-available", retryAt: "garbage" },
				{ day: "2026-10-05", outcome: "no-trading", retryAt: null },
				{ day: "2026-10-02", outcome: "no-trading", retryAt: NOW_ISO },
				{ day: "2026-10-01", outcome: "stored", retryAt: null },
			],
			[],
			[],
			"2026-09-30",
		);
		const plan = await planStockPrices(repo, OWNER, "US", NOW);
		expect(plan.days.slice(0, 4)).toEqual(["2026-10-07", "2026-10-06", "2026-10-02", "2026-09-30"]);
		expect(plan.days).toHaveLength(10);
		expect(plan.histories).toEqual([]);
		// The claim's split watermark is the stored one, not the newest stored day.
		expect(plan.adjustmentsSince).toBe("2026-09-30");
		expect(plan.windowStart).toBe("2024-10-10");
		expect(plan.newest).toBe("2026-10-10");
		expect(repo.calls).toEqual(["days US 2024-10-10..2026-10-10"]);
	});

	it("names unfilled stocks over the whole window only when no day is due", async () => {
		const repo = repository(everyDayAnswered(), ["7203", "lower-case", "130A"]);
		const plan = await planStockPrices(repo, OWNER, "JP", NOW);
		expect(plan.days).toEqual([]);
		// A symbol the contract cannot carry is left out, not sent.
		expect(plan.histories).toEqual([
			{ symbol: "7203", from: "2024-10-11", to: "2026-10-11" },
			{ symbol: "130A", from: "2024-10-11", to: "2026-10-11" },
		]);
		expect(plan.adjustmentsSince).toBeNull();
		// Back-offs are judged at the plan's clock.
		expect(repo.calls).toEqual([
			"days JP 2024-10-11..2026-10-11",
			`refetch JP ${NOW_ISO} 10`,
			`unfilled JP ${NOW_ISO} 10`,
		]);
	});

	it("puts owed split refetches before unfilled stocks, once each, at most the cap", async () => {
		const every = everyDayAnswered();
		const owed = ["7203", "9984"];
		const unfilled = ["9984", ...Array.from({ length: 12 }, (_, index) => `${1300 + index}`)];
		const plan = await planStockPrices(repository(every, unfilled, owed), OWNER, "JP", NOW);
		expect(plan.histories.map((history) => history.symbol)).toEqual([
			"7203",
			"9984",
			"1300",
			"1301",
			"1302",
			"1303",
			"1304",
			"1305",
			"1306",
			"1307",
		]);
		// A full queue of owed refetches skips the directory walk.
		const full = Array.from({ length: 10 }, (_, index) => `${2000 + index}`);
		const repo = repository(every, unfilled, full);
		expect((await planStockPrices(repo, OWNER, "JP", NOW)).histories).toHaveLength(10);
		expect(repo.calls.some((call) => call.startsWith("unfilled"))).toBe(false);
	});

	it("never plans an owed refetch while a day is due", async () => {
		const repo = repository([], [], ["7203"]);
		const plan = await planStockPrices(repo, OWNER, "JP", NOW);
		expect(plan.histories).toEqual([]);
		expect(repo.calls).toEqual(["days JP 2024-10-11..2026-10-11"]);
	});
});

/** The claim a completion answers: the given days and histories over the US window. */
function claim(fields: Partial<StockPricesClaimRecord> = {}): StockPricesClaimRecord {
	return { days: [], histories: [], windowStart: "2024-10-10", newest: "2026-10-10", ...fields };
}

function completion(fields: Record<string, unknown>) {
	const parsed: CompleteJobRequest = completeJobRequestSchema.parse({
		outcome: "stock-prices-synced",
		leaseGeneration: 1,
		usage: {
			agentSteps: 0,
			toolCalls: 0,
			inputBytes: 0,
			knownCostUsd: 0,
			hasUnmeteredUsage: false,
		},
		market: "US",
		provider: "massive",
		fetchedAt: "2026-10-11T00:00:00.000Z",
		days: [],
		histories: [],
		splitSymbols: [],
		splitCheckedThrough: null,
		...fields,
	});
	if (parsed.outcome !== "stock-prices-synced") throw new Error("not a stock-prices completion");
	return parsed;
}

const WINDOW = { from: "2024-10-10", to: "2026-10-10" } as const;

function history(
	symbol: string,
	reason: "split" | "requested",
	outcome: "stored" | "not-found" | "unavailable",
	bars: readonly unknown[] = outcome === "stored" ? [["2026-10-09", 1, [1, 1, 1, 1]]] : [],
	window: { readonly from: string; readonly to: string } = WINDOW,
) {
	return { symbol, reason, outcome, ...window, bars };
}

describe("stockPricesEffects: days", () => {
	const settleAndRetry = (
		market: "US" | "JP",
		days: readonly unknown[],
		claimed: readonly string[],
	) =>
		stockPricesEffects(
			completion({ market, provider: market === "US" ? "massive" : "jquants", days }),
			claim({ days: claimed }),
			NOW,
		).days;

	it("ignores days the claim did not ask for", () => {
		const effects = stockPricesEffects(
			completion({
				days: [
					{ date: "2026-09-01", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] },
					{ date: "2026-08-31", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] },
				],
			}),
			claim({ days: ["2026-09-01"] }),
			NOW,
		);
		expect(effects.days.map((day) => day.day)).toEqual(["2026-09-01"]);
		expect(effects.points.map((point) => point[1])).toEqual(["2026-09-01"]);
	});

	it("keeps a not-yet-available day and an unproven no-trading day open, a proven one final", () => {
		const retry = new Date(NOW + 6 * HOUR).toISOString();
		const days = settleAndRetry(
			"US",
			[
				{ date: "2026-09-04", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] },
				// Older than a stored day of the same answer: proven.
				{ date: "2026-09-03", outcome: "no-trading", bars: [] },
				{ date: "2026-09-02", outcome: "not-yet-available", bars: [] },
				{ date: "2026-08-03", outcome: "too-old", bars: [] },
			],
			["2026-09-04", "2026-09-03", "2026-09-02", "2026-08-03"],
		);
		expect(days).toEqual([
			{ day: "2026-09-04", outcome: "stored", barCount: 1, retryAt: null },
			{ day: "2026-09-03", outcome: "no-trading", barCount: 0, retryAt: null },
			{ day: "2026-09-02", outcome: "not-yet-available", barCount: 0, retryAt: retry },
			{ day: "2026-08-03", outcome: "too-old", barCount: 0, retryAt: null },
		]);
		// Newer than every stored day of the answer: open (the SQL may still prove it).
		const open = settleAndRetry(
			"US",
			[
				{ date: "2026-09-04", outcome: "no-trading", bars: [] },
				{ date: "2026-09-03", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] },
			],
			["2026-09-04", "2026-09-03"],
		);
		expect(open[0]).toEqual({
			day: "2026-09-04",
			outcome: "no-trading",
			barCount: 0,
			retryAt: retry,
		});
	});

	it("asks a day stored before it settled once more, from the local start of the day after it settles", () => {
		// New York on 2026-10-10 (EDT): 2026-10-07 is 3 days old (settleDays), 2026-10-06 is 4.
		const us = settleAndRetry(
			"US",
			[
				{ date: "2026-10-07", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] },
				{ date: "2026-10-06", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] },
			],
			["2026-10-07", "2026-10-06"],
		);
		expect(us).toEqual([
			// 2026-10-11 00:00 in New York is 04:00 UTC.
			{ day: "2026-10-07", outcome: "stored", barCount: 1, retryAt: "2026-10-11T04:00:00.000Z" },
			{ day: "2026-10-06", outcome: "stored", barCount: 1, retryAt: null },
		]);
		// Tokyo on 2026-10-11: 2026-10-09 is 2 days old; it settles from 2026-10-13 00:00 JST.
		const jp = settleAndRetry(
			"JP",
			[{ date: "2026-10-09", outcome: "stored", bars: [["7203", 2, [1, 3, 1, 10]]] }],
			["2026-10-09"],
		);
		expect(jp[0]?.retryAt).toBe("2026-10-12T15:00:00.000Z");
	});
});

describe("stockPricesEffects: histories", () => {
	it("stores bars of claimed days first, then histories within their claimed window", () => {
		const effects = stockPricesEffects(
			completion({
				days: [{ date: "2026-10-05", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] }],
				splitSymbols: ["AAPL"],
				histories: [
					history("AAPL", "split", "stored", [
						["2026-10-05", 1, [0.5, 1.5, 0.5, null]],
						// Past the newest claimed day: outside a split history's window.
						["2026-10-09", 9, [9, 9, 9, null]],
					]),
				],
			}),
			claim({ days: ["2026-10-05"] }),
			NOW,
		);
		expect(effects.points).toEqual([
			["AAPL", "2026-10-05", 2, 1, 3, 1, 10],
			["AAPL", "2026-10-05", 1, 0.5, 1.5, 0.5, null],
		]);
		expect(effects.replacements).toEqual([
			{ symbol: "AAPL", from: "2024-10-10", to: "2026-10-05", dates: ["2026-10-05"] },
		]);
		expect(effects).toMatchObject({
			publisher: "Massive",
			sourceUrl: "https://massive.com/",
			unit: "USD",
			committedAt: NOW_ISO,
			windowStart: "2024-10-10",
			filledSymbols: ["AAPL"],
			historyCleared: ["AAPL"],
			refetchOwed: [],
		});
	});

	it("ignores a requested history the claim did not ask for, and clamps one to its claimed window", () => {
		const effects = stockPricesEffects(
			completion({
				histories: [
					history("MSFT", "requested", "stored"),
					history(
						"AAPL",
						"requested",
						"stored",
						[
							["2024-01-02", 1, [1, 1, 1, 1]],
							["2026-10-09", 2, [2, 2, 2, 2]],
						],
						{ from: "2024-01-01", to: "2026-10-10" },
					),
				],
			}),
			claim({ histories: [{ symbol: "AAPL", ...WINDOW }] }),
			NOW,
		);
		expect(effects.replacements).toEqual([{ symbol: "AAPL", ...WINDOW, dates: ["2026-10-09"] }]);
		expect(effects.seriesSymbols).toEqual(["AAPL"]);
	});

	it("backs off an unavailable history, fills not-found ones, and owes refetches for unrefetched splits", () => {
		const effects = stockPricesEffects(
			completion({
				splitSymbols: ["AAPL", "MSFT", "NVDA", "TSLA"],
				histories: [
					history("AAPL", "split", "stored"),
					// A requested history of a split stock is adjusted as of this job too.
					history("NVDA", "requested", "stored"),
					history("TSLA", "split", "unavailable"),
					history("ZM", "requested", "not-found"),
					history("ZTS", "requested", "unavailable"),
				],
			}),
			claim({
				histories: ["NVDA", "ZM", "ZTS"].map((symbol) => ({ symbol, ...WINDOW })),
			}),
			NOW,
		);
		expect(effects.notFoundSymbols).toEqual(["ZM"]);
		expect(effects.filledSymbols).toEqual(["AAPL", "NVDA", "ZM"]);
		expect(effects.historyCleared).toEqual(["AAPL", "NVDA", "ZM"]);
		expect(effects.refetchOwed).toEqual(["MSFT", "TSLA"]);
		expect(effects.backoffSymbols).toEqual(["TSLA", "ZTS"]);
		expect(effects.backoffUntil).toBe(
			new Date(NOW + STOCK_HISTORY_BACKOFF_HOURS * HOUR).toISOString(),
		);
	});

	it("advances the split watermark only to a finished check, never past the claim's window", () => {
		const of = (splitCheckedThrough: string | null) =>
			stockPricesEffects(completion({ splitCheckedThrough }), claim(), NOW).splitCheckedOn;
		expect(of(null)).toBeNull();
		expect(of("2026-10-09")).toBe("2026-10-09");
		expect(of("2026-12-31")).toBe("2026-10-10");
	});

	it("names J-Quants and yen for a JP answer", () => {
		const effects = stockPricesEffects(
			completion({ market: "JP", provider: "jquants" }),
			claim(),
			NOW,
		);
		expect(effects).toMatchObject({
			publisher: "J-Quants",
			sourceUrl: "https://jpx-jquants.com/",
			unit: "JPY",
		});
	});

	it("records exactly what the plan asked for", () => {
		expect(
			claimRecordOf({
				market: "US",
				days: ["2026-10-09"],
				histories: [{ symbol: "AAPL", ...WINDOW }],
				adjustmentsSince: null,
				windowStart: "2024-10-10",
				newest: "2026-10-10",
			}),
		).toEqual({
			days: ["2026-10-09"],
			histories: [{ symbol: "AAPL", ...WINDOW }],
			windowStart: "2024-10-10",
			newest: "2026-10-10",
		});
	});
});

describe("ownerTrackedSeries (ADR-0058 §2)", () => {
	it("leaves every directory stock's series to stock-prices-sync", async () => {
		const asked: (readonly string[])[] = [];
		const series = await ownerTrackedSeries(
			{
				homeDashboard: {
					get: async () => ({
						dashboard: {
							schemaVersion: 2,
							widgets: [
								"twelve-data:AAPL",
								"twelve-data:7203:JPX",
								"twelve-data:SPX",
								"fred:DGS10",
							].map((seriesId, index) => ({
								type: "market-metric",
								widgetId: `w-${index}`,
								title: seriesId,
								size: "small",
								seriesId,
							})),
						},
						version: 1,
						updatedAt: "2026-10-10T00:00:00.000Z",
					}),
				},
				notebooks: { listMarketSeriesIds: async () => [], listWatchlistListIds: async () => [] },
				watchlistLists: { membersOf: async () => new Map() },
				watchlist: { listStocks: async () => [] },
				stockPrices: {
					usDirectorySeriesIds: async (_owner, seriesIds) => {
						asked.push(seriesIds);
						return new Set(seriesIds.filter((seriesId) => seriesId === "twelve-data:AAPL"));
					},
				},
			},
			OWNER,
		);
		expect(series.tracked).toEqual(["twelve-data:SPX", "fred:DGS10"]);
		// The keep set is unchanged; one directory lookup, without the :JPX ids.
		expect(series.keep).toContain("twelve-data:AAPL");
		expect(asked).toEqual([["twelve-data:AAPL", "twelve-data:SPX", "fred:DGS10"]]);
	});
});
