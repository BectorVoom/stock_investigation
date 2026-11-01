import {
	EARNINGS_LIMITS,
	type StockDirectoryHit,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistList,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import { tabKeyTarget } from "../src/components/Tabs.tsx";
import {
	canAddFromDetail,
	detailName,
	listChoicesFor,
	openableSearchState,
	selectedStockFor,
	watchlistRows,
} from "../src/stocks/stocksModel.ts";
import type { StockSearchState } from "../src/watchlist/watchlistModel.ts";
import { makeStock } from "./watchlistHarness.ts";

const MSFT = makeStock({ stockId: "us:MSFT", symbol: "MSFT", name: "Microsoft Corp" });

describe("watchlistRows (ADR-0049 §2, ADR-0058 §6)", () => {
	it("lists the watchlist in its order, each row its watchlist entry", () => {
		const rows = watchlistRows([makeStock(), MSFT]);
		expect(rows.map((row) => row.stockId)).toEqual(["us:AAPL", "us:MSFT"]);
		const [apple, msft] = rows;
		expect(apple?.watchlist.stockId).toBe("us:AAPL");
		expect(msft?.name).toBe("Microsoft Corp");
		expect(msft?.market).toBe("US");
	});

	it("names a row by the watchlist, else nothing", () => {
		const [row] = watchlistRows([makeStock({ name: null })]);
		expect(row?.name).toBeNull();
	});

	it("never repeats a stock, and is empty for an empty watchlist", () => {
		expect(watchlistRows([makeStock(), makeStock()]).map((row) => row.stockId)).toEqual([
			"us:AAPL",
		]);
		expect(watchlistRows([])).toEqual([]);
	});

	it("makes the largest watchlist into one row per stock (timed by `bun run bench`)", () => {
		const watchlist = Array.from({ length: EARNINGS_LIMITS.maxStocks }, (_, index) =>
			makeStock({ stockId: `us:W${index}`, symbol: `W${index}` }),
		);
		expect(watchlistRows(watchlist)).toHaveLength(EARNINGS_LIMITS.maxStocks);
	});
});

describe("selectedStockFor and detailName", () => {
	it("takes the row the page lists, else the bare stock the URL names", () => {
		const [row] = watchlistRows([makeStock()]);
		expect(selectedStockFor("us:AAPL", row, ["Tech"])).toMatchObject({
			stockId: "us:AAPL",
			name: "Apple Inc",
			listTitles: ["Tech"],
		});
		expect(selectedStockFor("jp:7203", undefined, [])).toEqual({
			stockId: "jp:7203",
			market: "JP",
			symbol: "7203",
			name: null,
			watchlist: null,
			listTitles: [],
		});
		expect(selectedStockFor("nasdaq:AAPL", undefined, [])).toBeNull();
	});

	it("names the heading by the page's name, else the stored name in the UI language, else the company's", () => {
		const directory = { name: "TOYOTA MOTOR CORPORATION", localName: "トヨタ自動車" };
		expect(detailName("Toyota", directory, "Toyota Motor Corp", "ja")).toBe("Toyota");
		expect(detailName(null, directory, "Toyota Motor Corp", "ja")).toBe("トヨタ自動車");
		expect(detailName(null, directory, null, "en")).toBe("TOYOTA MOTOR CORPORATION");
		expect(detailName(null, { name: "Apple Inc.", localName: null }, null, "ja")).toBe(
			"Apple Inc.",
		);
		expect(detailName(null, null, "任天堂株式会社", "en")).toBe("任天堂株式会社");
		expect(detailName(null, null, null, "en")).toBeNull();
	});
});

describe("tab keys (WAI-ARIA tabs pattern)", () => {
	it("moves with the arrows (wrapping), Home and End; other keys do nothing", () => {
		expect(tabKeyTarget("ArrowRight", 3, 4)).toBe(0);
		expect(tabKeyTarget("ArrowLeft", 0, 4)).toBe(3);
		expect(tabKeyTarget("ArrowRight", 1, 4)).toBe(2);
		expect(tabKeyTarget("Home", 2, 4)).toBe(0);
		expect(tabKeyTarget("End", 0, 4)).toBe(3);
		expect(tabKeyTarget("Enter", 0, 4)).toBeNull();
		expect(tabKeyTarget("ArrowRight", 0, 0)).toBeNull();
	});
});

function hit(overrides: Partial<StockDirectoryHit> = {}): StockDirectoryHit {
	return {
		stockId: "jp:7203",
		market: "JP",
		symbol: "7203",
		name: "TOYOTA MOTOR CORPORATION",
		localName: "トヨタ自動車",
		listing: "tse-prime",
		registered: false,
		...overrides,
	};
}

function list(overrides: Partial<WatchlistList> = {}): WatchlistList {
	return {
		listId: "list_a",
		title: "Semis",
		stockIds: [],
		version: 1,
		createdAt: "2026-10-25T00:00:00Z",
		updatedAt: "2026-10-25T00:00:00Z",
		...overrides,
	};
}

describe("openableSearchState (ADR-0050 §1)", () => {
	it("clears `registered` on every hit, so a registered stock can be opened", () => {
		const hits = [hit({ registered: true }), hit({ stockId: "us:TM", symbol: "TM", market: "US" })];
		const searching = openableSearchState({ kind: "searching", query: "toyota", hits });
		const results = openableSearchState({ kind: "results", query: "toyota", hits });
		for (const state of [searching, results]) {
			if (state.kind !== "searching" && state.kind !== "results") throw new Error("kind kept");
			expect(state.query).toBe("toyota");
			expect(state.hits.map((entry) => [entry.stockId, entry.registered])).toEqual([
				["jp:7203", false],
				["us:TM", false],
			]);
		}
		expect(searching.kind).toBe("searching");
		expect(results.kind).toBe("results");
	});

	it("returns the same state when nothing needs clearing", () => {
		const idle: StockSearchState = { kind: "idle" };
		const plain: StockSearchState = { kind: "results", query: "toyota", hits: [hit()] };
		expect(openableSearchState(idle)).toBe(idle);
		expect(openableSearchState(plain)).toBe(plain);
	});
});

describe("listChoicesFor and canAddFromDetail (ADR-0050 §2)", () => {
	const full = list({
		listId: "list_full",
		title: "Full",
		stockIds: Array.from(
			{ length: WATCHLIST_LISTS_LIMITS.maxStocksPerList },
			(_, index) => `us:S${index}`,
		),
	});

	it("marks each list, in order, as holding the stock, full, or available", () => {
		const lists = [
			list({ listId: "list_in", title: "Big tech", stockIds: ["us:AAPL"] }),
			full,
			list({ listId: "list_open", title: "Semis", stockIds: ["us:NVDA"] }),
		];
		expect(
			listChoicesFor(lists, "us:AAPL").map((choice) => [choice.list.listId, choice.state]),
		).toEqual([
			["list_in", "member"],
			["list_full", "full"],
			["list_open", "available"],
		]);
		// A full list that already holds the stock says so, not "full".
		const fullWithStock = { ...full, stockIds: [...full.stockIds.slice(1), "us:AAPL"] };
		expect(listChoicesFor([fullWithStock], "us:AAPL")[0]?.state).toBe("member");
	});

	it("offers the add for a stock off the watchlist, and for a watched one only while a list can take it", () => {
		expect(canAddFromDetail(false, [])).toBe(true);
		expect(canAddFromDetail(true, [])).toBe(false);
		const member = listChoicesFor([list({ stockIds: ["us:AAPL"] }), full], "us:AAPL");
		expect(canAddFromDetail(true, member)).toBe(false);
		expect(canAddFromDetail(false, member)).toBe(true);
		expect(canAddFromDetail(true, listChoicesFor([list()], "us:AAPL"))).toBe(true);
	});
});
