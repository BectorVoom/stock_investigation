import type { WatchlistList } from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	initialHomeServerState,
	initialServerState,
	installHomeRoutes,
	mountApp,
} from "./appHarness.tsx";
import {
	createControllableVisibility,
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import { createStocksBackend, mountRegistered, mountStocks } from "./stocksHarness.tsx";
import {
	DISCONNECTED_GOOGLE,
	emptyDirectoryMarket,
	FRESH_STAMP,
	freshDirectory,
	installDirectoryRoutes,
	makeStock,
	NOW_MS,
	type WatchServer,
} from "./watchlistHarness.ts";

let backend: FakeBackend;
let server: WatchServer;

beforeEach(() => {
	({ backend, server } = createStocksBackend());
});

afterEach(cleanup);

function mount() {
	mountRegistered(backend);
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

/** Every request that is not a read: the page must send none of its own (ADR-0054). */
const writes = () => backend.requests.filter((request) => request.method !== "GET");

describe("Registered stocks page (ADR-0049 §2, ADR-0054)", () => {
	it("shows the lists only: no All stocks tab, the first list selected, no dates or statements", async () => {
		server.stocks = [
			makeStock(),
			makeStock({ stockId: "us:MSFT", symbol: "MSFT", name: "Microsoft Corp" }),
		];
		server.lists = [
			list({ listId: "list_a", title: "Semis", stockIds: ["us:MSFT"] }),
			list({ listId: "list_b", title: "Big tech", stockIds: ["us:AAPL", "us:MSFT"] }),
		];
		mount();
		const tablist = await screen.findByRole("tablist", { name: "Stock lists" });
		expect(
			within(tablist)
				.getAllByRole("tab")
				.map((tab) => tab.textContent),
		).toEqual(["Semis (1)", "Big tech (2)"]);
		expect(
			within(tablist).getByRole("tab", { name: "Semis (1)" }).getAttribute("aria-selected"),
		).toBe("true");
		expect(screen.queryByRole("tab", { name: /All stocks/ })).toBeNull();
		const table = within(screen.getByRole("tabpanel")).getByRole("table");
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent),
		).toEqual(["Symbol", "Market", "Actions"]);
		const row = within(table).getByRole("row", { name: /MSFT/ });
		expect(row.textContent).toContain("Microsoft Corp");
		expect(row.textContent).toContain("In lists: Semis and Big tech");
		// No date, no statements' sync, no calendar links and no sync menu in a row.
		expect(within(row).queryByRole("link", { name: "Add to Google Calendar" })).toBeNull();
		expect(within(row).queryByRole("button", { name: /More actions/ })).toBeNull();
		expect(
			within(row)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Remove from list"]);
		expect(document.querySelector('[data-field="financials"]')).toBeNull();
		expect(document.querySelector('[data-field="watchlist-status"]')).toBeNull();
	});

	it("says how to make a list when there is none, with no table", async () => {
		mount();
		const empty = await screen.findByText(/No lists yet\. Make one with New list\./);
		expect(empty.textContent).toContain("Stocks go on the Watchlist from the Stocks page.");
		expect(screen.queryByRole("tablist")).toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.getByRole("button", { name: "New list" }).hasAttribute("disabled")).toBe(false);
	});

	it("offers no sync of any kind and sends none, whatever is stale, missing or out of sync", async () => {
		const stale = new Date(NOW_MS - 25 * 3_600_000).toISOString();
		server.stocks = [
			makeStock({ lastRefreshedAt: stale, retrievedAt: stale }),
			makeStock({
				stockId: "us:MSFT",
				symbol: "MSFT",
				name: "Microsoft Corp",
				lastRefreshedAt: null,
				retrievedAt: null,
			}),
		];
		server.lists = [list({ stockIds: ["us:AAPL", "us:MSFT"] })];
		server.lastSucceededAt = null;
		// The Google Calendar is behind and a market's stock list is missing.
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "connected",
			calendarId: "cal_1",
			connectedAt: FRESH_STAMP,
			inSync: false,
		};
		server.directory.US = emptyDirectoryMarket();
		mount();
		await screen.findByRole("tablist", { name: "Stock lists" });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(writes()).toEqual([]);
		for (const name of [
			/Sync/,
			/Refresh/,
			"Update stock list",
			/Add .* to the Watchlist/,
			"Remove AAPL",
		]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
		// The companies list is the Stocks page's: this page never reads it.
		expect(backend.requestsTo("GET", /\/equities\/companies/)).toEqual([]);
	});

	it("shows the load error with Try again when the first read fails", async () => {
		backend.on("GET", /^\/api\/v1\/watchlist$/, () => errorResponse(500, "INTERNAL", "boom"));
		mount();
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Could not load the watchlist.");
		expect(alert.textContent).toContain("INTERNAL");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => {
			expect(backend.requestsTo("GET", /^\/api\/v1\/watchlist$/).length).toBeGreaterThan(1);
		});
	});

	it("does not poll after a failed first load: nothing is active", async () => {
		backend.on("GET", /^\/api\/v1\/watchlist$/, () => errorResponse(500, "INTERNAL", "boom"));
		mount();
		await screen.findByRole("alert");
		// The poller starts immediately when it starts at all — so one
		// request after a settle delay proves it never started (`data()`
		// null must not read as an active run).
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(backend.requestsTo("GET", /^\/api\/v1\/watchlist$/)).toHaveLength(1);
	});

	it("opens from an old Watchlist link as the Registered stocks page", async () => {
		const appBackend = createFakeBackend();
		installHomeRoutes(appBackend, initialServerState(), initialHomeServerState(false));
		appBackend.on("GET", /^\/api\/v1\/watchlist$/, () =>
			jsonResponse({
				stocks: [],
				lists: [],
				refresh: {
					activeRunId: null,
					activeRunState: null,
					lastSucceededAt: null,
					lastFailure: null,
				},
				feed: { enabled: false, createdAt: null },
				googleCalendar: {
					status: "disconnected",
					authUrl: null,
					calendarId: null,
					connectedAt: null,
					lastSyncedAt: null,
					lastSync: null,
					inSync: null,
					activeRunId: null,
					activeRunState: null,
					activeAction: null,
					lastFailure: null,
				},
			}),
		);
		installDirectoryRoutes(appBackend, freshDirectory, () => []);
		appBackend.on("GET", /^\/api\/v1\/equities\/companies$/, () => jsonResponse({ companies: [] }));
		// An old Watchlist link opens the Registered stocks page (ADR-0049 §1).
		window.location.hash = "#/watchlist";
		try {
			mountApp(appBackend);
			await screen.findByRole("heading", { level: 2, name: "Registered stocks" });
			const nav = screen.getByRole("navigation", { name: "Views" });
			expect(nav.textContent).toContain("Registered stocks");
			expect(nav.textContent).not.toContain("Watchlist");
			expect(nav.textContent).not.toContain("Equities");
			expect(await screen.findByText(/No lists yet/)).toBeTruthy();
			// The Stocks link reopens the last stock the Stocks page showed (ADR-0049 §1).
			const stocksLink = within(nav).getByRole("link", { name: "Stocks" });
			expect(stocksLink.getAttribute("href")).toBe("#/stocks");
			window.location.hash = "#/stocks/us:AAPL/news";
			await waitFor(() => expect(stocksLink.getAttribute("aria-current")).toBe("page"));
			window.location.hash = "#/registered";
			await screen.findByRole("heading", { level: 2, name: "Registered stocks" });
			expect(stocksLink.getAttribute("href")).toBe("#/stocks/us:AAPL/news");
		} finally {
			window.location.hash = "";
		}
	});

	it("has no calendar: the month grid and the calendar settings live elsewhere", async () => {
		server.lists = [list({ stockIds: ["us:AAPL"] })];
		mount();
		await screen.findByRole("tablist", { name: "Stock lists" });
		expect(screen.queryByRole("region", { name: "Calendar" })).toBe(null);
		expect(screen.queryByRole("button", { name: "Download calendar file (.ics)" })).toBe(null);
		expect(screen.queryByRole("button", { name: "Create subscription link" })).toBe(null);
		expect(screen.queryByRole("button", { name: "Connect Google Calendar" })).toBe(null);
		expect(screen.queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
	});
});

