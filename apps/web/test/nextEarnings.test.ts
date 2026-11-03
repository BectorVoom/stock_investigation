import type { EarningsEvent } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { isoWeekday, nextEarnings } from "../src/stocks/nextEarnings.ts";
import { makeStock } from "./watchlistHarness.ts";

/** The next earnings announcement of a Watchlist stock (ADR-0067), from hand-worked dates. */

const event = (periodKey: string, announcementDate: string | null): EarningsEvent => ({
	periodKey,
	announcementDate,
	fiscalPeriodLabel: periodKey.toUpperCase(),
	fiscalPeriodEnd: null,
	timing: "unknown",
});

const TODAY = "2026-11-03";

describe("nextEarnings", () => {
	it("is not-watched for a stock that is not on the Watchlist", () => {
		expect(nextEarnings(null, TODAY)).toEqual({ kind: "not-watched" });
	});

	it("picks the first announcement on or after today, skipping past ones", () => {
		const stock = makeStock({
			events: [event("q2", "2026-08-04"), event("q3", "2026-11-05"), event("q4", "2027-02-05")],
		});
		expect(nextEarnings(stock, TODAY)).toMatchObject({
			kind: "scheduled",
			date: "2026-11-05",
			daysUntil: 2,
			event: { periodKey: "q3" },
		});
		// On the day itself it is still the next one, 0 days away.
		expect(nextEarnings(stock, "2026-11-05")).toMatchObject({ date: "2026-11-05", daysUntil: 0 });
		// Across a year end.
		expect(nextEarnings(stock, "2026-12-31")).toMatchObject({ date: "2027-02-05", daysUntil: 36 });
	});

	it("is undecided when only an undated announcement is upcoming", () => {
		const stock = makeStock({ events: [event("q2", "2026-08-04"), event("q3", null)] });
		expect(nextEarnings(stock, TODAY)).toMatchObject({
			kind: "undecided",
			event: { periodKey: "q3" },
		});
	});

	it("says why there is no date: never fetched, none scheduled or a failed fetch", () => {
		const unavailable = (code: "NEVER_REFRESHED" | "NO_SCHEDULED_DATE" | "RATE_LIMITED") => ({
			code,
			reason: "stored",
			upstreamStatus: null,
		});
		expect(
			nextEarnings(makeStock({ events: [], retrievedAt: null, unavailable: null }), TODAY),
		).toEqual({ kind: "not-fetched" });
		expect(
			nextEarnings(makeStock({ events: [], unavailable: unavailable("NEVER_REFRESHED") }), TODAY),
		).toEqual({ kind: "not-fetched" });
		expect(nextEarnings(makeStock({ events: [event("q2", "2026-08-04")] }), TODAY)).toEqual({
			kind: "none",
		});
		expect(
			nextEarnings(makeStock({ events: [], unavailable: unavailable("NO_SCHEDULED_DATE") }), TODAY),
		).toEqual({ kind: "none" });
		expect(
			nextEarnings(makeStock({ events: [], unavailable: unavailable("RATE_LIMITED") }), TODAY),
		).toEqual({ kind: "unavailable", code: "RATE_LIMITED" });
		// A stored upcoming date still shows after a later fetch failed.
		expect(
			nextEarnings(
				makeStock({
					events: [event("q3", "2026-11-05")],
					unavailable: unavailable("RATE_LIMITED"),
				}),
				TODAY,
			),
		).toMatchObject({ kind: "scheduled", date: "2026-11-05" });
	});
});

describe("isoWeekday", () => {
	it("names the weekday of a date, 0 = Sunday", () => {
		expect(isoWeekday("2026-11-01")).toBe(0);
		expect(isoWeekday("2026-11-05")).toBe(4);
		expect(isoWeekday("2028-02-29")).toBe(2);
	});
});
