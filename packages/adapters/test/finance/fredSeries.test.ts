/**
 * FRED adapter tests against the real provider responses captured on
 * 2026-10-12 (`fixtures/fred-*.json`, no key inside) plus synthetic variants.
 * The scripted fetcher pins hosts like the real one, so a wrong host fails.
 */
import { readFileSync } from "node:fs";
import { marketUnavailableReason } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createFredSeriesSource } from "../../src/finance/fredSeries.ts";
import { createScriptedFetcher } from "../tools/support.ts";

const API_KEY = "fred-synthetic-key-001";
const NEVER = new AbortController().signal;

function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const META_URL = `https://api.stlouisfed.org/fred/series?series_id=VIXCLS&file_type=json&api_key=${API_KEY}`;
const OBS_URL = `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&file_type=json&sort_order=desc&limit=800&api_key=${API_KEY}`;

function sourceWith(pages: Parameters<typeof createScriptedFetcher>[0]) {
	const fetcher = createScriptedFetcher(pages);
	return { source: createFredSeriesSource({ apiKey: API_KEY, fetcher }), fetcher };
}

const VIX_META = fixture("fred-series-VIXCLS.json");
const VIX_OBS = fixture("fred-observations-VIXCLS.json");

describe("FRED adapter: success", () => {
	it("parses the captured VIXCLS metadata and observations, oldest first", async () => {
		const { source, fetcher } = sourceWith({
			[META_URL]: { text: VIX_META },
			[OBS_URL]: { text: VIX_OBS },
		});
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta).toEqual({
			title: "CBOE Volatility Index: VIX",
			unit: "Index",
			frequency: "daily",
			publisher: "Federal Reserve Bank of St. Louis (FRED)",
			sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
		});
		// Hand-checked against the fixture (descending there, ascending here).
		expect(result.value.observations).toEqual([
			{ observedOn: "2026-10-02", value: 15.31 },
			{ observedOn: "2026-10-05", value: 15.52 },
			{ observedOn: "2026-10-06", value: 15.01 },
			{ observedOn: "2026-10-07", value: 15.08 },
			{ observedOn: "2026-10-08", value: 15.41 },
		]);
		for (const call of fetcher.calls) {
			expect(call.url.startsWith("https://api.stlouisfed.org/")).toBe(true);
			expect([...(call.options.allowedHosts ?? [])]).toEqual(["api.stlouisfed.org"]);
			expect(call.options.accept).toBe("application/json");
			expect(call.options.includeErrorBody).toBe(true);
		}
		// The key travels in the provider's own query parameter, and never
		// reaches the typed result.
		expect(fetcher.calls[0]?.url).toContain(`api_key=${API_KEY}`);
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	it("skips '.' values instead of turning them into 0 (synthetic fixture)", async () => {
		const { source } = sourceWith({
			[META_URL]: { text: VIX_META },
			[OBS_URL]: { text: fixture("fred-observations-synthetic-dot-values.json") },
		});
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.observations).toEqual([
			{ observedOn: "2026-10-02", value: 15.31 },
			{ observedOn: "2026-10-06", value: 15.01 },
			{ observedOn: "2026-10-08", value: 15.41 },
		]);
	});

	it("requests observation_start 45 days before since, and none without since", async () => {
		const withSince = sourceWith({
			[META_URL]: { text: VIX_META },
			[`https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&file_type=json&sort_order=desc&limit=5&observation_start=2026-08-17&api_key=${API_KEY}`]:
				{ text: VIX_OBS },
		});
		const result = await withSince.source.fetchSeries({
			symbol: "VIXCLS",
			since: "2026-10-01",
			maxObservations: 5,
			signal: NEVER,
		});
		expect(result.ok).toBe(true);
		expect(withSince.fetcher.calls).toHaveLength(2);
		const plain = sourceWith({ [META_URL]: { text: VIX_META }, [OBS_URL]: { text: VIX_OBS } });
		await plain.source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		expect(plain.fetcher.calls[1]?.url).not.toContain("observation_start");
	});

	it.each([
		["D", "daily"],
		["W", "weekly"],
		["BW", "weekly"],
		["M", "monthly"],
		["Q", "quarterly"],
		["SA", "unknown"],
		["A", "annual"],
	] as const)("maps frequency_short %s to %s", async (short, frequency) => {
		const meta = JSON.stringify({
			seriess: [
				{
					id: "X",
					title: "T",
					units: "U",
					frequency: "Monthly",
					frequency_short: short,
					seasonal_adjustment: "Not Seasonally Adjusted",
					seasonal_adjustment_short: "NSA",
				},
			],
		});
		const { source } = sourceWith({
			[`https://api.stlouisfed.org/fred/series?series_id=X&file_type=json&api_key=${API_KEY}`]: {
				text: meta,
			},
			[`https://api.stlouisfed.org/fred/series/observations?series_id=X&file_type=json&sort_order=desc&limit=800&api_key=${API_KEY}`]:
				{ text: '{"observations":[]}' },
		});
		const result = await source.fetchSeries({
			symbol: "X",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta.frequency).toBe(frequency);
		expect(result.value.observations).toEqual([]);
	});

	it.each(["SA", "SAAR"] as const)("marks %s series seasonally adjusted", async (adjustment) => {
		const meta = JSON.stringify({
			seriess: [
				{
					id: "X",
					title: "T",
					units: "Percent",
					frequency: "Monthly",
					frequency_short: "M",
					seasonal_adjustment: "Seasonally Adjusted",
					seasonal_adjustment_short: adjustment,
				},
			],
		});
		const { source } = sourceWith({
			[`https://api.stlouisfed.org/fred/series?series_id=X&file_type=json&api_key=${API_KEY}`]: {
				text: meta,
			},
			[`https://api.stlouisfed.org/fred/series/observations?series_id=X&file_type=json&sort_order=desc&limit=800&api_key=${API_KEY}`]:
				{ text: '{"observations":[]}' },
		});
		const result = await source.fetchSeries({
			symbol: "X",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.meta.unit).toBe("Percent, seasonally adjusted");
	});
});

describe("FRED adapter: failures", () => {
	it("maps a bad key to SOURCE_AUTH_FAILED with the fixed wording", async () => {
		const { source } = sourceWith({
			[META_URL]: {
				error: {
					code: "HTTP_ERROR",
					detail: "HTTP 400",
					status: 400,
					body: fixture("fred-series-badkey.json"),
				},
			},
		});
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("SOURCE_AUTH_FAILED");
		expect(result.error.reason).toBe(marketUnavailableReason("SOURCE_AUTH_FAILED", "fred"));
		// Provider message text (which names api_key) is never repeated.
		expect(result.error.reason).not.toContain("api_key");
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	it("maps an unknown series to SERIES_NOT_FOUND", async () => {
		const { source } = sourceWith({
			[META_URL]: {
				error: {
					code: "HTTP_ERROR",
					detail: "HTTP 400",
					status: 400,
					body: fixture("fred-series-notfound.json"),
				},
			},
		});
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("SERIES_NOT_FOUND");
		expect(result.error.reason).toBe(marketUnavailableReason("SERIES_NOT_FOUND", "fred"));
	});

	it("maps HTTP 429 to RATE_LIMITED without needing a body", async () => {
		const { source } = sourceWith({
			[META_URL]: { error: { code: "HTTP_ERROR", detail: "HTTP 429", status: 429 } },
		});
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("RATE_LIMITED");
	});

	it.each([
		[
			"HTTP 500 without a body",
			{ code: "HTTP_ERROR", detail: "HTTP 500", status: 500 } as const,
			500,
		],
		[
			"HTTP 400 without a body",
			{ code: "HTTP_ERROR", detail: "HTTP 400", status: 400 } as const,
			400,
		],
		// A status no mapping names comes out unchanged (§4a).
		[
			"HTTP 529 without a body",
			{ code: "HTTP_ERROR", detail: "HTTP 529", status: 529 } as const,
			529,
		],
		[
			"an oversize body",
			{ code: "RESPONSE_TOO_LARGE", detail: "body exceeds 1000 bytes" } as const,
			null,
		],
		["a timeout", { code: "TIMEOUT", detail: "no complete response" } as const, null],
	])("maps %s to SOURCE_FAILED, keeping the upstream status", async (_label, error, status) => {
		const { source } = sourceWith({ [META_URL]: { error } });
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error).toEqual({
			code: "SOURCE_FAILED",
			reason: marketUnavailableReason("SOURCE_FAILED", "fred"),
			upstreamStatus: status,
		});
	});

	it("maps non-JSON and empty payloads without inventing data", async () => {
		const malformed = sourceWith({ [META_URL]: { text: "{oops" } });
		const bad = await malformed.source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (bad.ok) throw new Error("expected a failure");
		expect(bad.error.code).toBe("SOURCE_FAILED");

		const empty = sourceWith({ [META_URL]: { text: '{"seriess":[]}' } });
		const none = await empty.source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (none.ok) throw new Error("expected a failure");
		expect(none.error.code).toBe("SERIES_NOT_FOUND");
	});

	it("fails closed on empty units instead of shipping a fallback", async () => {
		const meta = JSON.stringify({
			seriess: [
				{
					id: "X",
					title: "T",
					units: "",
					frequency: "Monthly",
					frequency_short: "M",
					seasonal_adjustment: "Not Seasonally Adjusted",
					seasonal_adjustment_short: "NSA",
				},
			],
		});
		const { source } = sourceWith({
			[`https://api.stlouisfed.org/fred/series?series_id=X&file_type=json&api_key=${API_KEY}`]: {
				text: meta,
			},
		});
		const result = await source.fetchSeries({
			symbol: "X",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("SOURCE_FAILED");
	});

	it("maps an observations failure after good metadata", async () => {
		const { source } = sourceWith({
			[META_URL]: { text: VIX_META },
			[OBS_URL]: { error: { code: "HTTP_ERROR", detail: "HTTP 500", status: 500 } },
		});
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (result.ok) throw new Error("expected a failure");
		expect(result.error.code).toBe("SOURCE_FAILED");
	});

	it("S7: skips empty and whitespace values instead of storing them as zero", async () => {
		const obs = JSON.stringify({
			observations: [
				{ date: "2026-10-06", value: "15.01" },
				{ date: "2026-10-07", value: "" },
				{ date: "2026-10-08", value: "   " },
				{ date: "2026-10-09", value: "15.41" },
			],
		});
		const { source } = sourceWith({ [META_URL]: { text: VIX_META }, [OBS_URL]: { text: obs } });
		const result = await source.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.observations).toEqual([
			{ observedOn: "2026-10-06", value: 15.01 },
			{ observedOn: "2026-10-09", value: 15.41 },
		]);
	});
});
