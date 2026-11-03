import type {
	EarningsMarketCalendar,
	EarningsMarketCalendarFailure,
	EarningsMarketCalendarSource,
} from "@research/application";
import type {
	ClaimedJob,
	CompleteJobRequest,
	EarningsCalendarEvent,
	EarningsSourceId,
	WatchMarket,
} from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import type { MarketRequestPacer, PacerKey } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;
const FROM = "2026-11-03";
const TO = "2027-05-07";

function job(market: WatchMarket): Extract<ClaimedJob, { kind: "earnings-calendar-sync" }> {
	return {
		kind: "earnings-calendar-sync",
		runId: "run_calendar",
		leaseGeneration: 5,
		leaseExpiresAt: "2026-11-03T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		market,
		fromDate: FROM,
		toDate: TO,
	};
}

function event(symbol: string, announcementDate: string | null): EarningsCalendarEvent {
	return {
		symbol,
		periodKey: "2026-q3",
		announcementDate,
		fiscalPeriodLabel: "Q3 2026",
		fiscalPeriodEnd: null,
		timing: "before-open",
	};
}

type CalendarAnswer = Result<EarningsMarketCalendar, EarningsMarketCalendarFailure>;

/** A source that takes one grant, records the window asked and answers once. */
function answering(sourceId: EarningsSourceId, answer: () => Promise<CalendarAnswer>) {
	const seen = { windows: [] as [string, string][], grants: [] as boolean[] };
	const source: EarningsMarketCalendarSource = {
		sourceId,
		async fetchCalendar(query) {
			seen.windows.push([query.fromDate, query.toDate]);
			seen.grants.push(await query.beforeRequest());
			return answer();
		},
	};
	return { source, seen };
}

function recordingPacer() {
	const keys: PacerKey[] = [];
	const pacer: MarketRequestPacer = {
		async pace(provider) {
			keys.push(provider);
			return true;
		},
		async admit(provider) {
			keys.push(provider);
			return "granted";
		},
	};
	return { pacer, keys };
}

async function run(
	market: WatchMarket,
	sources: ReadonlyMap<EarningsSourceId, EarningsMarketCalendarSource>,
) {
	const { pacer, keys } = recordingPacer();
	const lines: string[] = [];
	const { api, calls } = createFakeApi();
	const harness = createDeps(api);
	await executeJob(
		job(market),
		{
			...harness.deps,
			logger: createEventLogger((line) => {
				lines.push(line);
			}),
			marketPacer: pacer,
			earningsCalendarSources: sources,
		},
		never,
	);
	const logs = lines.map((line): Record<string, unknown> => JSON.parse(line));
	return { calls, keys, logs, harness };
}

function stateSequence(events: { events: { event: { type: string; state?: string } }[] }[]) {
	return events
		.flatMap((request) => request.events)
		.filter((entry) => entry.event.type === "state")
		.map((entry) => entry.event.state);
}

function failedOf(completion: CompleteJobRequest | undefined) {
	if (completion?.outcome !== "failed")
		throw new Error(`expected failed, got ${completion?.outcome}`);
	return completion;
}

