import {
	type ApiErrorCode,
	STOCK_DIRECTORY_SOURCES,
	type StockDirectoryMarketStatus,
	type StockListing,
	type WatchlistStock,
	type WatchMarket,
} from "@research/contracts";
import { rankStockSearch } from "@research/domain";
import { createFakeBackend, errorResponse, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import { makeRun } from "./fixtures.ts";

export const NOW_MS = Date.now();
/** A fresh stamp (one hour old), so the default fixture queues no auto-refresh on load. */
export const FRESH_STAMP = new Date(NOW_MS - 3_600_000).toISOString();
/** A UTC date `days` from today, so fixtures stay upcoming on any day. */
export function isoInDays(days: number): string {
	return new Date(NOW_MS + days * 86_400_000).toISOString().slice(0, 10);
}
/** The fixture's upcoming announcement date (the view compares it to today). */
export const UPCOMING_DATE = isoInDays(16);

export function makeStock(overrides: Partial<WatchlistStock> = {}): WatchlistStock {
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

/** One stored directory row, as the fake API keeps it. */
export interface DirectoryRow {
	readonly market: WatchMarket;
	readonly symbol: string;
	readonly name: string;
	readonly localName: string | null;
	readonly listing: StockListing;
}

/** The rows the web tests search: the names Worker A's E2E fixtures use too. */
export const DIRECTORY_ROWS: readonly DirectoryRow[] = [
	{ market: "US", symbol: "AAPL", name: "Apple Inc.", localName: null, listing: "nasdaq" },
	{ market: "US", symbol: "TM", name: "TOYOTA MOTOR CORP/", localName: null, listing: "nyse" },
	{ market: "US", symbol: "MSFT", name: "MICROSOFT CORP", localName: null, listing: "nasdaq" },
	{
		market: "JP",
		symbol: "7203",
		name: "TOYOTA MOTOR CORPORATION",
		localName: "トヨタ自動車",
		listing: "tse-prime",
	},
	{
		market: "JP",
		symbol: "7205",
		name: "HINO MOTORS,LTD.",
		localName: "日野自動車",
		listing: "tse-prime",
	},
	{
		market: "JP",
		symbol: "6758",
		name: "Sony Group Corporation",
		localName: "ソニーグループ",
		listing: "tse-prime",
	},
];

/** What one market's directory status says; tests mutate it to stage states. */
export interface DirectoryMarketServer {
	entryCount: number;
	asOf: string | null;
	retrievedAt: string | null;
	activeRunId: string | null;
	activeRunState: string | null;
	lastFailure: { state: string; code: string; at: string } | null;
}

export interface DirectoryServer {
	rows: DirectoryRow[];
	US: DirectoryMarketServer;
	JP: DirectoryMarketServer;
	/**
	 * When set, the refresh route queues these markets and then answers
	 * this error anyway — a partly applied request the client must notice.
	 */
	refreshFailure: {
		readonly status: number;
		readonly code: ApiErrorCode;
		readonly queued: readonly WatchMarket[];
	} | null;
}

/** Both lists downloaded an hour ago: no automatic download is queued on load. */
export function freshDirectory(): DirectoryServer {
	return {
		rows: [...DIRECTORY_ROWS],
		refreshFailure: null,
		US: {
			entryCount: 7691,
			asOf: null,
			retrievedAt: FRESH_STAMP,
			activeRunId: null,
			activeRunState: null,
			lastFailure: null,
		},
		JP: {
			entryCount: 3707,
			asOf: "2026-09-30",
			retrievedAt: FRESH_STAMP,
			activeRunId: null,
			activeRunState: null,
			lastFailure: null,
		},
	};
}

/** Nothing downloaded yet. */
export function emptyDirectoryMarket(): DirectoryMarketServer {
	return {
		entryCount: 0,
		asOf: null,
		retrievedAt: null,
		activeRunId: null,
		activeRunState: null,
		lastFailure: null,
	};
}

/**
 * Like the API: a failure is reported only while no later download
 * succeeded, and a cancelled run is not a failure.
 */
function standingFailure(state: DirectoryMarketServer): DirectoryMarketServer["lastFailure"] {
	const failure = state.lastFailure;
	if (failure === null || failure.state === "cancelled") return null;
	if (state.retrievedAt !== null && Date.parse(state.retrievedAt) >= Date.parse(failure.at)) {
		return null;
	}
	return failure;
}

function directoryMarketStatus(
	market: WatchMarket,
	state: DirectoryMarketServer,
): StockDirectoryMarketStatus {
	return {
		market,
		...STOCK_DIRECTORY_SOURCES[market],
		...state,
		lastFailure: standingFailure(state),
	};
}

/**
 * The stock-directory routes (ADR-0034) over `directory`: status, search
 * ranked by the domain's reference `rankStockSearch` with `registered`
 * read from `registeredIds()`, and a refresh that marks each market's run
 * pending (reusing an active one, like the API). Later registrations win, so
 * a test overrides a route by registering its own after this.
 */
export function installDirectoryRoutes(
	backend: FakeBackend,
	directory: () => DirectoryServer,
	registeredIds: () => readonly string[],
): void {
	backend.on("GET", /^\/api\/v1\/watchlist\/directory$/, () =>
		jsonResponse({
			markets: [
				directoryMarketStatus("US", directory().US),
				directoryMarketStatus("JP", directory().JP),
			],
		}),
	);
	backend.on("GET", /^\/api\/v1\/watchlist\/directory\/search\?(.*)$/, (_request, match) => {
		const params = new URLSearchParams(match[1] ?? "");
		const query = params.get("q") ?? "";
		const limit = Number(params.get("limit") ?? "10");
		const market = params.get("market");
		const rows = directory().rows.filter((row) => market === null || row.market === market);
		const registered = new Set(registeredIds());
		const hits = rankStockSearch(rows, query, limit).map((row) => {
			const stockId = `${row.market.toLowerCase()}:${row.symbol}`;
			return { stockId, ...row, registered: registered.has(stockId) };
		});
		return jsonResponse({ hits });
	});
	backend.on("POST", /^\/api\/v1\/watchlist\/directory\/refresh$/, (request) => {
		const body = request.body;
		const markets: WatchMarket[] =
			typeof body === "object" && body !== null && "markets" in body && Array.isArray(body.markets)
				? body.markets.filter((entry): entry is WatchMarket => entry === "US" || entry === "JP")
				: ["US", "JP"];
		const queue = (market: WatchMarket): string => {
			const state = directory()[market];
			state.activeRunId ??= `run_directory_${market.toLowerCase()}`;
			state.activeRunState ??= "pending";
			return state.activeRunId;
		};
		const failure = directory().refreshFailure;
		if (failure !== null) {
			for (const market of failure.queued) queue(market);
			return errorResponse(failure.status, failure.code, "The refresh was not queued.");
		}
		const runs = markets.map((market) => ({ market, runId: queue(market) }));
		return jsonResponse({ runs }, { status: 202 });
	});
}

export interface WatchServer {
	stocks: WatchlistStock[];
	directory: DirectoryServer;
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

export const DISCONNECTED_GOOGLE = (): WatchServer["google"] => ({
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

/**
 * A fake API serving one owner's watchlist (stocks, earnings refresh, the
 * `.ics` file, the subscription feed and Google Calendar steps). Tests
 * mutate `server` to stage states; the ETag follows every field.
 */
export function createWatchlistBackend(): {
	readonly backend: FakeBackend;
	readonly server: WatchServer;
} {
	const backend = createFakeBackend();
	const server: WatchServer = {
		stocks: [makeStock()],
		activeRunId: null,
		runState: "pending",
		lastSucceededAt: FRESH_STAMP,
		feedCreatedAt: null,
		google: DISCONNECTED_GOOGLE(),
		directory: freshDirectory(),
	};
	installDirectoryRoutes(
		backend,
		() => server.directory,
		() => server.stocks.map((stock) => stock.stockId),
	);
	const responseBody = () => ({
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
	});
	const etag = () =>
		`"w-${server.stocks.length}-${server.activeRunId ?? "idle"}-${server.feedCreatedAt ?? "none"}-${JSON.stringify(server.google)}"`;
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
	return { backend, server };
}
