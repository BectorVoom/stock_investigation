/**
 * Finnhub earnings adapter tests on DOCUMENTATION-SHAPED fixtures: synthetic
 * bodies written from Finnhub's docs, not captured responses. The real API
 * was exercised separately on 2026-10-13 (`earningsLive.test.ts`, opt-in) and
 * answered in the same shape; the 403 and 429 cases here remain
 * documentation-derived. The scripted fetcher pins hosts like the real one.
 */
import { describe, expect, it } from "vitest";
import {
	createFinnhubEarningsSource,
	FINNHUB_PUBLISHER,
	FINNHUB_SOURCE_URL,
} from "../../src/finance/finnhubEarnings.ts";
import { createScriptedFetcher } from "../tools/support.ts";

const API_KEY = "finnhub-synthetic-key-001";
const NEVER = new AbortController().signal;
const FROM = "2026-10-13";
const TO = "2027-04-16";

function calendarUrl(symbol: string): string {
	return `https://finnhub.io/api/v1/calendar/earnings?from=${FROM}&to=${TO}&symbol=${symbol}`;
}

function profileUrl(symbol: string): string {
	return `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}`;
}

/** Documentation-shaped calendar payload (Finnhub docs, read 2026-10-13). */
function calendarPayload(rows: readonly unknown[]): string {
	return JSON.stringify({ earningsCalendar: rows });
}

function row(overrides: {
	readonly date?: string;
	readonly hour?: string | null;
	readonly quarter?: number | null;
	readonly year?: number | null;
	readonly symbol?: string | null;
}): unknown {
	return {
		date: "2026-10-29",
		epsActual: null,
		epsEstimate: 1.9,
		hour: "amc",
		quarter: 4,
		revenueActual: null,
		revenueEstimate: 100000000000,
		symbol: "AAPL",
		year: 2026,
		...overrides,
	};
}

function sourceWith(pages: Parameters<typeof createScriptedFetcher>[0]) {
	const fetcher = createScriptedFetcher(pages);
	return { source: createFinnhubEarningsSource({ apiKey: API_KEY, fetcher }), fetcher };
}

