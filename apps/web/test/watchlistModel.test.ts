import type { WatchlistResponse, WatchlistStock } from "@research/contracts";
import { DISCONNECTED_GOOGLE_CALENDAR_STATE } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { formatInstant } from "../src/lib/format.ts";
import { watchlistModelMessages } from "../src/watchlist/watchlistModel.messages.ts";
import {
	googleFailureReason,
	googleWidgetStatus,
	hasNeverRefreshedStock,
	isGoogleCalendarRunActive,
	isNetworkFailure,
	isWatchlistRefreshActive,
	utcTodayIso,
	watchlistRefreshSignal,
} from "../src/watchlist/watchlistModel.ts";

function stock(overrides: Partial<WatchlistStock> = {}): WatchlistStock {
	return {
		stockId: "us:AAPL",
		market: "US",
		symbol: "AAPL",
		name: "Apple Inc",
		addedAt: "2026-10-12T00:00:00Z",
		source: "finnhub",
		publisher: "Finnhub",
		sourceUrl: "https://finnhub.io/",
		lastRefreshedAt: "2026-10-12T12:00:00Z",
		retrievedAt: "2026-10-12T12:00:00Z",
		unavailable: null,
		events: [],
		...overrides,
	};
}

describe("refresh status", () => {
	it("reads the UTC date from the clock reading", () => {
		expect(utcTodayIso(Date.parse("2026-10-13T00:30:00Z"))).toBe("2026-10-13");
	});

	it("derives the poll signal from the active run", () => {
		const base = {
			stocks: [],
			lists: [],
			refresh: {
				activeRunId: null,
				activeRunState: null,
				lastSucceededAt: null,
				lastFailure: null,
			},
			feed: { enabled: false, createdAt: null },
			googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
		};
		expect(watchlistRefreshSignal(null)).toBe("unchanged");
		expect(watchlistRefreshSignal(base)).toBe("unchanged");
		expect(
			watchlistRefreshSignal({
				...base,
				refresh: { ...base.refresh, activeRunId: "run_1", activeRunState: "pending" },
			}),
		).toBe("queued");
		expect(
			watchlistRefreshSignal({
				...base,
				refresh: { ...base.refresh, activeRunId: "run_1", activeRunState: "claimed" },
			}),
		).toBe("active");
	});

	it("keeps polling while a google-calendar run is active, even with no earnings run", () => {
		const base = {
			stocks: [],
			lists: [],
			refresh: {
				activeRunId: null,
				activeRunState: null,
				lastSucceededAt: null,
				lastFailure: null,
			},
			feed: { enabled: false, createdAt: null },
			googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
		};
		const connecting = {
			...base,
			googleCalendar: {
				...DISCONNECTED_GOOGLE_CALENDAR_STATE,
				status: "connecting" as const,
				activeRunId: "run_google_1",
				activeRunState: "pending" as const,
				activeAction: "connect" as const,
			},
		};
		expect(watchlistRefreshSignal(connecting)).toBe("queued");
		expect(isGoogleCalendarRunActive(connecting)).toBe(true);
		expect(isGoogleCalendarRunActive(base)).toBe(false);
		expect(isGoogleCalendarRunActive(null)).toBe(false);
		expect(isGoogleCalendarRunActive(undefined)).toBe(false);
		const syncing = {
			...connecting,
			googleCalendar: { ...connecting.googleCalendar, activeRunState: "claimed" as const },
		};
		expect(watchlistRefreshSignal(syncing)).toBe("active");
	});

	it("tells a loaded active run apart from nothing loaded", () => {
		expect(isWatchlistRefreshActive(null)).toBe(false);
		expect(isWatchlistRefreshActive(undefined)).toBe(false);
		expect(
			isWatchlistRefreshActive({
				stocks: [],
				lists: [],
				refresh: {
					activeRunId: null,
					activeRunState: null,
					lastSucceededAt: null,
					lastFailure: null,
				},
				feed: { enabled: false, createdAt: null },
				googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
			}),
		).toBe(false);
		expect(
			isWatchlistRefreshActive({
				stocks: [],
				lists: [],
				refresh: {
					activeRunId: "run_1",
					activeRunState: "claimed",
					lastSucceededAt: null,
					lastFailure: null,
				},
				feed: { enabled: false, createdAt: null },
				googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
			}),
		).toBe(true);
	});

	it("recognises network failures for idempotency-key retention", () => {
		expect(
			isNetworkFailure({
				kind: "network",
				code: "TIMEOUT",
				status: null,
				message: "t",
				detail: null,
				issues: [],
			}),
		).toBe(true);
		expect(
			isNetworkFailure({
				kind: "api",
				code: "RATE_LIMITED",
				status: 429,
				message: "t",
				detail: null,
				issues: [],
				upstreamStatus: null,
			}),
		).toBe(false);
	});
});

