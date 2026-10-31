import {
	EARNINGS_LIMITS,
	EQUITY_FINANCIAL_LIMITS,
	type StockDirectoryHit,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistList,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import { tabKeyTarget } from "../src/components/Tabs.tsx";
import { keyFigures, newestFiscalYear } from "../src/stocks/keyFigures.ts";
import {
	canAddFromDetail,
	detailName,
	listChoicesFor,
	mergeStockRows,
	openableSearchState,
	selectedStockFor,
} from "../src/stocks/stocksModel.ts";
import type { StockSearchState } from "../src/watchlist/watchlistModel.ts";
import { appleStatement, makeCompany, NINTENDO } from "./equitiesHarness.ts";
import { makeStock } from "./watchlistHarness.ts";

const MSFT = makeStock({ stockId: "us:MSFT", symbol: "MSFT", name: "Microsoft Corp" });

describe("mergeStockRows (ADR-0049 §2)", () => {
	it("lists the watchlist in its order, then the tracked companies not on it in tracking order", () => {
		const rows = mergeStockRows(
			[makeStock(), MSFT],
			[NINTENDO(), makeCompany(), makeCompany({ companyId: "eqc_ko", symbol: "KO", name: null })],
		);
		expect(rows.map((row) => row.stockId)).toEqual(["us:AAPL", "us:MSFT", "jp:7974", "us:KO"]);
		const [apple, msft, nintendo, ko] = rows;
		expect(apple?.watchlist?.stockId).toBe("us:AAPL");
		expect(apple?.company?.companyId).toBe("eqc_apple");
		expect(msft?.company).toBeNull();
		expect(nintendo?.watchlist).toBeNull();
		expect(nintendo?.market).toBe("JP");
		expect(nintendo?.name).toBe("任天堂株式会社");
		expect(ko?.name).toBeNull();
	});

	it("names a row by the watchlist, else the company, else nothing", () => {
		const [row] = mergeStockRows([makeStock({ name: null })], [makeCompany()]);
		expect(row?.name).toBe("Apple Inc.");
		const [watched] = mergeStockRows([makeStock()], [makeCompany()]);
		expect(watched?.name).toBe("Apple Inc");
	});

	it("leaves out companies that are no longer tracked, and never repeats a stock", () => {
		const rows = mergeStockRows(
			[makeStock(), makeStock()],
			[makeCompany({ tracked: false }), NINTENDO(), NINTENDO()],
		);
		expect(rows.map((row) => row.stockId)).toEqual(["us:AAPL", "jp:7974"]);
		expect(rows[0]?.company).toBeNull();
	});

	it("is empty for two empty lists", () => {
		expect(mergeStockRows([], [])).toEqual([]);
	});

	it("merges the largest lists into one row per stock (timed by `bun run bench`)", () => {
		const watchlist = Array.from({ length: EARNINGS_LIMITS.maxStocks }, (_, index) =>
			makeStock({ stockId: `us:W${index}`, symbol: `W${index}` }),
		);
		const companies = Array.from(
			{ length: EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies },
			(_, index) =>
				makeCompany({
					companyId: `eqc_${index}`,
					symbol: index % 2 === 0 ? `W${index}` : `T${index}`,
				}),
		);
		expect(mergeStockRows(watchlist, companies)).toHaveLength(
			EARNINGS_LIMITS.maxStocks + EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies / 2,
		);
	});
});

describe("selectedStockFor and detailName", () => {
	it("takes the row the page lists, else the bare stock the URL names", () => {
		const [row] = mergeStockRows([makeStock()], []);
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
			company: null,
			listTitles: [],
		});
		expect(selectedStockFor("nasdaq:AAPL", undefined, [])).toBeNull();
	});

	it("names the heading by the page's name, else the stored name in the UI language", () => {
		const directory = { name: "TOYOTA MOTOR CORPORATION", localName: "トヨタ自動車" };
		expect(detailName("Toyota", directory, "ja")).toBe("Toyota");
		expect(detailName(null, directory, "ja")).toBe("トヨタ自動車");
		expect(detailName(null, directory, "en")).toBe("TOYOTA MOTOR CORPORATION");
		expect(detailName(null, { name: "Apple Inc.", localName: null }, "ja")).toBe("Apple Inc.");
		expect(detailName(null, null, "en")).toBeNull();
	});
});

describe("key figures (ADR-0049 §6)", () => {
	it("takes the newest fiscal year's cell of each figure from its statement's answer", () => {
		const income = appleStatement("income-statement", 5, makeCompany());
		const cashFlow = appleStatement("cash-flow", 5, makeCompany());
		expect(newestFiscalYear([income, undefined, cashFlow])).toBe(2024);
		const figures = keyFigures(
			new Map([
				["income-statement", income],
				["balance-sheet", undefined],
				["cash-flow", cashFlow],
			]),
			2024,
		);
		expect(figures.map((figure) => figure.metric)).toEqual([
			"revenue",
			"operating-income",
			"profit-attributable-to-owners",
			"total-assets",
			"total-equity",
			"net-cash-from-operating-activities",
			"free-cash-flow",
		]);
		const revenue = figures[0];
		expect(revenue?.loaded).toBe(true);
		expect(revenue?.cell?.fiscalYear).toBe(2024);
		// The balance sheet has not answered yet.
		expect(figures.find((figure) => figure.metric === "total-assets")).toMatchObject({
			loaded: false,
			cell: null,
		});
		expect(newestFiscalYear([undefined])).toBeNull();
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
