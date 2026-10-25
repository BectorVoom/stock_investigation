import {
	type ApiErrorCode,
	jobStateSchema,
	STOCK_DIRECTORY_SOURCES,
	type StockDirectoryMarketStatus,
	type StockListing,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistList,
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
	lastFailure: { state: string; code: string; upstreamStatus: number | null; at: string } | null;
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
	/** The owner's titled lists (ADR-0040), in creation order. */
	lists: WatchlistList[];
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
		lastFailure: { code: string; reason: string; upstreamStatus: number | null; at: string } | null;
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
		lists: [],
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
		lists: server.lists,
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
		`"w-${server.stocks.length}-${server.lists.map((list) => `${list.listId}.${list.version}`).join(",")}-${server.activeRunId ?? "idle"}-${server.feedCreatedAt ?? "none"}-${JSON.stringify(server.google)}"`;
	backend.on("GET", /^\/api\/v1\/watchlist$/, (request) => {
		if (request.headers["if-none-match"] === etag()) return new Response(null, { status: 304 });
		return jsonResponse(responseBody(), { headers: { ETag: etag() } });
	});
	/** Adds a stock to the watchlist as `POST /watchlist/stocks` does; the stock id, or an error answer. */
	const watchStock = (body: { market?: unknown; symbol?: unknown }): string | Response => {
		if (body.market !== "US" && body.market !== "JP") {
			return errorResponse(400, "VALIDATION_FAILED", "market is required");
		}
		const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
		if (symbol === "" || symbol === "BAD!") {
			return errorResponse(400, "VALIDATION_FAILED", "symbol is required");
		}
		const market = body.market;
		const stockId = `${market.toLowerCase()}:${symbol}`;
		if (!server.stocks.some((entry) => entry.stockId === stockId)) {
			if (server.stocks.length >= 50) {
				return errorResponse(
					400,
					"VALIDATION_FAILED",
					"At most 50 stocks can be watched.",
					"WATCHLIST_FULL",
				);
			}
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
		return stockId;
	};
	backend.on("POST", /^\/api\/v1\/watchlist\/stocks$/, (request) => {
		const added = watchStock(request.body as { market?: unknown; symbol?: unknown });
		return typeof added === "string" ? jsonResponse(responseBody()) : added;
	});
	/** Replaces one list, bumping its version (every change does, ADR-0040 §1). */
	const changeList = (listId: string, change: (list: WatchlistList) => WatchlistList): void => {
		server.lists = server.lists.map((list) =>
			list.listId === listId
				? { ...change(list), version: list.version + 1, updatedAt: "2026-10-25T12:00:00Z" }
				: list,
		);
	};
	const titleOf = (body: unknown): string | null => {
		const title = (body as { title?: unknown }).title;
		if (typeof title !== "string") return null;
		const trimmed = title.trim();
		return trimmed.length === 0 || trimmed.length > WATCHLIST_LISTS_LIMITS.maxTitleChars
			? null
			: trimmed;
	};
	let listCounter = 0;
	backend.on("POST", /^\/api\/v1\/watchlist\/lists$/, (request) => {
		const title = titleOf(request.body);
		if (title === null) return errorResponse(400, "VALIDATION_FAILED", "title is invalid");
		if (server.lists.length >= WATCHLIST_LISTS_LIMITS.maxLists) {
			return errorResponse(400, "VALIDATION_FAILED", "At most 20 lists.", "WATCHLIST_LISTS_FULL");
		}
		listCounter += 1;
		server.lists = [
			...server.lists,
			{
				listId: `list_${listCounter}`,
				title,
				stockIds: [],
				version: 1,
				createdAt: "2026-10-25T12:00:00Z",
				updatedAt: "2026-10-25T12:00:00Z",
			},
		];
		return jsonResponse(responseBody(), { status: 201 });
	});
	const findList = (listId: string): WatchlistList | undefined =>
		server.lists.find((list) => list.listId === listId);
	backend.on("PATCH", /^\/api\/v1\/watchlist\/lists\/([^/]+)$/, (request, match) => {
		const listId = decodeURIComponent(match[1] ?? "");
		const title = titleOf(request.body);
		if (title === null) return errorResponse(400, "VALIDATION_FAILED", "title is invalid");
		if (findList(listId) === undefined) return errorResponse(404, "NOT_FOUND", "List not found.");
		changeList(listId, (list) => ({ ...list, title }));
		return jsonResponse(responseBody());
	});
	backend.on("DELETE", /^\/api\/v1\/watchlist\/lists\/([^/]+)$/, (_request, match) => {
		const listId = decodeURIComponent(match[1] ?? "");
		if (findList(listId) === undefined) return errorResponse(404, "NOT_FOUND", "List not found.");
		server.lists = server.lists.filter((list) => list.listId !== listId);
		return jsonResponse(responseBody());
	});
	backend.on("POST", /^\/api\/v1\/watchlist\/lists\/([^/]+)\/stocks$/, (request, match) => {
		const listId = decodeURIComponent(match[1] ?? "");
		const list = findList(listId);
		if (list === undefined) return errorResponse(404, "NOT_FOUND", "List not found.");
		const body = request.body as { market?: unknown; symbol?: unknown };
		const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
		const wanted = typeof body.market === "string" ? `${body.market.toLowerCase()}:${symbol}` : "";
		if (list.stockIds.includes(wanted)) return jsonResponse(responseBody());
		// The service checks the list's room before it touches the watchlist.
		if (list.stockIds.length >= WATCHLIST_LISTS_LIMITS.maxStocksPerList) {
			return errorResponse(
				400,
				"VALIDATION_FAILED",
				"At most 12 stocks per list.",
				"WATCHLIST_LIST_FULL",
			);
		}
		const added = watchStock(body);
		if (typeof added !== "string") return added;
		changeList(listId, (current) => ({ ...current, stockIds: [...current.stockIds, added] }));
		return jsonResponse(responseBody());
	});
	backend.on(
		"DELETE",
		/^\/api\/v1\/watchlist\/lists\/([^/]+)\/stocks\/([^/]+)$/,
		(_request, match) => {
			const listId = decodeURIComponent(match[1] ?? "");
			const stockId = decodeURIComponent(match[2] ?? "");
			const list = findList(listId);
			if (list === undefined || !list.stockIds.includes(stockId)) {
				return errorResponse(404, "NOT_FOUND", "Not in the list.");
			}
			changeList(listId, (current) => ({
				...current,
				stockIds: current.stockIds.filter((id) => id !== stockId),
			}));
			return jsonResponse(responseBody());
		},
	);
	backend.on("DELETE", /^\/api\/v1\/watchlist\/stocks\/(.+)$/, (_request, match) => {
		const stockId = decodeURIComponent(match[1] ?? "");
		if (!server.stocks.some((entry) => entry.stockId === stockId)) {
			return errorResponse(404, "NOT_FOUND", "Stock not found.");
		}
		server.stocks = server.stocks.filter((entry) => entry.stockId !== stockId);
		// The removal leaves every list too, bumping their versions (ADR-0040 §1).
		for (const list of server.lists) {
			if (list.stockIds.includes(stockId)) {
				changeList(list.listId, (current) => ({
					...current,
					stockIds: current.stockIds.filter((id) => id !== stockId),
				}));
			}
		}
		return jsonResponse(responseBody());
	});
	backend.on("POST", /^\/api\/v1\/watchlist\/refresh$/, () => {
		if (server.stocks.length === 0) {
			return errorResponse(400, "VALIDATION_FAILED", "The watchlist has no stocks to refresh.");
		}
		// One active run per kind, like the API: a request while one is
		// active answers with that run.
		if (server.activeRunId === null) {
			server.activeRunId = "run_earnings_1";
			server.runState = "pending";
		}
		return jsonResponse(
			{
				run: makeRun({
					runId: server.activeRunId,
					kind: "earnings-refresh",
					state: jobStateSchema.parse(server.runState),
				}),
			},
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