describe("never-fetched stocks", () => {
	function response(stocks: WatchlistStock[]): WatchlistResponse {
		return {
			stocks,
			lists: [],
			refresh: {
				activeRunId: null,
				activeRunState: null,
				lastSucceededAt: null,
				lastFailure: null,
			},
			feed: { enabled: false, createdAt: null },
			googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
		};
	}

	it("tells whether a stock's dates were never fetched (the pages then re-read sooner)", () => {
		expect(hasNeverRefreshedStock(response([]))).toBe(false);
		expect(hasNeverRefreshedStock(response([stock()]))).toBe(false);
		expect(hasNeverRefreshedStock(response([stock({ lastRefreshedAt: null })]))).toBe(true);
		expect(
			hasNeverRefreshedStock(
				response([stock(), stock({ stockId: "jp:7203", lastRefreshedAt: null })]),
			),
		).toBe(true);
	});
});

describe("google status text", () => {
	it("states the widget fragment for every status", () => {
		expect(googleWidgetStatus(DISCONNECTED_GOOGLE_CALENDAR_STATE, watchlistModelMessages.en)).toBe(
			"Google Calendar: not connected.",
		);
		expect(
			googleWidgetStatus(
				{ ...DISCONNECTED_GOOGLE_CALENDAR_STATE, status: "connecting" },
				watchlistModelMessages.en,
			),
		).toBe("Google Calendar: connecting…");
		expect(
			googleWidgetStatus(
				{ ...DISCONNECTED_GOOGLE_CALENDAR_STATE, status: "needs-reconnect" },
				watchlistModelMessages.en,
			),
		).toBe("Google Calendar: reconnect needed.");
		expect(
			googleWidgetStatus(
				{
					...DISCONNECTED_GOOGLE_CALENDAR_STATE,
					status: "connected",
					activeRunId: "run_google_1",
					activeRunState: "claimed",
				},
				watchlistModelMessages.en,
			),
		).toBe("Google Calendar: syncing…");
		expect(
			googleWidgetStatus(
				{
					...DISCONNECTED_GOOGLE_CALENDAR_STATE,
					status: "connected",
					lastSyncedAt: "2026-11-02T11:00:00Z",
				},
				watchlistModelMessages.en,
			),
		).toBe(`Google Calendar: synced ${formatInstant("2026-11-02T11:00:00Z")}.`);
		expect(
			googleWidgetStatus(
				{
					...DISCONNECTED_GOOGLE_CALENDAR_STATE,
					status: "connected",
					activeRunId: "run_google_2",
					activeRunState: "claimed",
					activeAction: "disconnect",
				},
				watchlistModelMessages.en,
			),
		).toBe("Google Calendar: disconnecting…");
		expect(
			googleWidgetStatus(
				{
					...DISCONNECTED_GOOGLE_CALENDAR_STATE,
					status: "connected",
				},
				watchlistModelMessages.en,
			),
		).toBe("Google Calendar: connected, not synced yet.");
	});

	it("states the fixed reason sentence per code, generic for unknown codes", () => {
		expect(googleFailureReason("GOOGLE_NOT_CONFIGURED", watchlistModelMessages.en)).toBe(
			"Google Calendar is not configured; set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in apps/runner/.env.",
		);
		expect(googleFailureReason("GOOGLE_AUTH_EXPIRED", watchlistModelMessages.en)).toBe(
			"The Google connection expired; reconnect Google Calendar.",
		);
		expect(googleFailureReason("SOMETHING_ELSE", watchlistModelMessages.en)).toBe(
			"The Google Calendar request failed.",
		);
	});
});
