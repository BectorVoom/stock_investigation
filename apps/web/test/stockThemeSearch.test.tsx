import type { CompanySummaryView } from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCompany } from "./equitiesHarness.ts";
import { errorResponse } from "./fakeBackend.ts";
import { createStocksBackend, mountStocks, type StocksServer } from "./stocksHarness.tsx";

/**
 * The Stocks page's theme search (ADR-0066): the box opens
 * `#/stocks/themes/<words>`, the results list the stocks whose shown themes
 * contain the words and open their Company tab, and the Company tab's
 * themes link to the search.
 */

const summary = (themes: CompanySummaryView["themes"]): CompanySummaryView => ({
	description: { en: "A company.", ja: "企業。" },
	themes,
	agentId: "claude-code",
	model: null,
	generatedAt: "2026-11-02T03:00:00.000Z",
});

let api: StocksServer;

beforeEach(() => {
	api = createStocksBackend({ companies: [makeCompany()] });
	api.summaryOf.set(
		"jp:7203",
		summary([
			{ en: "Automobiles", ja: "自動車" },
			{ en: "Hybrid vehicles", ja: "ハイブリッド車" },
		]),
	);
	api.summaryOf.set("jp:7205", summary([{ en: "Trucks", ja: "トラック" }]));
	api.summaryOf.set("us:AAPL", summary([{ en: "Smartphones", ja: "スマートフォン" }]));
});

afterEach(() => {
	cleanup();
});

async function resultsTable(): Promise<HTMLElement> {
	return waitFor(() => {
		const results = document.querySelector('[data-field="theme-search-results"]');
		const table = results?.querySelector("table");
		if (!(table instanceof HTMLElement)) throw new Error("no results table yet");
		return table;
	});
}

describe("Stocks page: find stocks by theme (ADR-0066)", () => {
	it("opens a theme search for the submitted words, and reads nothing before", async () => {
		const page = mountStocks(api.backend);
		const box = screen.getByRole("searchbox", { name: "Theme words" });
		const submit = screen.getByRole("button", { name: "Search" });
		expect(submit.hasAttribute("disabled")).toBe(true);
		fireEvent.input(box, { target: { value: "  hybrid " } });
		fireEvent.click(submit);
		expect(page.themeSearches).toEqual(["hybrid"]);
		await resultsTable();
		expect(api.backend.requestsTo("GET", /theme-search/)).toHaveLength(1);
	});

	it("lists the stocks whose themes contain the words, linking to their Company tab", async () => {
		mountStocks(api.backend, { theme: "VEHICLES" });
		const table = await resultsTable();
		expect(table.querySelector("caption")?.textContent).toBe(
			"Stocks with a theme containing “VEHICLES” · 1 stock",
		);
		const rows = within(table).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(1);
		const link = within(rows[0] as HTMLElement).getByRole("link", {
			name: "TOYOTA MOTOR CORPORATION",
		});
		expect(link.getAttribute("href")).toBe("#/stocks/jp:7203/company");
		expect(
			within(rows[0] as HTMLElement)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["Hybrid vehicles"]);
		// No "choose a stock" line under a theme search.
		expect(document.querySelector('[data-field="choose-stock"]')).toBeNull();
		expect(screen.getByRole("searchbox", { name: "Theme words" })).toHaveProperty(
			"value",
			"VEHICLES",
		);
	});

	it("shows Japanese names and themes in Japanese", async () => {
		mountStocks(api.backend, { theme: "自動車", locale: "ja" });
		const table = await resultsTable();
		expect(table.querySelector("caption")?.textContent).toBe(
			"「自動車」を含むテーマの銘柄 · 1 銘柄",
		);
		const headers = within(table)
			.getAllByRole("columnheader")
			.map((header) => header.textContent);
		expect(headers).toEqual(["銘柄", "コード", "一致したテーマ"]);
		expect(within(table).getByRole("link", { name: "トヨタ自動車" })).toBeTruthy();
		expect(
			within(table)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["自動車"]);
	});

	it("says when no stock has a matching theme", async () => {
		mountStocks(api.backend, { theme: "robotics" });
		const none = await waitFor(() => {
			const element = document.querySelector('[data-field="theme-search-none"]');
			if (element === null) throw new Error("no answer yet");
			return element;
		});
		expect(none.textContent).toBe(
			"No stock has a theme containing “robotics”. Only stocks with a business overview or an AI-written summary have themes.",
		);
	});

	it("states a failed search and retries it", async () => {
		api.backend.on("GET", /^\/api\/v1\/stocks\/theme-search\?/, () =>
			errorResponse(500, "INTERNAL", "boom"),
		);
		mountStocks(api.backend, { theme: "trucks" });
		const retry = await screen.findByRole("button", { name: "Try again" });
		expect(screen.getByText("The theme search failed")).toBeTruthy();
		fireEvent.click(retry);
		await waitFor(() => expect(api.backend.requestsTo("GET", /theme-search/)).toHaveLength(2));
	});

	it("links each theme on the Company tab to the theme search", async () => {
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" } });
		const themes = await screen.findByRole("list", { name: "Themes" });
		const links = within(themes).getAllByRole("link");
		expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
			["Automobiles", "#/stocks/themes/Automobiles"],
			["Hybrid vehicles", "#/stocks/themes/Hybrid%20vehicles"],
		]);
		expect(links[1]?.getAttribute("aria-label")).toBe("Find stocks with the theme Hybrid vehicles");
	});
});
