import { createFinnhubEarningsSource } from "@research/adapters/finance";
import type {
	EarningsCalendarSource,
	EarningsSourceResult,
	SafeFetcher,
} from "@research/application";
import { unconfiguredEarningsCalendarSource } from "@research/application";
import type { ClaimedJob, CompleteJobRequest, EarningsEvent } from "@research/contracts";
import { err, ok } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import { createMarketPacer, FINNHUB_RATE_LIMIT, JPX_RATE_LIMIT } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;

/** Narrows a recorded completion to the earnings-refreshed variant (throws otherwise). */
function earningsCompletionOf(
	completion: CompleteJobRequest | undefined,
): Extract<CompleteJobRequest, { outcome: "earnings-refreshed" }> {
	if (completion === undefined) throw new Error("expected a completion");
	if (completion.outcome !== "earnings-refreshed") {
		throw new Error(`expected an earnings completion, got ${completion.outcome}`);
	}
	return completion;
}

const EARNINGS_JOB: Extract<ClaimedJob, { kind: "earnings-refresh" }> = {
	kind: "earnings-refresh",
	runId: "run_earnings",
	leaseGeneration: 2,
	leaseExpiresAt: "2026-10-11T00:01:30.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [],
	fromDate: "2026-10-11",
	toDate: "2027-04-14",
	stocks: [
		{ stockId: "us:AAPL", name: null },
		{ stockId: "jp:7203", name: "Toyota Motor Corp." },
	],
};

const AAPL_EVENT = {
	periodKey: "2026-q4",
	announcementDate: "2026-10-29",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
} as const;

function stateSequence(
	events: { events: { seq: number; event: { type: string; state?: string } }[] }[],
) {
	return events
		.flatMap((request) => request.events)
		.filter((entry) => entry.event.type === "state")
		.map((entry) => entry.event.state);
}