describe("Finnhub adapter (documentation-derived fixtures): success", () => {
	it("maps the documented AAPL row and fetches the name when asked", async () => {
		const { source, fetcher } = sourceWith({
			[calendarUrl("AAPL")]: { text: calendarPayload([row({})]) },
			[profileUrl("AAPL")]: { text: JSON.stringify({ name: "Apple Inc", ticker: "AAPL" }) },
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: true }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) {
			throw new Error(`expected success, got ${JSON.stringify(result)}`);
		}
		expect(result.value.name).toBe("Apple Inc");
		expect(result.value.events).toEqual([
			{
				periodKey: "2026-q4",
				announcementDate: "2026-10-29",
				fiscalPeriodLabel: "Q4 2026",
				fiscalPeriodEnd: null,
				timing: "after-close",
			},
		]);
		expect(source.sourceId).toBe("finnhub");
		expect(FINNHUB_PUBLISHER).toBe("Finnhub");
		expect(FINNHUB_SOURCE_URL).toBe("https://finnhub.io/");
		const [profileCall, calendarCall] = fetcher.calls;
		for (const call of [calendarCall, profileCall]) {
			expect([...(call?.options.allowedHosts ?? [])]).toEqual(["finnhub.io"]);
			expect(call?.options.accept).toBe("application/json");
			expect(call?.options.finnhubToken).toBe(API_KEY);
			expect(call?.options.authorization).toBeUndefined();
			// The key travels in the header only, never in the URL or the result.
			expect(call?.url).not.toContain(API_KEY);
		}
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	it("sends null for an over-long company name instead of failing the refresh", async () => {
		const longName = "A".repeat(201);
		const { source } = sourceWith({
			[calendarUrl("AAPL")]: { text: calendarPayload([row({})]) },
			[profileUrl("AAPL")]: { text: JSON.stringify({ name: longName, ticker: "AAPL" }) },
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: true }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) {
			throw new Error(`expected success, got ${JSON.stringify(result)}`);
		}
		expect(result.value.name).toBeNull();
		expect(result.value.events).toHaveLength(1);
	});

	it("skips the profile request when the name is not needed", async () => {
		const { source, fetcher } = sourceWith({
			[calendarUrl("AAPL")]: { text: calendarPayload([row({})]) },
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) {
			throw new Error(`expected success, got ${JSON.stringify(result)}`);
		}
		expect(result.value.name).toBeNull();
		expect(fetcher.calls).toHaveLength(1);
	});

	it("maps every documented hour value and keeps rows in the window, oldest first", async () => {
		const { source } = sourceWith({
			[calendarUrl("MSFT")]: {
				text: calendarPayload([
					row({ date: "2027-04-16", hour: "bmo", quarter: 1, year: 2027, symbol: "MSFT" }),
					row({ date: "2026-10-29", hour: "dmh", quarter: 4, year: 2026, symbol: "MSFT" }),
					row({ date: "2026-10-20", hour: "nope", quarter: 3, year: 2026, symbol: "MSFT" }),
					row({ date: "2027-05-01", hour: "amc", quarter: 2, year: 2027, symbol: "MSFT" }),
					row({ date: "2026-10-01", hour: "amc", quarter: 3, year: 2026, symbol: "MSFT" }),
				]),
			},
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "MSFT", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) {
			throw new Error(`expected success, got ${JSON.stringify(result)}`);
		}
		expect(result.value.events).toEqual([
			{
				periodKey: "2026-q3",
				announcementDate: "2026-10-20",
				fiscalPeriodLabel: "Q3 2026",
				fiscalPeriodEnd: null,
				timing: "unknown",
			},
			{
				periodKey: "2026-q4",
				announcementDate: "2026-10-29",
				fiscalPeriodLabel: "Q4 2026",
				fiscalPeriodEnd: null,
				timing: "during-session",
			},
			{
				periodKey: "2027-q1",
				announcementDate: "2027-04-16",
				fiscalPeriodLabel: "Q1 2027",
				fiscalPeriodEnd: null,
				timing: "before-open",
			},
		]);
	});

	it("caps events per stock and answers one result per requested symbol, in order", async () => {
		const rows = Array.from({ length: 10 }, (_, index) =>
			row({ date: `2026-11-${String(index + 1).padStart(2, "0")}` }),
		);
		const { source } = sourceWith({
			[calendarUrl("AAPL")]: { text: calendarPayload(rows) },
			[calendarUrl("MSFT")]: { text: calendarPayload([]) },
		});
		const results = await source.fetchEarnings({
			stocks: [
				{ symbol: "AAPL", needName: false },
				{ symbol: "MSFT", needName: false },
			],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(results).toHaveLength(2);
		const [aapl, msft] = results;
		if (aapl === undefined || !aapl.ok) throw new Error("expected AAPL success");
		expect(aapl.value.events).toHaveLength(8);
		expect(msft).toEqual({ ok: false, error: { code: "NO_SCHEDULED_DATE", name: null } });
	});
});

describe("Finnhub adapter (documentation-derived fixtures): failures", () => {
	it("reports an empty calendar as NO_SCHEDULED_DATE", async () => {
		const { source } = sourceWith({
			[calendarUrl("AAPL")]: { text: calendarPayload([]) },
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(result).toEqual({ ok: false, error: { code: "NO_SCHEDULED_DATE", name: null } });
	});

	it("carries the company name on NO_SCHEDULED_DATE so it is stored once", async () => {
		const { source } = sourceWith({
			[calendarUrl("AAPL")]: { text: calendarPayload([]) },
			[profileUrl("AAPL")]: { text: JSON.stringify({ name: "Apple Inc", ticker: "AAPL" }) },
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: true }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		// A successful retrieval with nothing listed: the code is recorded
		// and the name still flows through (the profile is not asked again).
		expect(result).toEqual({
			ok: false,
			error: { code: "NO_SCHEDULED_DATE", name: "Apple Inc" },
		});
	});

	it("reports a missing ticker as SYMBOL_NOT_FOUND", async () => {
		const { source } = sourceWith({
			[calendarUrl("NOPE")]: { text: calendarPayload([]) },
			[profileUrl("NOPE")]: { text: JSON.stringify({}) },
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "NOPE", needName: true }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(result).toEqual({ ok: false, error: { code: "SYMBOL_NOT_FOUND" } });
	});

	it("resolves the profile before the calendar when the name is needed", async () => {
		const { source, fetcher } = sourceWith({
			[calendarUrl("NOPE")]: { text: calendarPayload([]) },
			[profileUrl("NOPE")]: { text: JSON.stringify({}) },
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "NOPE", needName: true }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		// The empty calendar must not mask the unknown symbol: the profile
		// (no ticker) decides first.
		expect(result).toEqual({ ok: false, error: { code: "SYMBOL_NOT_FOUND" } });
		expect(fetcher.urls()).toEqual([profileUrl("NOPE")]);
	});

	it("skips rows with null hour, quarter, year or symbol instead of failing", async () => {
		const { source } = sourceWith({
			[calendarUrl("AAPL")]: {
				text: calendarPayload([
					row({ hour: null, quarter: null, year: null, symbol: null }),
					row({}),
				]),
			},
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) {
			throw new Error(`expected success, got ${JSON.stringify(result)}`);
		}
		expect(result.value.events).toEqual([
			{
				periodKey: "2026-q4",
				announcementDate: "2026-10-29",
				fiscalPeriodLabel: "Q4 2026",
				fiscalPeriodEnd: null,
				timing: "after-close",
			},
		]);
	});

	it("ignores rows for a different symbol than the one requested", async () => {
		const { source } = sourceWith({
			[calendarUrl("AAPL")]: {
				text: calendarPayload([
					row({ date: "2026-11-05", quarter: 4, year: 2026, symbol: "MSFT" }),
					row({}),
				]),
			},
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) {
			throw new Error(`expected success, got ${JSON.stringify(result)}`);
		}
		expect(result.value.events).toEqual([
			{
				periodKey: "2026-q4",
				announcementDate: "2026-10-29",
				fiscalPeriodLabel: "Q4 2026",
				fiscalPeriodEnd: null,
				timing: "after-close",
			},
		]);
	});

	it("maps HTTP statuses to the fixed codes and never leaks response text", async () => {
		const cases = [
			["HTTP 401", "SOURCE_AUTH_FAILED"],
			["HTTP 403", "PLAN_NOT_ENTITLED"],
			["HTTP 429", "RATE_LIMITED"],
			["HTTP 500", "SOURCE_FAILED"],
		] as const;
		for (const [detail, code] of cases) {
			const { source } = sourceWith({
				[calendarUrl("AAPL")]: { error: { code: "HTTP_ERROR", detail } },
			});
			const [result] = await source.fetchEarnings({
				stocks: [{ symbol: "AAPL", needName: false }],
				fromDate: FROM,
				toDate: TO,
				signal: NEVER,
				beforeRequest: () => Promise.resolve(true),
			});
			expect(result).toEqual({ ok: false, error: { code } });
		}
	});

	it("maps transport failures and unparsable payloads to SOURCE_FAILED", async () => {
		const transport = sourceWith({
			[calendarUrl("AAPL")]: { error: { code: "TIMEOUT", detail: "timed out" } },
		});
		const [timedOut] = await transport.source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(timedOut).toEqual({ ok: false, error: { code: "SOURCE_FAILED" } });

		const malformed = sourceWith({
			[calendarUrl("AAPL")]: { text: JSON.stringify({ earningsCalendar: [{ nope: 1 }] }) },
		});
		const [badShape] = await malformed.source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(badShape).toEqual({ ok: false, error: { code: "SOURCE_FAILED" } });
	});
});
