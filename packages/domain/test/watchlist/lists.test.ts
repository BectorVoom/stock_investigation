import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DASHBOARD_LIMITS, type DashboardWidget } from "../../src/market/dashboard.ts";
import { parseMarketSeriesId } from "../../src/market/seriesId.ts";
import {
	pageSeriesIds,
	stockPriceSeriesId,
	WATCHLIST_LIST_LIMITS,
	watchlistListIdsOf,
} from "../../src/watchlist/lists.ts";
import {
	formatStockId,
	parseStockId,
	STOCK_SYMBOL_PATTERNS,
	type WatchMarket,
} from "../../src/watchlist/stockId.ts";
import { expectOk } from "../support/result.ts";
import "../support/seededProperties.ts";

const listWidget = (widgetId: string, listId: string): DashboardWidget => ({
	type: "watchlist-prices",
	widgetId,
	title: "List",
	size: "medium",
	listId,
});

const metric = (widgetId: string, seriesId: string): DashboardWidget => ({
	type: "market-metric",
	widgetId,
	title: "Metric",
	size: "small",
	seriesId,
});

const table = (widgetId: string, seriesIds: readonly string[]): DashboardWidget => ({
	type: "stock-table",
	widgetId,
	title: "Table",
	size: "large",
	seriesIds,
});

const text = (widgetId: string): DashboardWidget => ({
	type: "text",
	widgetId,
	title: "Note",
	size: "small",
});

const calendar = (widgetId: string): DashboardWidget => ({
	type: "earnings-calendar",
	widgetId,
	title: "Earnings",
	size: "medium",
	daysAhead: 30,
});

/** A lookup over a fixed table; a missing key is a deleted list. */
function lookup(
	lists: Readonly<Record<string, readonly string[]>>,
): (listId: string) => readonly string[] | undefined {
	const table = new Map(Object.entries(lists));
	return (listId) => table.get(listId);
}

/** Expected price-series symbol (after the `twelve-data:` provider) of a stock. */
const expectedPriceSymbol = (market: WatchMarket, symbol: string): string =>
	market === "US" ? symbol : `${symbol}:JPX`;

/** Stock id → parsed stock → price series → parsed series, checking each step. */
function roundTrip(market: WatchMarket, symbol: string): void {
	const stock = expectOk(parseStockId(formatStockId(market, symbol)));
	expect(stock).toEqual({ market, symbol });
	const seriesId = stockPriceSeriesId(stock.market, stock.symbol);
	expect(expectOk(parseMarketSeriesId(seriesId))).toEqual({
		provider: "twelve-data",
		symbol: expectedPriceSymbol(market, symbol),
	});
}

describe("WATCHLIST_LIST_LIMITS", () => {
	it("pins the ADR-0040 bounds; a list is one stock table's worth", () => {
		expect(WATCHLIST_LIST_LIMITS.maxLists).toBe(20);
		expect(WATCHLIST_LIST_LIMITS.maxStocksPerList).toBe(12);
		expect(WATCHLIST_LIST_LIMITS.maxStocksPerList).toBe(DASHBOARD_LIMITS.maxTableSeries);
		expect(WATCHLIST_LIST_LIMITS.maxTitleChars).toBe(80);
	});
});

describe("stockPriceSeriesId", () => {
	it("maps a US stock to its Twelve Data symbol and a JP code to JPX", () => {
		expect(stockPriceSeriesId("US", "AAPL")).toBe("twelve-data:AAPL");
		expect(stockPriceSeriesId("US", "BRK.B")).toBe("twelve-data:BRK.B");
		expect(stockPriceSeriesId("JP", "7203")).toBe("twelve-data:7203:JPX");
		expect(stockPriceSeriesId("JP", "130A")).toBe("twelve-data:130A:JPX");
	});

	it("gives a valid series id for every stock id shape at the pattern edges", () => {
		const usShapes = [
			"A",
			"Z",
			"AAPL",
			"BRK.B",
			"BF-B",
			"A1",
			"A.",
			"A-",
			"ABCDEFGHIJ",
			"Z9.9-9.9-9",
		];
		const jpShapes = ["7203", "130A", "0000", "9999", "1A2B", "9ZZZ"];
		for (const symbol of usShapes) roundTrip("US", symbol);
		for (const symbol of jpShapes) roundTrip("JP", symbol);
	});

	it("gives a valid series id for every stock id parseStockId accepts", () => {
		const market = fc.constantFrom<WatchMarket>("US", "JP");
		const stock = market.chain((m) =>
			fc.stringMatching(STOCK_SYMBOL_PATTERNS[m]).map((symbol) => ({ market: m, symbol })),
		);
		fc.assert(
			fc.property(stock, ({ market: m, symbol }) => {
				roundTrip(m, symbol);
			}),
		);
	});

	it("never maps two different stocks to the same series", () => {
		const stock = fc.oneof(
			fc
				.stringMatching(STOCK_SYMBOL_PATTERNS.US)
				.map((symbol) => ({ market: "US" as const, symbol })),
			fc
				.stringMatching(STOCK_SYMBOL_PATTERNS.JP)
				.map((symbol) => ({ market: "JP" as const, symbol })),
		);
		fc.assert(
			fc.property(stock, stock, (a, b) => {
				const same = a.market === b.market && a.symbol === b.symbol;
				expect(
					stockPriceSeriesId(a.market, a.symbol) === stockPriceSeriesId(b.market, b.symbol),
				).toBe(same);
			}),
		);
	});
});