describe("earnings-refresh execution (FR-018)", () => {
	it("reports every stock as SOURCE_NOT_CONFIGURED when no adapter is wired", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(EARNINGS_JOB, harness.deps, never);

		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(calls.completions).toHaveLength(1);
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion).toMatchObject({ outcome: "earnings-refreshed", leaseGeneration: 2 });
		expect(completion.stocks.map((entry) => entry.errorCode)).toEqual([
			"SOURCE_NOT_CONFIGURED",
			"SOURCE_NOT_CONFIGURED",
		]);
		// Claim order is preserved.
		expect(completion.stocks.map((entry) => entry.stockId)).toEqual(["us:AAPL", "jp:7203"]);
	});

	it("names the unconfigured source honestly per stock", async () => {
		const source = unconfiguredEarningsCalendarSource("finnhub");
		const results = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: true }],
			fromDate: "2026-10-11",
			toDate: "2027-04-14",
			signal: never,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(results).toHaveLength(1);
		const first = results[0];
		if (first === undefined || first.ok) throw new Error("expected unconfigured");
		expect(first.error.code).toBe("SOURCE_NOT_CONFIGURED");
	});

	it("groups stocks by source so JPX is one batch, asking names only when missing", async () => {
		const seen: { source: string; symbols: string[]; needNames: boolean[] }[] = [];
		const finnhub: EarningsCalendarSource = {
			sourceId: "finnhub",
			fetchEarnings: (query) => {
				seen.push({
					source: "finnhub",
					symbols: query.stocks.map((stock) => stock.symbol),
					needNames: query.stocks.map((stock) => stock.needName),
				});
				const results: EarningsSourceResult[] = query.stocks.map((stock) =>
					stock.symbol === "AAPL"
						? ok({ name: "Apple Inc", events: [{ ...AAPL_EVENT }] })
						: err({ code: "SYMBOL_NOT_FOUND" }),
				);
				return Promise.resolve(results);
			},
		};
		const jpx: EarningsCalendarSource = {
			sourceId: "jpx",
			fetchEarnings: (query) => {
				seen.push({
					source: "jpx",
					symbols: query.stocks.map((stock) => stock.symbol),
					needNames: query.stocks.map((stock) => stock.needName),
				});
				return Promise.resolve([
					ok({
						name: "Toyota Motor Corp.",
						events: [
							{
								periodKey: "fy2027-03-31-second-quarter",
								announcementDate: "2026-11-05",
								fiscalPeriodLabel: "Second quarter",
								fiscalPeriodEnd: "2027-03-31",
								timing: "unknown",
							},
						],
					}),
				]);
			},
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{
				...EARNINGS_JOB,
				stocks: [
					{ stockId: "us:AAPL", name: null },
					{ stockId: "us:MSFT", name: "Microsoft Corp." },
					{ stockId: "jp:7203", name: null },
				],
			},
			{
				...harness.deps,
				earningsSources: new Map([
					["finnhub", finnhub],
					["jpx", jpx],
				]),
			},
			never,
		);
		// One batch per source; needName is true only where the stored name was null.
		expect(seen).toEqual([
			{ source: "finnhub", symbols: ["AAPL", "MSFT"], needNames: [true, false] },
			{ source: "jpx", symbols: ["7203"], needNames: [true] },
		]);
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks.map((entry) => entry.stockId)).toEqual([
			"us:AAPL",
			"us:MSFT",
			"jp:7203",
		]);
		const aapl = completion.stocks.find((entry) => entry.stockId === "us:AAPL");
		expect(aapl?.errorCode).toBeNull();
		expect(aapl?.name).toBe("Apple Inc");
		expect(aapl?.events).toEqual([{ ...AAPL_EVENT }]);
		const msft = completion.stocks.find((entry) => entry.stockId === "us:MSFT");
		expect(msft?.errorCode).toBe("SYMBOL_NOT_FOUND");
		expect(msft?.events).toEqual([]);
		const toyota = completion.stocks.find((entry) => entry.stockId === "jp:7203");
		expect(toyota?.errorCode).toBeNull();
		expect(toyota?.events).toHaveLength(1);
	});

	it("paces every Finnhub request start: two stocks needing names wait out the window", async () => {
		const symbols = ["AAPL", "MSFT"];
		const starts: number[] = [];
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const fetcher: SafeFetcher = {
			fetchText: (url) => {
				starts.push(harness.time.clock.nowMs());
				const parsed = new URL(url);
				const symbol = parsed.searchParams.get("symbol") ?? "";
				if (parsed.pathname === "/api/v1/calendar/earnings") {
					return Promise.resolve(
						ok({
							finalUrl: url,
							contentType: "application/json",
							text: JSON.stringify({
								earningsCalendar: [
									{
										date: "2026-10-29",
										hour: "amc",
										quarter: 4,
										symbol,
										year: 2026,
									},
								],
							}),
						}),
					);
				}
				return Promise.resolve(
					ok({
						finalUrl: url,
						contentType: "application/json",
						text: JSON.stringify({ name: `${symbol} Inc`, ticker: symbol }),
					}),
				);
			},
		};
		const slept: number[] = [];
		await executeJob(
			{
				...EARNINGS_JOB,
				stocks: symbols.map((symbol) => ({ stockId: `us:${symbol}`, name: null })),
			},
			{
				...harness.deps,
				earningsSources: new Map([
					["finnhub", createFinnhubEarningsSource({ apiKey: "test-key", fetcher })],
				]),
				marketPacer: createMarketPacer({
					clock: harness.time.clock,
					sleep: async (ms) => {
						slept.push(ms);
						harness.time.advance(ms);
					},
					limits: new Map([["finnhub", { maxPerWindow: 3, windowMs: 60_000 }]]),
				}),
			},
			never,
		);
		// Two stocks needing names send 4 requests against a 3-per-minute
		// window: the fourth start waits out the window. Without the
		// per-request hook nothing waits, so this fails when pacing is removed.
		expect(slept).toEqual([60_000]);
		expect(starts).toHaveLength(4);
		expect(Math.max(...starts) - Math.min(...starts)).toBe(60_000);
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks.map((entry) => entry.errorCode)).toEqual([null, null]);
		expect(FINNHUB_RATE_LIMIT).toEqual({ maxPerWindow: 30, windowMs: 60_000 });
		expect(JPX_RATE_LIMIT).toEqual({ maxPerWindow: 6, windowMs: 60_000 });
	});

	it("paces 50 stocks needing names: no 60 s window holds more than the limit", async () => {
		const symbols = Array.from({ length: 50 }, (_, index) => `T${index}`);
		const starts: number[] = [];
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const fetcher: SafeFetcher = {
			fetchText: (url) => {
				starts.push(harness.time.clock.nowMs());
				const parsed = new URL(url);
				const symbol = parsed.searchParams.get("symbol") ?? "";
				if (parsed.pathname === "/api/v1/calendar/earnings") {
					return Promise.resolve(
						ok({
							finalUrl: url,
							contentType: "application/json",
							text: JSON.stringify({
								earningsCalendar: [
									{
										date: "2026-10-29",
										hour: "amc",
										quarter: 4,
										symbol,
										year: 2026,
									},
								],
							}),
						}),
					);
				}
				return Promise.resolve(
					ok({
						finalUrl: url,
						contentType: "application/json",
						text: JSON.stringify({ name: `${symbol} Inc`, ticker: symbol }),
					}),
				);
			},
		};
		await executeJob(
			{
				...EARNINGS_JOB,
				stocks: symbols.map((symbol) => ({ stockId: `us:${symbol}`, name: null })),
			},
			{
				...harness.deps,
				earningsSources: new Map([
					["finnhub", createFinnhubEarningsSource({ apiKey: "test-key", fetcher })],
				]),
				marketPacer: createMarketPacer({
					clock: harness.time.clock,
					sleep: async (ms) => {
						harness.time.advance(ms);
					},
					limits: new Map([["finnhub", FINNHUB_RATE_LIMIT]]),
				}),
			},
			never,
		);
		// 50 stocks needing names send 100 request starts at 30 per 60 s.
		expect(starts).toHaveLength(100);
		const ordered = [...starts].sort((a, b) => a - b);
		for (let index = 0; index < ordered.length; index += 1) {
			const start = ordered[index];
			if (start === undefined) continue;
			const inWindow = ordered.filter(
				(other) => other !== undefined && other >= start && other < start + 60_000,
			).length;
			expect(inWindow).toBeLessThanOrEqual(30);
		}
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks).toHaveLength(50);
		expect(completion.stocks.every((entry) => entry.errorCode === null)).toBe(true);
	});

	it("sends nothing further when the signal aborts while waiting for a grant", async () => {
		const controller = new AbortController();
		const fetchedUrls: string[] = [];
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const fetcher: SafeFetcher = {
			fetchText: (url) => {
				fetchedUrls.push(url);
				const parsed = new URL(url);
				const symbol = parsed.searchParams.get("symbol") ?? "";
				if (parsed.pathname === "/api/v1/calendar/earnings") {
					return Promise.resolve(
						ok({
							finalUrl: url,
							contentType: "application/json",
							text: JSON.stringify({
								earningsCalendar: [
									{
										date: "2026-10-29",
										hour: "amc",
										quarter: 4,
										symbol,
										year: 2026,
									},
								],
							}),
						}),
					);
				}
				return Promise.resolve(
					ok({
						finalUrl: url,
						contentType: "application/json",
						text: JSON.stringify({ name: `${symbol} Inc`, ticker: symbol }),
					}),
				);
			},
		};
		await executeJob(
			{
				...EARNINGS_JOB,
				stocks: [
					{ stockId: "us:AAPL", name: null },
					{ stockId: "us:MSFT", name: null },
					{ stockId: "us:GOOG", name: null },
				],
			},
			{
				...harness.deps,
				earningsSources: new Map([
					["finnhub", createFinnhubEarningsSource({ apiKey: "test-key", fetcher })],
				]),
				marketPacer: createMarketPacer({
					clock: harness.time.clock,
					// One grant fits; the second wait aborts instead of advancing.
					sleep: async () => {
						controller.abort();
					},
					limits: new Map([["finnhub", { maxPerWindow: 1, windowMs: 60_000 }]]),
				}),
			},
			controller.signal,
		);
		// The first request went out; the wait aborted and nothing followed it.
		// The aborted job submits nothing (the lease expires for the next
		// claim), so the assertion is on the wire, not the completion.
		expect(fetchedUrls).toHaveLength(1);
		expect(calls.completions).toHaveLength(0);
	});

	it("fails every stock of a source whose batch comes back short", async () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => {
			lines.push(line);
		});
		const short: EarningsCalendarSource = {
			sourceId: "finnhub",
			fetchEarnings: (query) =>
				Promise.resolve(
					query.stocks
						.slice(0, 1)
						.map(() => ok({ name: "Apple Inc", events: [{ ...AAPL_EVENT }] })),
				),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{
				...EARNINGS_JOB,
				stocks: [
					{ stockId: "us:AAPL", name: null },
					{ stockId: "us:MSFT", name: "Microsoft Corp." },
				],
			},
			{ ...harness.deps, logger, earningsSources: new Map([["finnhub", short]]) },
			never,
		);
		// The port promises one result per symbol in order: a short batch is
		// a contract breach, failed closed for the whole source.
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks.map((entry) => entry.errorCode)).toEqual([
			"SOURCE_FAILED",
			"SOURCE_FAILED",
		]);
		const warnings = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(warnings.filter((line) => line.event === "earnings_source_failed")).toHaveLength(1);
	});

	it("carries the company name through a NO_SCHEDULED_DATE completion", async () => {
		const finnhub: EarningsCalendarSource = {
			sourceId: "finnhub",
			fetchEarnings: (query) =>
				Promise.resolve(
					query.stocks.map(() => err({ code: "NO_SCHEDULED_DATE" as const, name: "Apple Inc" })),
				),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{ ...EARNINGS_JOB, stocks: [{ stockId: "us:AAPL", name: null }] },
			{ ...harness.deps, earningsSources: new Map([["finnhub", finnhub]]) },
			never,
		);
		// A listed-nothing retrieval still delivers the name with the code,
		// so the stock gets its name and the profile is not asked again.
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks).toEqual([
			expect.objectContaining({
				stockId: "us:AAPL",
				name: "Apple Inc",
				events: [],
				errorCode: "NO_SCHEDULED_DATE",
			}),
		]);
	});

	it("caps events at eight per stock", async () => {
		const many: EarningsEvent[] = Array.from({ length: 20 }, (_, index) => ({
			periodKey: `2026-q${(index % 4) + 1}-${index}`,
			announcementDate: "2026-10-29",
			fiscalPeriodLabel: "Q4 2026",
			fiscalPeriodEnd: null,
			timing: "after-close",
		}));
		const finnhub: EarningsCalendarSource = {
			sourceId: "finnhub",
			fetchEarnings: (query) =>
				Promise.resolve(query.stocks.map(() => ok({ name: "Apple Inc", events: many }))),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{ ...EARNINGS_JOB, stocks: [{ stockId: "us:AAPL", name: null }] },
			{ ...harness.deps, earningsSources: new Map([["finnhub", finnhub]]) },
			never,
		);
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks[0]?.events).toHaveLength(8);
	});

	it("logs a thrown adapter failure with the class name only", async () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => {
			lines.push(line);
		});
		const throwing: EarningsCalendarSource = {
			sourceId: "jpx",
			fetchEarnings: () => Promise.reject(new TypeError("socket secret-detail https://x.example/")),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{ ...EARNINGS_JOB, stocks: [{ stockId: "jp:7203", name: null }] },
			{ ...harness.deps, logger, earningsSources: new Map([["jpx", throwing]]) },
			never,
		);
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks[0]?.errorCode).toBe("SOURCE_FAILED");
		const warnings = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		const failed = warnings.filter((line) => line.event === "earnings_source_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			level: "warn",
			event: "earnings_source_failed",
			source: "jpx",
			error: "TypeError",
		});
		for (const line of lines) {
			expect(line).not.toContain("secret-detail");
			expect(line).not.toContain("https://x.example/");
		}
	});

	it("fails a stock that no longer parses instead of skipping it", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{ ...EARNINGS_JOB, stocks: [{ stockId: "bogus", name: null }] },
			{ ...harness.deps, earningsSources: new Map() },
			never,
		);
		const completion = earningsCompletionOf(calls.completions[0]);
		expect(completion.stocks).toHaveLength(1);
		expect(completion.stocks[0]?.errorCode).toBe("SOURCE_FAILED");
	});
});
