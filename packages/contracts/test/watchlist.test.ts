import { WATCHLIST_LIMITS } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	addWatchlistStockRequestSchema,
	calendarFeedIssuedSchema,
	DISCONNECTED_GOOGLE_CALENDAR_STATE,
	EARNINGS_LIMITS,
	EARNINGS_UNAVAILABLE_CODES,
	earningsEventSchema,
	earningsSourceIdSchema,
	earningsTimingSchema,
	earningsUnavailable,
	earningsUnavailableReason,
	earningsUnavailableSchema,
	formatStockId,
	parseStockId,
	watchlistResponseSchema,
	watchlistStockIdSchema,
	watchlistStockSchema,
	watchMarketSchema,
} from "../src/index.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

const EVENT = {
	periodKey: "2026-q4",
	announcementDate: "2026-10-29",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
} as const;

const STOCK = {
	stockId: "us:AAPL",
	market: "US",
	symbol: "AAPL",
	name: "Apple Inc",
	addedAt: "2026-10-11T03:00:00.000Z",
	source: "finnhub",
	publisher: "Finnhub",
	sourceUrl: "https://finnhub.io/",
	lastRefreshedAt: "2026-10-11T03:00:00.000Z",
	retrievedAt: "2026-10-11T03:00:00.000Z",
	unavailable: null,
	events: [EVENT],
} as const;

const RESPONSE = {
	stocks: [STOCK],
	refresh: {
		activeRunId: null,
		activeRunState: null,
		lastSucceededAt: "2026-10-11T03:00:00.000Z",
		lastFailure: null,
	},
	feed: { enabled: false, createdAt: null },
	googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
} as const;

describe("watchlist limits", () => {
	it("re-exports the domain bounds by reference", () => {
		expect(EARNINGS_LIMITS.maxStocks).toBe(WATCHLIST_LIMITS.maxStocks);
		expect(EARNINGS_LIMITS.maxEventsPerStock).toBe(WATCHLIST_LIMITS.maxEventsPerStock);
		expect(EARNINGS_LIMITS.horizonDays).toBe(WATCHLIST_LIMITS.horizonDays);
		expect(EARNINGS_LIMITS).toEqual({ maxStocks: 50, maxEventsPerStock: 8, horizonDays: 185 });
	});
});

describe("watchlist stock ids", () => {
	it("accepts market ids and rejects bad ones", () => {
		for (const id of ["us:AAPL", "us:BRK.B", "jp:7203", "jp:130A"]) {
			expectAccepted(watchlistStockIdSchema, id);
		}
		for (const id of ["AAPL", "us:", "us:aapl", "jp:720", "nasdaq:AAPL", "US:AAPL", ""]) {
			expectRejected(watchlistStockIdSchema, id);
		}
	});

	it("parses into market and symbol and formats back", () => {
		expect(parseStockId("us:AAPL")).toEqual({ market: "US", symbol: "AAPL" });
		expect(parseStockId("jp:130A")).toEqual({ market: "JP", symbol: "130A" });
		expect(parseStockId("nope")).toBeNull();
		expect(formatStockId("JP", "7203")).toBe("jp:7203");
	});

	it("knows the two markets, sources and timings", () => {
		expectAccepted(watchMarketSchema, "US");
		expectAccepted(watchMarketSchema, "JP");
		expectRejected(watchMarketSchema, "UK");
		expectAccepted(earningsSourceIdSchema, "finnhub");
		expectAccepted(earningsSourceIdSchema, "jpx");
		expectRejected(earningsSourceIdSchema, "twelve-data");
		for (const timing of ["before-open", "after-close", "during-session", "unknown"]) {
			expectAccepted(earningsTimingSchema, timing);
		}
		expectRejected(earningsTimingSchema, "morning");
	});
});

describe("earnings unavailable", () => {
	it("pins every code to fixed wording", () => {
		expect(EARNINGS_UNAVAILABLE_CODES).toEqual([
			"NEVER_REFRESHED",
			"SOURCE_NOT_CONFIGURED",
			"SOURCE_AUTH_FAILED",
			"SYMBOL_NOT_FOUND",
			"PLAN_NOT_ENTITLED",
			"RATE_LIMITED",
			"NO_SCHEDULED_DATE",
			"SOURCE_FAILED",
		]);
		for (const code of EARNINGS_UNAVAILABLE_CODES) {
			const unavailable = earningsUnavailable(code);
			expectAccepted(earningsUnavailableSchema, unavailable);
			expect(unavailable.reason.length).toBeLessThanOrEqual(300);
		}
		expectRejected(earningsUnavailableSchema, { code: "BROKEN", reason: "x" });
		expect(earningsUnavailable("NO_SCHEDULED_DATE").reason).toBe(
			"The source lists no upcoming announcement for this stock.",
		);
		expect(earningsUnavailableReason("SOURCE_NOT_CONFIGURED", "finnhub")).toContain(
			"FINNHUB_API_KEY",
		);
		expect(earningsUnavailableReason("SOURCE_NOT_CONFIGURED", "finnhub")).toContain(
			"apps/runner/.env",
		);
		expect(earningsUnavailableReason("SOURCE_AUTH_FAILED", "finnhub")).toBe(
			earningsUnavailableReason("SOURCE_AUTH_FAILED"),
		);
	});
});