describe("watchlistListIdsOf", () => {
	it("is empty for a page without list widgets", () => {
		expect(watchlistListIdsOf([])).toEqual([]);
		expect(watchlistListIdsOf([metric("w1", "fred:VIXCLS"), text("w2"), calendar("w3")])).toEqual(
			[],
		);
	});

	it("names each list once, first appearance first", () => {
		expect(
			watchlistListIdsOf([
				listWidget("w1", "list-b"),
				metric("w2", "fred:VIXCLS"),
				listWidget("w3", "list-a"),
				listWidget("w4", "list-b"),
			]),
		).toEqual(["list-b", "list-a"]);
	});
});

describe("pageSeriesIds", () => {
	const aapl = stockPriceSeriesId("US", "AAPL");
	const msft = stockPriceSeriesId("US", "MSFT");
	const toyota = stockPriceSeriesId("JP", "7203");
	const vix = "fred:VIXCLS";

	it("is the named series alone when there is no list widget", () => {
		expect(pageSeriesIds([metric("w1", vix), table("w2", [aapl, vix])], lookup({}))).toEqual([
			vix,
			aapl,
		]);
	});

	it("puts named series first even when a list widget comes first", () => {
		const widgets = [listWidget("w1", "tech"), metric("w2", vix), table("w3", [msft])];
		expect(pageSeriesIds(widgets, lookup({ tech: [aapl, msft] }))).toEqual([vix, msft, aapl]);
	});

	it("follows widget order across lists and list order within a list", () => {
		const widgets = [listWidget("w1", "japan"), listWidget("w2", "tech")];
		expect(pageSeriesIds(widgets, lookup({ tech: [msft, aapl], japan: [toyota] }))).toEqual([
			toyota,
			msft,
			aapl,
		]);
	});

	it("counts a series named by a widget and a list, or by two lists, once", () => {
		const widgets = [metric("w1", aapl), listWidget("w2", "a"), listWidget("w3", "b")];
		expect(pageSeriesIds(widgets, lookup({ a: [toyota, aapl], b: [aapl, toyota, msft] }))).toEqual([
			aapl,
			toyota,
			msft,
		]);
	});

	it("counts a list shown by two widgets once", () => {
		const widgets = [listWidget("w1", "a"), listWidget("w2", "b"), listWidget("w3", "a")];
		expect(pageSeriesIds(widgets, lookup({ a: [aapl], b: [msft] }))).toEqual([aapl, msft]);
	});

	it("skips a deleted or empty list and keeps the others", () => {
		const widgets = [listWidget("w1", "gone"), listWidget("w2", "empty"), listWidget("w3", "tech")];
		expect(pageSeriesIds(widgets, lookup({ empty: [], tech: [aapl] }))).toEqual([aapl]);
	});

	it("ignores content widgets and lists no widget shows", () => {
		const widgets = [text("w1"), calendar("w2"), listWidget("w3", "tech")];
		expect(pageSeriesIds(widgets, lookup({ tech: [msft], other: [aapl] }))).toEqual([msft]);
	});

	it("stops at the limit, cutting list rows before named series", () => {
		const widgets = [listWidget("w1", "tech"), metric("w2", vix), metric("w3", toyota)];
		const lists = lookup({ tech: [aapl, msft] });
		expect(pageSeriesIds(widgets, lists, 0)).toEqual([]);
		expect(pageSeriesIds(widgets, lists, 1)).toEqual([vix]);
		expect(pageSeriesIds(widgets, lists, 2)).toEqual([vix, toyota]);
		expect(pageSeriesIds(widgets, lists, 3)).toEqual([vix, toyota, aapl]);
		expect(pageSeriesIds(widgets, lists, 10)).toEqual([vix, toyota, aapl, msft]);
	});

	it("caps a page at DASHBOARD_LIMITS.maxSeries by default, named series first", () => {
		const named = Array.from({ length: 12 }, (_, index) =>
			stockPriceSeriesId("US", `N${String(index)}`),
		);
		const listA = Array.from({ length: 12 }, (_, index) =>
			stockPriceSeriesId("US", `A${String(index)}`),
		);
		const listB = Array.from({ length: 12 }, (_, index) =>
			stockPriceSeriesId("JP", `${String(1000 + index)}`),
		);
		const widgets = [listWidget("w1", "a"), listWidget("w2", "b"), table("w3", named)];
		const page = pageSeriesIds(widgets, lookup({ a: listA, b: listB }));
		expect(page).toHaveLength(DASHBOARD_LIMITS.maxSeries);
		expect(page).toEqual([...named, ...listA, ...listB.slice(0, 6)]);
	});
});
