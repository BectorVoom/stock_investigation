import type { CompanySummaryView } from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCompany } from "./equitiesHarness.ts";
import { errorResponse } from "./fakeBackend.ts";
import { createStocksBackend, mountStocks, type StocksServer } from "./stocksHarness.tsx";

/**
 * The Stocks page's theme search (ADR-0066, ADR-0070): the box opens
 * `#/stocks/themes/<words>`, the results list 50 a page the stocks whose
 * shown themes contain the words, a stock's name shows it in a panel beside
 * them, and the Company tab's themes link to the search.
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
		expect(page.themeSearches).toEqual([{ words: "hybrid", page: 1 }]);
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
		// No "Close the results" link (removed 2026-11-04, ADR-0070 §5).
		expect(screen.queryByRole("link", { name: "Close the results" })).toBeNull();
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

/** `count` stocks `us:C000`, `us:C001`… whose one theme is Cloud software. */
function cloudStocks(count: number): string[] {
	const ids = Array.from({ length: count }, (_, index) => `us:C${String(index).padStart(3, "0")}`);
	for (const id of ids) api.summaryOf.set(id, summary([{ en: "Cloud software", ja: "クラウド" }]));
	return ids;
}

/** The pager's items as text, one space apart (the current page reads "1Page 1"). */
function pagerText(pages: HTMLElement): string {
	return [...pages.querySelectorAll("li")].map((item) => item.textContent?.trim()).join(" ");
}

function rowSymbols(table: HTMLElement): string[] {
	return within(table)
		.getAllByRole("row")
		.slice(1)
		.map((row) => row.getAttribute("data-stock-id") ?? "");
}

