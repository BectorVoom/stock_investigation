import type { WatchlistResponse, WatchlistStock } from "@research/contracts";
import { DISCONNECTED_GOOGLE_CALENDAR_STATE } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	EARNINGS_AUTO_REFRESH_NOTICE,
	EARNINGS_AUTO_REFRESH_STALE_MS,
	earningsAutoRefreshReason,
	hasNeverRefreshedStock,
	hasUndecidedEvent,
	isNetworkFailure,
	isWatchlistRefreshActive,
	nextDatedEvent,
	normaliseSymbol,
	STORED_DATES_PASSED_NOTICE,
	storedDatesPassed,
	timingText,
	utcTodayIso,
	validateNewStock,
	watchlistRefreshSignal,
	watchlistStatusText,
	withoutUpcomingReason,
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

describe("validateNewStock", () => {
	it("accepts a US symbol and a Japanese code, trimmed and upper-cased before checking", () => {
		expect(validateNewStock("US", "AAPL")).toEqual([]);
		expect(validateNewStock("US", "  aapl ")).toEqual([]);
		expect(validateNewStock("JP", "7203")).toEqual([]);
		expect(validateNewStock("JP", "130a")).toEqual([]);
		expect(normaliseSymbol("  aapl ")).toBe("AAPL");
	});

	it("lists every problem the guideline way", () => {
		expect(validateNewStock("EU", "AAPL")).toEqual(["Choose a market."]);
		expect(validateNewStock("US", "   ")).toEqual(["Enter a symbol."]);
		expect(validateNewStock("US", "aapl!")).toEqual([
			'"aapl!" is not a valid symbol. A US symbol starts with a letter, e.g. AAPL.',
		]);
		expect(validateNewStock("JP", "720")).toEqual([
			'"720" is not a valid symbol. A Japanese code has four characters, e.g. 7203.',
		]);
		expect(validateNewStock("JP", "72034")).toEqual([
			'"72034" is not a valid symbol. A Japanese code has four characters, e.g. 7203.',
		]);
	});
});

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
		expect(STORED_DATES_PASSED_NOTICE).toBe(
			"unavailable (the stored dates have passed; refresh to update)",
		);
	});

	it("names the timing, or nothing when the source states none", () => {
		expect(timingText("after-close")).toBe("after market close");
		expect(timingText("before-open")).toBe("before market open");
		expect(timingText("during-session")).toBe("during the trading session");
		expect(timingText("unknown")).toBe(null);
	});

	it("explains why a stock has no upcoming date without guessing", () => {
		expect(withoutUpcomingReason(stock(), 90, TODAY)).toBe(
			"No earnings dates have been refreshed yet; queue a refresh.",
		);
		expect(
			withoutUpcomingReason(
				stock({
					unavailable: { code: "RATE_LIMITED", reason: "The provider rate limit was reached." },
				}),
				90,
				TODAY,
			),
		).toBe("The provider rate limit was reached.");
		expect(withoutUpcomingReason(stock({ events: [undecided] }), 90, TODAY)).toBe(
			"The source lists the announcement with the date undecided.",
		);
		expect(withoutUpcomingReason(stock({ events: [dated] }), 90, TODAY)).toBe(
			"The source lists no announcement in the next 90 days.",
		);
		// Stored dates that have all passed say so, even beside a failure reason.
		expect(
			withoutUpcomingReason(
				stock({
					events: [past],
					unavailable: { code: "RATE_LIMITED", reason: "The provider rate limit was reached." },
				}),
				90,
				TODAY,
			),
		).toBe(STORED_DATES_PASSED_NOTICE);
	});
});