describe("earnings events", () => {
	it("accepts dated and undecided events", () => {
		expectAccepted(earningsEventSchema, EVENT);
		expectAccepted(earningsEventSchema, {
			periodKey: "fy2027-03-31-second-quarter",
			announcementDate: null,
			fiscalPeriodLabel: "Second quarter",
			fiscalPeriodEnd: "2027-03-31",
			timing: "unknown",
		});
	});

	it("rejects bad period keys, labels and dates", () => {
		expectRejected(earningsEventSchema, { ...EVENT, periodKey: "2026/Q4" }, ["periodKey"]);
		expectRejected(earningsEventSchema, { ...EVENT, periodKey: "2026_Q4" }, ["periodKey"]);
		expectRejected(earningsEventSchema, { ...EVENT, periodKey: "" }, ["periodKey"]);
		expectRejected(earningsEventSchema, { ...EVENT, fiscalPeriodLabel: "" });
		expectRejected(earningsEventSchema, {
			...EVENT,
			fiscalPeriodLabel: "x".repeat(81),
		});
		expectRejected(earningsEventSchema, { ...EVENT, announcementDate: "10/29/2026" });
		expectRejected(earningsEventSchema, { ...EVENT, timing: "morning" });
		expectRejected(earningsEventSchema, without(EVENT, "timing"));
	});
});

describe("watchlist stocks and responses", () => {
	it("accepts a full response", () => {
		expectAccepted(watchlistResponseSchema, RESPONSE);
	});

	it("accepts a JP stock with an undecided event after dated ones", () => {
		expectAccepted(watchlistStockSchema, {
			stockId: "jp:7203",
			market: "JP",
			symbol: "7203",
			name: null,
			addedAt: "2026-10-11T03:00:00.000Z",
			source: "jpx",
			publisher: "Japan Exchange Group (JPX)",
			sourceUrl: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
			lastRefreshedAt: null,
			retrievedAt: null,
			unavailable: earningsUnavailable("NEVER_REFRESHED"),
			events: [
				{
					periodKey: "fy2026-03-31-second-quarter",
					announcementDate: "2026-11-05",
					fiscalPeriodLabel: "Second quarter",
					fiscalPeriodEnd: "2026-03-31",
					timing: "unknown",
				},
				{
					periodKey: "fy2027-03-31-second-quarter",
					announcementDate: null,
					fiscalPeriodLabel: "Second quarter",
					fiscalPeriodEnd: "2027-03-31",
					timing: "unknown",
				},
			],
		});
	});

	it("rejects mismatched ids, unordered events and over-limit collections", () => {
		expectRejected(watchlistStockSchema, { ...STOCK, stockId: "us:MSFT" }, ["stockId"]);
		expectRejected(
			watchlistStockSchema,
			{
				...STOCK,
				events: [
					{ ...EVENT, announcementDate: null },
					{ ...EVENT, periodKey: "2027-q1", announcementDate: "2027-01-28" },
				],
			},
			["events"],
		);
		expectRejected(
			watchlistStockSchema,
			{
				...STOCK,
				events: [
					{ ...EVENT, periodKey: "2027-q2", announcementDate: "2027-04-28" },
					{ ...EVENT, announcementDate: "2026-10-29" },
				],
			},
			["events"],
		);
		expectRejected(
			watchlistStockSchema,
			{ ...STOCK, events: repeat(EVENT, EARNINGS_LIMITS.maxEventsPerStock + 1) },
			["events"],
		);
		expectRejected(
			watchlistResponseSchema,
			{ ...RESPONSE, stocks: repeat(STOCK, EARNINGS_LIMITS.maxStocks + 1) },
			["stocks"],
		);
		expectRejected(watchlistStockSchema, without(STOCK, "addedAt"));
		expectRejected(watchlistStockSchema, { ...STOCK, sourceUrl: "http://finnhub.io/" });
	});
});

describe("addWatchlistStockRequest", () => {
	it("trims and upper-cases the symbol before validation", () => {
		expect(addWatchlistStockRequestSchema.parse({ market: "US", symbol: "  aapl " })).toEqual({
			market: "US",
			symbol: "AAPL",
		});
		expect(addWatchlistStockRequestSchema.parse({ market: "JP", symbol: " 7203 " })).toEqual({
			market: "JP",
			symbol: "7203",
		});
	});

	it("rejects symbols that do not match the market shape", () => {
		expectRejected(addWatchlistStockRequestSchema, { market: "US", symbol: "7203" }, ["symbol"]);
		expectRejected(addWatchlistStockRequestSchema, { market: "JP", symbol: "AAPL" }, ["symbol"]);
		expectRejected(addWatchlistStockRequestSchema, { market: "US", symbol: "" });
		expectRejected(addWatchlistStockRequestSchema, { market: "XX", symbol: "AAPL" });
		expectRejected(addWatchlistStockRequestSchema, { market: "US", symbol: "AAPL", extra: 1 });
	});
});

describe("calendarFeedIssued", () => {
	it("accepts a token, path and timestamp", () => {
		const token = "a".repeat(43);
		expectAccepted(calendarFeedIssuedSchema, {
			token,
			path: `/api/v1/calendar-feed/${token}/earnings.ics`,
			createdAt: "2026-10-11T03:00:00.000Z",
		});
	});

	it("rejects short tokens and wrong paths", () => {
		expectRejected(calendarFeedIssuedSchema, {
			token: "short",
			path: "/api/v1/calendar-feed/short/earnings.ics",
			createdAt: "2026-10-11T03:00:00.000Z",
		});
		expectRejected(calendarFeedIssuedSchema, {
			token: "a".repeat(43),
			path: "/api/v1/watchlist/calendar.ics",
			createdAt: "2026-10-11T03:00:00.000Z",
		});
		expectRejected(calendarFeedIssuedSchema, without({ token: "a".repeat(43) }, "token"));
	});
});
