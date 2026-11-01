import type { WatchlistResponse, WatchlistStock } from "@research/contracts";
import { DISCONNECTED_GOOGLE_CALENDAR_STATE } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { formatInstant } from "../src/lib/format.ts";
import { watchlistModelMessages } from "../src/watchlist/watchlistModel.messages.ts";
import {
	earningsUnavailableText,
	googleAutoSyncWanted,
	googleFailureReason,
	googleWidgetStatus,
	hasNeverRefreshedStock,
	hasUndecidedEvent,
	isGoogleCalendarRunActive,
	isNetworkFailure,
	isWatchlistRefreshActive,
	nextDatedEvent,
	storedDatesPassed,
	timingText,
	utcTodayIso,
	watchlistRefreshSignal,
	watchlistStatusText,
	withoutUpcomingReason,
} from "../src/watchlist/watchlistModel.ts";

/** The English words the model's sentences are checked against. */
const EN = watchlistModelMessages.en;

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

describe("event helpers", () => {
	const dated = {
		periodKey: "2026-q4",
		announcementDate: "2026-10-29",
		fiscalPeriodLabel: "Q4 2026",
		fiscalPeriodEnd: null,
		timing: "after-close" as const,
	};
	const past = {
		...dated,
		periodKey: "2026-q3",
		announcementDate: "2026-07-29",
		fiscalPeriodLabel: "Q3 2026",
	};
	const undecided = {
		periodKey: "fy2027-03-31-second-quarter",
		announcementDate: null,
		fiscalPeriodLabel: "Second quarter",
		fiscalPeriodEnd: "2027-03-31",
		timing: "unknown" as const,
	};
	const TODAY = "2026-10-13";

	it("finds the first dated event on or after today, never a past one", () => {
		expect(nextDatedEvent(stock(), TODAY)).toBe(null);
		expect(nextDatedEvent(stock({ events: [undecided, dated] }), TODAY)).toEqual(dated);
		expect(nextDatedEvent(stock({ events: [past, dated] }), TODAY)).toEqual(dated);
		expect(nextDatedEvent(stock({ events: [past] }), TODAY)).toBe(null);
		expect(nextDatedEvent(stock({ events: [dated] }), "2026-10-29")).toEqual(dated);
		expect(hasUndecidedEvent(stock({ events: [dated] }))).toBe(false);
		expect(hasUndecidedEvent(stock({ events: [dated, undecided] }))).toBe(true);
	});

	it("spots stocks whose stored dates have all passed", () => {
		expect(storedDatesPassed(stock(), TODAY)).toBe(false);
		expect(storedDatesPassed(stock({ events: [undecided] }), TODAY)).toBe(false);
		expect(storedDatesPassed(stock({ events: [past] }), TODAY)).toBe(true);
		expect(storedDatesPassed(stock({ events: [past, dated] }), TODAY)).toBe(false);
		expect(storedDatesPassed(stock({ events: [dated] }), "2026-10-30")).toBe(true);
		expect(EN.storedDatesPassed).toBe(
			"unavailable (the stored dates have passed; the next automatic refresh updates them)",
		);
	});

	it("names the timing, or nothing when the source states none", () => {
		expect(timingText("after-close", EN)).toBe("after market close");
		expect(timingText("before-open", EN)).toBe("before market open");
		expect(timingText("during-session", EN)).toBe("during the trading session");
		expect(timingText("unknown", EN)).toBe(null);
	});

	it("explains why a stock has no upcoming date without guessing", () => {
		expect(withoutUpcomingReason(stock(), 90, TODAY, EN)).toBe(
			"No earnings dates yet; they appear after the next automatic refresh.",
		);
		// A stock never fetched says when its dates come, not the stored sentence.
		expect(
			earningsUnavailableText(
				{
					code: "NEVER_REFRESHED",
					reason: "No earnings dates have been refreshed yet.",
					upstreamStatus: null,
				},
				EN,
			),
		).toBe(EN.noRefreshYet);
		expect(watchlistModelMessages.ja.noRefreshYet).toBe(
			"決算発表日はまだありません。次回の自動更新後に表示されます。",
		);
		expect(
			withoutUpcomingReason(
				stock({
					unavailable: {
						code: "RATE_LIMITED",
						reason: "The provider rate limit was reached.",
						upstreamStatus: null,
					},
				}),
				90,
				TODAY,
				EN,
			),
		).toBe("The provider rate limit was reached.");
		expect(
			withoutUpcomingReason(
				stock({
					unavailable: {
						code: "RATE_LIMITED",
						reason: "The provider rate limit was reached.",
						upstreamStatus: 429,
					},
				}),
				90,
				TODAY,
				EN,
			),
		).toBe("The provider rate limit was reached. The service answered HTTP 429.");
		expect(withoutUpcomingReason(stock({ events: [undecided] }), 90, TODAY, EN)).toBe(
			"The source lists the announcement with the date undecided.",
		);
		expect(withoutUpcomingReason(stock({ events: [dated] }), 90, TODAY, EN)).toBe(
			"The source lists no announcement in the next 90 days.",
		);
		// Stored dates that have all passed say so, even beside a failure reason.
		expect(
			withoutUpcomingReason(
				stock({
					events: [past],
					unavailable: {
						code: "RATE_LIMITED",
						reason: "The provider rate limit was reached.",
						upstreamStatus: null,
					},
				}),
				90,
				TODAY,
				EN,
			),
		).toBe(EN.storedDatesPassed);
	});
});

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

	it("says nothing when idle and current, and names a run or a failure no success followed", () => {
		const watchlist = (refresh: WatchlistResponse["refresh"]): WatchlistResponse => ({
			stocks: [],
			lists: [],
			refresh,
			feed: { enabled: false, createdAt: null },
			googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
		});
		const failure = {
			state: "failed",
			code: "RUNNER_FAILED",
			upstreamStatus: null,
			at: "2026-10-12T13:00:00Z",
		} as const;
		const idle = { activeRunId: null, activeRunState: null } as const;
		// Never refreshed, or refreshed fine: nothing to say (the table shows the dates).
		expect(
			watchlistStatusText(watchlist({ ...idle, lastSucceededAt: null, lastFailure: null }), EN),
		).toBe(null);
		expect(
			watchlistStatusText(
				watchlist({ ...idle, lastSucceededAt: "2026-10-12T12:00:00Z", lastFailure: null }),
				EN,
			),
		).toBe(null);
		// A failure after the last success is stated; one a later success replaced is not.
		const failed = watchlistStatusText(
			watchlist({ ...idle, lastSucceededAt: "2026-10-12T12:00:00Z", lastFailure: failure }),
			EN,
		);
		expect(failed).toContain("Last refresh failed (RUNNER_FAILED)");
		expect(failed).not.toContain("Last successful refresh");
		expect(
			watchlistStatusText(
				watchlist({ ...idle, lastSucceededAt: "2026-10-12T14:00:00Z", lastFailure: failure }),
				EN,
			),
		).toBe(null);
		// A run in progress is always stated.
		expect(
			watchlistStatusText(
				watchlist({
					activeRunId: "run_1",
					activeRunState: "claimed",
					lastSucceededAt: null,
					lastFailure: null,
				}),
				EN,
			),
		).toContain("run run_1");
	});

	it("shows the provider's own status beside a failed refresh's code, unchanged (ADR-0037)", () => {
		const text = watchlistStatusText(
			{
				stocks: [],
				lists: [],
				refresh: {
					activeRunId: null,
					activeRunState: null,
					lastSucceededAt: null,
					lastFailure: {
						state: "failed",
						code: "RATE_LIMITED",
						upstreamStatus: 429,
						at: "2026-10-12T13:00:00Z",
					},
				},
				feed: { enabled: false, createdAt: null },
				googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
			},
			EN,
		);
		expect(text).toContain("Last refresh failed (RATE_LIMITED, service answered HTTP 429)");
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

describe("google auto-sync rule", () => {
	function response(
		overrides: Partial<WatchlistResponse["googleCalendar"]> = {},
		refreshActive: string | null = null,
	): WatchlistResponse {
		return {
			stocks: [stock()],
			lists: [],
			refresh: {
				activeRunId: refreshActive,
				activeRunState: refreshActive === null ? null : "pending",
				lastSucceededAt: null,
				lastFailure: null,
			},
			feed: { enabled: false, createdAt: null },
			googleCalendar: {
				...DISCONNECTED_GOOGLE_CALENDAR_STATE,
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-11-02T10:00:00Z",
				inSync: false,
				...overrides,
			},
		};
	}

	it("wants one sync when connected, out of sync, and nothing runs", () => {
		expect(googleAutoSyncWanted(response(), '"etag-1"', null)).toBe(true);
	});

	it("wants nothing unless connected and out of sync", () => {
		expect(
			googleAutoSyncWanted(response({ status: "disconnected", inSync: null }), '"etag-1"', null),
		).toBe(false);
		expect(googleAutoSyncWanted(response({ status: "needs-reconnect" }), '"etag-1"', null)).toBe(
			false,
		);
		expect(googleAutoSyncWanted(response({ inSync: true }), '"etag-1"', null)).toBe(false);
		expect(googleAutoSyncWanted(response({ inSync: null }), '"etag-1"', null)).toBe(false);
	});

	it("wants nothing while a google or earnings run is active", () => {
		expect(
			googleAutoSyncWanted(
				response({ activeRunId: "run_google_1", activeRunState: "claimed" }),
				'"etag-1"',
				null,
			),
		).toBe(false);
		expect(googleAutoSyncWanted(response({}, "run_earnings_1"), '"etag-1"', null)).toBe(false);
	});

	it("stops after any recorded failure, whatever the ETag — a failed run can never queue the next", () => {
		const failed = response({
			lastFailure: {
				code: "GOOGLE_RATE_LIMITED",
				upstreamStatus: null,
				reason: "Google is limiting requests right now; try again later.",
				at: "2026-11-02T11:00:00Z",
			},
		});
		// Every failed run moves the ETag (a new `lastFailure`): replaying the
		// rule over thirty such ETags queues nothing, with or without a
		// recorded attempt.
		let attempted: string | null = null;
		let queued = 0;
		for (let run = 0; run < 30; run += 1) {
			const tag = `"etag-after-failure-${run}"`;
			if (googleAutoSyncWanted(failed, tag, attempted)) {
				queued += 1;
				attempted = tag;
			}
		}
		expect(queued).toBe(0);
		expect(googleAutoSyncWanted(failed, '"fresh-mount"', null)).toBe(false);
	});

	it("attempts at most once per watchlist ETag: a recorded attempt never retries", () => {
		expect(googleAutoSyncWanted(response(), '"etag-1"', '"etag-1"')).toBe(false);
		// A changed watchlist (a new ETag) re-arms the rule once.
		expect(googleAutoSyncWanted(response(), '"etag-2"', '"etag-1"')).toBe(true);
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
