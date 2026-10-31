import { admitMarketRequest } from "@research/adapters/finance";
import type { MarketSeriesSource } from "@research/application";
import { unconfiguredMarketSeriesSource } from "@research/application";
import {
	type ClaimedJob,
	type CompleteJobRequest,
	completeJobRequestSchema,
	MARKET_LIMITS,
} from "@research/contracts";
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
		{ seriesId: "fred:VIXCLS", latestObservedOn: null, anchor: null, fullCheck: false },
		{
			seriesId: "twelve-data:AAPL",
			latestObservedOn: "2026-10-01",
			anchor: null,
			fullCheck: false,
		},
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
			from: null,
			maxObservations: 800,
			signal: never,
			beforeRequest: () => Promise.resolve("granted"),
		});
		if (result.ok) throw new Error("expected unconfigured");
		expect(result.error.code).toBe("SOURCE_NOT_CONFIGURED");
		expect(result.error.reason).toContain("FRED_API_KEY");
	});

	it("records one provider's success without aborting on the other's failure", async () => {
		const seen: { symbol: string; from: string | null }[] = [];
		const fred: MarketSeriesSource = {
			providerId: "fred",
			fetchSeries: (query) => {
				seen.push({ symbol: query.symbol, from: query.from });
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
		expect(seen).toEqual([{ symbol: "VIXCLS", from: null }]);
	});

	it("passes the anchor's date as from and reports a throw as SOURCE_FAILED", async () => {
		const seen: { symbol: string; from: string | null }[] = [];
		const twelve: MarketSeriesSource = {
			providerId: "twelve-data",
			fetchSeries: (query) => {
				seen.push({ symbol: query.symbol, from: query.from });
				return Promise.reject(new Error("boom"));
			},
		};
		const fredDown: MarketSeriesSource = {
			providerId: "fred",
			fetchSeries: () =>
				Promise.resolve(err({ code: "RATE_LIMITED", reason: "limited", upstreamStatus: 429 })),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const anchored: Extract<ClaimedJob, { kind: "market-refresh" }> = {
			...MARKET_JOB,
			series: [
				{ seriesId: "fred:VIXCLS", latestObservedOn: null, anchor: null, fullCheck: false },
				{
					seriesId: "twelve-data:AAPL",
					latestObservedOn: "2026-10-01",
					anchor: { observedOn: "2026-08-19", value: 101.5 },
					fullCheck: false,
				},
			],
		};
		await executeJob(
			anchored,
			{
				...harness.deps,
				marketSources: new Map([
					["fred", fredDown],
					["twelve-data", twelve],
				]),
			},
			never,
		);
		// The window starts at the anchor itself (inclusive), not at the newest
		// stored date; a failed first request is not retried in full.
		expect(seen).toEqual([{ symbol: "AAPL", from: "2026-08-19" }]);
		const completion = marketCompletionOf(calls.completions[0]);
		const vix = completion.series.find((entry) => entry.seriesId === "fred:VIXCLS");
		expect(vix?.errorCode).toBe("RATE_LIMITED");
		// The provider's own status, unchanged (§4a).
		expect(vix?.upstreamStatus).toBe(429);
		const aapl = completion.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		expect(aapl?.errorCode).toBe("SOURCE_FAILED");
		// A throw is not an answer: no upstream status.
		expect(aapl?.upstreamStatus ?? null).toBeNull();
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
			{
				...MARKET_JOB,
				series: [{ seriesId: "bogus", latestObservedOn: null, anchor: null, fullCheck: false }],
			},
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
	/** Admits its one request like the real adapter, then answers one close. */
	const twelveSuccess: MarketSeriesSource = {
		providerId: "twelve-data",
		fetchSeries: async (query) => {
			const refused = await admitMarketRequest(query.beforeRequest, "twelve-data");
			if (refused !== null) return err(refused);
			return ok({
				meta: {
					title: `${query.symbol} (NASDAQ)`,
					unit: "USD",
					frequency: "daily",
					publisher: "Twelve Data",
					sourceUrl: "https://twelvedata.com/",
				},
				observations: [{ observedOn: "2026-10-09", value: 100 }],
			});
		},
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
				{ seriesId: "twelve-data:AAPL", latestObservedOn: null, anchor: null, fullCheck: false },
				{ seriesId: "twelve-data:MSFT", latestObservedOn: null, anchor: null, fullCheck: false },
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

	it("fails a series as RATE_LIMITED, with no upstream status, without sending once the day's budget is spent", async () => {
		const sent: string[] = [];
		const twelve: MarketSeriesSource = {
			providerId: "twelve-data",
			fetchSeries: async (query) => {
				const refused = await admitMarketRequest(query.beforeRequest, "twelve-data");
				if (refused !== null) return err(refused);
				sent.push(query.symbol);
				return twelveSuccess.fetchSeries({
					...query,
					beforeRequest: () => Promise.resolve("granted"),
				});
			},
		};
		const job: Extract<ClaimedJob, { kind: "market-refresh" }> = {
			...MARKET_JOB,
			series: [
				{ seriesId: "twelve-data:AAPL", latestObservedOn: null, anchor: null, fullCheck: false },
				{ seriesId: "twelve-data:MSFT", latestObservedOn: null, anchor: null, fullCheck: false },
			],
		};
		const harness = createDeps(createFakeApi().api);
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: harness.time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				harness.time.advance(ms);
			},
			limits: new Map([["twelve-data", twelveDataRateLimit(8)]]),
			dailyBudgets: new Map([["twelve-data", 1]]),
		});
		const run = async () => {
			const { api, calls } = createFakeApi();
			await executeJob(
				job,
				{
					...createDeps(api).deps,
					clock: harness.time.clock,
					marketSources: new Map([["twelve-data", twelve]]),
					marketPacer: pacer,
				},
				never,
			);
			return marketCompletionOf(calls.completions[0]).series;
		};
		const today = await run();
		expect(sent).toEqual(["AAPL"]);
		expect(today.map((entry) => [entry.errorCode, entry.upstreamStatus ?? null])).toEqual([
			[null, null],
			["RATE_LIMITED", null],
		]);
		// Refused at once: no waiting for a window that would not help.
		expect(slept).toEqual([]);
		// The budget is per UTC day: the next day admits again.
		harness.time.advance(24 * 60 * 60 * 1000);
		const tomorrow = await run();
		expect(sent).toEqual(["AAPL", "AAPL"]);
		expect(tomorrow.map((entry) => entry.errorCode)).toEqual([null, "RATE_LIMITED"]);
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
			{
				...MARKET_JOB,
				series: [
					{ seriesId: "fred:VIXCLS", latestObservedOn: null, anchor: null, fullCheck: false },
				],
			},
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

describe("market-refresh execution: incremental history (ADR-0044)", () => {
	const META = {
		title: "AAPL (NASDAQ)",
		unit: "USD",
		frequency: "daily",
		publisher: "Twelve Data",
		sourceUrl: "https://twelvedata.com/",
	} as const;
	const ANCHOR = { observedOn: "2026-09-01", value: 10 };

	type Answer = Awaited<ReturnType<MarketSeriesSource["fetchSeries"]>> | Error;
	const answered = (points: readonly [string, number][]): Answer =>
		ok({
			meta: META,
			observations: points.map(([observedOn, value]) => ({ observedOn, value })),
		});

	/** A Twelve Data stand-in that plays one scripted answer per request and records each `from`. */
	function scriptedSource(answers: readonly Answer[], onFetch?: () => void) {
		const froms: (string | null)[] = [];
		const source: MarketSeriesSource = {
			providerId: "twelve-data",
			fetchSeries: async (query) => {
				// Like the real adapter: nothing is sent unless the request is admitted.
				const refused = await admitMarketRequest(query.beforeRequest, "twelve-data");
				if (refused !== null) return err(refused);
				froms.push(query.from);
				onFetch?.();
				const answer = answers[froms.length - 1];
				if (answer === undefined) throw new Error("unexpected extra request");
				if (answer instanceof Error) throw answer;
				return answer;
			},
		};
		return { source, froms };
	}

	function jobWith(
		anchor: { observedOn: string; value: number } | null,
		fullCheck: boolean,
	): Extract<ClaimedJob, { kind: "market-refresh" }> {
		return {
			...MARKET_JOB,
			series: [{ seriesId: "twelve-data:AAPL", latestObservedOn: null, anchor, fullCheck }],
		};
	}

	/** Runs the job against `source` and returns its one series, after checking the completion against the contract. */
	async function refreshOne(
		job: Extract<ClaimedJob, { kind: "market-refresh" }>,
		source: MarketSeriesSource,
	) {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job,
			{ ...harness.deps, marketSources: new Map([["twelve-data", source]]) },
			never,
		);
		const completion = marketCompletionOf(calls.completions[0]);
		// The API refuses a history write whose replaceFrom is not one of the
		// answered dates: every completion here must pass the real schema.
		expect(completeJobRequestSchema.safeParse(completion).success).toBe(true);
		const [entry] = completion.series;
		if (entry === undefined) throw new Error("expected one series");
		return entry;
	}

	it("stores a window that reproduces the anchor with one request from the anchor's date", async () => {
		const { source, froms } = scriptedSource([
			answered([
				["2026-09-01", 10],
				["2026-09-02", 11],
			]),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, false), source);
		expect(froms).toEqual(["2026-09-01"]);
		expect(entry.errorCode).toBeNull();
		expect(entry.observations).toEqual([
			["2026-09-01", 10],
			["2026-09-02", 11],
		]);
		expect(entry.history).toEqual({ mode: "window", replaceFrom: "2026-09-01" });
	});

	it("fetches everything again when the window changed the anchor's value, and replaces the history", async () => {
		const { source, froms } = scriptedSource([
			answered([
				["2026-09-01", 5],
				["2026-09-02", 5.5],
			]),
			answered([
				["2026-08-01", 4],
				["2026-09-01", 5],
				["2026-09-02", 5.5],
			]),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, false), source);
		expect(froms).toEqual(["2026-09-01", null]);
		// The completion carries the full answer, never the window.
		expect(entry.observations).toEqual([
			["2026-08-01", 4],
			["2026-09-01", 5],
			["2026-09-02", 5.5],
		]);
		expect(entry.history).toEqual({ mode: "full", replaceFrom: null });
	});

	it("fetches everything again when the window lacks the anchor's date", async () => {
		const { source, froms } = scriptedSource([
			answered([["2026-09-02", 11]]),
			answered([
				["2026-08-31", 9],
				["2026-09-02", 11],
			]),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, false), source);
		expect(froms).toEqual(["2026-09-01", null]);
		expect(entry.history).toEqual({ mode: "full", replaceFrom: null });
	});

	it("keeps older stored rows when only the window missed the anchor and the full answer holds it", async () => {
		const { source, froms } = scriptedSource([
			answered([["2026-09-02", 11]]),
			answered([
				["2026-08-31", 9],
				["2026-09-01", 10],
				["2026-09-02", 11],
			]),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, false), source);
		expect(froms).toEqual(["2026-09-01", null]);
		expect(entry.history).toEqual({ mode: "full", replaceFrom: "2026-08-31" });
	});

	it("fetches everything on a due full check and replaces from the oldest fetched date when the anchor holds", async () => {
		const { source, froms } = scriptedSource([
			answered([
				["2026-07-01", 8],
				["2026-09-01", 10],
				["2026-09-02", 11],
			]),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, true), source);
		expect(froms).toEqual([null]);
		expect(entry.history).toEqual({ mode: "full", replaceFrom: "2026-07-01" });
	});

	it("replaces everything on a due full check whose answer changed the anchor, with one request", async () => {
		const { source, froms } = scriptedSource([
			answered([
				["2026-07-01", 4],
				["2026-09-01", 5],
			]),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, true), source);
		expect(froms).toEqual([null]);
		expect(entry.history).toEqual({ mode: "full", replaceFrom: null });
	});

	it("fetches everything once for a series with nothing stored", async () => {
		const { source, froms } = scriptedSource([answered([["2026-09-02", 11]])]);
		const entry = await refreshOne(jobWith(null, false), source);
		expect(froms).toEqual([null]);
		expect(entry.history).toEqual({ mode: "full", replaceFrom: null });
	});

	it("attaches no history to an empty answer, so nothing stored is replaced", async () => {
		const { source, froms } = scriptedSource([answered([])]);
		const entry = await refreshOne(jobWith(null, false), source);
		expect(froms).toEqual([null]);
		expect(entry.errorCode).toBeNull();
		expect(entry.observations).toEqual([]);
		expect(entry.history).toBeUndefined();
	});

	it("keeps replaceFrom among the sent dates when the answer is cut to one response", async () => {
		const day0 = Date.UTC(2020, 0, 1);
		const points: [string, number][] = Array.from(
			{ length: MARKET_LIMITS.maxObservationsPerResponse + 1 },
			(_, index) => [new Date(day0 + index * 86_400_000).toISOString().slice(0, 10), index],
		);
		const anchorPoint = points[5];
		if (anchorPoint === undefined) throw new Error("expected an anchor point");
		const { source } = scriptedSource([answered(points)]);
		const entry = await refreshOne(
			jobWith({ observedOn: anchorPoint[0], value: anchorPoint[1] }, true),
			source,
		);
		expect(entry.observations).toHaveLength(MARKET_LIMITS.maxObservationsPerResponse);
		// The oldest point fell off the response, so the write starts at the oldest one sent.
		expect(entry.history).toEqual({ mode: "full", replaceFrom: points[1]?.[0] });
	});

	it("fails the series like any fetch error when the full request after a revision fails", async () => {
		const { source, froms } = scriptedSource([
			answered([["2026-09-01", 5]]),
			err({ code: "RATE_LIMITED", reason: "limited", upstreamStatus: 429 }),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, false), source);
		expect(froms).toEqual(["2026-09-01", null]);
		expect(entry).toMatchObject({
			errorCode: "RATE_LIMITED",
			upstreamStatus: 429,
			meta: null,
			observations: [],
		});
		expect(entry.history).toBeUndefined();
	});

	it("reports a throw on the full request after a revision as SOURCE_FAILED", async () => {
		const { source, froms } = scriptedSource([
			answered([["2026-09-01", 5]]),
			new TypeError("socket"),
		]);
		const entry = await refreshOne(jobWith(ANCHOR, false), source);
		expect(froms).toEqual(["2026-09-01", null]);
		expect(entry.errorCode).toBe("SOURCE_FAILED");
		expect(entry.upstreamStatus ?? null).toBeNull();
		expect(entry.history).toBeUndefined();
	});

	it("stops without the second request or a completion when shutdown arrives between the two", async () => {
		const shutdown = new AbortController();
		const { source, froms } = scriptedSource([answered([["2026-09-01", 5]])], () => {
			shutdown.abort();
		});
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			jobWith(ANCHOR, false),
			{ ...harness.deps, marketSources: new Map([["twelve-data", source]]) },
			shutdown.signal,
		);
		expect(froms).toEqual(["2026-09-01"]);
		expect(calls.completions).toEqual([]);
	});

	it("paces the full request after a revision through the same gate as the first", async () => {
		const { source, froms } = scriptedSource([
			answered([["2026-09-01", 5]]),
			answered([["2026-09-01", 5]]),
		]);
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const slept: number[] = [];
		await executeJob(
			jobWith(ANCHOR, false),
			{
				...harness.deps,
				marketSources: new Map([["twelve-data", source]]),
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
		// One request per minute: the second request of the same series waited a full window.
		expect(froms).toEqual(["2026-09-01", null]);
		expect(slept).toEqual([60_000]);
		const entry = marketCompletionOf(calls.completions[0]).series[0];
		expect(entry?.history).toEqual({ mode: "full", replaceFrom: null });
	});

	it("fetches a series claimed twice once, so the completion names it once", async () => {
		const { source, froms } = scriptedSource([answered([["2026-09-01", 10]])]);
		const entry = { seriesId: "twelve-data:AAPL", latestObservedOn: null, fullCheck: false };
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{
				...MARKET_JOB,
				series: [
					{ ...entry, anchor: null },
					{ ...entry, anchor: ANCHOR },
				],
			},
			{ ...harness.deps, marketSources: new Map([["twelve-data", source]]) },
			never,
		);
		expect(froms).toEqual([null]);
		const completion = marketCompletionOf(calls.completions[0]);
		expect(completion.series.map((series) => series.seriesId)).toEqual(["twelve-data:AAPL"]);
		expect(completeJobRequestSchema.safeParse(completion).success).toBe(true);
	});
});
