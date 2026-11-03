/**
 * The whole-market earnings calendars (ADR-0068): Finnhub's calendar asked
 * without a symbol, walked in 7-day windows with capped weeks asked day by
 * day, and every JPX workbook row as a calendar event. Finnhub bodies are
 * shaped like its live answer of 2026-11-03 (a 7-day window answered
 * exactly 1,500 rows; one day 567).
 */
import type { EarningsCalendarEvent } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	calendarWindows,
	createFinnhubEarningsSource,
	finnhubCalendarSymbol,
} from "../../src/finance/finnhubEarnings.ts";
import { jpxCalendarEvents } from "../../src/finance/jpxEarnings.ts";
import type { JpxWorkbookRow } from "../../src/finance/jpxWorkbook.ts";
import { createScriptedFetcher } from "../tools/support.ts";

const NEVER = new AbortController().signal;

function url(from: string, to: string): string {
	return `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}`;
}

function row(symbol: string | null, date: string, quarter: number | null = 3) {
	return { date, epsActual: null, epsEstimate: 0.5, hour: "amc", quarter, year: 2026, symbol };
}

function answer(rows: readonly unknown[]): { readonly text: string } {
	return { text: JSON.stringify({ earningsCalendar: rows }) };
}

/** `count` distinct rows dated `date`: a capped answer when count is 1,500. */
function many(count: number, date: string): unknown[] {
	return Array.from({ length: count }, (_, index) => row(`Z${index}`, date));
}

describe("calendarWindows", () => {
	it("cuts a window into consecutive 7-day pieces, the last shorter", () => {
		expect(calendarWindows("2026-12-28", "2027-01-12", 7)).toEqual([
			{ from: "2026-12-28", to: "2027-01-03" },
			{ from: "2027-01-04", to: "2027-01-10" },
			{ from: "2027-01-11", to: "2027-01-12" },
		]);
		expect(calendarWindows("2026-11-03", "2026-11-03", 7)).toEqual([
			{ from: "2026-11-03", to: "2026-11-03" },
		]);
		expect(calendarWindows("2026-11-03", "2026-11-05", 1).map((window) => window.from)).toEqual([
			"2026-11-03",
			"2026-11-04",
			"2026-11-05",
		]);
	});

	it("is empty for a backwards or invalid window", () => {
		expect(calendarWindows("2026-11-05", "2026-11-03", 7)).toEqual([]);
		expect(calendarWindows("2026-02-30", "2026-03-03", 7)).toEqual([]);
		expect(calendarWindows("2026-11-03", "2026-11-05", 0)).toEqual([]);
	});
});

describe("finnhubCalendarSymbol", () => {
	it("writes share classes as the stock list does and drops what it cannot hold", () => {
		expect(finnhubCalendarSymbol("BH.A")).toBe("BH-A");
		expect(finnhubCalendarSymbol("KO")).toBe("KO");
		expect(finnhubCalendarSymbol("")).toBeNull();
		expect(finnhubCalendarSymbol("abc")).toBeNull();
		expect(finnhubCalendarSymbol("A".repeat(17))).toBeNull();
	});
});