describe("refresh status", () => {
	it("reads the UTC date from the clock reading", () => {
		expect(utcTodayIso(Date.parse("2026-10-13T00:30:00Z"))).toBe("2026-10-13");
	});

	it("derives the poll signal from the active run", () => {
		const base = {
			stocks: [],
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

	it("tells success and failure apart like Home does", () => {
		const text = watchlistStatusText({
			stocks: [],
			refresh: {
				activeRunId: null,
				activeRunState: null,
				lastSucceededAt: "2026-10-12T12:00:00Z",
				lastFailure: { state: "failed", code: "RUNNER_FAILED", at: "2026-10-12T13:00:00Z" },
			},
			feed: { enabled: false, createdAt: null },
			googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
		});
		expect(text).toContain("Last successful refresh:");
		expect(text).toContain("Last refresh failed (RUNNER_FAILED)");
		expect(
			watchlistStatusText({
				stocks: [],
				refresh: {
					activeRunId: "run_1",
					activeRunState: "claimed",
					lastSucceededAt: null,
					lastFailure: null,
				},
				feed: { enabled: false, createdAt: null },
				googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
			}),
		).toContain("run run_1");
	});

	it("tells a loaded active run apart from nothing loaded", () => {
		expect(isWatchlistRefreshActive(null)).toBe(false);
		expect(isWatchlistRefreshActive(undefined)).toBe(false);
		expect(
			isWatchlistRefreshActive({
				stocks: [],
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
			}),
		).toBe(false);
	});
});

describe("earnings auto-refresh reason", () => {
	const NOW = Date.parse("2026-10-13T12:00:00Z");

	function response(
		stocks: WatchlistStock[],
		activeRunId: string | null = null,
	): WatchlistResponse {
		return {
			stocks,
			refresh: {
				activeRunId,
				activeRunState: activeRunId === null ? null : "pending",
				lastSucceededAt: null,
				lastFailure: null,
			},
			feed: { enabled: false, createdAt: null },
			googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
		};
	}

	it("is a 24-hour window", () => {
		expect(EARNINGS_AUTO_REFRESH_STALE_MS).toBe(24 * 3_600_000);
	});

	it("never fires for an empty list or an active run", () => {
		expect(earningsAutoRefreshReason(response([]), NOW)).toBe(null);
		expect(earningsAutoRefreshReason(response([stock()], "run_1"), NOW)).toBe(null);
	});

	it("reports never-refreshed when a stock was never refreshed", () => {
		expect(earningsAutoRefreshReason(response([stock({ lastRefreshedAt: null })]), NOW)).toBe(
			"never-refreshed",
		);
		// Mixed: one fresh stock beside one never refreshed still fetches.
		expect(
			earningsAutoRefreshReason(
				response([stock(), stock({ stockId: "jp:7203", lastRefreshedAt: null })]),
				NOW,
			),
		).toBe("never-refreshed");
		expect(hasNeverRefreshedStock(response([stock()]))).toBe(false);
		expect(hasNeverRefreshedStock(response([stock({ lastRefreshedAt: null })]))).toBe(true);
	});

	it("counts an unparsable stamp as never refreshed, like Home", () => {
		expect(
			earningsAutoRefreshReason(response([stock({ lastRefreshedAt: "not-a-date" })]), NOW),
		).toBe("never-refreshed");
	});

	it("is stale only past 24 hours: exactly 24 h is fresh, 24 h + 1 ms is stale", () => {
		const fresh = new Date(NOW - EARNINGS_AUTO_REFRESH_STALE_MS).toISOString();
		const stale = new Date(NOW - EARNINGS_AUTO_REFRESH_STALE_MS - 1).toISOString();
		expect(earningsAutoRefreshReason(response([stock({ lastRefreshedAt: fresh })]), NOW)).toBe(
			null,
		);
		expect(earningsAutoRefreshReason(response([stock({ lastRefreshedAt: stale })]), NOW)).toBe(
			"stale",
		);
		// Freshness follows the NEWEST stamp: one stale stock beside a fresh one queues nothing.
		expect(
			earningsAutoRefreshReason(
				response([
					stock({ lastRefreshedAt: stale }),
					stock({ stockId: "jp:7203", lastRefreshedAt: new Date(NOW).toISOString() }),
				]),
				NOW,
			),
		).toBe(null);
	});

	it("announces why, the same text on both views", () => {
		expect(EARNINGS_AUTO_REFRESH_NOTICE["never-refreshed"]).toBe(
			"Earnings dates had not been fetched yet, so one refresh was queued.",
		);
		expect(EARNINGS_AUTO_REFRESH_NOTICE.stale).toBe(
			"Earnings dates were more than a day old, so one refresh was queued.",
		);
	});
});
