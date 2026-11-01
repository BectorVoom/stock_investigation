/**
 * Twelve Data adapter tests against the real provider responses captured on
 * 2026-10-12 (`fixtures/twelvedata-*.json`, no key inside) plus synthetic
 * variants. The scripted fetcher pins hosts like the real one.
 */

import { readFileSync } from "node:fs";
import type { MarketRequestAdmission } from "@research/application";
import { marketUnavailableReason } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	createTwelveDataSeriesSource,
	splitTwelveSymbol,
} from "../../src/finance/twelveDataSeries.ts";
import { createScriptedFetcher } from "../tools/support.ts";

const API_KEY = "twelve-synthetic-key-002";
const NEVER = new AbortController().signal;
/** Admits every request, as an unpaced runner would. */
const GRANT = (): Promise<MarketRequestAdmission> => Promise.resolve("granted");

function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function seriesUrl(params: string): string {
	return `https://api.twelvedata.com/time_series?${params}`;
}

function sourceWith(pages: Parameters<typeof createScriptedFetcher>[0]) {
	const fetcher = createScriptedFetcher(pages);
	return { source: createTwelveDataSeriesSource({ apiKey: API_KEY, fetcher }), fetcher };
}

const AAPL_URL = seriesUrl("symbol=AAPL&interval=1day&outputsize=800");

async function observationsOf(values: readonly { readonly [key: string]: unknown }[]) {
	const { source } = sourceWith({
		[AAPL_URL]: {
			text: JSON.stringify({
				meta: { symbol: "AAPL", currency: "USD", exchange: "NASDAQ" },
				values,
				status: "ok",
			}),
		},
	});
	const result = await source.fetchSeries({
		symbol: "AAPL",
		from: null,
		maxObservations: 800,
		signal: NEVER,
		beforeRequest: GRANT,
	});
	if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
	return result.value.observations;
}

