import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { formatInstant } from "../src/lib/format.ts";
import { WatchlistView } from "../src/watchlist/WatchlistView.tsx";
import {
	initialHomeServerState,
	initialServerState,
	installHomeRoutes,
	mountApp,
} from "./appHarness.tsx";
import {
	ALWAYS_VISIBLE,
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import {
	createWatchlistBackend,
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

beforeEach(() => {
	({ backend, server } = createWatchlistBackend());
});

afterEach(cleanup);

function mount() {
	render(() => (
		<WatchlistView api={createApiClient({ fetch: backend.fetch })} visibility={ALWAYS_VISIBLE} />
	));
}

describe("Watchlist view", () => {
	it("lists registered stocks with the next announcement, provenance and refresh status", async () => {
		mount();
		const table = await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
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
		expect(screen.getByText(/Last successful refresh:/)).toBeTruthy();
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
		const table = await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		const row = within(table).getByRole("row", { name: /7203/ });
		expect(row.textContent).toContain("unavailable (not retrieved yet)");
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
		const table = await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).toContain(
			"unavailable (The provider rate limit was reached. The service answered HTTP 429.)",
		);
		const msft = within(table).getByRole("row", { name: /MSFT/ }).textContent ?? "";
		expect(msft).toContain("unavailable (The earnings source request failed.)");
		expect(msft).not.toContain("service answered");
	});

	it("adds a stock through the form and lists problems the guideline way", async () => {
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		fireEvent.change(screen.getByLabelText("Market"), { target: { value: "JP" } });
		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "720" } });
		const problems = screen.getByRole("list", { name: "Before you can add this stock" });
		expect(problems.textContent).toContain("four characters");
		expect(screen.getByRole("button", { name: "Add stock" }).getAttribute("disabled")).not.toBe(
			null,
		);

		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "7203" } });
		expect(screen.queryByRole("list", { name: "Before you can add this stock" })).toBe(null);
		fireEvent.click(screen.getByRole("button", { name: "Add stock" }));
		await waitFor(() => {
			expect(
				screen.getByRole("table", {
					name: "Stocks you follow, with their next earnings announcement date",
				}).textContent,
			).toContain("7203");
		});
		// The add queues its own refresh: no click on "Refresh earnings dates".
		expect(
			await screen.findByText(
				"Added 7203. Its earnings dates are being fetched by the local runner.",
			),
		).toBeTruthy();
		await waitFor(() => {
			expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(1);
		});
		// ADR-0039: only the new stock's dates are fetched, not every stock's.
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)[0]?.body).toEqual({
			scope: "unrefreshed",
		});
	});

	it("removes a stock only after confirmation", async () => {
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		fireEvent.click(screen.getByRole("button", { name: "Remove AAPL" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("Remove AAPL?");
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove stock" }));
		await waitFor(() => {
			expect(
				screen.queryByRole("table", {
					name: "Stocks you follow, with their next earnings announcement date",
				}),
			).toBe(null);
		});
		expect(await screen.findByText("Removed AAPL.")).toBeTruthy();
	});

	it("queues an earnings-date refresh and shows the active run", async () => {
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		fireEvent.click(screen.getByRole("button", { name: "Refresh earnings dates" }));
		await waitFor(() => {
			expect(screen.getByText(/run run_earnings_1/)).toBeTruthy();
		});
		const refresh = backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/);
		expect(refresh).toHaveLength(1);
		expect(refresh[0]?.headers["idempotency-key"]).toMatch(/^idem-/);
		// ADR-0039: the Refresh button refreshes every stock.
		expect(refresh[0]?.body).toEqual({ scope: "all" });
	});

	it("shows an empty state with no table when no stock is registered", async () => {
		server.stocks = [];
		mount();
		expect(await screen.findByText(/No stocks registered yet/)).toBeTruthy();
		expect(
			screen.queryByRole("table", {
				name: "Stocks you follow, with their next earnings announcement date",
			}),
		).toBe(null);
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
		const table = await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain(
			"unavailable (the stored dates have passed; refresh to update)",
		);
		expect(row.textContent).not.toContain("2020-10-29");
		expect(within(row).queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(within(row).queryByRole("link", { name: "Add to Outlook" })).toBe(null);
	});

	it("shows the date but no calendar links when nothing was retrieved yet", async () => {
		server.stocks = [makeStock({ retrievedAt: null, lastRefreshedAt: null })];
		mount();
		const table = await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		const row = within(table).getByRole("row", { name: /AAPL/ });
		// The stored date is still shown…
		expect(row.textContent).toContain(UPCOMING_DATE);
		// …but without a retrieved stamp there is no calendar link for it.
		expect(within(row).queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(within(row).queryByRole("link", { name: "Add to Outlook" })).toBe(null);
		expect(row.textContent).toContain("not retrieved yet");
	});

	it("opens from the navigation as its own page", async () => {
		const appBackend = createFakeBackend();
		installHomeRoutes(appBackend, initialServerState(), initialHomeServerState(false));
		appBackend.on("GET", /^\/api\/v1\/watchlist$/, () =>
			jsonResponse({
				stocks: [],
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
		window.location.hash = "#/watchlist";
		try {
			mountApp(appBackend);
			await screen.findByRole("heading", { level: 2, name: "Watchlist" });
			expect(screen.getByRole("navigation", { name: "Views" }).textContent).toContain("Watchlist");
			expect(await screen.findByText(/No stocks registered yet/)).toBeTruthy();
		} finally {
			window.location.hash = "";
		}
	});

	it("queues one refresh on load when dates were never fetched, and says why", async () => {
		server.stocks = [makeStock({ lastRefreshedAt: null, retrievedAt: null })];
		server.lastSucceededAt = null;
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		expect(
			await screen.findByText(
				"Earnings dates had not been fetched yet, so one refresh was queued.",
			),
		).toBeTruthy();
		await waitFor(() => {
			expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(1);
		});
		// Once per mount: later polls never queue another.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(1);
	});

	it("queues one refresh on load when dates are more than a day old", async () => {
		const stale = new Date(NOW_MS - 25 * 3_600_000).toISOString();
		server.stocks = [makeStock({ lastRefreshedAt: stale, retrievedAt: stale })];
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		expect(
			await screen.findByText(
				"Earnings dates were more than a day old, so one refresh was queued.",
			),
		).toBeTruthy();
		await waitFor(() => {
			expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(1);
		});
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)[0]?.body).toEqual({
			scope: "all",
		});
	});

	it("queues nothing on load when the dates are fresh", async () => {
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(0);
	});

	it("reports a failed automatic queue once and never retries it", async () => {
		backend.on("POST", /^\/api\/v1\/watchlist\/refresh$/, () =>
			errorResponse(500, "INTERNAL", "boom"),
		);
		server.stocks = [makeStock({ lastRefreshedAt: null, retrievedAt: null })];
		server.lastSucceededAt = null;
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The earnings-date refresh was not queued.");
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(1);
	});

	it("queues exactly one follow-up when a stock is added mid-run and stays unfetched", async () => {
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		// One manual refresh starts the run…
		fireEvent.click(screen.getByRole("button", { name: "Refresh earnings dates" }));
		await waitFor(() => {
			expect(screen.getByText(/run run_earnings_1/)).toBeTruthy();
		});
		// …then a stock is added while it runs: armed, but no second queue yet.
		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "MSFT" } });
		fireEvent.click(screen.getByRole("button", { name: "Add stock" }));
		expect(
			await screen.findByText(
				"Added MSFT. Its earnings dates are being fetched by the local runner.",
			),
		).toBeTruthy();
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(1);
		// The run ends with the new stock still never refreshed: exactly one follow-up.
		server.activeRunId = null;
		await waitFor(
			() => {
				expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(2);
			},
			{ timeout: 30_000 },
		);
		expect(
			await screen.findByText(
				"A stock was added while the refresh ran, so one follow-up refresh was queued.",
			),
		).toBeTruthy();
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)[1]?.body).toEqual({
			scope: "unrefreshed",
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(2);
		// A further stock added while the FOLLOW-UP runs earns its own
		// follow-up: the rule is one per add-during-a-run, not one per mount.
		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "NVDA" } });
		fireEvent.click(screen.getByRole("button", { name: "Add stock" }));
		expect(
			await screen.findByText(
				"Added NVDA. Its earnings dates are being fetched by the local runner.",
			),
		).toBeTruthy();
		expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(2);
		server.activeRunId = null;
		await waitFor(
			() => {
				expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/refresh$/)).toHaveLength(3);
			},
			{ timeout: 30_000 },
		);
	}, 90_000);

	it("queues no follow-up when the pending run covered the added stock", async () => {
		server.activeRunId = "run_earnings_0";
		server.runState = "pending";
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "MSFT" } });
		fireEvent.click(screen.getByRole("button", { name: "Add stock" }));
		expect(
			await screen.findByText(
				"Added MSFT. Its earnings dates are being fetched by the local runner.",
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

	it("clears the queued notice when the poller sees the run end", async () => {
		server.stocks = [makeStock({ lastRefreshedAt: null, retrievedAt: null })];
		server.lastSucceededAt = null;
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		await screen.findByText(/so one refresh was queued/);
		server.activeRunId = null;
		server.lastSucceededAt = FRESH_STAMP;
		for (const stock of server.stocks) {
			stock.lastRefreshedAt = FRESH_STAMP;
			stock.retrievedAt = FRESH_STAMP;
		}
		await waitFor(
			() => {
				expect(screen.queryByText(/so one refresh was queued/)).toBe(null);
			},
			{ timeout: 30_000 },
		);
		expect(screen.getByText(/Last successful refresh:/)).toBeTruthy();
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
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
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
		const table = await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
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
