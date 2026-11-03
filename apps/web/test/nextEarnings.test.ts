import type { EarningsEvent, StockEarningsCalendarView } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { isoWeekday, nextEarnings } from "../src/stocks/nextEarnings.ts";
import { makeStock } from "./watchlistHarness.ts";

/**
 * The next earnings announcement (ADR-0067, ADR-0068): the Watchlist entry
 * first, then the market calendar from the profile, from hand-worked dates.
 */

const event = (periodKey: string, announcementDate: string | null): EarningsEvent => ({
	periodKey,
	announcementDate,
	fiscalPeriodLabel: periodKey.toUpperCase(),
	fiscalPeriodEnd: null,
	timing: "unknown",
});

const TODAY = "2026-11-03";
const FINNHUB = { publisher: "Finnhub", sourceUrl: "https://finnhub.io/" };
const JPX = {
	publisher: "Japan Exchange Group (JPX)",
	sourceUrl: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
};

const calendar = (events: EarningsEvent[]): StockEarningsCalendarView => ({
	source: "jpx",
	...JPX,
	syncedAt: "2026-11-03T01:00:00.000Z",
	events,
});

describe("nextEarnings from the Watchlist entry", () => {
	it("picks the first announcement on or after today, skipping past ones", () => {
		const stock = makeStock({
			events: [event("q2", "2026-08-04"), event("q3", "2026-11-05"), event("q4", "2027-02-05")],
		});
		expect(nextEarnings(stock, undefined, TODAY)).toEqual({
			kind: "scheduled",
			event: event("q3", "2026-11-05"),
			date: "2026-11-05",
			daysUntil: 2,
			source: FINNHUB,
		});
		// On the day itself it is still the next one, 0 days away.
		expect(nextEarnings(stock, null, "2026-11-05")).toMatchObject({ daysUntil: 0 });
		// Across a year end.
		expect(nextEarnings(stock, null, "2026-12-31")).toMatchObject({
			date: "2027-02-05",
			daysUntil: 36,
		});
	});

	it("is undecided when only an undated announcement is upcoming", () => {
		const stock = makeStock({ events: [event("q2", "2026-08-04"), event("q3", null)] });
		expect(nextEarnings(stock, null, TODAY)).toEqual({
			kind: "undecided",
			event: event("q3", null),
			source: FINNHUB,
		});
	});

	it("says why there is no date when no calendar is stored either", () => {
		const unavailable = (code: "NEVER_REFRESHED" | "NO_SCHEDULED_DATE" | "RATE_LIMITED") => ({
			code,
			reason: "stored",
			upstreamStatus: null,
		});
		expect(
			nextEarnings(makeStock({ events: [], retrievedAt: null, unavailable: null }), null, TODAY),
		).toEqual({ kind: "not-fetched" });
		expect(
			nextEarnings(
				makeStock({ events: [], unavailable: unavailable("NEVER_REFRESHED") }),
				null,
				TODAY,
			),
		).toEqual({ kind: "not-fetched" });
		expect(nextEarnings(makeStock({ events: [event("q2", "2026-08-04")] }), null, TODAY)).toEqual({
			kind: "none",
			source: FINNHUB,
		});
		expect(
			nextEarnings(
				makeStock({ events: [], unavailable: unavailable("NO_SCHEDULED_DATE") }),
				null,
				TODAY,
			),
		).toEqual({ kind: "none", source: FINNHUB });
		expect(
			nextEarnings(
				makeStock({ events: [], unavailable: unavailable("RATE_LIMITED") }),
				null,
				TODAY,
			),
		).toEqual({ kind: "unavailable", code: "RATE_LIMITED" });
		// A stored upcoming date still shows after a later fetch failed.
		expect(
			nextEarnings(
				makeStock({
					events: [event("q3", "2026-11-05")],
					unavailable: unavailable("RATE_LIMITED"),
				}),
				null,
				TODAY,
			),
		).toMatchObject({ kind: "scheduled", date: "2026-11-05" });
	});
});

describe("nextEarnings from the market calendar (ADR-0068)", () => {
	it("answers a stock outside the Watchlist from its market's calendar", () => {
		expect(
			nextEarnings(null, calendar([event("q1", "2026-11-01"), event("q2", "2026-11-13")]), TODAY),
		).toEqual({
			kind: "scheduled",
			event: event("q2", "2026-11-13"),
			date: "2026-11-13",
			daysUntil: 10,
			source: JPX,
		});
		expect(nextEarnings(null, calendar([event("q2", null)]), TODAY)).toMatchObject({
			kind: "undecided",
			source: JPX,
		});
	});

	it("fills in for a Watchlist stock whose own fetch has no date, never overriding one", () => {
		const failed = makeStock({
			events: [],
			unavailable: { code: "RATE_LIMITED", reason: "stored", upstreamStatus: 429 },
		});
		expect(nextEarnings(failed, calendar([event("q2", "2026-11-13")]), TODAY)).toMatchObject({
			kind: "scheduled",
			date: "2026-11-13",
			source: JPX,
		});
		const dated = makeStock({ events: [event("q3", "2026-11-05")] });
		expect(nextEarnings(dated, calendar([event("q2", "2026-11-13")]), TODAY)).toMatchObject({
			date: "2026-11-05",
			source: FINNHUB,
		});
	});

	it("waits for the profile, then says none listed or not fetched yet", () => {
		expect(nextEarnings(null, undefined, TODAY)).toEqual({ kind: "loading" });
		expect(nextEarnings(null, calendar([event("q1", "2026-10-30")]), TODAY)).toEqual({
			kind: "none",
			source: JPX,
		});
		expect(nextEarnings(null, null, TODAY)).toEqual({ kind: "not-fetched" });
		// A stored calendar's "none" outranks the Watchlist's failure.
		const failed = makeStock({
			events: [],
			unavailable: { code: "SOURCE_FAILED", reason: "stored", upstreamStatus: null },
		});
		expect(nextEarnings(failed, calendar([]), TODAY)).toEqual({ kind: "none", source: JPX });
	});
});

describe("isoWeekday", () => {
	it("names the weekday of a date, 0 = Sunday", () => {
		expect(isoWeekday("2026-11-01")).toBe(0);
		expect(isoWeekday("2026-11-05")).toBe(4);
		expect(isoWeekday("2028-02-29")).toBe(2);
	});
});