describe("Twelve Data adapter: daily bars (ADR-0056 §2)", () => {
	it("keeps a stock's open, high, low and volume beside the close (MSFT)", async () => {
		const { source } = sourceWith({
			[seriesUrl("symbol=MSFT&interval=1day&outputsize=800")]: {
				text: fixture("twelvedata-key-symbol_MSFT.json"),
			},
		});
		const result = await source.fetchSeries({
			symbol: "MSFT",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		// Hand-checked against the fixture's 2026-10-09 row.
		expect(result.value.observations.at(-1)).toEqual({
			observedOn: "2026-10-09",
			value: 535.070007,
			bar: [528.23999, 537.21997, 526.23999, 18483600],
		});
	});

	it("gives a currency pair's bar a null volume (USD/JPY reports none)", async () => {
		const { source } = sourceWith({
			[seriesUrl("symbol=USD%2FJPY&interval=1day&outputsize=800")]: {
				text: fixture("twelvedata-key-symbol_USD_JPY.json"),
			},
		});
		const result = await source.fetchSeries({
			symbol: "USD/JPY",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.observations.at(-1)).toEqual({
			observedOn: "2026-10-12",
			value: 158.59164,
			bar: [158.29851, 158.64628, 158.07367, null],
		});
		expect(result.value.observations.every((point) => point.bar?.[3] === null)).toBe(true);
	});

	it("keeps the close and drops the bar when open, high or low is unreadable", async () => {
		const observations = await observationsOf([
			{ datetime: "2026-10-01", close: "5", high: "6", low: "4", volume: "10" },
			{ datetime: "2026-10-02", close: "5", open: "", high: "6", low: "4" },
			{ datetime: "2026-10-03", close: "5", open: "5", high: "  ", low: "4" },
			{ datetime: "2026-10-04", close: "5", open: "5", high: "6", low: "abc" },
			{ datetime: "2026-10-05", close: "5", open: "5", high: 6, low: "4" },
			{ datetime: "2026-10-06", close: "5", open: "5", high: "Infinity", low: "4" },
			{ datetime: "2026-10-07", close: "5", open: "5", high: "1e400", low: "4" },
			{ datetime: "2026-10-08", close: "5", open: "5", high: null, low: "4" },
		]);
		expect(observations).toHaveLength(8);
		expect(observations.every((point) => point.bar === undefined)).toBe(true);
	});

	it("drops a bar that is not consistent with its close", async () => {
		const observations = await observationsOf([
			// close above the high
			{ datetime: "2026-10-01", close: "7", open: "5", high: "6", low: "4", volume: "1" },
			// open below the low
			{ datetime: "2026-10-02", close: "5", open: "3", high: "6", low: "4", volume: "1" },
			// high below the low
			{ datetime: "2026-10-03", close: "5", open: "5", high: "4", low: "6", volume: "1" },
			// bounds included: open = low, close = high
			{ datetime: "2026-10-04", close: "6", open: "4", high: "6", low: "4", volume: "1" },
		]);
		expect(observations).toEqual([
			{ observedOn: "2026-10-01", value: 7 },
			{ observedOn: "2026-10-02", value: 5 },
			{ observedOn: "2026-10-03", value: 5 },
			{ observedOn: "2026-10-04", value: 6, bar: [4, 6, 4, 1] },
		]);
	});

	it("reads a missing, unreadable or negative volume as null", async () => {
		const row = { close: "5", open: "5", high: "6", low: "4" };
		const observations = await observationsOf([
			{ ...row, datetime: "2026-10-01" },
			{ ...row, datetime: "2026-10-02", volume: "" },
			{ ...row, datetime: "2026-10-03", volume: "-5" },
			{ ...row, datetime: "2026-10-04", volume: "lots" },
			{ ...row, datetime: "2026-10-05", volume: 100 },
			{ ...row, datetime: "2026-10-06", volume: "1e400" },
			{ ...row, datetime: "2026-10-07", volume: "0" },
			{ ...row, datetime: "2026-10-08", volume: " 2.5e2 " },
		]);
		expect(observations.map((point) => point.bar?.[3])).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
			0,
			250,
		]);
	});

	it("skips a row without a readable close, and a duplicate date keeps the first row's bar", async () => {
		const observations = await observationsOf([
			{ datetime: "2026-10-01", close: " ", open: "5", high: "6", low: "4", volume: "1" },
			{ datetime: "2026-10-02", close: "5", open: "5", high: "6", low: "4", volume: "1" },
			{ datetime: "2026-10-02", close: "5.5", open: "5", high: "6", low: "4", volume: "2" },
		]);
		expect(observations).toEqual([{ observedOn: "2026-10-02", value: 5, bar: [5, 6, 4, 1] }]);
	});
});

describe("Twelve Data adapter: success", () => {
	it("parses the captured AAPL bars, oldest first, in USD on NASDAQ", async () => {
		const { source, fetcher } = sourceWith({
			[AAPL_URL]: { text: fixture("twelvedata-timeseries-AAPL.json") },
		});
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta).toEqual({
			title: "AAPL (NASDAQ)",
			unit: "USD",
			frequency: "daily",
			publisher: "Twelve Data",
			sourceUrl: "https://twelvedata.com/",
		});
		// Hand-checked against the fixture (descending there, ascending here):
		// each close keeps the day's [open, high, low, volume] (ADR-0056).
		expect(result.value.observations).toEqual([
			{
				observedOn: "2026-10-05",
				value: 332.89001,
				bar: [332.82001, 336.20999, 331.64999, 34400900],
			},
			{ observedOn: "2026-10-06", value: 333.63, bar: [332.28, 334.38, 330.62, 30449000] },
			{
				observedOn: "2026-10-07",
				value: 336.67001,
				bar: [336.95999, 338.67001, 332.78, 34147900],
			},
			{
				observedOn: "2026-10-08",
				value: 340.42001,
				bar: [336.82001, 341.57001, 335.89999, 35332400],
			},
			{
				observedOn: "2026-10-09",
				value: 336.64001,
				bar: [331.70001, 338.60999, 330.70001, 37855000],
			},
		]);
		const [call] = fetcher.calls;
		expect([...(call?.options.allowedHosts ?? [])]).toEqual(["api.twelvedata.com"]);
		expect(call?.options.accept).toBe("application/json");
		expect(call?.options.authorization).toBe(`apikey ${API_KEY}`);
		// The key travels in the header only, never in the URL or the result.
		expect(call?.url).not.toContain(API_KEY);
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	it("labels MSFT as a NASDAQ stock in USD", async () => {
		const { source } = sourceWith({
			[seriesUrl("symbol=MSFT&interval=1day&outputsize=800")]: {
				text: fixture("twelvedata-key-symbol_MSFT.json"),
			},
		});
		const result = await source.fetchSeries({
			symbol: "MSFT",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta.title).toBe("MSFT (NASDAQ)");
		expect(result.value.meta.unit).toBe("USD");
		expect(result.value.observations).toHaveLength(3);
	});

	it("reads gold as USD per troy ounce of XAU", async () => {
		const { source } = sourceWith({
			[seriesUrl("symbol=XAU%2FUSD&interval=1day&outputsize=800")]: {
				text: fixture("twelvedata-key-symbol_XAU_USD.json"),
			},
		});
		const result = await source.fetchSeries({
			symbol: "XAU/USD",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta.title).toBe("XAU/USD");
		expect(result.value.meta.unit).toBe("USD per XAU (troy ounce of gold)");
		expect(result.value.observations).toHaveLength(3);
	});

	it("derives pair units from the ISO codes, not the meta names", async () => {
		const euro = sourceWith({
			[seriesUrl("symbol=EUR%2FUSD&interval=1day&outputsize=800")]: {
				text: fixture("twelvedata-timeseries-EURUSD.json"),
			},
		});
		const eur = await euro.source.fetchSeries({
			symbol: "EUR/USD",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!eur.ok) throw new Error(`expected success, got ${eur.error.code}`);
		expect(eur.value.meta.unit).toBe("USD per EUR");

		const yen = sourceWith({
			[seriesUrl("symbol=USD%2FJPY&interval=1day&outputsize=800")]: {
				text: fixture("twelvedata-key-symbol_USD_JPY.json"),
			},
		});
		const jpy = await yen.source.fetchSeries({
			symbol: "USD/JPY",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!jpy.ok) throw new Error(`expected success, got ${jpy.error.code}`);
		expect(jpy.value.meta.unit).toBe("JPY per USD");
	});

	it("sends the :EXCHANGE suffix as the exchange parameter", async () => {
		const bars = JSON.stringify({
			meta: {
				symbol: "7203",
				interval: "1day",
				currency: "JPY",
				exchange: "JPX",
				type: "Common Stock",
			},
			values: [{ datetime: "2026-10-09", open: "1", high: "1", low: "1", close: "2", volume: "3" }],
			status: "ok",
		});
		const { source, fetcher } = sourceWith({
			[seriesUrl("symbol=7203&exchange=JPX&interval=1day&outputsize=800")]: { text: bars },
		});
		const result = await source.fetchSeries({
			symbol: "7203:JPX",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta.title).toBe("7203 (JPX)");
		expect(result.value.meta.unit).toBe("JPY");
		expect(fetcher.calls[0]?.url).toContain("exchange=JPX");
	});

	it("trims the currency it reports as the unit (F4)", async () => {
		const bars = JSON.stringify({
			meta: { symbol: "AAPL", currency: " USD ", exchange: "NASDAQ" },
			values: [{ datetime: "2026-10-09", open: "1", high: "1", low: "1", close: "2", volume: "3" }],
			status: "ok",
		});
		const { source } = sourceWith({
			[seriesUrl("symbol=AAPL&interval=1day&outputsize=800")]: { text: bars },
		});
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta.unit).toBe("USD");
	});

	it("requests start_date exactly at from (inclusive) and caps outputsize", async () => {
		const capped = sourceWith({
			[seriesUrl("symbol=AAPL&interval=1day&outputsize=2&start_date=2026-10-01")]: {
				text: fixture("twelvedata-timeseries-AAPL.json"),
			},
		});
		const result = await capped.source.fetchSeries({
			symbol: "AAPL",
			from: "2026-10-01",
			maxObservations: 2,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		// Newest two bars, ascending, each with its own bar.
		expect(result.value.observations).toEqual([
			{
				observedOn: "2026-10-08",
				value: 340.42001,
				bar: [336.82001, 341.57001, 335.89999, 35332400],
			},
			{
				observedOn: "2026-10-09",
				value: 336.64001,
				bar: [331.70001, 338.60999, 330.70001, 37855000],
			},
		]);
	});

	it("skips unreadable bars but fails closed when none parse", async () => {
		const partial = sourceWith({
			[seriesUrl("symbol=AAPL&interval=1day&outputsize=800")]: {
				text: JSON.stringify({
					meta: { symbol: "AAPL", interval: "1day", currency: "USD", exchange: "NASDAQ" },
					values: [
						{ datetime: "2026-10-09", close: "336.64" },
						{ datetime: "junk", close: "1" },
						{ datetime: "2026-10-08", close: "not-a-number" },
					],
					status: "ok",
				}),
			},
		});
		const mixed = await partial.source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!mixed.ok) throw new Error(`expected success, got ${mixed.error.code}`);
		expect(mixed.value.observations).toEqual([{ observedOn: "2026-10-09", value: 336.64 }]);

		const empty = sourceWith({
			[seriesUrl("symbol=AAPL&interval=1day&outputsize=800")]: {
				text: JSON.stringify({
					meta: { symbol: "AAPL", interval: "1day", currency: "USD", exchange: "NASDAQ" },
					values: [{ datetime: "junk", close: "1" }],
					status: "ok",
				}),
			},
		});
		const none = await empty.source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (none.ok) throw new Error("expected a failure");
		expect(none.error.code).toBe("NO_DATA");
	});
	it("answers ascending and one point per date, whatever order Twelve Data sends (ADR-0044 anchor search)", async () => {
		// The runner binary-searches the answer for its anchor, so the adapter
		// guarantees strictly ascending, date-unique points (a bar's time part
		// does not make a second point for the same day).
		const { source } = sourceWith({
			[AAPL_URL]: {
				text: JSON.stringify({
					meta: { symbol: "AAPL", interval: "1day", currency: "USD", exchange: "NASDAQ" },
					values: [
						{ datetime: "2026-10-02", close: "2" },
						{ datetime: "2026-10-03", close: "3" },
						{ datetime: "2026-10-01 16:00:00", close: "1" },
						{ datetime: "2026-10-01", close: "11" },
						{ datetime: "2026-10-03 09:30:00", close: "33" },
					],
					status: "ok",
				}),
			},
		});
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.observations).toEqual([
			{ observedOn: "2026-10-01", value: 1 },
			{ observedOn: "2026-10-02", value: 2 },
			{ observedOn: "2026-10-03", value: 3 },
		]);
	});
});

describe("Twelve Data adapter: failures", () => {
	it("maps a bad key to SOURCE_AUTH_FAILED with the fixed wording", async () => {
		const { source } = sourceWith({
			[AAPL_URL]: { text: fixture("twelvedata-error-badkey.json") },
		});
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("SOURCE_AUTH_FAILED");
		expect(result.error.reason).toBe(marketUnavailableReason("SOURCE_AUTH_FAILED", "twelve-data"));
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	it("maps the demo restriction to SOURCE_AUTH_FAILED", async () => {
		const { source } = sourceWith({
			[AAPL_URL]: { text: fixture("twelvedata-error-demo-restricted.json") },
		});
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("SOURCE_AUTH_FAILED");
	});

	it("maps the JPX free-plan refusal to SERIES_NOT_FOUND, on 200 or 404", async () => {
		const jpxUrl = seriesUrl("symbol=7203&exchange=JPX&interval=1day&outputsize=800");
		const on200 = sourceWith({
			[jpxUrl]: { text: fixture("twelvedata-key-symbol_7203_exchange_JPX.json") },
		});
		const first = await on200.source.fetchSeries({
			symbol: "7203:JPX",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (first.ok) throw new Error("expected a failure");
		expect(first.error.code).toBe("SERIES_NOT_FOUND");
		expect(first.error.reason).toBe(marketUnavailableReason("SERIES_NOT_FOUND", "twelve-data"));

		const on404 = sourceWith({
			[jpxUrl]: {
				error: {
					code: "HTTP_ERROR",
					detail: "HTTP 404",
					status: 404,
					body: fixture("twelvedata-key-symbol_7203_exchange_JPX.json"),
				},
			},
		});
		const second = await on404.source.fetchSeries({
			symbol: "7203:JPX",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (second.ok) throw new Error("expected a failure");
		expect(second.error.code).toBe("SERIES_NOT_FOUND");
	});

	it("maps the synthetic 429 to RATE_LIMITED, on 200 or as a status", async () => {
		const on200 = sourceWith({
			[AAPL_URL]: { text: fixture("twelvedata-synthetic-error-429.json") },
		});
		const first = await on200.source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (first.ok) throw new Error("expected a failure");
		expect(first.error.code).toBe("RATE_LIMITED");

		const onStatus = sourceWith({
			[AAPL_URL]: { error: { code: "HTTP_ERROR", detail: "HTTP 429", status: 429 } },
		});
		const second = await onStatus.source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (second.ok) throw new Error("expected a failure");
		expect(second.error.code).toBe("RATE_LIMITED");
	});

	it.each([
		["a 403 plan refusal", '{"code":403,"message":"x","status":"error"}', "PLAN_NOT_ENTITLED"],
		["a 404 unknown symbol", '{"code":404,"message":"x","status":"error"}', "SERIES_NOT_FOUND"],
		// An invalid parameter is not a missing symbol (and not the plan's fault).
		["a 400 invalid parameter", '{"code":400,"message":"x","status":"error"}', "SOURCE_FAILED"],
		["an unknown error code", '{"code":418,"message":"x","status":"error"}', "SOURCE_FAILED"],
	] as const)("maps %s to %s", async (_label, text, code) => {
		const { source } = sourceWith({ [AAPL_URL]: { text } });
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe(code);
		expect(result.error.reason).toBe(marketUnavailableReason(code, "twelve-data"));
	});

	it.each([
		[
			"HTTP 403 without a body",
			{ code: "HTTP_ERROR", detail: "HTTP 403", status: 403 } as const,
			"PLAN_NOT_ENTITLED",
		],
		[
			"HTTP 401 without a body",
			{ code: "HTTP_ERROR", detail: "HTTP 401", status: 401 } as const,
			"SOURCE_AUTH_FAILED",
		],
		[
			"HTTP 500 without a body",
			{ code: "HTTP_ERROR", detail: "HTTP 500", status: 500 } as const,
			"SOURCE_FAILED",
		],
		[
			"an oversize body",
			{ code: "RESPONSE_TOO_LARGE", detail: "too large" } as const,
			"SOURCE_FAILED",
		],
		["a timeout", { code: "TIMEOUT", detail: "too slow" } as const, "SOURCE_FAILED"],
	])("maps %s to %s", async (_label, error, code) => {
		const { source } = sourceWith({ [AAPL_URL]: { error } });
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe(code);
	});

	it("sends nothing when the request is not admitted: a spent daily budget is RATE_LIMITED with no upstream status", async () => {
		const { source, fetcher } = sourceWith({
			[AAPL_URL]: { text: fixture("twelvedata-timeseries-AAPL.json") },
		});
		const spent = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: () => Promise.resolve("budget-spent"),
		});
		expect(spent).toMatchObject({
			ok: false,
			error: {
				code: "RATE_LIMITED",
				// Nothing was sent, so Twelve Data answered nothing (§4a).
				upstreamStatus: null,
				reason: marketUnavailableReason("RATE_LIMITED", "twelve-data"),
			},
		});
		const stopped = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: () => Promise.resolve("stopped"),
		});
		expect(stopped.ok).toBe(false);
		expect(fetcher.calls).toHaveLength(0);
	});

	it("reports a 400 invalid parameter as SOURCE_FAILED with Twelve Data's status kept", async () => {
		for (const page of [
			{ error: { code: "HTTP_ERROR", detail: "HTTP 400", status: 400 } } as const,
			{ text: '{"code":400,"message":"x","status":"error"}' },
		]) {
			const { source } = sourceWith({ [AAPL_URL]: page });
			const result = await source.fetchSeries({
				symbol: "AAPL",
				from: null,
				maxObservations: 800,
				signal: NEVER,
				beforeRequest: GRANT,
			});
			if (result.ok) throw new Error("expected a failure");
			expect(result.error).toMatchObject({ code: "SOURCE_FAILED", upstreamStatus: 400 });
		}
	});

	it("maps empty values to NO_DATA and malformed JSON to SOURCE_FAILED", async () => {
		const empty = sourceWith({
			[AAPL_URL]: { text: fixture("twelvedata-synthetic-empty-values.json") },
		});
		const noData = await empty.source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (noData.ok) throw new Error("expected a failure");
		expect(noData.error.code).toBe("NO_DATA");

		const malformed = sourceWith({
			[AAPL_URL]: { text: fixture("twelvedata-synthetic-malformed.json") },
		});
		const bad = await malformed.source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (bad.ok) throw new Error("expected a failure");
		expect(bad.error.code).toBe("SOURCE_FAILED");
	});

	it("fails closed when no honest unit can be determined", async () => {
		const { source } = sourceWith({
			[AAPL_URL]: {
				text: JSON.stringify({
					meta: { symbol: "WEIRD", interval: "1day", type: "Unknown Thing" },
					values: [{ datetime: "2026-10-09", close: "1" }],
					status: "ok",
				}),
			},
		});
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("SOURCE_FAILED");
	});

	it("S7: skips empty and whitespace closes instead of storing them as zero", async () => {
		const { source } = sourceWith({
			[AAPL_URL]: {
				text: JSON.stringify({
					meta: { symbol: "AAPL", currency: "USD", exchange: "NASDAQ" },
					values: [
						{ datetime: "2026-10-09", close: "336.64" },
						{ datetime: "2026-10-08", close: "" },
						{ datetime: "2026-10-07", close: "   " },
						{ datetime: "2026-10-06", close: "333.63" },
					],
					status: "ok",
				}),
			},
		});
		const result = await source.fetchSeries({
			symbol: "AAPL",
			from: null,
			maxObservations: 800,
			signal: NEVER,
			beforeRequest: GRANT,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.observations).toEqual([
			{ observedOn: "2026-10-06", value: 333.63 },
			{ observedOn: "2026-10-09", value: 336.64 },
		]);
	});
});

describe("splitTwelveSymbol", () => {
	it("splits the :EXCHANGE suffix and leaves pairs alone", () => {
		expect(splitTwelveSymbol("AAPL")).toEqual({ base: "AAPL", exchange: null });
		expect(splitTwelveSymbol("XAU/USD")).toEqual({ base: "XAU/USD", exchange: null });
		expect(splitTwelveSymbol("7203:JPX")).toEqual({ base: "7203", exchange: "JPX" });
		expect(splitTwelveSymbol("AAPL:NASDAQ")).toEqual({ base: "AAPL", exchange: "NASDAQ" });
	});
});
