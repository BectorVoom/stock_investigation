import type { WatchlistStock } from "@research/contracts";
import { GOOGLE_AUTH_URL_PREFIX } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { makeRun } from "./fixtures.ts";

const NOW_MS = Date.now();
/** A fresh stamp (one hour old), so the default fixture queues no auto-refresh on load. */
const FRESH_STAMP = new Date(NOW_MS - 3_600_000).toISOString();
/** A UTC date `days` from today, so fixtures stay upcoming on any day. */
function isoInDays(days: number): string {
	return new Date(NOW_MS + days * 86_400_000).toISOString().slice(0, 10);
}
/** The fixture's upcoming announcement date (the view compares it to today). */
const UPCOMING_DATE = isoInDays(16);

function makeStock(overrides: Partial<WatchlistStock> = {}): WatchlistStock {
	return {
		stockId: "us:AAPL",
		market: "US",
		symbol: "AAPL",
		name: "Apple Inc",
		addedAt: "2026-10-12T00:00:00Z",
		source: "finnhub",
		publisher: "Finnhub",
		sourceUrl: "https://finnhub.io/",
		lastRefreshedAt: FRESH_STAMP,
		retrievedAt: FRESH_STAMP,
		unavailable: null,
		events: [
			{
				periodKey: "2026-q4",
				announcementDate: UPCOMING_DATE,
				fiscalPeriodLabel: "Q4 2026",
				fiscalPeriodEnd: null,
				timing: "after-close",
			},
		],
		...overrides,
	};
}

interface WatchServer {
	stocks: WatchlistStock[];
	activeRunId: string | null;
	runState: string;
	lastSucceededAt: string | null;
	feedCreatedAt: string | null;
	google: {
		status: "disconnected" | "connecting" | "connected" | "needs-reconnect";
		authUrl: string | null;
		calendarId: string | null;
		connectedAt: string | null;
		lastSyncedAt: string | null;
		lastSync: { inserted: number; updated: number; deleted: number; unchanged: number } | null;
		inSync: boolean | null;
		activeRunId: string | null;
		activeRunState: string | null;
		activeAction: "connect" | "sync" | "disconnect" | null;
		lastFailure: { code: string; reason: string; at: string } | null;
	};
}

const DISCONNECTED_GOOGLE = (): WatchServer["google"] => ({
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
});

let backend: FakeBackend;
let server: WatchServer;

function responseBody() {
	return {
		stocks: server.stocks,
		refresh: {
			activeRunId: server.activeRunId,
			activeRunState: server.activeRunId === null ? null : server.runState,
			lastSucceededAt: server.lastSucceededAt,
			lastFailure: null,
		},
		feed: { enabled: server.feedCreatedAt !== null, createdAt: server.feedCreatedAt },
		googleCalendar: {
			...server.google,
			activeRunState:
				server.google.activeRunId === null ? null : (server.google.activeRunState ?? "pending"),
		},
	};
}

function etag() {
	return `"w-${server.stocks.length}-${server.activeRunId ?? "idle"}-${server.feedCreatedAt ?? "none"}-${JSON.stringify(server.google)}"`;
}

