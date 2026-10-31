/**
 * The examples in docs/external-apis/apis/twelve-data.md, fed through the
 * Twelve Data adapter the TypeScript runner uses (conventions §4): each
 * documented body is served by the scripted fetcher at the exact URL the
 * adapter builds.
 */
import type { MarketRequestAdmission } from "@research/application";
import { describe, expect, it } from "vitest";
import { createTwelveDataSeriesSource } from "../../src/finance/twelveDataSeries.ts";
import { docExampleText } from "../docExamples.ts";
import { createScriptedFetcher, type ScriptedPage } from "../tools/support.ts";
import { expectErr, expectOk } from "./support.ts";

const API_KEY = "twelve-doc-example-key";
const NEVER = new AbortController().signal;
/** Admits every request, as an unpaced runner would. */
const GRANT = (): Promise<MarketRequestAdmission> => Promise.resolve("granted");
const BASE = "https://api.twelvedata.com/time_series";

function fetchSeries(url: string, page: ScriptedPage, symbol: string, from: string | null) {
	const fetcher = createScriptedFetcher({ [url]: page });
	const source = createTwelveDataSeriesSource({ apiKey: API_KEY, fetcher });
	return source.fetchSeries({
		symbol,
		from,
		maxObservations: 800,
		signal: NEVER,
		beforeRequest: GRANT,
	});
}

describe("Twelve Data document examples", () => {
	it("parses the full AAPL answer, oldest first, with the stock title and unit", async () => {
		const result = expectOk(
			await fetchSeries(
				`${BASE}?symbol=AAPL&interval=1day&outputsize=800`,
				{ text: docExampleText("twelve-data", "twelve-data-time-series-aapl-full") },
				"AAPL",
				null,
			),
		);
		expect(result.meta).toEqual({
			title: "AAPL (NASDAQ)",
			unit: "USD",
			frequency: "daily",
			publisher: "Twelve Data",
			sourceUrl: "https://twelvedata.com/",
		});
		expect(result.observations[0]).toEqual({ observedOn: "2023-08-24", value: 176.38 });
		expect(result.observations).toHaveLength(3);
	});

	it("parses the AAPL window from the anchor date, inclusive", async () => {
		const result = expectOk(
			await fetchSeries(
				`${BASE}?symbol=AAPL&interval=1day&outputsize=800&start_date=2026-10-26`,
				{ text: docExampleText("twelve-data", "twelve-data-time-series-aapl-window") },
				"AAPL",
				"2026-10-26",
			),
		);
		expect(result.observations[0]).toEqual({ observedOn: "2026-10-26", value: 343.91 });
		expect(result.observations).toHaveLength(5);
	});

	it("parses the XAU/USD window with the metal unit and its weekend bar", async () => {
		const result = expectOk(
			await fetchSeries(
				`${BASE}?symbol=XAU%2FUSD&interval=1day&outputsize=800&start_date=2026-10-27`,
				{ text: docExampleText("twelve-data", "twelve-data-time-series-xauusd-window") },
				"XAU/USD",
				"2026-10-27",
			),
		);
		expect(result.meta.title).toBe("XAU/USD");
		expect(result.meta.unit).toBe("USD per XAU (troy ounce of gold)");
		expect(result.observations.at(-1)).toEqual({ observedOn: "2026-10-31", value: 3875.39858 });
	});

	it("maps the documented error statuses and error bodies, keeping the status", async () => {
		const jpxUrl = `${BASE}?symbol=7203&exchange=JPX&interval=1day&outputsize=800`;
		const notFoundStatus = expectErr(
			await fetchSeries(
				jpxUrl,
				{ error: { code: "HTTP_ERROR", detail: "HTTP 404", status: 404 } },
				"7203:JPX",
				null,
			),
		);
		expect(notFoundStatus).toMatchObject({ code: "SERIES_NOT_FOUND", upstreamStatus: 404 });
		// The same error object on a 2xx answer is mapped by its JSON `code`.
		const notFoundBody = expectErr(
			await fetchSeries(
				jpxUrl,
				{ text: docExampleText("twelve-data", "twelve-data-error-not-found") },
				"7203:JPX",
				null,
			),
		);
		expect(notFoundBody).toMatchObject({ code: "SERIES_NOT_FOUND", upstreamStatus: 404 });
		const badKey = expectErr(
			await fetchSeries(
				`${BASE}?symbol=AAPL&interval=1day&outputsize=800`,
				{ text: docExampleText("twelve-data", "twelve-data-error-bad-key") },
				"AAPL",
				null,
			),
		);
		expect(badKey).toMatchObject({ code: "SOURCE_AUTH_FAILED", upstreamStatus: 401 });
	});
});
