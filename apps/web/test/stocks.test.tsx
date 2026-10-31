import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCompany, NINTENDO } from "./equitiesHarness.ts";
import { errorResponse } from "./fakeBackend.ts";
import { lastOpenMenu } from "./openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import {
	createStocksBackend,
	mountStocks,
	STOCKS_TABLE,
	type StocksServer,
} from "./stocksHarness.tsx";
import { makeStock } from "./watchlistHarness.ts";

let api: StocksServer;

beforeEach(() => {
	resetGlobalFetchCalls();
	// The watchlist: AAPL and MSFT. Tracked: Apple (also watched) and Nintendo (only tracked).
	api = createStocksBackend({ companies: [makeCompany(), NINTENDO()] });
	api.server.stocks = [
		makeStock(),
		makeStock({ stockId: "us:MSFT", symbol: "MSFT", name: "Microsoft Corp" }),
	];
});
afterEach(() => {
	cleanup();
	assertOnlyIconFetches();
});

async function table(): Promise<HTMLElement> {
	const found = await screen.findByRole("table", { name: STOCKS_TABLE });
	// The companies arrive on their own read: wait for Nintendo's row.
	await waitFor(() => expect(found.querySelector('tr[data-stock-id="jp:7974"]')).not.toBeNull());
	return found;
}

function row(stockId: string): HTMLElement {
	const element = document.querySelector(`tr[data-stock-id="${stockId}"]`);
	if (!(element instanceof HTMLElement)) throw new Error(`no row ${stockId}`);
	return element;
}

function rowIds(): (string | null)[] {
	return [...document.querySelectorAll('table[data-field="stocks"] tbody tr')].map((entry) =>
		entry.getAttribute("data-stock-id"),
	);
}

function count(pattern: RegExp): number {
	return api.backend.requestsTo("GET", pattern).length;
}