describe("Stocks page: theme results pages (ADR-0070)", () => {
	it("shows 50 stocks a page with the page numbers", async () => {
		const ids = cloudStocks(120);
		const page = mountStocks(api.backend, { theme: "cloud" });
		const table = await resultsTable();
		expect(rowSymbols(table)).toEqual(ids.slice(0, 50));
		expect(table.querySelector("caption")?.textContent).toBe(
			"Stocks with a theme containing “cloud” · 1–50 of 120 stocks",
		);
		const pages = screen.getByRole("navigation", { name: "Result pages" });
		expect(pagerText(pages)).toBe("1Page 1 2 3");
		// No Previous / Next (removed 2026-11-04); the current page is not a link.
		expect(within(pages).queryByRole("link", { name: "Previous" })).toBeNull();
		expect(within(pages).queryByRole("link", { name: "Next" })).toBeNull();
		expect(within(pages).queryByRole("link", { name: "Page 1" })).toBeNull();
		expect(pages.querySelector('[aria-current="page"]')?.textContent).toBe("1Page 1");
		expect(within(pages).getByRole("link", { name: "Page 3" }).getAttribute("href")).toBe(
			"#/stocks/themes/cloud/3",
		);
		expect(within(pages).getByRole("link", { name: "Page 2" }).getAttribute("href")).toBe(
			"#/stocks/themes/cloud/2",
		);

		fireEvent.click(within(pages).getByRole("link", { name: "Page 2" }));
		expect(page.themeSearches).toEqual([{ words: "cloud", page: 2 }]);
		await waitFor(() =>
			expect(rowSymbols(document.querySelector("table") as HTMLElement)).toEqual(
				ids.slice(50, 100),
			),
		);
		const url = new URL(
			api.backend.requestsTo("GET", /theme-search/).at(-1)?.path ?? "",
			"http://x",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({ q: "cloud", page: "2" });
		await waitFor(() => expect(document.activeElement?.tagName).toBe("CAPTION"));
	});

	it("shows 1 2 3 4 … and the last page when there are many pages", async () => {
		cloudStocks(500);
		mountStocks(api.backend, { theme: "cloud" });
		await resultsTable();
		const pages = screen.getByRole("navigation", { name: "Result pages" });
		expect(pagerText(pages)).toBe("1Page 1 2 3 4 … 10");
	});

	it("opens at the URL's page and shows the last page's rest", async () => {
		const ids = cloudStocks(120);
		mountStocks(api.backend, { theme: "cloud", themePage: 3 });
		const table = await resultsTable();
		expect(rowSymbols(table)).toEqual(ids.slice(100));
		expect(table.querySelector("caption")?.textContent).toBe(
			"Stocks with a theme containing “cloud” · 101–120 of 120 stocks",
		);
		const pages = screen.getByRole("navigation", { name: "Result pages" });
		expect(pages.querySelector('[aria-current="page"]')?.textContent).toBe("3Page 3");
		expect(within(pages).getByRole("link", { name: "Page 2" }).getAttribute("href")).toBe(
			"#/stocks/themes/cloud/2",
		);
		expect(within(pages).getByRole("link", { name: "Page 1" }).getAttribute("href")).toBe(
			"#/stocks/themes/cloud",
		);
	});

	it("shows no page controls when every stock fits on one page", async () => {
		cloudStocks(50);
		mountStocks(api.backend, { theme: "cloud" });
		const table = await resultsTable();
		expect(within(table).getAllByRole("row")).toHaveLength(51);
		expect(screen.queryByRole("navigation", { name: "Result pages" })).toBeNull();
	});

	it("says the pages in Japanese", async () => {
		cloudStocks(60);
		mountStocks(api.backend, { theme: "クラウド", locale: "ja" });
		const table = await resultsTable();
		expect(table.querySelector("caption")?.textContent).toBe(
			"「クラウド」を含むテーマの銘柄 · 60 銘柄中 1–50",
		);
		const pages = screen.getByRole("navigation", { name: "検索結果のページ" });
		expect(within(pages).getByRole("link", { name: "2 ページ" })).toBeTruthy();
	});
});

describe("Stocks page: a theme result's stock beside the results (ADR-0070)", () => {
	it("shows a clicked stock in a panel, on its Company tab, without leaving the search", async () => {
		const page = mountStocks(api.backend, { theme: "VEHICLES" });
		const table = await resultsTable();
		const link = within(table).getByRole("link", { name: "TOYOTA MOTOR CORPORATION" });
		fireEvent.click(link);
		// No navigation: the search stays in the URL.
		expect(page.navigations).toEqual([]);
		expect(page.theme()).toEqual({ words: "VEHICLES", page: 1 });
		const panel = await screen.findByRole("complementary", { name: "Chosen stock" });
		expect(panel.getAttribute("data-stock-id")).toBe("jp:7203");
		const heading = await within(panel).findByRole("heading", {
			name: "TOYOTA MOTOR CORPORATION · 7203",
		});
		await waitFor(() => expect(document.activeElement).toBe(heading));
		expect(within(panel).getByRole("tab", { name: "Company" }).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(
			within(panel).getByRole("link", { name: "Open on its own page" }).getAttribute("href"),
		).toBe("#/stocks/jp:7203/company");
		// The shown stock's row is marked; the results stay.
		expect(link.closest("tr")?.getAttribute("aria-current")).toBe("true");
		expect(document.querySelector("table")).not.toBeNull();
		// A tab switch stays in the panel and the link follows it.
		fireEvent.click(within(panel).getByRole("tab", { name: "Chart" }));
		expect(within(panel).getByRole("tab", { name: "Chart" }).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(
			within(panel).getByRole("link", { name: "Open on its own page" }).getAttribute("href"),
		).toBe("#/stocks/jp:7203");
		expect(page.navigations).toEqual([]);
	});

	it("swaps the panel for another stock, and closes it", async () => {
		api.summaryOf.set("jp:7205", summary([{ en: "Trucks and vehicles", ja: "トラック" }]));
		mountStocks(api.backend, { theme: "vehicles" });
		const table = await resultsTable();
		const links = within(table).getAllByRole("link");
		expect(links).toHaveLength(2);
		fireEvent.click(links[0] as HTMLElement);
		const panel = await screen.findByRole("complementary", { name: "Chosen stock" });
		expect(panel.getAttribute("data-stock-id")).toBe("jp:7203");
		fireEvent.click(links[1] as HTMLElement);
		await waitFor(() =>
			expect(
				screen.getByRole("complementary", { name: "Chosen stock" }).getAttribute("data-stock-id"),
			).toBe("jp:7205"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Close the stock" }));
		expect(screen.queryByRole("complementary", { name: "Chosen stock" })).toBeNull();
		expect(document.querySelector("table")).not.toBeNull();
	});

	it("keeps the panel across result pages and forgets it on a new search", async () => {
		const ids = cloudStocks(60);
		const page = mountStocks(api.backend, { theme: "cloud" });
		const table = await resultsTable();
		fireEvent.click(within(table).getAllByRole("link")[0] as HTMLElement);
		await screen.findByRole("complementary", { name: "Chosen stock" });
		fireEvent.click(screen.getByRole("link", { name: "Page 2" }));
		await waitFor(() =>
			expect(rowSymbols(document.querySelector("table") as HTMLElement)).toEqual(ids.slice(50)),
		);
		expect(
			screen.getByRole("complementary", { name: "Chosen stock" }).getAttribute("data-stock-id"),
		).toBe(ids[0]);
		page.setTheme({ words: "trucks", page: 1 });
		await waitFor(() =>
			expect(screen.queryByRole("complementary", { name: "Chosen stock" })).toBeNull(),
		);
	});
});