describe("earnings-calendar-sync execution (ADR-0068)", () => {
	it("completes with the market's calendar from its own source, paced under it", async () => {
		const events = [event("AAPL", "2026-11-05"), event("BH-A", FROM)];
		const finnhub = answering("finnhub", async () =>
			ok({ events, truncatedDates: ["2026-11-05"] }),
		);
		const jpx = answering("jpx", async () => ok({ events: [], truncatedDates: [] }));
		const { calls, keys, logs, harness } = await run(
			"US",
			new Map([
				["finnhub", finnhub.source],
				["jpx", jpx.source],
			]),
		);
		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(calls.completions).toEqual([
			{
				outcome: "earnings-calendar-synced",
				leaseGeneration: 5,
				usage: {
					agentSteps: 0,
					toolCalls: 0,
					inputBytes: 0,
					knownCostUsd: 0,
					hasUnmeteredUsage: false,
				},
				market: "US",
				fromDate: FROM,
				toDate: TO,
				fetchedAt: harness.time.clock.nowIso(),
				events,
				truncatedDates: ["2026-11-05"],
			},
		]);
		expect(finnhub.seen.windows).toEqual([[FROM, TO]]);
		expect(finnhub.seen.grants).toEqual([true]);
		expect(jpx.seen.windows).toEqual([]);
		expect(keys).toEqual(["finnhub"]);
		expect(logs.find((line) => line.event === "earnings_calendar_fetched")).toEqual({
			at: expect.any(String),
			level: "info",
			event: "earnings_calendar_fetched",
			runId: "run_calendar",
			market: "US",
			events: 2,
			truncatedDates: 1,
		});
	});

	it("reads a JP calendar from JPX under JPX's window", async () => {
		const jpx = answering("jpx", async () =>
			ok({ events: [event("7203", "2026-11-06"), event("130A", null)], truncatedDates: [] }),
		);
		const { calls, keys } = await run("JP", new Map([["jpx", jpx.source]]));
		expect(calls.completions[0]).toMatchObject({
			outcome: "earnings-calendar-synced",
			market: "JP",
			truncatedDates: [],
		});
		expect(keys).toEqual(["jpx"]);
	});

	it("fails a US calendar without Finnhub's key as not configured, asking nothing", async () => {
		const jpx = answering("jpx", async () => ok({ events: [], truncatedDates: [] }));
		const { calls, keys } = await run("US", new Map([["jpx", jpx.source]]));
		expect(failedOf(calls.completions[0])).toEqual({
			outcome: "failed",
			leaseGeneration: 5,
			usage: expect.any(Object),
			failureCode: "SOURCE_NOT_CONFIGURED",
			retryable: false,
		});
		expect(jpx.seen.windows).toEqual([]);
		expect(keys).toEqual([]);
	});

	it.each([
		["SOURCE_FAILED", 503, true],
		["SOURCE_FAILED", null, true],
		["RATE_LIMITED", 429, false],
		["SOURCE_AUTH_FAILED", 401, false],
		["PLAN_NOT_ENTITLED", 403, false],
	] as const)("keeps %s and the provider's status %s; retried at once: %s", async (code, upstreamStatus, retryable) => {
		const finnhub = answering("finnhub", async () => err({ code, upstreamStatus }));
		const { calls } = await run("US", new Map([["finnhub", finnhub.source]]));
		const failed = failedOf(calls.completions[0]);
		expect(failed.failureCode).toBe(code);
		expect(failed.retryable).toBe(retryable);
		if (upstreamStatus === null) expect(failed).not.toHaveProperty("failureUpstreamStatus");
		else expect(failed.failureUpstreamStatus).toBe(upstreamStatus);
	});

	it("fails a throwing source as SOURCE_FAILED and logs only the error's class", async () => {
		const finnhub = answering("finnhub", async () => {
			throw new TypeError("secret detail");
		});
		const { calls, logs } = await run("US", new Map([["finnhub", finnhub.source]]));
		expect(failedOf(calls.completions[0])).toMatchObject({
			failureCode: "SOURCE_FAILED",
			retryable: true,
		});
		expect(logs.find((line) => line.event === "earnings_calendar_source_failed")).toEqual({
			at: expect.any(String),
			level: "warn",
			event: "earnings_calendar_source_failed",
			source: "finnhub",
			error: "TypeError",
		});
		expect(JSON.stringify(logs)).not.toContain("secret detail");
	});

	it("fails a calendar the API would refuse instead of sending it", async () => {
		const finnhub = answering("finnhub", async () =>
			ok({ events: [event("AAPL", "2026-11-05"), event("AAPL", null)], truncatedDates: [] }),
		);
		const { calls, logs } = await run("US", new Map([["finnhub", finnhub.source]]));
		expect(failedOf(calls.completions[0])).toMatchObject({
			failureCode: "SOURCE_FAILED",
			retryable: true,
		});
		expect(logs.find((line) => line.event === "earnings_calendar_rejected")).toEqual({
			at: expect.any(String),
			level: "warn",
			event: "earnings_calendar_rejected",
			runId: "run_calendar",
			market: "US",
		});
	});
});
