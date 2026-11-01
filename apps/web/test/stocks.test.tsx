import type { WatchlistList } from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCompany, NINTENDO } from "./equitiesHarness.ts";
import { createControllableVisibility, deferred, errorResponse } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import {
	createStocksBackend,
	mountRegistered,
	mountStocks,
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

function count(pattern: RegExp): number {
	return api.backend.requestsTo("GET", pattern).length;
}

describe("Stocks page: URL and tabs (ADR-0049 §1, §3)", () => {
	it("links each list row's name to its Chart tab on the Stocks page, reading no stock data", async () => {
		api.server.lists = [list({ stockIds: ["us:AAPL", "us:MSFT"] })];
		mountRegistered(api.backend);
		const table = await screen.findByRole("table", { name: "Stocks in Semis" });
		const show = within(table).getByRole("link", { name: "Microsoft Corp" });
		expect(show.getAttribute("href")).toBe("#/stocks/us:MSFT");
		// The list page reads no stock's profile, prices or news, and no statements.
		expect(count(/^\/api\/v1\/stocks\//)).toBe(0);
		expect(count(/\/equities\//)).toBe(0);
	});

	it("with no stock in the URL, says where to choose one and reads nothing", async () => {
		mountStocks(api.backend);
		const hint = await screen.findByText(/No stock is shown\./);
		expect(
			within(hint).getByRole("link", { name: "Open Registered stocks" }).getAttribute("href"),
		).toBe("#/registered");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(api.backend.requests).toEqual([]);
	});

	it("queues no earnings refresh or Google sync for a shown stock, even with dates never fetched", async () => {
		api.server.stocks = [makeStock({ lastRefreshedAt: null, retrievedAt: null })];
		api.server.lastSucceededAt = null;
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "chart" } });
		await screen.findByRole("heading", { name: "Apple Inc · AAPL" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(api.backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("names a shown stock from the registered stocks, focuses its heading, and links back to them", async () => {
		mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "chart" } });
		const heading = await screen.findByRole("heading", { name: "Microsoft Corp · MSFT" });
		// Arriving from a link: focus lands on the heading (the linking page may have been scrolled).
		await waitFor(() => expect(document.activeElement).toBe(heading));
		expect(screen.getByRole("link", { name: "Choose another stock" }).getAttribute("href")).toBe(
			"#/registered",
		);
		// The page knew the name: the heading read nothing.
		expect(count(/^\/api\/v1\/stocks\/us%3AMSFT$/)).toBe(0);
		// The Stocks page has no stock list.
		expect(screen.queryByRole("table", { name: /^Stocks in / })).toBeNull();
	});

	it("switches tabs by replacing the URL, keeps focus on the tab, and follows the keyboard (←/→ wrap, Home, End)", async () => {
		const page = mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "chart" } });
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
		expect(
			await screen.findByRole("heading", { name: "TOYOTA MOTOR CORPORATION · 7203" }),
		).toBeTruthy();
		// One profile read serves the heading and the Company tab.
		await waitFor(() => expect(document.body.textContent).toContain("Prime"));
		expect(count(/^\/api\/v1\/stocks\/jp%3A7203$/)).toBe(1);
	});

	it("keeps showing a stock that stops being registered while shown", async () => {
		const visibility = createControllableVisibility();
		const page = mountStocks(api.backend, {
			route: { stockId: "jp:7974", tab: "chart" },
			visibility,
		});
		await screen.findByRole("heading", { name: /7974/ });
		// Nintendo (tracked only) stops syncing in another tab; the catch-up poll sees it.
		const polls = count(/^\/api\/v1\/equities\/companies$/);
		api.equities.companies.splice(0);
		api.equities.revision += 1;
		visibility.setVisible(false);
		visibility.setVisible(true);
		await waitFor(() => expect(count(/^\/api\/v1\/equities\/companies$/)).toBe(polls + 1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(page.navigations).toEqual([]);
		expect(screen.getByRole("tablist", { name: /^Data of / })).toBeTruthy();
	});
});

describe("Stocks page review fixes", () => {
	it("heads a stock with no stored name by its symbol alone", async () => {
		mountStocks(api.backend, { route: { stockId: "us:ZZZZ", tab: "chart" } });
		await waitFor(() => expect(count(/^\/api\/v1\/stocks\/us%3AZZZZ$/)).toBe(1));
		const heading = await screen.findByRole("heading", { name: "ZZZZ" });
		expect(heading.textContent).toBe("ZZZZ");
		expect(screen.getByRole("tablist", { name: "Data of ZZZZ" })).toBeTruthy();
	});

	it("says the statements are not loaded when the companies read fails, and offers no financial action", async () => {
		api.backend.on("GET", /^\/api\/v1\/equities\/companies$/, () =>
			errorResponse(500, "INTERNAL", "boom"),
		);
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "financials" } });
		expect(
			await screen.findByText("Could not load the companies whose statements are synced."),
		).toBeTruthy();
		await waitFor(() =>
			expect(document.querySelector('[data-field="financials-unknown"]')).not.toBeNull(),
		);
		expect(screen.queryByRole("button", { name: "Sync financial statements" })).toBeNull();
	});
});

