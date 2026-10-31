import { EARNINGS_LIMITS, EQUITY_FINANCIAL_LIMITS } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { tabKeyTarget } from "../src/components/Tabs.tsx";
import { keyFigures, newestFiscalYear } from "../src/stocks/keyFigures.ts";
import { detailName, mergeStockRows, selectedStockFor } from "../src/stocks/stocksModel.ts";
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

	it("merges the largest lists in well under a millisecond each", () => {
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
		const rounds = 200;
		const started = performance.now();
		let rows = 0;
		for (let round = 0; round < rounds; round += 1)
			rows = mergeStockRows(watchlist, companies).length;
		const perRound = (performance.now() - started) / rounds;
		expect(rows).toBe(EARNINGS_LIMITS.maxStocks + EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies / 2);
		expect(perRound).toBeLessThan(1);
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