describe("Finnhub market calendar", () => {
	it("walks the window, asks a capped week day by day and reports a capped day", async () => {
		const fetcher = createScriptedFetcher({
			[url("2026-11-01", "2026-11-07")]: answer([
				row("KO", "2026-11-03"),
				row("BH.A", "2026-11-04"),
				row("bad symbol", "2026-11-04"),
				row("NOQ", "2026-11-04", null),
				// Outside the window asked: Finnhub's answer is not trusted on it.
				row("OUT", "2026-11-09"),
				// A second row for one stock and period: the first wins.
				row("KO", "2026-11-05"),
			]),
			[url("2026-11-08", "2026-11-14")]: answer(many(1_500, "2026-11-09")),
			[url("2026-11-08", "2026-11-08")]: answer([]),
			[url("2026-11-09", "2026-11-09")]: answer(many(1_500, "2026-11-09")),
			[url("2026-11-10", "2026-11-10")]: answer([row("PEP", "2026-11-10")]),
			[url("2026-11-11", "2026-11-11")]: answer([]),
			[url("2026-11-12", "2026-11-12")]: answer([]),
			[url("2026-11-13", "2026-11-13")]: answer([]),
			[url("2026-11-14", "2026-11-14")]: answer([]),
			[url("2026-11-15", "2026-11-16")]: answer([row("XOM", "2026-11-16")]),
		});
		let grants = 0;
		const source = createFinnhubEarningsSource({ apiKey: "finnhub-key", fetcher });
		const result = await source.fetchCalendar({
			fromDate: "2026-11-01",
			toDate: "2026-11-16",
			signal: NEVER,
			beforeRequest: () => {
				grants += 1;
				return Promise.resolve(true);
			},
		});
		if (!result.ok) throw new Error(`expected a calendar, got ${JSON.stringify(result.error)}`);
		// One week, the capped week, its seven days, the last two days.
		expect(fetcher.urls()).toEqual([
			url("2026-11-01", "2026-11-07"),
			url("2026-11-08", "2026-11-14"),
			...calendarWindows("2026-11-08", "2026-11-14", 1).map((day) => url(day.from, day.to)),
			url("2026-11-15", "2026-11-16"),
		]);
		expect(grants).toBe(fetcher.calls.length);
		// The key travels as a header, never in the URL.
		expect(fetcher.calls.every((call) => !call.url.includes("finnhub-key"))).toBe(true);
		expect(result.value.truncatedDates).toEqual(["2026-11-09"]);
		const bySymbol = (symbol: string): EarningsCalendarEvent | undefined =>
			result.value.events.find((event) => event.symbol === symbol);
		expect(bySymbol("KO")).toEqual({
			symbol: "KO",
			periodKey: "2026-q3",
			announcementDate: "2026-11-03",
			fiscalPeriodLabel: "Q3 2026",
			fiscalPeriodEnd: null,
			timing: "after-close",
		});
		expect(bySymbol("BH-A")?.announcementDate).toBe("2026-11-04");
		expect(bySymbol("PEP")?.announcementDate).toBe("2026-11-10");
		expect(bySymbol("XOM")?.announcementDate).toBe("2026-11-16");
		for (const dropped of ["bad symbol", "NOQ", "OUT"]) expect(bySymbol(dropped)).toBeUndefined();
		expect(result.value.events.filter((event) => event.symbol === "KO")).toHaveLength(1);
		expect(result.value.events).toHaveLength(4 + 1_500);
	});

	it("fails the whole calendar on any failed request, with Finnhub's status", async () => {
		const fetcher = createScriptedFetcher({
			[url("2026-11-01", "2026-11-07")]: answer([row("KO", "2026-11-03")]),
			[url("2026-11-08", "2026-11-10")]: {
				error: { code: "HTTP_ERROR", detail: "HTTP 429", status: 429 },
			},
		});
		const source = createFinnhubEarningsSource({ apiKey: "finnhub-key", fetcher });
		const result = await source.fetchCalendar({
			fromDate: "2026-11-01",
			toDate: "2026-11-10",
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(result).toEqual({ ok: false, error: { code: "RATE_LIMITED", upstreamStatus: 429 } });
	});

	it("sends nothing once the pacer refuses", async () => {
		const fetcher = createScriptedFetcher({});
		const source = createFinnhubEarningsSource({ apiKey: "finnhub-key", fetcher });
		const result = await source.fetchCalendar({
			fromDate: "2026-11-01",
			toDate: "2026-11-10",
			signal: NEVER,
			beforeRequest: () => Promise.resolve(false),
		});
		expect(result).toEqual({ ok: false, error: { code: "SOURCE_FAILED", upstreamStatus: null } });
		expect(fetcher.calls).toEqual([]);
	});
});

describe("JPX market calendar", () => {
	const jpxRow = (code: string, date: string | null, kind = "second-quarter"): JpxWorkbookRow => ({
		code,
		name: "Company",
		announcementDate: date,
		fiscalPeriodEnd: "2027-03-31",
		fiscalPeriodLabel: "Q2 2027",
		periodKey: `fy2027-03-31-${kind}`,
	});

	it("keeps every listed company's undecided and in-window rows, once per period", () => {
		expect(
			jpxCalendarEvents(
				[
					jpxRow("1380", "2026-11-13"),
					jpxRow("130A", null),
					jpxRow("7203", "2026-10-30"),
					jpxRow("1380", "2026-11-14"),
					jpxRow("bad!", "2026-11-13"),
					jpxRow("9984", "2027-06-01", "full-year"),
				],
				"2026-11-03",
				"2027-05-07",
			),
		).toEqual([
			{
				symbol: "1380",
				periodKey: "fy2027-03-31-second-quarter",
				announcementDate: "2026-11-13",
				fiscalPeriodLabel: "Q2 2027",
				fiscalPeriodEnd: "2027-03-31",
				timing: "unknown",
			},
			{
				symbol: "130A",
				periodKey: "fy2027-03-31-second-quarter",
				announcementDate: null,
				fiscalPeriodLabel: "Q2 2027",
				fiscalPeriodEnd: "2027-03-31",
				timing: "unknown",
			},
		]);
	});
});
