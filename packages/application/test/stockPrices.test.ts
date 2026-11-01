import { type CompleteJobRequest, completeJobRequestSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { ownerTrackedSeries } from "../src/dataSync.ts";
import type { StockPriceRepository, StoredStockPriceDay } from "../src/ports.ts";
import { marketToday, planStockPrices, stockPricesEffects } from "../src/stockPrices.ts";

/** ADR-0058 §2: the stock-price plan, the completion's writes, and what Twelve Data leaves. */

const OWNER = "owner_1";
/** Sunday 2026-10-11 00:00 UTC: Saturday 20:00 in New York, Sunday 09:00 in Tokyo. */
const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const HOUR = 3_600_000;

function repository(
	days: readonly StoredStockPriceDay[],
	unstored: readonly string[] = [],
): Pick<StockPriceRepository, "listDays" | "listUnstoredSymbols"> & {
	readonly calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		listDays: async (_owner, market, oldest, newest) => {
			calls.push(`days ${market} ${oldest}..${newest}`);
			return days;
		},
		listUnstoredSymbols: async (_owner, market, limit) => {
			calls.push(`unstored ${market} ${limit}`);
			return unstored;
		},
	};
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
	it("plans the due days and reads no directory while a day is due", async () => {
		const repo = repository([
			{
				day: "2026-10-09",
				outcome: "not-yet-available",
				retryAt: new Date(NOW + HOUR).toISOString(),
			},
			{ day: "2026-10-08", outcome: "stored", retryAt: null },
			{ day: "2026-10-07", outcome: "not-yet-available", retryAt: new Date(NOW).toISOString() },
			// An unreadable retry time is due, never stuck.
			{ day: "2026-10-06", outcome: "not-yet-available", retryAt: "garbage" },
			{ day: "2026-10-05", outcome: "no-trading", retryAt: null },
		]);
		const plan = await planStockPrices(repo, OWNER, "US", NOW);
		expect(plan.days.slice(0, 4)).toEqual(["2026-10-07", "2026-10-06", "2026-10-02", "2026-10-01"]);
		expect(plan.days).toHaveLength(10);
		expect(plan.histories).toEqual([]);
		expect(plan.adjustmentsSince).toBe("2026-10-08");
		expect(plan.windowStart).toBe("2024-10-10");
		expect(repo.calls).toEqual(["days US 2024-10-10..2026-10-10"]);
	});

	it("names unstored stocks over the whole window only when no day is due", async () => {
		const every: StoredStockPriceDay[] = [];
		for (let offset = 0; offset <= 730; offset += 1) {
			const day = new Date(Date.parse("2026-10-11T00:00:00.000Z") - offset * 24 * HOUR)
				.toISOString()
				.slice(0, 10);
			every.push({ day, outcome: offset === 3 ? "stored" : "too-old", retryAt: null });
		}
		const repo = repository(every, ["7203", "lower-case", "130A"]);
		const plan = await planStockPrices(repo, OWNER, "JP", NOW);
		expect(plan.days).toEqual([]);
		// A symbol the contract cannot carry is left out, not sent.
		expect(plan.histories).toEqual([
			{ symbol: "7203", from: "2024-10-11", to: "2026-10-11" },
			{ symbol: "130A", from: "2024-10-11", to: "2026-10-11" },
		]);
		expect(plan.adjustmentsSince).toBe("2026-10-08");
		expect(repo.calls).toEqual(["days JP 2024-10-11..2026-10-11", "unstored JP 10"]);
	});
});

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
		...fields,
	});
	if (parsed.outcome !== "stock-prices-synced") throw new Error("not a stock-prices completion");
	return parsed;
}

describe("stockPricesEffects", () => {
	it("stores day outcomes with a retry time only for not-yet-available, bars of stored days first", () => {
		const effects = stockPricesEffects(
			completion({
				days: [
					{ date: "2026-10-09", outcome: "stored", bars: [["AAPL", 2, [1, 3, 1, 10]]] },
					{ date: "2026-10-08", outcome: "not-yet-available", bars: [] },
				],
				histories: [
					{
						symbol: "AAPL",
						reason: "split",
						outcome: "stored",
						from: "2024-10-10",
						to: "2026-10-10",
						bars: [
							["2026-10-09", 1, [0.5, 1.5, 0.5, null]],
							// Outside the window it replaces: not its answer.
							["2027-01-04", 9, [9, 9, 9, null]],
						],
					},
					{
						symbol: "MSFT",
						reason: "requested",
						outcome: "not-found",
						from: "2024-10-10",
						to: "2026-10-10",
						bars: [],
					},
				],
			}),
			NOW,
		);
		expect(effects.days).toEqual([
			{ day: "2026-10-09", outcome: "stored", barCount: 1, retryAt: null },
			{
				day: "2026-10-08",
				outcome: "not-yet-available",
				barCount: 0,
				retryAt: new Date(NOW + 6 * HOUR).toISOString(),
			},
		]);
		// The split refetch's bar comes after the day's, so it wins the shared date.
		expect(effects.points).toEqual([
			["AAPL", "2026-10-09", 2, 1, 3, 1, 10],
			["AAPL", "2026-10-09", 1, 0.5, 1.5, 0.5, null],
		]);
		expect(effects.replacements).toEqual([
			{ symbol: "AAPL", from: "2024-10-10", to: "2026-10-10", dates: ["2026-10-09"] },
		]);
		expect(effects.seriesSymbols).toEqual(["AAPL"]);
		expect(effects.notFoundSymbols).toEqual(["MSFT"]);
		expect(effects).toMatchObject({
			publisher: "Massive",
			sourceUrl: "https://massive.com/",
			unit: "USD",
		});
	});

	it("names J-Quants and yen for a JP answer, and keeps a stored stock out of not-found", () => {
		const effects = stockPricesEffects(
			completion({
				market: "JP",
				provider: "jquants",
				days: [
					{ date: "2026-10-09", outcome: "stored", bars: [["7203", 2500, [2490, 2510, 2480, 1]]] },
				],
				histories: [
					{
						symbol: "7203",
						reason: "requested",
						outcome: "not-found",
						from: "2024-10-10",
						to: "2026-10-10",
						bars: [],
					},
				],
			}),
			NOW,
		);
		expect(effects).toMatchObject({
			publisher: "J-Quants",
			sourceUrl: "https://jpx-jquants.com/",
			unit: "JPY",
			notFoundSymbols: [],
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