beforeEach(() => {
	backend = createFakeBackend();
	server = {
		stocks: [makeStock()],
		activeRunId: null,
		runState: "pending",
		lastSucceededAt: FRESH_STAMP,
		feedCreatedAt: null,
		google: DISCONNECTED_GOOGLE(),
	};
	backend.on("GET", /^\/api\/v1\/watchlist$/, (request) => {
		if (request.headers["if-none-match"] === etag()) return new Response(null, { status: 304 });
		return jsonResponse(responseBody(), { headers: { ETag: etag() } });
	});
	backend.on("POST", /^\/api\/v1\/watchlist\/stocks$/, (request) => {
		const body = request.body as { market?: unknown; symbol?: unknown };
		if (body.market !== "US" && body.market !== "JP") {
			return errorResponse(400, "VALIDATION_FAILED", "market is required");
		}
		const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
		if (symbol === "" || symbol === "BAD!") {
			return errorResponse(400, "VALIDATION_FAILED", "symbol is required");
		}
		const market = body.market as "US" | "JP";
		const stockId = `${market.toLowerCase()}:${symbol}`;
		if (!server.stocks.some((entry) => entry.stockId === stockId)) {
			server.stocks = [
				...server.stocks,
				makeStock({
					stockId,
					market,
					symbol,
					name: null,
					source: market === "US" ? "finnhub" : "jpx",
					publisher: market === "US" ? "Finnhub" : "Japan Exchange Group (JPX)",
					sourceUrl:
						market === "US"
							? "https://finnhub.io/"
							: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
					lastRefreshedAt: null,
					retrievedAt: null,
					events: [],
				}),
			];
		}
		return jsonResponse(responseBody());
	});
	backend.on("DELETE", /^\/api\/v1\/watchlist\/stocks\/(.+)$/, (_request, match) => {
		const stockId = decodeURIComponent(match[1] ?? "");
		if (!server.stocks.some((entry) => entry.stockId === stockId)) {
			return errorResponse(404, "NOT_FOUND", "Stock not found.");
		}
		server.stocks = server.stocks.filter((entry) => entry.stockId !== stockId);
		return jsonResponse(responseBody());
	});
	backend.on("POST", /^\/api\/v1\/watchlist\/refresh$/, () => {
		if (server.stocks.length === 0) {
			return errorResponse(400, "VALIDATION_FAILED", "The watchlist has no stocks to refresh.");
		}
		server.activeRunId = "run_earnings_1";
		server.runState = "pending";
		return jsonResponse(
			{ run: makeRun({ runId: "run_earnings_1", kind: "earnings-refresh", state: "pending" }) },
			{ status: 202 },
		);
	});
	backend.on(
		"GET",
		/^\/api\/v1\/watchlist\/calendar\.ics$/,
		() =>
			new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
				status: 200,
				headers: { "Content-Type": "text/calendar; charset=utf-8" },
			}),
	);
	backend.on("POST", /^\/api\/v1\/watchlist\/feed$/, () => {
		const token = "a".repeat(43);
		server.feedCreatedAt = "2026-10-12T13:00:00Z";
		return jsonResponse(
			{
				token,
				path: `/api/v1/calendar-feed/${token}/earnings.ics`,
				createdAt: server.feedCreatedAt,
			},
			{ status: 201 },
		);
	});
	backend.on("DELETE", /^\/api\/v1\/watchlist\/feed$/, () => {
		if (server.feedCreatedAt === null) {
			return errorResponse(404, "NOT_FOUND", "There is no subscription link to revoke.");
		}
		server.feedCreatedAt = null;
		return new Response(null, { status: 204 });
	});
	backend.on(
		"POST",
		/^\/api\/v1\/google-calendar\/(connect|sync|disconnect)$/,
		(_request, match) => {
			const action = match[1] as "connect" | "sync" | "disconnect";
			if (action !== "connect" && server.google.status !== "connected") {
				return errorResponse(400, "VALIDATION_FAILED", "Google Calendar is not connected.");
			}
			server.google = {
				...server.google,
				status: action === "connect" ? "connecting" : server.google.status,
				activeRunId: `run_google_${action}`,
				activeRunState: "pending",
				activeAction: action,
			};
			return jsonResponse(
				{
					run: makeRun({
						runId: `run_google_${action}`,
						kind: "google-calendar",
						state: "pending",
					}),
				},
				{ status: 202 },
			);
		},
	);
	backend.on("POST", /^\/api\/v1\/research-runs\/.+\/cancel$/, () => {
		server.google = {
			...server.google,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
		};
		return jsonResponse({ run: makeRun({ state: "cancelled" }) });
	});
});

afterEach(cleanup);

