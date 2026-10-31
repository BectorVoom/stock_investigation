/**
 * The examples in docs/external-apis/apis/fred.md, fed through the FRED
 * adapter the TypeScript runner uses (conventions §4): each documented body is
 * served by the scripted fetcher at the exact URL the adapter builds.
 */
import type { MarketRequestAdmission } from "@research/application";
import { describe, expect, it } from "vitest";
import { createFredSeriesSource } from "../../src/finance/fredSeries.ts";
import { docExampleText } from "../docExamples.ts";
import { createScriptedFetcher, fixedClock, type ScriptedPage } from "../tools/support.ts";
import { expectErr, expectOk } from "./support.ts";

const API_KEY = "fred-doc-example-key";
const NEVER = new AbortController().signal;
/** Admits every request, as an unpaced runner would. */
const GRANT = (): Promise<MarketRequestAdmission> => Promise.resolve("granted");
const BASE = "https://api.stlouisfed.org/fred";
const META_URL = `${BASE}/series?series_id=VIXCLS&file_type=json&api_key=${API_KEY}`;
const FULL_URL = `${BASE}/series/observations?series_id=VIXCLS&file_type=json&sort_order=desc&limit=800&api_key=${API_KEY}`;
const WINDOW_URL = `${BASE}/series/observations?series_id=VIXCLS&file_type=json&sort_order=desc&limit=800&observation_start=2026-09-15&api_key=${API_KEY}`;

function fetchVix(pages: { readonly [url: string]: ScriptedPage }, from: string | null) {
	const fetcher = createScriptedFetcher(pages);
	const source = createFredSeriesSource({ apiKey: API_KEY, fetcher, clock: fixedClock() });
	return source.fetchSeries({
		symbol: "VIXCLS",
		from,
		maxObservations: 800,
		signal: NEVER,
		beforeRequest: GRANT,
	});
}

function httpError(status: number, body: string): ScriptedPage {
	return { error: { code: "HTTP_ERROR", detail: `HTTP ${status}`, status, body } };
}

describe("FRED document examples", () => {
	const meta = docExampleText("fred", "fred-series-vixcls");

	it("parses the series metadata and the full observations, skipping '.'", async () => {
		const result = expectOk(
			await fetchVix(
				{
					[META_URL]: { text: meta },
					[FULL_URL]: { text: docExampleText("fred", "fred-observations-full") },
				},
				null,
			),
		);
		expect(result.meta).toEqual({
			title: "CBOE Volatility Index: VIX",
			unit: "Index",
			frequency: "daily",
			publisher: "Federal Reserve Bank of St. Louis (FRED)",
			sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
		});
		expect(result.observations).toEqual([
			{ observedOn: "2023-10-06", value: 17.45 },
			{ observedOn: "2026-10-28", value: 16.91 },
			{ observedOn: "2026-10-29", value: 17.2 },
		]);
	});

	it("parses the window observations from the anchor date, inclusive", async () => {
		const result = expectOk(
			await fetchVix(
				{
					[META_URL]: { text: meta },
					[WINDOW_URL]: { text: docExampleText("fred", "fred-observations-window") },
				},
				"2026-09-15",
			),
		);
		expect(result.observations[0]).toEqual({ observedOn: "2026-09-15", value: 17.2 });
		expect(result.observations).toHaveLength(3);
	});

	it("maps the documented 400 bodies to their codes, keeping FRED's status", async () => {
		const notFound = expectErr(
			await fetchVix(
				{ [META_URL]: httpError(400, docExampleText("fred", "fred-error-not-found")) },
				null,
			),
		);
		expect(notFound).toMatchObject({ code: "SERIES_NOT_FOUND", upstreamStatus: 400 });
		const badKey = expectErr(
			await fetchVix(
				{ [META_URL]: httpError(400, docExampleText("fred", "fred-error-bad-key")) },
				null,
			),
		);
		expect(badKey).toMatchObject({ code: "SOURCE_AUTH_FAILED", upstreamStatus: 400 });
	});
});
