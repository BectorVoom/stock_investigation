import type { MarketSeriesSource } from "@research/application";
import { unconfiguredMarketSeriesSource } from "@research/application";
import type { ClaimedJob, CompleteJobRequest } from "@research/contracts";
import { err, ok } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import { createMarketPacer, twelveDataRateLimit } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;

/** Narrows a recorded completion to the market-refreshed variant (throws otherwise). */
function marketCompletionOf(
	completion: CompleteJobRequest | undefined,
): Extract<CompleteJobRequest, { outcome: "market-refreshed" }> {
	if (completion === undefined) throw new Error("expected a completion");
	if (completion.outcome !== "market-refreshed") {
		throw new Error(`expected a market completion, got ${completion.outcome}`);
	}
	return completion;
}

const MARKET_JOB: Extract<ClaimedJob, { kind: "market-refresh" }> = {
	kind: "market-refresh",
	runId: "run_market",
	leaseGeneration: 2,
	leaseExpiresAt: "2026-10-11T00:01:30.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [],
	series: [
		{ seriesId: "fred:VIXCLS", latestObservedOn: null },
		{ seriesId: "twelve-data:AAPL", latestObservedOn: "2026-10-01" },
	],
};

function stateSequence(
	events: { events: { seq: number; event: { type: string; state?: string } }[] }[],
) {
	return events
		.flatMap((request) => request.events)
		.filter((entry) => entry.event.type === "state")
		.map((entry) => entry.event.state);
}

describe("market-refresh execution (FR-017)", () => {
	it("reports every series as SOURCE_NOT_CONFIGURED when no adapter is wired", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(MARKET_JOB, harness.deps, never);

		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(calls.completions).toHaveLength(1);
		const completion = marketCompletionOf(calls.completions[0]);
		expect(completion).toMatchObject({ outcome: "market-refreshed", leaseGeneration: 2 });
		expect(completion.series).toHaveLength(2);
		const vix = completion.series.find((entry) => entry.seriesId === "fred:VIXCLS");
		expect(vix?.meta).toBeNull();
		expect(vix?.observations).toEqual([]);
		expect(vix?.errorCode).toBe("SOURCE_NOT_CONFIGURED");
		const aapl = completion.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		expect(aapl?.errorCode).toBe("SOURCE_NOT_CONFIGURED");
		// The fixed reason names the variable to set (never provider message text).
		expect(completion.series.map((entry) => entry.errorCode)).toEqual([
			"SOURCE_NOT_CONFIGURED",
			"SOURCE_NOT_CONFIGURED",
		]);
	});

	it("names the provider key per provider in the fixed reason", async () => {
		const fred = unconfiguredMarketSeriesSource("fred", "set FRED_API_KEY in apps/runner/.env");
		const result = await fred.fetchSeries({
			symbol: "VIXCLS",
			since: null,
			maxObservations: 800,
			signal: never,
		});
		if (result.ok) throw new Error("expected unconfigured");
		expect(result.error.code).toBe("SOURCE_NOT_CONFIGURED");
		expect(result.error.reason).toContain("FRED_API_KEY");
	});

	it("records one provider's success without aborting on the other's failure", async () => {
		const seen: { symbol: string; since: string | null }[] = [];
		const fred: MarketSeriesSource = {
			providerId: "fred",
			fetchSeries: (query) => {
				seen.push({ symbol: query.symbol, since: query.since });
				return Promise.resolve(
					ok({
						meta: {
							title: "VIX",
							unit: "Index",
							frequency: "daily",
							publisher: "Federal Reserve Bank of St. Louis (FRED)",
							sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
						},
						observations: [{ observedOn: "2026-10-02", value: 15.8 }],
					}),
				);
			},
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			MARKET_JOB,
			{ ...harness.deps, marketSources: new Map([["fred", fred]]) },
			never,
		);
		const completion = marketCompletionOf(calls.completions[0]);
		const vix = completion.series.find((entry) => entry.seriesId === "fred:VIXCLS");
		expect(vix?.errorCode).toBeNull();
		expect(vix?.meta?.unit).toBe("Index");
		expect(vix?.observations).toEqual([["2026-10-02", 15.8]]);
		// Twelve Data has no source in this registry: honestly unconfigured, not fatal.
		const aapl = completion.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		expect(aapl?.errorCode).toBe("SOURCE_NOT_CONFIGURED");
		expect(seen).toEqual([{ symbol: "VIXCLS", since: null }]);
	});

	it("passes the stored watermark as since and reports a throw as SOURCE_FAILED", async () => {
		const seen: { symbol: string; since: string | null }[] = [];
		const twelve: MarketSeriesSource = {
			providerId: "twelve-data",
			fetchSeries: (query) => {
				seen.push({ symbol: query.symbol, since: query.since });
				return Promise.reject(new Error("boom"));
			},
		};
		const fredDown: MarketSeriesSource = {
			providerId: "fred",
			fetchSeries: () => Promise.resolve(err({ code: "RATE_LIMITED", reason: "limited" })),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			MARKET_JOB,
			{
				...harness.deps,
				marketSources: new Map([
					["fred", fredDown],
					["twelve-data", twelve],
				]),
			},
			never,
		);
		expect(seen).toEqual([{ symbol: "AAPL", since: "2026-10-01" }]);
		const completion = marketCompletionOf(calls.completions[0]);
		expect(completion.series.find((entry) => entry.seriesId === "fred:VIXCLS")?.errorCode).toBe(
			"RATE_LIMITED",
		);
		const aapl = completion.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		expect(aapl?.errorCode).toBe("SOURCE_FAILED");
		expect(aapl?.meta).toBeNull();
		expect(aapl?.observations).toEqual([]);
	});

	it("marks an unparsable series id SERIES_NOT_FOUND without fetching", async () => {
		let fetched = 0;
		const fred: MarketSeriesSource = {
			providerId: "fred",
			fetchSeries: () => {
				fetched += 1;
				return Promise.resolve(
					ok({
						meta: {
							title: "T",
							unit: "U",
							frequency: "daily",
							publisher: "P",
							sourceUrl: "https://fred.stlouisfed.org/series/X",
						},
						observations: [],
					}),
				);
			},
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{ ...MARKET_JOB, series: [{ seriesId: "bogus", latestObservedOn: null }] },
			{ ...harness.deps, marketSources: new Map([["fred", fred]]) },
			never,
		);
		expect(fetched).toBe(0);
		const completion = marketCompletionOf(calls.completions[0]);
		expect(completion.series).toHaveLength(1);
		expect(completion.series[0]?.errorCode).toBe("SERIES_NOT_FOUND");
	});

	it("abandons the job on shutdown without completing it", async () => {
		const shutdown = new AbortController();
		shutdown.abort();
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(MARKET_JOB, harness.deps, shutdown.signal);
		expect(calls.completions).toEqual([]);
		expect(harness.scratch.removed).toEqual(["/scratch/run_market"]);
	});
});