function mount(
	props: { readonly calendarDate?: string | null; readonly calendarLinked?: boolean } = {},
) {
	render(() => (
		<WatchlistView
			api={createApiClient({ fetch: backend.fetch })}
			visibility={ALWAYS_VISIBLE}
			calendarDate={props.calendarDate ?? null}
			calendarLinked={props.calendarLinked ?? false}
		/>
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

	it("downloads the calendar file through the shared download helper", async () => {
		const created: string[] = [];
		Object.defineProperty(URL, "createObjectURL", {
			value: () => {
				created.push("blob:fake");
				return "blob:fake";
			},
			configurable: true,
		});
		Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		try {
			mount();
			await screen.findByRole("table", {
				name: "Stocks you follow, with their next earnings announcement date",
			});
			fireEvent.click(screen.getByRole("button", { name: "Download calendar file (.ics)" }));
			await waitFor(() => {
				expect(click).toHaveBeenCalled();
			});
			expect(created).toEqual(["blob:fake"]);
		} finally {
			click.mockRestore();
		}
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

	it("creates the subscription link once, copies it, replaces and revokes it", async () => {
		const written: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: (text: string) => written.push(text) },
			configurable: true,
		});
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		fireEvent.click(screen.getByRole("button", { name: "Create subscription link" }));
		const field = (await screen.findByLabelText(
			"Subscription link (shown once)",
		)) as HTMLInputElement;
		expect(field.value).toContain("/api/v1/calendar-feed/");
		expect(field.value).not.toContain("undefined");
		fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		await waitFor(() => {
			expect(written).toHaveLength(1);
		});
		expect(await screen.findByText("Copied to the clipboard.")).toBeTruthy();

		fireEvent.click(await screen.findByRole("button", { name: "Replace link" }));
		const replaceDialog = await screen.findByRole("dialog");
		expect(replaceDialog.textContent).toContain("The old link stops working immediately.");
		fireEvent.click(within(replaceDialog).getByRole("button", { name: "Replace link" }));
		await waitFor(() => {
			expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/feed$/)).toHaveLength(2);
		});
		// The dialog closes only once the issue response is processed, not
		// when the request is recorded — wait for the dismissal itself.
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBe(null);
		});

		fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));
		const revokeDialog = await screen.findByRole("dialog");
		fireEvent.click(within(revokeDialog).getByRole("button", { name: "Revoke link" }));
		expect(await screen.findByText("The subscription link was revoked.")).toBeTruthy();
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

	it("shows the month calendar and selects a day with its details and links", async () => {
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		const calendar = await screen.findByRole("table", { name: /earnings announcements/ });
		expect(calendar.textContent).toContain("earnings announcements");
		const day = within(calendar).getByRole("button", { name: /1 announcement, AAPL/ });
		fireEvent.click(day);
		expect(day.getAttribute("aria-pressed")).toBe("true");
		const panel = await screen.findByRole("region", { name: /Announcements on/ });
		expect(panel.textContent).toContain("Apple Inc");
		expect(panel.textContent).toContain("Q4 2026");
		expect(
			within(panel).getByRole("link", { name: "Add to Google Calendar" }).getAttribute("href"),
		).toContain("calendar.google.com");
	});

	it("opens on the deep-linked day with its details", async () => {
		mount({ calendarDate: UPCOMING_DATE, calendarLinked: true });
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		const panel = await screen.findByRole("region", { name: /Announcements on/ });
		expect(panel.textContent).toContain("AAPL");
	});

	it("queues a Google Calendar connect and shows the preparing state", async () => {
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect Google Calendar" }));
		await waitFor(() => {
			expect(backend.requestsTo("POST", /google-calendar\/connect$/)).toHaveLength(1);
		});
		expect(await screen.findByText(/Preparing Google sign-in…/)).toBeTruthy();
	});

	it("shows the sign-in link while connecting with a URL", async () => {
		const authUrl = `${GOOGLE_AUTH_URL_PREFIX}response_type=code&client_id=e2e`;
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "connecting",
			authUrl,
			activeRunId: "run_google_connect",
			activeRunState: "claimed",
			activeAction: "connect",
		};
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		const link = await screen.findByRole("link", { name: "Open Google sign-in" });
		expect(link.getAttribute("href")).toBe(authUrl);
		expect(await screen.findByText(/Waiting for you to finish in Google/)).toBeTruthy();
	});

	it("states needs-reconnect with the fixed failure sentence", async () => {
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "needs-reconnect",
			lastFailure: {
				code: "GOOGLE_AUTH_EXPIRED",
				reason: "The Google connection expired; reconnect Google Calendar.",
				at: FRESH_STAMP,
			},
		};
		mount();
		await screen.findByRole("table", {
			name: "Stocks you follow, with their next earnings announcement date",
		});
		expect(await screen.findByRole("button", { name: "Reconnect Google Calendar" })).toBeTruthy();
		expect((await screen.findAllByText(/The Google connection expired/)).length).toBeGreaterThan(0);
	});

	it("queues one automatic sync when connected and out of sync, and never loops after a failed run", async () => {
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
		// The queued run is active: the card says syncing.
		expect(await screen.findByText(/Syncing…/)).toBeTruthy();
		// The run fails server-side: the active run clears and the failure moves the ETag.
		server.google = {
			...server.google,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: {
				code: "GOOGLE_REQUEST_FAILED",
				reason: "The Google Calendar request failed.",
				at: FRESH_STAMP,
			},
		};
		await waitFor(
			() => {
				expect(screen.queryByText(/Syncing…/)).toBe(null);
			},
			{ timeout: 30_000 },
		);
		// No second sync is queued even though the ETag moved: no loops.
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect(backend.requestsTo("POST", /google-calendar\/sync$/)).toHaveLength(1);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The Google Calendar request failed.");
	}, 90_000);
});