describe("Stocks page list (ADR-0049 §2)", () => {
	it("lists the watchlist, then the tracked companies not on it, one row per stock", async () => {
		mountStocks(api.backend);
		await table();
		expect(rowIds()).toEqual(["us:AAPL", "us:MSFT", "jp:7974"]);
		expect(screen.getByRole("tab", { name: "All stocks (3)" })).toBeTruthy();
		expect(document.querySelector('[data-field="tracked-count"]')?.textContent).toBe(
			"Statements synced for 2 of 20 companies",
		);
		// Both on the watchlist and tracked: earnings and the sync status.
		const apple = row("us:AAPL");
		expect(apple.textContent).toContain("Q4 2026");
		expect(apple.querySelector('[data-field="sync-status"]')?.textContent).toMatch(
			/^Synced · Last synced/,
		);
		expect(within(apple).getByRole("button", { name: "Remove AAPL" })).toBeTruthy();
		// On the watchlist only: not synced.
		expect(row("us:MSFT").querySelector('[data-field="financials"]')?.textContent).toBe(
			"Not synced",
		);
		// Tracked only: not on the watchlist, its failure with its code, Add to Watchlist.
		const nintendo = row("jp:7974");
		expect(nintendo.textContent).toContain("Not on Watchlist");
		expect(nintendo.querySelector('[data-field="sync-failure"]')?.textContent).toBe(
			"FINANCIAL_SOURCE_NOT_CONFIGURED: Not configured: set EDINET_API_KEY in apps/runner/.env, then restart the runner.",
		);
		expect(
			within(nintendo).getByRole("button", { name: "Add 7974 to the Watchlist" }),
		).toBeTruthy();
		expect(within(nintendo).queryByRole("button", { name: /^Remove/ })).toBeNull();
		// Opening the page reads only the list: no stock is selected, no tab reads.
		expect(screen.getByText(/Choose a stock to see its chart/)).toBeTruthy();
		expect(count(/^\/api\/v1\/stocks\//)).toBe(0);
		expect(count(/\/statements\//)).toBe(0);
	});

	it("adds a tracked-only stock to the watchlist and queues its earnings dates", async () => {
		mountStocks(api.backend);
		await table();
		fireEvent.click(
			within(row("jp:7974")).getByRole("button", { name: "Add 7974 to the Watchlist" }),
		);
		await waitFor(() =>
			expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/stocks$/)[0]?.body).toEqual({
				market: "JP",
				symbol: "7974",
			}),
		);
		await waitFor(() => expect(row("jp:7974").textContent).not.toContain("Not on Watchlist"));
		// Still one row, now in watchlist order (added last).
		expect(rowIds()).toEqual(["us:AAPL", "us:MSFT", "jp:7974"]);
		await waitFor(() =>
			expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(1),
		);
	});

	it("syncs, starts and stops a stock's statements from the row menu, stopping only after confirmation", async () => {
		mountStocks(api.backend);
		await table();
		// Sync now on a tracked stock.
		fireEvent.click(within(row("us:AAPL")).getByRole("button", { name: "More actions for AAPL" }));
		fireEvent.click(within(lastOpenMenu()).getByRole("menuitem", { name: "Sync financials now" }));
		await waitFor(() =>
			expect(api.backend.requestsTo("POST", /\/eqc_apple\/sync$/)).toHaveLength(1),
		);
		await waitFor(() => expect(document.body.textContent).toContain("Apple Inc. will be synced"));
		// Start syncing a watched stock that is not tracked.
		fireEvent.click(within(row("us:MSFT")).getByRole("button", { name: "More actions for MSFT" }));
		fireEvent.click(
			within(lastOpenMenu()).getByRole("menuitem", { name: "Sync financial statements" }),
		);
		await waitFor(() =>
			expect(api.backend.requestsTo("POST", /^\/api\/v1\/equities\/companies$/)[0]?.body).toEqual({
				stockId: "us:MSFT",
			}),
		);
		await waitFor(() =>
			expect(row("us:MSFT").querySelector('[data-field="sync-status"]')?.textContent).toContain(
				"Queued",
			),
		);
		// Stop syncing a tracked-only stock: it leaves the list (it is in neither).
		fireEvent.click(within(row("jp:7974")).getByRole("button", { name: "More actions for 7974" }));
		fireEvent.click(
			within(lastOpenMenu()).getByRole("menuitem", { name: "Stop syncing financial statements" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Stop syncing the statements of 任天堂株式会社?",
		});
		expect(dialog.textContent).toContain("Its stored filings and values are kept");
		expect(dialog.textContent).toContain("it leaves this list");
		expect(api.backend.requestsTo("DELETE", /\/equities\/companies\//)).toHaveLength(0);
		fireEvent.click(within(dialog).getByRole("button", { name: "Stop syncing" }));
		await waitFor(() => expect(document.querySelector('tr[data-stock-id="jp:7974"]')).toBeNull());
		expect(document.body.textContent).toContain(
			"Stopped syncing the statements of 任天堂株式会社. Its stored data is kept.",
		);
	});

	it("keeps a watched stock whose statements stop syncing, and a tracked stock removed from the watchlist", async () => {
		mountStocks(api.backend);
		await table();
		fireEvent.click(within(row("us:AAPL")).getByRole("button", { name: "Remove AAPL" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove stock" }));
		// Still tracked: the row stays, now offering Add to Watchlist.
		await waitFor(() => expect(row("us:AAPL").textContent).toContain("Not on Watchlist"));
		expect(rowIds()).toEqual(["us:MSFT", "us:AAPL", "jp:7974"]);
		expect(api.backend.requestsTo("DELETE", /\/equities\/companies\//)).toHaveLength(0);
	});

	it("adds a stock and, with the checkbox (checked by default), syncs its statements; a refused second write is reported on its own", async () => {
		api.backend.on("POST", /^\/api\/v1\/equities\/companies$/, () =>
			errorResponse(409, "CONFLICT", "Another company is the same issuer."),
		);
		mountStocks(api.backend);
		await table();
		const checkbox = screen.getByRole("checkbox", {
			name: "Also sync annual financial statements",
		});
		expect(checkbox).toHaveProperty("checked", true);
		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "KO" } });
		fireEvent.click(screen.getByRole("button", { name: "Add stock" }));
		await waitFor(() => expect(document.querySelector('tr[data-stock-id="us:KO"]')).not.toBeNull());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain(
			"KO was added to the Watchlist, but its financial statements were not set to sync.",
		);
		expect(alert.querySelector("[data-error-code]")?.textContent).toBe("CONFLICT");
		// The first write stands.
		expect(row("us:KO").querySelector('[data-field="financials"]')?.textContent).toBe("Not synced");
	});

	it("adds without syncing when the checkbox is cleared, and disables it with its reason at the limit", async () => {
		mountStocks(api.backend);
		await table();
		const checkbox = screen.getByRole("checkbox", {
			name: "Also sync annual financial statements",
		});
		fireEvent.click(checkbox);
		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "KO" } });
		fireEvent.click(screen.getByRole("button", { name: "Add stock" }));
		await waitFor(() => expect(document.querySelector('tr[data-stock-id="us:KO"]')).not.toBeNull());
		await waitFor(() =>
			expect(
				api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/).length,
			).toBeGreaterThan(0),
		);
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/equities\/companies$/)).toHaveLength(0);
		cleanup();

		api = createStocksBackend({
			companies: Array.from({ length: 20 }, (_, index) =>
				makeCompany({ companyId: `eqc_${index}`, symbol: `S${index}` }),
			),
		});
		mountStocks(api.backend);
		await screen.findByRole("table", { name: STOCKS_TABLE });
		await waitFor(() =>
			expect(
				screen
					.getByRole("checkbox", { name: "Also sync annual financial statements" })
					.hasAttribute("disabled"),
			).toBe(true),
		);
		expect(document.querySelector('[data-field="track-limit"]')?.textContent).toBe(
			"Statements are synced for 20 companies, the most there can be. Stop syncing one to sync another.",
		);
	});
});

describe("Stocks page selection, URL and tabs (ADR-0049 §1, §3)", () => {
	it("selects a stock by its name: pushes the URL, presses and highlights the row, focuses the detail heading", async () => {
		const page = mountStocks(api.backend);
		await table();
		const show = within(row("us:MSFT")).getByRole("button", { name: "Microsoft Corp" });
		expect(show.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(show);
		expect(page.navigations).toEqual([
			{ stock: { stockId: "us:MSFT", tab: "chart" }, replace: false },
		]);
		const heading = await screen.findByRole("heading", { name: "Microsoft Corp · MSFT" });
		await waitFor(() => expect(document.activeElement).toBe(heading));
		expect(show.getAttribute("aria-pressed")).toBe("true");
		expect(row("us:MSFT").getAttribute("data-selected")).toBe("true");
		// The page knew the name: the heading read nothing.
		expect(count(/^\/api\/v1\/stocks\/us%3AMSFT$/)).toBe(0);
	});

	it("switches tabs by replacing the URL, keeps focus on the tab, and follows the keyboard (←/→ wrap, Home, End)", async () => {
		const page = mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "chart" } });
		await table();
		const strip = await screen.findByRole("tablist", { name: "Data of Apple Inc" });
		const tabs = within(strip).getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Chart",
			"Financial statements",
			"Company",
			"News",
		]);
		const [chart, financials, company, news] = tabs;
		if (
			chart === undefined ||
			financials === undefined ||
			company === undefined ||
			news === undefined
		) {
			throw new Error("four tabs");
		}
		// One tab stop; each tab controls its own panel.
		expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
		expect(chart.getAttribute("aria-controls")).toBe("stock-panel-chart");
		expect(document.getElementById("stock-panel-chart")?.getAttribute("aria-labelledby")).toBe(
			chart.id,
		);
		chart.focus();
		fireEvent.keyDown(chart, { key: "ArrowRight" });
		expect(page.navigations.at(-1)).toEqual({
			stock: { stockId: "us:AAPL", tab: "financials" },
			replace: true,
		});
		expect(document.activeElement).toBe(financials);
		expect(financials.getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(financials, { key: "End" });
		expect(document.activeElement).toBe(news);
		fireEvent.keyDown(news, { key: "ArrowRight" });
		expect(document.activeElement).toBe(chart);
		fireEvent.keyDown(chart, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(news);
		fireEvent.keyDown(news, { key: "Home" });
		expect(document.activeElement).toBe(chart);
		fireEvent.click(company);
		expect(page.navigations.at(-1)).toEqual({
			stock: { stockId: "us:AAPL", tab: "company" },
			replace: true,
		});
		// Every tab switch replaced the entry: none pushed.
		expect(page.navigations.every((entry) => entry.replace)).toBe(true);
	});

	it("mounts a panel on its first showing and keeps it (with its state) while the stock stays selected", async () => {
		const page = mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "chart" } });
		await table();
		await waitFor(() =>
			expect(
				document.querySelector('#stock-panel-chart [data-field="stock-chart-tab"]'),
			).not.toBeNull(),
		);
		// Not shown yet: no panel content, no read.
		expect(document.getElementById("stock-panel-financials")?.childElementCount).toBe(0);
		expect(count(/\/statements\//)).toBe(0);
		fireEvent.click(screen.getByRole("tab", { name: "Financial statements" }));
		const panel = await waitFor(() => {
			const found = document.querySelector("#stock-panel-financials table[data-statement]");
			if (found === null) throw new Error("no statement yet");
			return found;
		});
		expect(panel.getAttribute("data-statement")).toBe("income-statement");
		const statements = document.querySelector('[data-segmented="equities-statement"]');
		if (!(statements instanceof HTMLElement)) throw new Error("no switch");
		fireEvent.click(within(statements).getByRole("button", { name: "Balance sheet" }));
		await waitFor(() =>
			expect(
				document
					.querySelector("#stock-panel-financials table[data-statement]")
					?.getAttribute("data-statement"),
			).toBe("balance-sheet"),
		);
		// Switching away and back within the fresh window (ADR-0049 §3 rule 3)
		// sends nothing at all: not the statement, not the chart's prices.
		const requestsBefore = api.backend.requests.length;
		fireEvent.click(screen.getByRole("tab", { name: "Chart" }));
		expect(document.getElementById("stock-panel-financials")?.hidden).toBe(true);
		fireEvent.click(screen.getByRole("tab", { name: "Financial statements" }));
		// The same panel, with its statement choice.
		expect(
			document
				.querySelector("#stock-panel-financials table[data-statement]")
				?.getAttribute("data-statement"),
		).toBe("balance-sheet");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(api.backend.requests.slice(requestsBefore)).toEqual([]);
		// Another stock disposes the panels: Financial statements is not mounted for it.
		page.setRoute({ stockId: "us:MSFT", tab: "chart" });
		await screen.findByRole("heading", { name: "Microsoft Corp · MSFT" });
		expect(document.getElementById("stock-panel-financials")?.childElementCount).toBe(0);
	});

	it("shows a stock the URL names that neither list holds, heading from its stored listing", async () => {
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" } });
		await table();
		expect(
			await screen.findByRole("heading", { name: "TOYOTA MOTOR CORPORATION · 7203" }),
		).toBeTruthy();
		// One profile read serves the heading and the Company tab.
		await waitFor(() => expect(document.body.textContent).toContain("Prime"));
		expect(count(/^\/api\/v1\/stocks\/jp%3A7203$/)).toBe(1);
		expect(document.body.textContent).toContain("Statements are not synced for this stock");
	});

	it("deselects a stock that leaves both lists", async () => {
		const page = mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "chart" } });
		await table();
		await screen.findByRole("heading", { name: "Microsoft Corp · MSFT" });
		fireEvent.click(within(row("us:MSFT")).getByRole("button", { name: "Remove MSFT" }));
		fireEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove stock" }),
		);
		await waitFor(() => expect(page.route()).toBeNull());
		expect(page.navigations.at(-1)).toEqual({ stock: null, replace: true });
		expect(screen.getByText(/Choose a stock to see its chart/)).toBeTruthy();
	});
});