function list(overrides: Partial<WatchlistList> = {}): WatchlistList {
	return {
		listId: "list_semis",
		title: "Semis",
		stockIds: [],
		version: 1,
		createdAt: "2026-10-25T00:00:00Z",
		updatedAt: "2026-10-25T00:00:00Z",
		...overrides,
	};
}

/** The detail's Watchlist part: its status line and its add button. */
async function watchlistPart(): Promise<HTMLElement> {
	return await waitFor(() => {
		const part = document.querySelector('[data-field="stock-watchlist"]');
		if (!(part instanceof HTMLElement)) throw new Error("no Watchlist part yet");
		return part;
	});
}

async function search(text: string): Promise<HTMLElement> {
	const box = screen.getByRole("combobox", { name: "Search stocks" });
	fireEvent.input(box, { target: { value: text } });
	return await screen.findByRole("listbox", { name: "Matching stocks" });
}

describe("Stocks page: Find a stock (ADR-0050 §1)", () => {
	it("reads nothing until the owner types; a pick opens the stock and clears the box", async () => {
		const page = mountStocks(api.backend);
		await screen.findByRole("region", { name: "Find a stock" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(api.backend.requests).toEqual([]);
		const listbox = await search("toyota");
		const toyota = await within(listbox).findByText("TOYOTA MOTOR CORPORATION");
		// The stored lists' status is read once, to explain an empty answer; no download is queued.
		expect(count(/^\/api\/v1\/watchlist\/directory$/)).toBe(1);
		fireEvent.click(toyota);
		expect(page.navigations.at(-1)).toEqual({
			stock: { stockId: "jp:7203", tab: "chart" },
			replace: false,
		});
		expect(screen.getByRole("combobox", { name: "Search stocks" })).toHaveProperty("value", "");
		await screen.findByRole("heading", { name: "TOYOTA MOTOR CORPORATION · 7203" });
		expect(api.backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("opens a stock already on the watchlist too (the add form greys those out)", async () => {
		const page = mountStocks(api.backend);
		const listbox = await search("apple");
		const option = await waitFor(() => {
			const found = listbox.querySelector('[role="option"][data-stock-id="us:AAPL"]');
			if (!(found instanceof HTMLElement)) throw new Error("no AAPL option yet");
			return found;
		});
		expect(option.getAttribute("aria-disabled")).toBeNull();
		fireEvent.click(option);
		expect(page.route()).toEqual({ stockId: "us:AAPL", tab: "chart" });
		await screen.findByRole("heading", { name: "Apple Inc · AAPL" });
		expect(count(/^\/api\/v1\/watchlist\/directory$/)).toBe(1);
	});
});

describe("Stocks page: Add to Watchlist (ADR-0050 §2)", () => {
	it("puts a stock that is not on the watchlist there alone when no list is ticked, and says its dates are coming", async () => {
		api.server.lists = [list()];
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const part = await watchlistPart();
		expect(part.querySelector('[data-field="stock-watchlist-status"]')).toBeNull();
		fireEvent.click(within(part).getByRole("button", { name: "Add to Watchlist" }));
		const dialog = await screen.findByRole("dialog", { name: "Add 7203 to the Watchlist" });
		const semis = within(dialog).getByRole("checkbox", { name: /Semis/ });
		expect(semis).toHaveProperty("checked", false);
		await waitFor(() => expect(document.activeElement).toBe(semis));
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const adds = api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/stocks$/);
		expect(adds.map((request) => request.body)).toEqual([{ market: "JP", symbol: "7203" }]);
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/lists\//)).toEqual([]);
		// The server fetches the new stock's dates at the runner's next claim: no refresh is queued.
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toEqual([]);
		await screen.findByText(
			"Added 7203 to the Watchlist. Its earnings dates are being fetched by the local runner.",
		);
		await waitFor(() =>
			expect(part.querySelector('[data-field="stock-watchlist-status"]')?.textContent).toBe(
				"On the Watchlist",
			),
		);
		// A list can still take it: the button now offers a list.
		const again = within(part).getByRole("button", { name: "Add to a list" });
		await waitFor(() => expect(document.activeElement).toBe(again));
	});

	it("adds a watched stock to each ticked list; lists that hold it or are full cannot be ticked", async () => {
		const filler = Array.from({ length: 12 }, (_, index) =>
			makeStock({ stockId: `us:F${index}`, symbol: `F${index}`, name: `Filler ${index}` }),
		);
		// A list holds watchlist stocks only (the contract checks it).
		api.server.stocks = [...api.server.stocks, ...filler];
		const fullIds = filler.map((stock) => stock.stockId);
		api.server.lists = [
			list({ listId: "list_big", title: "Big tech", stockIds: ["us:MSFT"] }),
			list({ listId: "list_full", title: "Full one", stockIds: fullIds }),
			list({ listId: "list_semis", title: "Semis" }),
			list({ listId: "list_value", title: "Value" }),
		];
		mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "chart" } });
		const part = await watchlistPart();
		expect(part.querySelector('[data-field="stock-watchlist-status"]')?.textContent).toBe(
			"On the Watchlist · In lists: Big tech",
		);
		fireEvent.click(within(part).getByRole("button", { name: "Add to a list" }));
		const dialog = await screen.findByRole("dialog", { name: "Add MSFT to lists" });
		const box = (name: RegExp) => within(dialog).getByRole("checkbox", { name });
		expect(
			[box(/Big tech/), box(/Full one/)].map((entry) => entry.hasAttribute("disabled")),
		).toEqual([true, true]);
		expect(box(/Big tech/)).toHaveProperty("checked", true);
		expect(dialog.textContent).toContain("Already in this list");
		expect(dialog.textContent).toContain("Full · 12 of 12 stocks");
		const add = within(dialog).getByRole("button", { name: "Add" });
		// Already watched: Add waits for a ticked list.
		expect(add.hasAttribute("disabled")).toBe(true);
		fireEvent.click(box(/Semis/));
		fireEvent.click(box(/Value/));
		expect(add.hasAttribute("disabled")).toBe(false);
		fireEvent.click(add);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(
			api.backend
				.requestsTo("POST", /^\/api\/v1\/watchlist\/lists\/[^/]+\/stocks$/)
				.map((request) => [request.path, request.body]),
		).toEqual([
			["/api/v1/watchlist/lists/list_semis/stocks", { market: "US", symbol: "MSFT" }],
			["/api/v1/watchlist/lists/list_value/stocks", { market: "US", symbol: "MSFT" }],
		]);
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/(stocks|refresh)$/)).toEqual([]);
		await screen.findByText("Added MSFT to Semis and Value.");
		await waitFor(() =>
			expect(part.querySelector('[data-field="stock-watchlist-status"]')?.textContent).toBe(
				"On the Watchlist · In lists: Big tech, Semis, and Value",
			),
		);
		// Every list that can take it now holds it: no add is offered (only Remove from
		// Watchlist), and focus lands on the heading.
		expect(
			within(part)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Remove from Watchlist"]);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "Microsoft Corp · MSFT" }),
			),
		);
	});

	it("keeps the dialog open with the reason when the watchlist refuses, and Escape returns focus", async () => {
		api.server.stocks = Array.from({ length: 50 }, (_, index) =>
			makeStock({ stockId: `us:W${index}`, symbol: `W${index}`, name: `Watched ${index}` }),
		);
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const part = await watchlistPart();
		const button = within(part).getByRole("button", { name: "Add to Watchlist" });
		fireEvent.click(button);
		const dialog = await screen.findByRole("dialog", { name: "Add 7203 to the Watchlist" });
		expect(within(dialog).getByText(/You have no lists yet\./)).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		await within(dialog).findByText(
			"The watchlist is full (50 stocks): remove a stock from it before adding a new one.",
		);
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toEqual([]);
		fireEvent(dialog, new Event("cancel", { cancelable: true }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(button));
	});

	it("a refusal that changed nothing re-reads but starts no Google Calendar sync", async () => {
		api.server.google = {
			...api.server.google,
			status: "connected",
			calendarId: "primary",
			connectedAt: "2026-10-20T00:00:00Z",
			lastSyncedAt: "2026-10-20T00:00:00Z",
			inSync: false,
		};
		api.server.lists = [list({ listId: "list_gone", title: "Gone" })];
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const part = await watchlistPart();
		fireEvent.click(within(part).getByRole("button", { name: "Add to Watchlist" }));
		const dialog = await screen.findByRole("dialog", { name: "Add 7203 to the Watchlist" });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Gone/ }));
		api.server.lists = [];
		const readsBefore = count(/^\/api\/v1\/watchlist$/);
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		await within(dialog).findByText(/changed elsewhere/);
		expect(count(/^\/api\/v1\/watchlist$/)).toBeGreaterThan(readsBefore);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(
			api.backend.requests.filter((request) => request.method === "POST").map((r) => r.path),
		).toEqual(["/api/v1/watchlist/lists/list_gone/stocks"]);
	});

	it("puts a stock that is not on the watchlist in each ticked list (the list add watches it first)", async () => {
		api.server.lists = [list(), list({ listId: "list_autos", title: "Autos" })];
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const part = await watchlistPart();
		fireEvent.click(within(part).getByRole("button", { name: "Add to Watchlist" }));
		const dialog = await screen.findByRole("dialog", { name: "Add 7203 to the Watchlist" });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Autos/ }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(
			api.backend
				.requestsTo("POST", /^\/api\/v1\/watchlist\/(stocks|lists\/[^/]+\/stocks)$/)
				.map((request) => request.path),
		).toEqual(["/api/v1/watchlist/lists/list_autos/stocks"]);
		await screen.findByText(
			"Added 7203 to the Watchlist and to Autos. Its earnings dates are being fetched by the local runner.",
		);
		// The server fetches the new stock's dates at the runner's next claim: no refresh is queued.
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toEqual([]);
		expect(part.querySelector('[data-field="stock-watchlist-status"]')?.textContent).toBe(
			"On the Watchlist · In lists: Autos",
		);
	});

	it("after a partial failure shows what landed, keeps the reason, and re-reads after a refusal", async () => {
		api.server.lists = [list(), list({ listId: "list_gone", title: "Gone" })];
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const part = await watchlistPart();
		fireEvent.click(within(part).getByRole("button", { name: "Add to Watchlist" }));
		const dialog = await screen.findByRole("dialog", { name: "Add 7203 to the Watchlist" });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Semis/ }));
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Gone/ }));
		// "Gone" is deleted elsewhere before its add arrives.
		api.server.lists = api.server.lists.filter((entry) => entry.listId !== "list_gone");
		const readsBefore = count(/^\/api\/v1\/watchlist$/);
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		await within(dialog).findByText(/changed elsewhere/);
		expect(count(/^\/api\/v1\/watchlist$/)).toBeGreaterThan(readsBefore);
		// The dialog now shows the current lists: 7203 is watched and in Semis; Gone is gone.
		await screen.findByRole("dialog", { name: "Add 7203 to lists" });
		expect(within(dialog).queryByRole("checkbox", { name: /Gone/ })).toBeNull();
		expect(within(dialog).getByRole("checkbox", { name: /Semis/ }).hasAttribute("disabled")).toBe(
			true,
		);
		expect(dialog.textContent).toContain("Already in this list");
		// The server fetches the new stock's dates at the runner's next claim: no refresh is queued.
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toEqual([]);
	});

	it("ignores Escape while a write is on its way, so its refusal is still shown", async () => {
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const part = await watchlistPart();
		const held = deferred<Response>();
		api.backend.on("POST", /^\/api\/v1\/watchlist\/stocks$/, () => held.promise);
		fireEvent.click(within(part).getByRole("button", { name: "Add to Watchlist" }));
		const dialog = await screen.findByRole("dialog", { name: "Add 7203 to the Watchlist" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		fireEvent(dialog, new Event("cancel", { cancelable: true }));
		expect(screen.getByRole("dialog")).toBe(dialog);
		held.resolve(errorResponse(400, "VALIDATION_FAILED", "No.", "WATCHLIST_FULL"));
		await within(dialog).findByText(/The watchlist is full/);
	});

	it("finishes an add when another stock is opened meanwhile: the re-read still follows", async () => {
		const page = mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const part = await watchlistPart();
		const held = deferred<void>();
		api.backend.on("POST", /^\/api\/v1\/watchlist\/stocks$/, async () => {
			await held.promise;
			api.server.stocks = [
				...api.server.stocks,
				makeStock({ stockId: "jp:7203", market: "JP", symbol: "7203", name: null }),
			];
			// Answer the whole watchlist, as the real route does.
			return await api.backend.fetch("/api/v1/watchlist", { method: "GET" });
		});
		fireEvent.click(within(part).getByRole("button", { name: "Add to Watchlist" }));
		const dialog = await screen.findByRole("dialog", { name: "Add 7203 to the Watchlist" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		page.setRoute({ stockId: "us:MSFT", tab: "chart" });
		await screen.findByRole("heading", { name: "Microsoft Corp · MSFT" });
		held.resolve();
		await waitFor(() =>
			expect(api.server.stocks.some((stock) => stock.stockId === "jp:7203")).toBe(true),
		);
		// The server fetches the new stock's dates at the runner's next claim: no refresh is queued.
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toEqual([]);
		// Back on 7203, the page knows it is watched.
		page.setRoute({ stockId: "jp:7203", tab: "chart" });
		await waitFor(() =>
			expect(document.querySelector('[data-field="stock-watchlist-status"]')?.textContent).toBe(
				"On the Watchlist",
			),
		);
	});

	it("queues no staleness refresh when a run it watched after a list add ends", async () => {
		const stale = "2026-01-01T00:00:00Z";
		api.server.stocks = api.server.stocks.map((stock) => ({
			...stock,
			lastRefreshedAt: stale,
			retrievedAt: stale,
		}));
		api.server.lastSucceededAt = stale;
		api.server.activeRunId = "run_earnings";
		api.server.runState = "running";
		api.server.lists = [list()];
		const visibility = createControllableVisibility();
		mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "chart" }, visibility });
		const part = await watchlistPart();
		fireEvent.click(within(part).getByRole("button", { name: "Add to a list" }));
		const dialog = await screen.findByRole("dialog", { name: "Add MSFT to lists" });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Semis/ }));
		const readsAtAdd = count(/^\/api\/v1\/watchlist$/);
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// The page follows the active run (its poller started with the first read) and re-read.
		await waitFor(() => expect(count(/^\/api\/v1\/watchlist$/)).toBeGreaterThan(readsAtAdd));
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The run ends; the next poll (hidden → visible polls at once) sees it.
		api.server.activeRunId = null;
		const readsBefore = count(/^\/api\/v1\/watchlist$/);
		visibility.setVisible(false);
		visibility.setVisible(true);
		await waitFor(() => expect(count(/^\/api\/v1\/watchlist$/)).toBeGreaterThan(readsBefore));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toEqual([]);
	});

	it("removes a stock from the Watchlist after a confirmation that says how many lists it leaves", async () => {
		api.server.lists = [
			list({ listId: "list_semis", title: "Semis", stockIds: ["us:AAPL"] }),
			list({ listId: "list_big", title: "Big tech", stockIds: ["us:MSFT", "us:AAPL"] }),
		];
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "chart" } });
		const part = await watchlistPart();
		const remove = within(part).getByRole("button", { name: "Remove from Watchlist" });
		// Cancel leaves everything as it was and returns focus.
		fireEvent.click(remove);
		const first = await screen.findByRole("dialog", { name: "Remove AAPL?" });
		expect(first.textContent).toContain(
			"AAPL and its earnings dates are removed from the watchlist.",
		);
		expect(first.querySelector('[data-field="remove-leaves-lists"]')?.textContent).toBe(
			"Also removes it from 2 lists.",
		);
		fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(remove));
		expect(api.backend.requestsTo("DELETE", /\/watchlist\/stocks\//)).toEqual([]);

		fireEvent.click(remove);
		const dialog = await screen.findByRole("dialog", { name: "Remove AAPL?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove stock" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(api.backend.requestsTo("DELETE", /\/watchlist\/stocks\//).map((r) => r.path)).toEqual([
			"/api/v1/watchlist/stocks/us%3AAAPL",
		]);
		// Off the Watchlist now: the stock stays shown and offers Add to Watchlist again.
		await waitFor(() =>
			expect(within(part).getByRole("button", { name: "Add to Watchlist" })).toBeTruthy(),
		);
		expect(within(part).queryByRole("button", { name: "Remove from Watchlist" })).toBeNull();
		expect(await screen.findByText("Removed AAPL.")).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("heading", { name: /· AAPL$/ })),
		);
		// Nothing but the removal was written: no sync of any kind (ADR-0054).
		expect(
			api.backend.requests.filter((request) => request.method !== "GET").map((r) => r.method),
		).toEqual(["DELETE"]);
	});

	it("says nothing about lists when the stock is in none, and offers no remove off the Watchlist", async () => {
		mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "chart" } });
		const part = await watchlistPart();
		fireEvent.click(within(part).getByRole("button", { name: "Remove from Watchlist" }));
		const dialog = await screen.findByRole("dialog", { name: "Remove MSFT?" });
		expect(dialog.querySelector('[data-field="remove-leaves-lists"]')).toBeNull();
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		cleanup();
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "chart" } });
		const other = await watchlistPart();
		expect(within(other).queryByRole("button", { name: "Remove from Watchlist" })).toBeNull();
	});

	it("speaks Japanese", async () => {
		api.server.lists = [list()];
		mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "chart" }, locale: "ja" });
		await screen.findByRole("region", { name: "銘柄を探す" });
		const part = await watchlistPart();
		expect(part.querySelector('[data-field="stock-watchlist-status"]')?.textContent).toBe(
			"ウォッチリストに登録済み",
		);
		expect(within(part).getByRole("button", { name: "ウォッチリストから削除" })).toBeTruthy();
		fireEvent.click(within(part).getByRole("button", { name: "リストに追加" }));
		await screen.findByRole("dialog", { name: "MSFT をリストに追加" });
	});
});