describe("market-refresh execution: provider keys and pacing (FR-017, Phase B)", () => {
	const twelveSuccess: MarketSeriesSource = {
		providerId: "twelve-data",
		fetchSeries: (query) =>
			Promise.resolve(
				ok({
					meta: {
						title: `${query.symbol} (NASDAQ)`,
						unit: "USD",
						frequency: "daily",
						publisher: "Twelve Data",
						sourceUrl: "https://twelvedata.com/",
					},
					observations: [{ observedOn: "2026-10-09", value: 100 }],
				}),
			),
	};

	it("reports SOURCE_NOT_CONFIGURED for the provider without a key only", async () => {
		// Only Twelve Data wired: FRED is unconfigured, Twelve Data still succeeds.
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			MARKET_JOB,
			{ ...harness.deps, marketSources: new Map([["twelve-data", twelveSuccess]]) },
			never,
		);
		const completion = marketCompletionOf(calls.completions[0]);
		expect(completion.series.find((entry) => entry.seriesId === "fred:VIXCLS")?.errorCode).toBe(
			"SOURCE_NOT_CONFIGURED",
		);
		const aapl = completion.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		expect(aapl?.errorCode).toBeNull();
		expect(aapl?.observations).toEqual([["2026-10-09", 100]]);
	});

	it("paces Twelve Data requests through the shared gate with a fake clock", async () => {
		const started: string[] = [];
		const twelve: MarketSeriesSource = {
			providerId: "twelve-data",
			fetchSeries: (query) => {
				started.push(query.symbol);
				return twelveSuccess.fetchSeries(query);
			},
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const slept: number[] = [];
		const job: Extract<ClaimedJob, { kind: "market-refresh" }> = {
			...MARKET_JOB,
			series: [
				{ seriesId: "twelve-data:AAPL", latestObservedOn: null },
				{ seriesId: "twelve-data:MSFT", latestObservedOn: null },
			],
		};
		await executeJob(
			job,
			{
				...harness.deps,
				marketSources: new Map([["twelve-data", twelve]]),
				marketPacer: createMarketPacer({
					clock: harness.time.clock,
					sleep: async (ms) => {
						slept.push(ms);
						harness.time.advance(ms);
					},
					limits: new Map([["twelve-data", twelveDataRateLimit(1)]]),
				}),
			},
			never,
		);
		// One request per minute: the second start waited a full window, with no real sleeping.
		expect(started).toEqual(["AAPL", "MSFT"]);
		expect(slept).toEqual([60_000]);
		const completion = marketCompletionOf(calls.completions[0]);
		expect(completion.series.map((entry) => entry.errorCode)).toEqual([null, null]);
	});

	it("logs a thrown adapter failure as market_series_failed with the class name only", async () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => {
			lines.push(line);
		});
		const throwing: MarketSeriesSource = {
			providerId: "fred",
			fetchSeries: () => Promise.reject(new TypeError("socket secret-detail https://x.example/")),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{ ...MARKET_JOB, series: [{ seriesId: "fred:VIXCLS", latestObservedOn: null }] },
			{ ...harness.deps, logger, marketSources: new Map([["fred", throwing]]) },
			never,
		);
		const completion = marketCompletionOf(calls.completions[0]);
		expect(completion.series[0]?.errorCode).toBe("SOURCE_FAILED");
		const warnings = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		const failed = warnings.filter((line) => line.event === "market_series_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			level: "warn",
			event: "market_series_failed",
			seriesId: "fred:VIXCLS",
			error: "TypeError",
		});
		// Neither the thrown message nor anything URL-like reaches the log.
		for (const line of lines) {
			expect(line).not.toContain("secret-detail");
			expect(line).not.toContain("https://x.example/");
		}
	});
});
