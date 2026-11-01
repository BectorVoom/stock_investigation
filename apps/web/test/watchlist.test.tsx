import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatInstant } from "../src/lib/format.ts";
import {
	initialHomeServerState,
	initialServerState,
	installHomeRoutes,
	mountApp,
} from "./appHarness.tsx";
import type { EquitiesServer } from "./equitiesHarness.ts";
import {
	createControllableVisibility,
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import {
	addToWatchlistFromRow,
	createStocksBackend,
	mountRegistered,
	mountStocks,
	STOCKS_TABLE,
	trackedOnly,
} from "./stocksHarness.tsx";
import {
	DISCONNECTED_GOOGLE,
	FRESH_STAMP,
	freshDirectory,
	installDirectoryRoutes,
	makeStock,
	NOW_MS,
	UPCOMING_DATE,
	type WatchServer,
} from "./watchlistHarness.ts";

let backend: FakeBackend;
let server: WatchServer;
let equities: EquitiesServer;

beforeEach(() => {
	({ backend, server, equities } = createStocksBackend());
});

afterEach(cleanup);

function mount() {
	mountRegistered(backend);
}

describe("Registered stocks page: the Watchlist half (FR-018, ADR-0049 §2)", () => {
	it("lists registered stocks with the next announcement, provenance and refresh status", async () => {
		mount();
		const table = await screen.findByRole("table", { name: STOCKS_TABLE });
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain("Apple Inc");
		expect(row.textContent).toContain(UPCOMING_DATE);
		expect(row.textContent).toContain("Q4 2026");
		expect(row.textContent).toContain("after market close");
		expect(row.textContent).toContain(formatInstant(FRESH_STAMP));
		expect(within(row).getByRole("link", { name: "Finnhub" }).getAttribute("href")).toBe(
			"https://finnhub.io/",
		);
		expect(
			within(row).getByRole("link", { name: "Add to Google Calendar" }).getAttribute("href"),
		).toContain("calendar.google.com");
		expect(
			within(row).getByRole("link", { name: "Add to Outlook" }).getAttribute("href"),
		).toContain("outlook.live.com");
		// Refreshed fine and idle: the refresh line says nothing (ADR-0050 §5).
		expect(document.querySelector('[data-field="watchlist-status"]')?.textContent).toBe("");
	});

	it("states undecided dates and unavailable reasons as text, never blank", async () => {
		server.stocks = [
			makeStock({
				stockId: "jp:7203",
				market: "JP",
				symbol: "7203",
				name: null,
				source: "jpx",
				publisher: "Japan Exchange Group (JPX)",
				sourceUrl:
					"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
				lastRefreshedAt: null,
				retrievedAt: null,
				unavailable: null,
				events: [
					{
						periodKey: "fy2027-03-31-second-quarter",
						announcementDate: null,
						fiscalPeriodLabel: "Second quarter",
						fiscalPeriodEnd: "2027-03-31",
						timing: "unknown",
					},
				],
			}),
		];
		mount();
		const table = await screen.findByRole("table", { name: STOCKS_TABLE });
		const row = within(table).getByRole("row", { name: /7203/ });
		// No stored name yet: the Show button names the symbol.
		expect(within(row).getByRole("link", { name: "Show 7203" })).toBeTruthy();
		expect(row.textContent).toContain("date undecided");
		expect(row.textContent).toContain("not retrieved yet");
	});

	it("adds the provider's answer status to a stock's reason only when the provider caused it", async () => {
		server.stocks = [
			makeStock({
				events: [],
				unavailable: {
					code: "RATE_LIMITED",
					reason: "The provider rate limit was reached.",
					upstreamStatus: 429,
				},
			}),
			makeStock({
				stockId: "us:MSFT",
				symbol: "MSFT",
				name: "Microsoft Corp",
				events: [],
				unavailable: {
					code: "SOURCE_FAILED",
					reason: "The earnings source request failed.",
					upstreamStatus: null,
				},
			}),
		];
		mount();
		const table = await screen.findByRole("table", { name: STOCKS_TABLE });
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).toContain(
			"unavailable (The provider rate limit was reached. The service answered HTTP 429.)",
		);
		const msft = within(table).getByRole("row", { name: /MSFT/ }).textContent ?? "";
		expect(msft).toContain("unavailable (The earnings source request failed.)");
		expect(msft).not.toContain("service answered");
	});

	it("removes a stock only after confirmation", async () => {
		mount();
		await screen.findByRole("table", { name: STOCKS_TABLE });
		fireEvent.click(screen.getByRole("button", { name: "Remove AAPL" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("Remove AAPL?");
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove stock" }));
		await waitFor(() => {
			expect(screen.queryByRole("table", { name: STOCKS_TABLE })).toBe(null);
		});
		expect(await screen.findByText("Removed AAPL.")).toBeTruthy();
	});

	it("offers no earnings-date refresh: the server fetches the dates on its own schedule", async () => {
		mount();
		await screen.findByRole("table", { name: STOCKS_TABLE });
		expect(screen.queryByRole("button", { name: "Refresh earnings dates" })).toBeNull();
	});

	it("words a stock never fetched as waiting for the next automatic refresh", async () => {
		server.stocks = [
			makeStock({
				lastRefreshedAt: null,
				retrievedAt: null,
				events: [],
				unavailable: {
					code: "NEVER_REFRESHED",
					reason: "No earnings dates have been refreshed yet; queue a refresh.",
					upstreamStatus: null,
				},
			}),
		];
		mount();
		const table = await screen.findByRole("table", { name: STOCKS_TABLE });
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain(
			"No earnings dates yet; they appear after the next automatic refresh.",
		);
		expect(row.textContent).not.toContain("queue a refresh");
	});

	it("shows an empty state with no table when no stock is registered", async () => {
		server.stocks = [];
		mount();
		expect(await screen.findByText(/No stocks yet/)).toBeTruthy();
		expect(screen.queryByRole("table", { name: STOCKS_TABLE })).toBe(null);
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

	it("states passed stored dates as text with no calendar links", async () => {
		server.stocks = [
			makeStock({
				events: [
					{
						periodKey: "2020-q4",
						announcementDate: "2020-10-29",
						fiscalPeriodLabel: "Q4 2020",
						fiscalPeriodEnd: null,
						timing: "after-close",
					},
				],
			}),
		];
		mount();
		const table = await screen.findByRole("table", { name: STOCKS_TABLE });
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain(
			"unavailable (the stored dates have passed; the next automatic refresh updates them)",
		);
		expect(row.textContent).not.toContain("2020-10-29");
		expect(within(row).queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(within(row).queryByRole("link", { name: "Add to Outlook" })).toBe(null);
	});

	it("shows the date but no calendar links when nothing was retrieved yet", async () => {
		server.stocks = [makeStock({ retrievedAt: null, lastRefreshedAt: null })];
		mount();
		const table = await screen.findByRole("table", { name: STOCKS_TABLE });
		const row = within(table).getByRole("row", { name: /AAPL/ });
		// The stored date is still shown…
		expect(row.textContent).toContain(UPCOMING_DATE);
		// …but without a retrieved stamp there is no calendar link for it.
		expect(within(row).queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(within(row).queryByRole("link", { name: "Add to Outlook" })).toBe(null);
		expect(row.textContent).toContain("not retrieved yet");
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
			expect(await screen.findByText(/No stocks yet/)).toBeTruthy();
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

	it("queues no earnings refresh on load, whether the dates are fresh, stale or never fetched", async () => {
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
		server.lastSucceededAt = null;
		mount();
		await screen.findByRole("table", { name: STOCKS_TABLE });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toEqual([]);
		expect(screen.queryByText(/refresh was queued/)).toBeNull();
	});

	it("clears the add notice when the server's run that fetched the new stock ends", async () => {
		server.activeRunId = "run_earnings_0";
		server.runState = "pending";
		equities.companies = [trackedOnly("MSFT", "Microsoft Corp")];
		mount();
		await screen.findByRole("table", { name: STOCKS_TABLE });
		await addToWatchlistFromRow("MSFT");
		expect(
			await screen.findByText(
				"Added MSFT to the Watchlist. Its earnings dates are being fetched by the local runner.",
			),
		).toBeTruthy();
		// The pending run claims the current watchlist — the new stock
		// included — so when it ends refreshed, nothing more is queued.
		for (const stock of server.stocks) {
			stock.lastRefreshedAt = FRESH_STAMP;
			stock.retrievedAt = FRESH_STAMP;
		}
		server.activeRunId = null;
		server.lastSucceededAt = FRESH_STAMP;
		await waitFor(
			() => {
				expect(screen.queryByText(/being fetched/)).toBe(null);
			},
			{ timeout: 30_000 },
		);
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(0);
	}, 60_000);

	it("still queues one automatic sync after its own changes, and never loops after a failed run", async () => {
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "connected",
			calendarId: "cal_1",
			connectedAt: FRESH_STAMP,
			inSync: false,
		};
		mount();
		await screen.findByRole("table", { name: STOCKS_TABLE });
		await waitFor(
			() => {
				expect(backend.requestsTo("POST", /google-calendar\/sync$/)).toHaveLength(1);
			},
			{ timeout: 30_000 },
		);
		// The run fails server-side: the active run clears and the failure moves the ETag.
		server.google = {
			...server.google,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: {
				code: "GOOGLE_REQUEST_FAILED",
				upstreamStatus: null,
				reason: "The Google Calendar request failed.",
				at: FRESH_STAMP,
			},
		};
		// The poller reads the ended run and its failure…
		const reads = () => backend.requestsTo("GET", /^\/api\/v1\/watchlist$/).length;
		const before = reads();
		await waitFor(() => expect(reads()).toBeGreaterThan(before), { timeout: 30_000 });
		// …and no second sync is queued even though the ETag moved: no loops.
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect(backend.requestsTo("POST", /google-calendar\/sync$/)).toHaveLength(1);
	}, 90_000);

	it("has no calendar: the month grid and the calendar settings live elsewhere", async () => {
		mount();
		const table = await screen.findByRole("table", { name: STOCKS_TABLE });
		expect(screen.queryByRole("region", { name: "Calendar" })).toBe(null);
		expect(screen.queryByRole("table", { name: /earnings announcements$/ })).toBe(null);
		expect(screen.queryByRole("button", { name: "Download calendar file (.ics)" })).toBe(null);
		expect(screen.queryByRole("button", { name: "Create subscription link" })).toBe(null);
		expect(screen.queryByRole("button", { name: "Connect Google Calendar" })).toBe(null);
		// Each row keeps its per-date calendar links.
		expect(within(table).getByRole("link", { name: "Add to Google Calendar" })).toBeTruthy();
		expect(within(table).getByRole("link", { name: "Add to Outlook" })).toBeTruthy();
	});
});

/**
 * The server syncs the earnings dates on its own schedule; the pages only
 * read (`createIdleReread`): a conditional re-read every minute while the
 * page is visible and no run is followed, sooner (5 s, doubling) while a
 * stock was never fetched, at once on a return to the page — and never a
 * refresh request.
 */
describe("server-scheduled earnings syncs (idle re-read)", () => {
	const REFRESH = /^\/api\/v1\/watchlist\/refresh$/;
	const reads = () => backend.requestsTo("GET", /^\/api\/v1\/watchlist$/);
	const status = () => document.querySelector('[data-field="watchlist-status"]')?.textContent ?? "";

	/** Advances the fake clock in small steps until `ready` holds. */
	async function settleUntil(ready: () => boolean, label: string, maxMs = 10_000): Promise<void> {
		for (let elapsed = 0; elapsed < maxMs; elapsed += 50) {
			if (ready()) return;
			await vi.advanceTimersByTimeAsync(50);
		}
		if (!ready()) throw new Error(`gave up waiting: ${label}`);
	}
	const tableShown = () => screen.queryByRole("table", { name: STOCKS_TABLE }) !== null;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-reads every minute while visible; a run the server started shows and is followed to its end", async () => {
		mountRegistered(backend);
		await settleUntil(tableShown, "the table");
		const first = reads().length;
		await vi.advanceTimersByTimeAsync(59_000);
		expect(reads()).toHaveLength(first);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(reads()).toHaveLength(first + 1);
		// Conditional: nothing moved, so the server answers 304.
		expect(reads().at(-1)?.headers["if-none-match"]).toMatch(/^"w-/);
		// The server queues an earnings sync at a runner claim; the next re-read sees it.
		server.activeRunId = "run_earnings_server";
		server.runState = "leased";
		await vi.advanceTimersByTimeAsync(60_000);
		await settleUntil(() => status().includes("run_earnings_server"), "the run's status line");
		// The poller follows it fast.
		const during = reads().length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(reads().length).toBeGreaterThan(during);
		// The run ends: the status line goes quiet and the fast polls stop.
		server.activeRunId = null;
		server.lastSucceededAt = new Date(NOW_MS).toISOString();
		await settleUntil(() => status() === "", "the quiet status line");
		const after = reads().length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(reads()).toHaveLength(after);
		expect(backend.requestsTo("POST", REFRESH)).toEqual([]);
	});

	it("after an add, looks for the new stock's dates within seconds and drops the notice once they came", async () => {
		equities.companies = [trackedOnly("MSFT", "Microsoft Corp")];
		mountRegistered(backend);
		await settleUntil(
			() =>
				screen
					.queryByRole("button", { name: "Add MSFT to the Watchlist" })
					?.hasAttribute("disabled") === false,
			"the row's add button",
		);
		fireEvent.click(screen.getByRole("button", { name: "Add MSFT to the Watchlist" }));
		const notice =
			"Added MSFT to the Watchlist. Its earnings dates are being fetched by the local runner.";
		await settleUntil(() => screen.queryByText(notice) !== null, "the add notice");
		const afterAdd = reads().length;
		// MSFT was never fetched: the next re-read comes after 5 s, not a minute.
		await vi.advanceTimersByTimeAsync(5_100);
		expect(reads()).toHaveLength(afterAdd + 1);
		// The server's sync fetches MSFT between two re-reads (the run is never seen).
		server.stocks = server.stocks.map((stock) =>
			stock.stockId === "us:MSFT"
				? { ...stock, lastRefreshedAt: FRESH_STAMP, retrievedAt: FRESH_STAMP }
				: stock,
		);
		await vi.advanceTimersByTimeAsync(10_100);
		expect(reads()).toHaveLength(afterAdd + 2);
		await settleUntil(() => screen.queryByText(notice) === null, "the notice cleared");
		expect(backend.requestsTo("POST", REFRESH)).toEqual([]);
	});

	it("never re-reads while hidden, and re-reads at once on becoming visible", async () => {
		const visibility = createControllableVisibility();
		mountRegistered(backend, { visibility });
		await settleUntil(tableShown, "the table");
		const before = reads().length;
		visibility.setVisible(false);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(reads()).toHaveLength(before);
		visibility.setVisible(true);
		await vi.advanceTimersByTimeAsync(10);
		expect(reads()).toHaveLength(before + 1);
	});

	/** Connected and in sync: only the dates a run changes put Google out of sync. */
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
	/** Starts a server earnings run, lets the re-read see it, then ends it with Google out of sync. */
	async function serverRunThatChangesDates(): Promise<void> {
		server.activeRunId = "run_earnings_server";
		server.runState = "leased";
		await vi.advanceTimersByTimeAsync(61_000);
		await settleUntil(
			() => reads().length > 0 && server.activeRunId !== null,
			"the run seen by the re-read",
		);
		server.activeRunId = null;
		server.lastSucceededAt = new Date(NOW_MS).toISOString();
		server.google = { ...server.google, inSync: false };
		await vi.advanceTimersByTimeAsync(10_000);
	}

	it("on Registered stocks, a server run that changes the dates is followed by one Google sync", async () => {
		connectedInSync();
		mountRegistered(backend);
		await settleUntil(tableShown, "the table");
		expect(backend.requestsTo("POST", /google-calendar\/sync$/)).toHaveLength(0);
		await serverRunThatChangesDates();
		expect(backend.requestsTo("POST", /google-calendar\/sync$/)).toHaveLength(1);
		expect(backend.requestsTo("POST", REFRESH)).toEqual([]);
	});

	it("on the Stocks page, a server run the page only watched never queues a Google sync", async () => {
		connectedInSync();
		mountStocks(backend, { route: { stockId: "us:AAPL", tab: "chart" } });
		await settleUntil(
			() => screen.queryByRole("heading", { name: "Apple Inc · AAPL" }) !== null,
			"the stock heading",
		);
		const before = reads().length;
		await serverRunThatChangesDates();
		// The page did follow the run…
		expect(reads().length).toBeGreaterThan(before + 1);
		// …but showing a stock never makes the runner do anything (ADR-0049 §3).
		expect(backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});
});
