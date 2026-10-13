/**
 * OPT-IN live contract check against the real FRED and Twelve Data endpoints.
 *
 * Skipped unless RUN_LIVE_MARKET=1 and both key variables are present in the
 * environment:
 *   RUN_LIVE_MARKET=1 FRED_API_KEY=... TWELVE_DATA_API_KEY=... \
 *     node_modules/.bin/vitest run --project node packages/adapters/test/finance/marketLive.test.ts
 * It makes a handful of requests through the production Node SafeFetcher
 * (real DNS validation and pinned TLS) and asserts shape and plausibility
 * only — never particular values, so it does not go stale.
 */
import { describe, expect, it } from "vitest";
import { createFredSeriesSource } from "../../src/finance/fredSeries.ts";
import { createTwelveDataSeriesSource } from "../../src/finance/twelveDataSeries.ts";
import { createNodeSafeFetcher } from "../../src/node/index.ts";

const fredApiKey = process.env.FRED_API_KEY ?? null;
const twelveDataApiKey = process.env.TWELVE_DATA_API_KEY ?? null;
const enabled =
	process.env.RUN_LIVE_MARKET === "1" && fredApiKey !== null && twelveDataApiKey !== null;

function expectPlausibleSeries(
	label: string,
	series: { readonly observedOn: string; readonly value: number }[],
): void {
	expect(series.length, `${label}: non-empty`).toBeGreaterThan(0);
	for (const point of series) {
		expect(point.observedOn, `${label}: ISO date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(Number.isFinite(point.value), `${label}: finite value`).toBe(true);
	}
	const dates = series.map((point) => point.observedOn);
	expect([...dates].sort(), `${label}: ascending dates`).toEqual(dates);
}

describe.skipIf(!enabled)("market data live contract (opt-in)", () => {
	const fetcher = createNodeSafeFetcher();
	const signal = new AbortController().signal;

	it("fetches fred:VIXCLS with plausible observations", async () => {
		if (fredApiKey === null) throw new Error("FRED_API_KEY is required for the live test");
		const source = createFredSeriesSource({ apiKey: fredApiKey, fetcher });
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 30,
			signal,
		});
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.reason}`);
		expect(result.value.meta.title.length).toBeGreaterThan(0);
		expect(result.value.meta.unit.length).toBeGreaterThan(0);
		expect(result.value.meta.sourceUrl).toContain("VIXCLS");
		expectPlausibleSeries("fred:VIXCLS", [...result.value.observations]);
	}, 120_000);

	it("fetches twelve-data:AAPL with plausible observations", async () => {
		if (twelveDataApiKey === null)
			throw new Error("TWELVE_DATA_API_KEY is required for the live test");
		const source = createTwelveDataSeriesSource({ apiKey: twelveDataApiKey, fetcher });
		const result = await source.fetchSeries({
			symbol: "AAPL",
			since: null,
			maxObservations: 30,
			signal,
		});
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.reason}`);
		expect(result.value.meta.title).toContain("AAPL");
		expect(result.value.meta.unit.length).toBeGreaterThan(0);
		expectPlausibleSeries("twelve-data:AAPL", [...result.value.observations]);
	}, 120_000);
});
