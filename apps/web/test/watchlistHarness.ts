import type { WatchlistStock } from "@research/contracts";
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

export interface WatchServer {
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
	};
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