/**
 * The server syncs the earnings dates and the Google Calendar on its own
 * schedule (ADR-0051, ADR-0054); the pages only read (`createIdleReread`):
 * a conditional re-read every minute while the page is visible and no run
 * is followed, at once on a return to the page — and never a write.
 */
describe("server-scheduled syncs (idle re-read)", () => {
	const reads = () => backend.requestsTo("GET", /^\/api\/v1\/watchlist$/);

	/** Advances the fake clock in small steps until `ready` holds. */
	async function settleUntil(ready: () => boolean, label: string, maxMs = 10_000): Promise<void> {
		for (let elapsed = 0; elapsed < maxMs; elapsed += 50) {
			if (ready()) return;
			await vi.advanceTimersByTimeAsync(50);
		}
		if (!ready()) throw new Error(`gave up waiting: ${label}`);
	}
	const listShown = () => screen.queryByRole("tablist", { name: "Stock lists" }) !== null;

	beforeEach(() => {
		server.lists = [list({ stockIds: ["us:AAPL"] })];
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-reads every minute while visible; a run the server started is followed to its end", async () => {
		mountRegistered(backend);
		await settleUntil(listShown, "the lists");
		const first = reads().length;
		await vi.advanceTimersByTimeAsync(59_000);
		expect(reads()).toHaveLength(first);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(reads()).toHaveLength(first + 1);
		// Conditional: nothing moved, so the server answers 304.
		expect(reads().at(-1)?.headers["if-none-match"]).toMatch(/^"w-/);
		// The server queues an earnings sync at a runner claim; the next re-read sees it…
		server.activeRunId = "run_earnings_server";
		server.runState = "leased";
		await vi.advanceTimersByTimeAsync(60_000);
		// …and the poller follows it fast.
		const during = reads().length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(reads().length).toBeGreaterThan(during);
		// The run ends: the fast polls stop.
		server.activeRunId = null;
		server.lastSucceededAt = new Date(NOW_MS).toISOString();
		await vi.advanceTimersByTimeAsync(10_000);
		const after = reads().length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(reads()).toHaveLength(after);
		expect(writes()).toEqual([]);
	});

	it("never re-reads while hidden, and re-reads at once on becoming visible", async () => {
		const visibility = createControllableVisibility();
		mountRegistered(backend, { visibility });
		await settleUntil(listShown, "the lists");
		const before = reads().length;
		visibility.setVisible(false);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(reads()).toHaveLength(before);
		visibility.setVisible(true);
		await vi.advanceTimersByTimeAsync(10);
		expect(reads()).toHaveLength(before + 1);
	});

	/** Starts a server earnings run, lets the re-read see it, then ends it with Google out of sync. */
	async function serverRunThatChangesDates(): Promise<void> {
		server.activeRunId = "run_earnings_server";
		server.runState = "leased";
		await vi.advanceTimersByTimeAsync(61_000);
		server.activeRunId = null;
		server.lastSucceededAt = new Date(NOW_MS).toISOString();
		server.google = { ...server.google, inSync: false };
		await vi.advanceTimersByTimeAsync(10_000);
	}
	function connectedInSync(): void {
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "connected",
			calendarId: "cal_1",
			connectedAt: FRESH_STAMP,
			lastSyncedAt: FRESH_STAMP,
			inSync: true,
		};
	}

	it("on Registered stocks, a server run that changes the dates is never followed by a Google sync", async () => {
		connectedInSync();
		mountRegistered(backend);
		await settleUntil(listShown, "the lists");
		await serverRunThatChangesDates();
		expect(writes()).toEqual([]);
	});

	it("on the Stocks page, a server run the page watched never queues a Google sync", async () => {
		connectedInSync();
		mountStocks(backend, { route: { stockId: "us:AAPL", tab: "chart" } });
		await settleUntil(
			() => screen.queryByRole("heading", { name: "Apple Inc · AAPL" }) !== null,
			"the stock heading",
		);
		const before = reads().length;
		await serverRunThatChangesDates();
		// The page did follow the run, and wrote nothing.
		expect(reads().length).toBeGreaterThan(before + 1);
		expect(writes()).toEqual([]);
	});
});
