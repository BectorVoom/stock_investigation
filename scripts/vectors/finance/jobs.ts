/**
 * The market pacer and the runner's `market-refresh` / `earnings-refresh` job
 * bodies (crate `research-finance`: `pacing`, `jobs`).
 *
 * The job bodies are not exported by `jobExecution.ts`, so each case drives
 * the real `executeJob` with the runner's own test harness (fake Worker API,
 * silent everything else) and records what the body did: the states it
 * reported with their timestamps, every source call, every pacing request
 * and sleep, the log lines, and the completion it produced. When a case
 * aborts mid-run, `executeJob` replaces the body's completion (cancelled or
 * abandoned), so such cases compare the observable effects only.
 *
 * The clock is shared and ticks on every read, so a body that reads the
 * clock at another moment than the TypeScript produces different `fetchedAt`
 * values; the sleeps advance it, as in the TypeScript tests.
 */
import type {
	EarningsCalendarSource,
	EarningsSourceResult,
	MarketSeriesSource,
} from "@research/application";
import { unconfiguredEarningsCalendarSource } from "@research/application";
import type {
	ClaimedJob,
	CompleteJobRequest,
	EarningsSourceId,
	MarketProviderId,
} from "@research/contracts";
import { err, ok } from "@research/domain";
import type { EventLogger } from "@research/effects";
import { executeJob } from "../../../apps/runner/src/jobExecution.ts";
import {
	createMarketPacer,
	FINNHUB_RATE_LIMIT,
	FRED_RATE_LIMIT,
	GOOGLE_RATE_LIMIT,
	JPX_RATE_LIMIT,
	type MarketRateLimit,
	type MarketRequestPacer,
	type PacerKey,
	twelveDataRateLimit,
} from "../../../apps/runner/src/marketPacing.ts";
import { createDeps, createFakeApi } from "../../../apps/runner/test/support.ts";
import { createFinnhubEarningsSource } from "../../../packages/adapters/src/finance/finnhubEarnings.ts";
import { admitMarketRequest } from "../../../packages/adapters/src/finance/marketFetch.ts";
import {
	digestOf,
	type FetchEvent,
	plain,
	Rng,
	type ScriptEntry,
	scriptedFetcher,
} from "./support.ts";

const BASE_MS = Date.UTC(2026, 9, 17, 3, 0, 0);

/** A clock that ticks one millisecond on every read; sleeps add to it. */
interface SharedClock {
	nowMs(): number;
	nowIso(): string;
	advance(ms: number): void;
	reads(): number;
}

function sharedClock(): SharedClock {
	let reads = 0;
	let offset = 0;
	const read = (): number => {
		const value = BASE_MS + offset + reads;
		reads += 1;
		return value;
	};
	return {
		nowMs: read,
		nowIso: () => new Date(read()).toISOString(),
		advance(ms) {
			offset += ms;
		},
		reads: () => reads,
	};
}

/* ---------- limits ---------- */

type LimitSpec = {
	readonly provider: string;
	readonly maxPerWindow: number;
	readonly windowMs: number;
};

function standardLimits(twelvePerMinute: number): LimitSpec[] {
	const entry = (provider: PacerKey, limit: MarketRateLimit): LimitSpec => ({
		provider,
		maxPerWindow: limit.maxPerWindow,
		windowMs: limit.windowMs,
	});
	return [
		entry("fred", FRED_RATE_LIMIT),
		entry("twelve-data", twelveDataRateLimit(twelvePerMinute)),
		entry("finnhub", FINNHUB_RATE_LIMIT),
		entry("jpx", JPX_RATE_LIMIT),
		entry("google", GOOGLE_RATE_LIMIT),
	];
}

function limitMap(specs: readonly LimitSpec[]): Map<PacerKey, MarketRateLimit> {
	const limits = new Map<PacerKey, MarketRateLimit>();
	for (const spec of specs) {
		limits.set(spec.provider as PacerKey, {
			maxPerWindow: spec.maxPerWindow,
			windowMs: spec.windowMs,
		});
	}
	return limits;
}

/* ---------- pacer traces ---------- */

interface PacerOp {
	readonly provider: string;
	readonly requests: number | null;
	readonly advanceMs: number;
	readonly abortBefore: boolean;
	/** `admit` (one request start, three answers) instead of `pace`. */
	readonly admit?: true;
}

interface PacerCase {
	readonly limits: readonly LimitSpec[];
	readonly requestsPerSeries: readonly (readonly [string, number])[] | null;
	/** Request starts per UTC day by provider; absent: none. */
	readonly dailyBudgets?: readonly (readonly [string, number])[];
	/** Aborts the signal in the n-th sleep (1-based); null never. */
	readonly abortInSleep: number | null;
	readonly ops: readonly PacerOp[];
	readonly output: unknown;
}

const PROVIDERS = ["fred", "twelve-data", "finnhub", "jpx", "google", "unknown-provider"] as const;

async function runPacer(
	limits: readonly LimitSpec[],
	requestsPerSeries: readonly (readonly [string, number])[] | null,
	abortInSleep: number | null,
	ops: readonly PacerOp[],
	dailyBudgets?: readonly (readonly [string, number])[],
): Promise<PacerCase> {
	const clock = sharedClock();
	const sleeps: number[] = [];
	const controller = new AbortController();
	const pacer = createMarketPacer({
		clock,
		sleep: async (ms, signal) => {
			sleeps.push(ms);
			clock.advance(ms);
			if (abortInSleep !== null && sleeps.length === abortInSleep) controller.abort();
			void signal;
		},
		limits: limitMap(limits),
		...(requestsPerSeries === null ? {} : { requestsPerSeries: new Map(requestsPerSeries) }),
		...(dailyBudgets === undefined ? {} : { dailyBudgets: budgetMap(dailyBudgets) }),
	});
	const results: unknown[] = [];
	for (const op of ops) {
		clock.advance(op.advanceMs);
		const local = new AbortController();
		if (op.abortBefore) local.abort();
		const signal =
			abortInSleep === null ? local.signal : AbortSignal.any([local.signal, controller.signal]);
		const before = sleeps.length;
		if (op.admit === true) {
			const admission = await pacer.admit(op.provider as PacerKey, signal);
			results.push({ admission, sleeps: sleeps.slice(before) });
			continue;
		}
		const granted = await pacer.pace(
			op.provider as PacerKey,
			signal,
			...(op.requests === null ? [] : [op.requests]),
		);
		results.push({ granted, sleeps: sleeps.slice(before) });
	}
	return {
		limits,
		requestsPerSeries,
		...(dailyBudgets === undefined ? {} : { dailyBudgets }),
		abortInSleep,
		ops,
		output: { results, reads: clock.reads() },
	};
}

function budgetMap(entries: readonly (readonly [string, number])[]): Map<PacerKey, number> {
	return new Map(entries.map(([provider, budget]) => [provider as PacerKey, budget]));
}

async function pacerCases(): Promise<PacerCase[]> {
	const rng = new Rng(0xbace);
	const cases: PacerCase[] = [];
	const op = (
		provider: string,
		requests: number | null = null,
		advanceMs = 0,
		abortBefore = false,
	): PacerOp => ({
		provider,
		requests,
		advanceMs,
		abortBefore,
	});
	// marketPacing.test.ts families.
	cases.push(
		await runPacer(
			standardLimits(8),
			null,
			null,
			Array.from({ length: 10 }, () => op("twelve-data")),
		),
	);
	cases.push(
		await runPacer(
			standardLimits(8),
			null,
			null,
			Array.from({ length: 4 }, () => op("fred")),
		),
	);
	cases.push(
		await runPacer(standardLimits(8), null, null, [
			op("unknown-provider"),
			op("unknown-provider", 5),
		]),
	);
	cases.push(await runPacer(standardLimits(8), null, null, [op("twelve-data", null, 0, true)]));
	cases.push(
		await runPacer(
			standardLimits(2),
			null,
			1,
			Array.from({ length: 5 }, () => op("twelve-data")),
		),
	);
	cases.push(
		await runPacer(
			standardLimits(8),
			[
				["fred", 3],
				["jpx", 2],
			],
			null,
			[op("fred"), op("jpx"), op("finnhub")],
		),
	);
	cases.push(
		await runPacer(
			standardLimits(8),
			null,
			null,
			Array.from({ length: 40 }, () => op("google")),
		),
	);
	cases.push(
		await runPacer(standardLimits(8), null, null, [op("fred", 0), op("fred", 3), op("fred", 101)]),
	);
	// Multi-unit requests reserve all their units at once; more than the window takes the window.
	cases.push(
		await runPacer(standardLimits(8), null, null, [
			op("google", 3),
			op("google", 3),
			op("google", 2),
			op("google"),
			op("google", 7),
			op("google", 1),
		]),
	);
	// Daily budgets (Twelve Data Basic): refused at once when spent, a new count each UTC day.
	const admit = (provider: string, advanceMs = 0, abortBefore = false): PacerOp => ({
		...op(provider, null, advanceMs, abortBefore),
		admit: true,
	});
	cases.push(
		await runPacer(
			standardLimits(2),
			null,
			null,
			[
				admit("twelve-data"),
				admit("twelve-data"),
				admit("twelve-data"),
				admit("twelve-data"),
				op("twelve-data"),
				admit("twelve-data", 0, true),
				admit("twelve-data", 21 * 60 * 60 * 1000),
				admit("fred"),
			],
			[["twelve-data", 3]],
		),
	);
	cases.push(
		await runPacer(
			[],
			null,
			null,
			[admit("twelve-data"), op("twelve-data", 2), admit("twelve-data"), admit("google")],
			[["twelve-data", 2]],
		),
	);
	cases.push(
		await runPacer(
			standardLimits(1),
			null,
			2,
			Array.from({ length: 4 }, () => admit("twelve-data")),
			[["twelve-data", 800]],
		),
	);
	for (let index = 0; index < 300; index += 1) {
		const limits: LimitSpec[] = rng.chance(0.4)
			? standardLimits(rng.pick([1, 2, 8, 600]))
			: PROVIDERS.slice(0, rng.int(1, 5)).map((provider) => ({
					provider,
					maxPerWindow: rng.int(1, 5),
					windowMs: rng.pick([1, 10, 1000, 60_000]),
				}));
		const requestsPerSeries = rng.chance(0.3)
			? [["fred", rng.int(1, 3)] as const, ["finnhub", rng.int(1, 3)] as const]
			: null;
		const ops = Array.from({ length: rng.int(1, 14) }, () =>
			op(
				rng.pick(PROVIDERS),
				rng.chance(0.3) ? rng.int(0, 4) : null,
				rng.pick([0, 0, 1, 10, 999, 1000, 60_000, 100_000]),
				rng.chance(0.05),
			),
		);
		cases.push(
			await runPacer(limits, requestsPerSeries, rng.chance(0.2) ? rng.int(1, 4) : null, ops),
		);
	}
	return cases;
}

/* ---------- job harness ---------- */

type Thrown = { readonly throw: "Error" };

interface RecordedLog {
	readonly level: string;
	readonly event: string;
	readonly fields: unknown;
}

interface JobRecord {
	readonly states: readonly { readonly state: string; readonly at: string }[];
	readonly completion: unknown;
	readonly logs: readonly RecordedLog[];
	readonly sourceCalls: readonly unknown[];
	readonly pace: readonly unknown[];
	readonly sleeps: readonly number[];
	readonly reads: number;
}

interface JobSetup {
	readonly limits: readonly LimitSpec[];
	/** Request starts per UTC day by provider; absent: none. */
	readonly dailyBudgets?: readonly (readonly [string, number])[];
	/** Abort the run in the n-th sleep, source call or `beforeRequest` (1-based); null never. */
	readonly abortAt: { readonly where: "sleep" | "source" | "before"; readonly n: number } | null;
	readonly preAborted: boolean;
}

function recordingLogger(sink: RecordedLog[]): EventLogger {
	const write =
		(level: string) => (event: string, fields?: { readonly [key: string]: unknown }) => {
			sink.push({ level, event, fields: plain(fields ?? {}) });
		};
	return { info: write("info"), warn: write("warn"), error: write("error"), logFailures: () => 0 };
}

interface Harness {
	readonly clock: SharedClock;
	readonly shutdown: AbortController;
	readonly record: () => JobRecord;
	readonly pacer: MarketRequestPacer;
	readonly sourceCalls: unknown[];
	readonly logs: RecordedLog[];
	readonly bumpAbort: (where: "sleep" | "source" | "before") => void;
}

function harnessFor(setup: JobSetup): Harness {
	const clock = sharedClock();
	const shutdown = new AbortController();
	const counters = { sleep: 0, source: 0, before: 0 };
	const bumpAbort = (where: "sleep" | "source" | "before"): void => {
		counters[where] += 1;
		if (
			setup.abortAt !== null &&
			setup.abortAt.where === where &&
			setup.abortAt.n === counters[where]
		) {
			shutdown.abort();
		}
	};
	const sleeps: number[] = [];
	const pace: unknown[] = [];
	const inner = createMarketPacer({
		clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.advance(ms);
			bumpAbort("sleep");
		},
		limits: limitMap(setup.limits),
		...(setup.dailyBudgets === undefined ? {} : { dailyBudgets: budgetMap(setup.dailyBudgets) }),
	});
	const pacer: MarketRequestPacer = {
		async pace(provider, signal, requests) {
			const granted = await inner.pace(
				provider,
				signal,
				...(requests === undefined ? [] : [requests]),
			);
			pace.push({ provider, requests: requests ?? null, granted });
			return granted;
		},
		async admit(provider, signal) {
			const admission = await inner.admit(provider, signal);
			pace.push({ provider, admission });
			return admission;
		},
	};
	const logs: RecordedLog[] = [];
	const sourceCalls: unknown[] = [];
	return {
		clock,
		shutdown,
		pacer,
		sourceCalls,
		logs,
		bumpAbort,
		record: () => ({
			states: [],
			completion: null,
			logs,
			sourceCalls,
			pace,
			sleeps,
			reads: clock.reads(),
		}),
	};
}

/** Long observation lists are summarised as their length and both ends. */
function summarizeCompletion(completion: unknown): unknown {
	if (typeof completion !== "object" || completion === null || !("series" in completion))
		return completion;
	const { series } = completion as { series: { observations: unknown[] }[] };
	return {
		...completion,
		series: series.map((entry) =>
			entry.observations.length > 20
				? {
						...entry,
						observations: {
							length: entry.observations.length,
							digest: digestOf(entry.observations),
						},
					}
				: entry,
		),
	};
}

async function drive(
	job: ClaimedJob,
	setup: JobSetup,
	harness: Harness,
	wiring: {
		readonly marketSources?: Map<MarketProviderId, MarketSeriesSource>;
		readonly earningsSources?: Map<EarningsSourceId, EarningsCalendarSource>;
	},
): Promise<JobRecord> {
	const { api, calls } = createFakeApi();
	const base = createDeps(api);
	if (setup.preAborted) harness.shutdown.abort();
	await executeJob(
		job,
		{
			...base.deps,
			clock: harness.clock,
			logger: recordingLogger(harness.logs),
			marketPacer: harness.pacer,
			marketSources: wiring.marketSources ?? new Map(),
			earningsSources: wiring.earningsSources ?? new Map(),
		},
		harness.shutdown.signal,
	);
	const states = calls.events
		.flatMap((request) => request.events)
		.filter((entry) => entry.event.type === "state")
		.map((entry) => ({
			state: entry.event.type === "state" ? entry.event.state : "",
			at: entry.at,
		}));
	const aborted = harness.shutdown.signal.aborted;
	const completion: CompleteJobRequest | undefined = calls.completions[0];
	const recorded = harness.record();
	return {
		...recorded,
		states,
		// An aborted run's completion belongs to `executeJob`, not to the body.
		completion: aborted ? null : summarizeCompletion(plain(completion ?? null)),
		logs: recorded.logs.filter((line) => !line.event.startsWith("job_")),
	};
}

/* ---------- market-refresh cases ---------- */

type MarketAnswer =
	| { readonly ok: { readonly meta: unknown; readonly count: number } }
	| {
			readonly err: {
				readonly code: string;
				readonly reason: string;
				/** The provider's answer status the fake source reports (§4a); null when none. */
				readonly upstreamStatus: number | null;
			};
	  }
	| Thrown;

interface MarketCase {
	readonly kind: "market";
	readonly job: unknown;
	readonly setup: JobSetup;
	/** Provider -> scripted answers (one per call); absent = no registry entry; "unconfigured" = the real unconfigured source. */
	readonly sources: { readonly [provider: string]: readonly MarketAnswer[] | "unconfigured" };
	readonly output: JobRecord;
}

function claimBase(kind: ClaimedJob["kind"]): {
	kind: ClaimedJob["kind"];
	runId: string;
	leaseGeneration: number;
	leaseExpiresAt: string;
	attempt: number;
	heartbeatIntervalMs: number;
	sources: never[];
} {
	return {
		kind,
		runId: "run_jobs",
		leaseGeneration: 3,
		leaseExpiresAt: "2026-10-11T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
	};
}

const META = {
	title: "CBOE Volatility Index: VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis (FRED)",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
};

function observations(count: number): unknown[] {
	return Array.from({ length: count }, (_, index) => ({
		observedOn: new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
		value: index * 1.5,
	}));
}

function fakeMarketSource(
	provider: MarketProviderId,
	answers: readonly MarketAnswer[] | "unconfigured",
	harness: Harness,
): MarketSeriesSource | null {
	if (answers === "unconfigured") {
		return {
			providerId: provider,
			async fetchSeries(query) {
				harness.sourceCalls.push({
					provider,
					symbol: query.symbol,
					from: query.from,
					max: query.maxObservations,
					aborted: query.signal.aborted,
				});
				return err({
					code: "SOURCE_NOT_CONFIGURED",
					reason: "not configured",
					upstreamStatus: null,
				});
			},
		};
	}
	let index = 0;
	return {
		providerId: provider,
		async fetchSeries(query) {
			harness.sourceCalls.push({
				provider,
				symbol: query.symbol,
				from: query.from,
				max: query.maxObservations,
				aborted: query.signal.aborted,
			});
			// One admitted request per call, like the Twelve Data adapter (FRED's
			// one-or-two requests are pinned by the adapter vectors).
			const refused = await admitMarketRequest(query.beforeRequest, provider);
			if (refused !== null) return err(refused);
			harness.bumpAbort("source");
			const answer = answers[index];
			index += 1;
			if (answer === undefined) {
				return err({ code: "NO_DATA", reason: "script exhausted", upstreamStatus: null });
			}
			if ("throw" in answer) throw new Error("boom");
			if ("err" in answer) {
				return err({
					code: answer.err.code as never,
					reason: answer.err.reason,
					upstreamStatus: answer.err.upstreamStatus,
				});
			}
			return ok({
				meta: answer.ok.meta as never,
				observations: observations(answer.ok.count) as never,
			});
		},
	};
}

/** One claimed series (ADR-0044: the anchor the window must reproduce, the full-check flag). */
interface MarketClaimSeries {
	readonly seriesId: string;
	readonly latestObservedOn: string | null;
	readonly anchor: { readonly observedOn: string; readonly value: number } | null;
	readonly fullCheck: boolean;
}

type HistoryClaim = Pick<MarketClaimSeries, "anchor" | "fullCheck">;

/**
 * The claim's history request against the fake answers (`observations`:
 * day i from 2020-01-01 with value 1.5·i): nothing stored; an anchor the
 * answer reproduces (as a window or a due full check); one whose value
 * changed; one the answer lacks; and the oldest point, which an 801-point
 * answer loses to the per-response cut.
 */
const NO_HISTORY: HistoryClaim = { anchor: null, fullCheck: false };
const HELD: HistoryClaim = { anchor: { observedOn: "2020-01-02", value: 1.5 }, fullCheck: false };
const HELD_FULL: HistoryClaim = { ...HELD, fullCheck: true };
const CHANGED: HistoryClaim = { anchor: { observedOn: "2020-01-02", value: 2 }, fullCheck: false };
const MISSING: HistoryClaim = { anchor: { observedOn: "2026-10-01", value: 1 }, fullCheck: false };
const MISSING_FULL: HistoryClaim = { ...MISSING, fullCheck: true };
const OLDEST: HistoryClaim = { anchor: { observedOn: "2020-01-01", value: 0 }, fullCheck: false };
const HISTORY_CLAIMS: readonly HistoryClaim[] = [
	NO_HISTORY,
	NO_HISTORY,
	HELD,
	HELD_FULL,
	CHANGED,
	MISSING,
	MISSING_FULL,
	OLDEST,
];

async function runMarket(
	series: readonly MarketClaimSeries[],
	setup: JobSetup,
	sources: MarketCase["sources"],
): Promise<MarketCase> {
	const harness = harnessFor(setup);
	const registry = new Map<MarketProviderId, MarketSeriesSource>();
	for (const [provider, answers] of Object.entries(sources)) {
		const source = fakeMarketSource(provider as MarketProviderId, answers, harness);
		if (source !== null) registry.set(provider as MarketProviderId, source);
	}
	const job = { ...claimBase("market-refresh"), series } as unknown as ClaimedJob;
	const output = await drive(job, setup, harness, { marketSources: registry });
	return { kind: "market", job: plain(job), setup, sources, output };
}

const SERIES_IDS = [
	"fred:VIXCLS",
	"fred:CPIAUCSL",
	"fred:A",
	"twelve-data:AAPL",
	"twelve-data:7203:JPX",
	"twelve-data:EUR/USD",
	"twelve-data:BRK.B",
	"bogus",
	"fred:lower",
	"fred:",
	":x",
	"twelve-data:",
	`fred:${"A".repeat(26)}`,
	"unknown:X",
	"twelve-data:A:B",
	"twelve-data:AAPL:N",
];

/**
 * The upstream status a fake source reports with each code. Derived from the
 * code (no extra random draw) so the rest of the generated cases stay put;
 * 529 is a status no mapping table names, NO_DATA comes with none.
 */
const SPEC_STATUS: { readonly [code: string]: number } = {
	RATE_LIMITED: 429,
	SOURCE_FAILED: 529,
	SERIES_NOT_FOUND: 404,
	SOURCE_AUTH_FAILED: 401,
	PLAN_NOT_ENTITLED: 403,
};

function marketAnswer(rng: Rng): MarketAnswer {
	const roll = rng.float();
	if (roll < 0.55) {
		return { ok: { meta: META, count: rng.pick([0, 1, 5, 12, 800, 801, 805]) } };
	}
	if (roll < 0.9) {
		const code = rng.pick([
			"RATE_LIMITED",
			"SOURCE_FAILED",
			"NO_DATA",
			"SERIES_NOT_FOUND",
			"SOURCE_AUTH_FAILED",
			"PLAN_NOT_ENTITLED",
		]);
		return { err: { code, reason: "fixed reason", upstreamStatus: SPEC_STATUS[code] ?? null } };
	}
	return { throw: "Error" };
}

async function marketCases(): Promise<MarketCase[]> {
	const rng = new Rng(0x3a4b);
	const cases: MarketCase[] = [];
	const noLimits: LimitSpec[] = [];
	const quiet: JobSetup = { limits: noLimits, abortAt: null, preAborted: false };
	const ok1: MarketAnswer = { ok: { meta: META, count: 3 } };
	// The families of marketRefresh.test.ts.
	cases.push(
		await runMarket(
			[
				{ seriesId: "fred:VIXCLS", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:AAPL", latestObservedOn: "2026-10-01", ...HELD },
			],
			quiet,
			{},
		),
	);
	cases.push(
		await runMarket(
			[
				{ seriesId: "fred:VIXCLS", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:AAPL", latestObservedOn: "2026-10-01", ...HELD },
			],
			quiet,
			{ fred: "unconfigured", "twelve-data": "unconfigured" },
		),
	);
	cases.push(
		await runMarket(
			[
				{ seriesId: "fred:VIXCLS", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:AAPL", latestObservedOn: "2026-10-01", ...HELD },
			],
			quiet,
			{ fred: [ok1] },
		),
	);
	cases.push(
		await runMarket(
			[
				{ seriesId: "fred:VIXCLS", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:AAPL", latestObservedOn: "2026-10-01", ...HELD },
			],
			quiet,
			{
				fred: [{ err: { code: "RATE_LIMITED", reason: "limited", upstreamStatus: 429 } }],
				"twelve-data": [{ throw: "Error" }],
			},
		),
	);
	cases.push(
		await runMarket([{ seriesId: "bogus", latestObservedOn: null, ...NO_HISTORY }], quiet, {
			fred: [ok1],
		}),
	);
	cases.push(
		await runMarket(
			[{ seriesId: "fred:VIXCLS", latestObservedOn: null, ...NO_HISTORY }],
			{ ...quiet, preAborted: true },
			{ fred: [ok1] },
		),
	);
	cases.push(await runMarket([], quiet, { fred: [ok1] }));
	// ADR-0044: every history branch, one series each, against a 5-point answer.
	const ok5: MarketAnswer = { ok: { meta: META, count: 5 } };
	for (const history of [HELD, HELD_FULL, CHANGED, MISSING, MISSING_FULL, OLDEST, NO_HISTORY]) {
		cases.push(
			await runMarket(
				[{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01", ...history }],
				quiet,
				{ fred: [ok5, ok5] },
			),
		);
	}
	// The anchor changed and the full refetch fails: an error entry, no history.
	cases.push(
		await runMarket(
			[{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01", ...CHANGED }],
			quiet,
			{
				fred: [ok5, { err: { code: "RATE_LIMITED", reason: "limited", upstreamStatus: 429 } }],
			},
		),
	);
	cases.push(
		await runMarket(
			[{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01", ...CHANGED }],
			quiet,
			{
				fred: [ok5, { throw: "Error" }],
			},
		),
	);
	// The full refetch answers nothing: a plain merge (no history write).
	cases.push(
		await runMarket(
			[{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01", ...CHANGED }],
			quiet,
			{
				fred: [ok5, { ok: { meta: META, count: 0 } }],
			},
		),
	);
	// An abort after the window answer: the refetch is never sent.
	cases.push(
		await runMarket(
			[
				{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01", ...CHANGED },
				{ seriesId: "twelve-data:AAPL", latestObservedOn: null, ...NO_HISTORY },
			],
			{ ...quiet, abortAt: { where: "source", n: 1 } },
			{ fred: [ok5, ok5], "twelve-data": [ok5] },
		),
	);
	// Both requests of a revised series pace through the provider's window.
	cases.push(
		await runMarket(
			[
				{ seriesId: "twelve-data:AAPL", latestObservedOn: "2026-10-01", ...CHANGED },
				{ seriesId: "twelve-data:MSFT", latestObservedOn: "2026-10-01", ...HELD },
			],
			{ limits: standardLimits(1), abortAt: null, preAborted: false },
			{ "twelve-data": [ok5, ok5, ok5] },
		),
	);
	// A series claimed twice is fetched once and reported once (first wins).
	cases.push(
		await runMarket(
			[
				{ seriesId: "fred:VIXCLS", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:AAPL", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01", ...HELD },
			],
			quiet,
			{ fred: [ok5, ok5], "twelve-data": [ok5] },
		),
	);
	// 801 points lose the oldest to the cut, so that anchor is missing.
	cases.push(
		await runMarket(
			[{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01", ...OLDEST }],
			quiet,
			{
				fred: [{ ok: { meta: META, count: 801 } }, { ok: { meta: META, count: 801 } }],
			},
		),
	);
	// 60 series under the standard limits: one grant per request sent.
	const sixty = Array.from({ length: 60 }, (_, index) => ({
		seriesId: index % 2 === 0 ? `fred:S${index}` : `twelve-data:T${index}`,
		latestObservedOn: index % 3 === 0 ? "2026-09-01" : null,
		...(HISTORY_CLAIMS[index % HISTORY_CLAIMS.length] ?? NO_HISTORY),
	}));
	cases.push(
		await runMarket(
			sixty,
			{ limits: standardLimits(8), abortAt: null, preAborted: false },
			{
				fred: Array.from({ length: 30 }, () => ok1),
				"twelve-data": Array.from({ length: 30 }, () => ok1),
			},
		),
	);
	// Twelve Data's daily budget: spent after two starts, the rest fail as RATE_LIMITED (429)
	// without being sent, also the full refetch of a revised series; FRED is unaffected.
	cases.push(
		await runMarket(
			[
				{ seriesId: "twelve-data:AAPL", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:MSFT", latestObservedOn: "2026-10-01", ...CHANGED },
				{ seriesId: "fred:VIXCLS", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:EUR/USD", latestObservedOn: null, ...NO_HISTORY },
			],
			{
				limits: standardLimits(8),
				dailyBudgets: [["twelve-data", 2]],
				abortAt: null,
				preAborted: false,
			},
			{ "twelve-data": [ok5, ok5, ok5], fred: [ok5] },
		),
	);
	cases.push(
		await runMarket(
			[
				{ seriesId: "twelve-data:AAPL", latestObservedOn: null, ...NO_HISTORY },
				{ seriesId: "twelve-data:MSFT", latestObservedOn: null, ...NO_HISTORY },
			],
			{ limits: [], dailyBudgets: [["twelve-data", 0]], abortAt: null, preAborted: true },
			{ "twelve-data": [ok5, ok5] },
		),
	);
	for (let index = 0; index < 400; index += 1) {
		const count = rng.int(0, 8);
		const series = Array.from({ length: count }, () => ({
			seriesId: rng.pick(SERIES_IDS),
			latestObservedOn: rng.pick([null, null, "2026-10-01", "2026-02-28"]),
			...rng.pick(HISTORY_CLAIMS),
		}));
		const sources: { [provider: string]: MarketAnswer[] | "unconfigured" } = {};
		for (const provider of ["fred", "twelve-data"]) {
			const roll = rng.float();
			if (roll < 0.1) continue;
			sources[provider] =
				roll < 0.2 ? "unconfigured" : Array.from({ length: 8 }, () => marketAnswer(rng));
		}
		const limits = rng.chance(0.5) ? standardLimits(rng.pick([1, 2, 8])) : noLimits;
		const abortAt = rng.chance(0.25)
			? { where: rng.pick(["sleep", "source"] as const), n: rng.int(1, 4) }
			: null;
		cases.push(await runMarket(series, { limits, abortAt, preAborted: rng.chance(0.04) }, sources));
	}
	return cases;
}

/* ---------- earnings-refresh cases ---------- */

type EarningsResultSpec =
	| { readonly ok: { readonly name: string | null; readonly events: readonly unknown[] } }
	| {
			readonly err: {
				readonly code: string;
				readonly name?: string | null;
				/** The provider's answer status the fake source reports (§4a); absent with a name. */
				readonly upstreamStatus?: number | null;
			};
	  };

type EarningsAnswer =
	| { readonly results: readonly EarningsResultSpec[]; readonly beforePerStock: readonly number[] }
	| Thrown;

interface EarningsCase {
	readonly kind: "earnings";
	readonly job: unknown;
	readonly setup: JobSetup;
	/** Source -> scripted answers (one per call); absent = no registry entry; "unconfigured" = the real unconfigured source; "real-finnhub" = the real adapter over `fetchScript`. */
	readonly sources: {
		readonly [source: string]: readonly EarningsAnswer[] | "unconfigured" | "real-finnhub";
	};
	readonly fetchScript: readonly ScriptEntry[] | null;
	readonly output: JobRecord;
}

const EVENT = {
	periodKey: "2026-q4",
	announcementDate: "2026-10-29",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
};

function fakeEarningsSource(
	sourceId: EarningsSourceId,
	answers: readonly EarningsAnswer[],
	harness: Harness,
): EarningsCalendarSource {
	let index = 0;
	return {
		sourceId,
		async fetchEarnings(query) {
			harness.sourceCalls.push({
				source: sourceId,
				stocks: query.stocks.map((stock) => ({ symbol: stock.symbol, needName: stock.needName })),
				fromDate: query.fromDate,
				toDate: query.toDate,
			});
			const answer = answers[index];
			index += 1;
			if (answer === undefined) return [];
			if ("throw" in answer) throw new Error("boom");
			// The per-stock hook calls, like an adapter taking one grant per request.
			const hooks: boolean[] = [];
			for (const [position] of query.stocks.entries()) {
				const calls = answer.beforePerStock[position] ?? 0;
				for (let call = 0; call < calls; call += 1) {
					harness.bumpAbort("before");
					const granted = await query.beforeRequest();
					hooks.push(granted);
					if (!granted) break;
				}
			}
			harness.sourceCalls.push({ source: sourceId, hooks });
			return answer.results.map((spec): EarningsSourceResult => {
				if ("ok" in spec) return ok({ name: spec.ok.name, events: spec.ok.events as never });
				return spec.err.name === undefined
					? err({ code: spec.err.code as never, upstreamStatus: spec.err.upstreamStatus ?? null })
					: err({ code: "NO_SCHEDULED_DATE", name: spec.err.name });
			});
		},
	};
}

async function runEarnings(
	stocks: readonly { stockId: string; name: string | null }[],
	setup: JobSetup,
	sources: EarningsCase["sources"],
	fetchScript: readonly ScriptEntry[] | null,
): Promise<EarningsCase> {
	const harness = harnessFor(setup);
	const registry = new Map<EarningsSourceId, EarningsCalendarSource>();
	for (const [sourceId, answers] of Object.entries(sources)) {
		if (answers === "unconfigured") {
			registry.set(
				sourceId as EarningsSourceId,
				unconfiguredEarningsCalendarSource(sourceId as EarningsSourceId),
			);
		} else if (answers === "real-finnhub") {
			const events: FetchEvent[] = [];
			registry.set(
				"finnhub",
				createFinnhubEarningsSource({
					apiKey: "test-key",
					fetcher: scriptedFetcher(fetchScript ?? [], events),
				}),
			);
		} else {
			registry.set(
				sourceId as EarningsSourceId,
				fakeEarningsSource(sourceId as EarningsSourceId, answers, harness),
			);
		}
	}
	const job = {
		...claimBase("earnings-refresh"),
		fromDate: "2026-10-11",
		toDate: "2027-04-14",
		stocks,
	} as unknown as ClaimedJob;
	const output = await drive(job, setup, harness, { earningsSources: registry });
	return { kind: "earnings", job: plain(job), setup, sources, fetchScript, output };
}

const STOCK_IDS = [
	"us:AAPL",
	"us:MSFT",
	"us:BRK.B",
	"jp:7203",
	"jp:130A",
	"jp:9984",
	"us:aapl",
	"xx:1",
	"us:",
	"jp:12345",
	"us:AAPL",
	"nothing",
	":AAPL",
];

function earningsResult(rng: Rng): EarningsResultSpec {
	const roll = rng.float();
	if (roll < 0.45) {
		return {
			ok: {
				name: rng.pick([null, "Apple Inc", "Toyota Motor Corp."]),
				events: rng.chance(0.8)
					? [EVENT]
					: Array.from({ length: 10 }, (_, i) => ({ ...EVENT, periodKey: `p${i}` })),
			},
		};
	}
	if (roll < 0.6)
		return { err: { code: "NO_SCHEDULED_DATE", name: rng.pick([null, "Apple Inc"]) } };
	const code = rng.pick([
		"SYMBOL_NOT_FOUND",
		"SOURCE_FAILED",
		"RATE_LIMITED",
		"SOURCE_AUTH_FAILED",
		"PLAN_NOT_ENTITLED",
	]);
	return { err: { code, upstreamStatus: SPEC_STATUS[code] ?? null } };
}

function earningsAnswer(rng: Rng, expected: number): EarningsAnswer {
	if (rng.chance(0.06)) return { throw: "Error" };
	const length = rng.chance(0.9) ? expected : Math.max(0, expected + rng.pick([-1, 1, 2]));
	return {
		results: Array.from({ length }, () => earningsResult(rng)),
		beforePerStock: Array.from({ length: Math.max(expected, length) }, () =>
			rng.pick([0, 1, 1, 2]),
		),
	};
}

async function earningsCases(): Promise<EarningsCase[]> {
	const rng = new Rng(0xea41);
	const cases: EarningsCase[] = [];
	const quiet: JobSetup = { limits: [], abortAt: null, preAborted: false };
	const mixed = [
		{ stockId: "us:AAPL", name: null },
		{ stockId: "us:MSFT", name: "Microsoft Corp." },
		{ stockId: "jp:7203", name: null },
	];
	cases.push(await runEarnings(mixed, quiet, {}, null));
	cases.push(
		await runEarnings(mixed, quiet, { finnhub: "unconfigured", jpx: "unconfigured" }, null),
	);
	cases.push(
		await runEarnings(
			mixed,
			quiet,
			{
				finnhub: [
					{
						results: [
							{ ok: { name: "Apple Inc", events: [EVENT] } },
							{ err: { code: "SYMBOL_NOT_FOUND" } },
						],
						beforePerStock: [1, 1],
					},
				],
				jpx: [
					{
						results: [
							{
								ok: {
									name: "Toyota Motor Corp.",
									events: [{ ...EVENT, periodKey: "fy2027-03-31-second-quarter" }],
								},
							},
						],
						beforePerStock: [1],
					},
				],
			},
			null,
		),
	);
	// The real adapter: two stocks needing names against a 3-per-minute window.
	const realScript = (symbols: readonly string[]): ScriptEntry[] =>
		symbols.flatMap((symbol) => [
			{ text: JSON.stringify({ name: `${symbol} Inc`, ticker: symbol }) },
			{
				text: JSON.stringify({
					earningsCalendar: [{ date: "2026-10-29", hour: "amc", quarter: 4, symbol, year: 2026 }],
				}),
			},
		]);
	cases.push(
		await runEarnings(
			["AAPL", "MSFT"].map((symbol) => ({ stockId: `us:${symbol}`, name: null })),
			{
				limits: [{ provider: "finnhub", maxPerWindow: 3, windowMs: 60_000 }],
				abortAt: null,
				preAborted: false,
			},
			{ finnhub: "real-finnhub" },
			realScript(["AAPL", "MSFT"]),
		),
	);
	const fifty = Array.from({ length: 50 }, (_, index) => `T${index}`);
	cases.push(
		await runEarnings(
			fifty.map((symbol) => ({ stockId: `us:${symbol}`, name: null })),
			{
				limits: [{ provider: "finnhub", maxPerWindow: 30, windowMs: 60_000 }],
				abortAt: null,
				preAborted: false,
			},
			{ finnhub: "real-finnhub" },
			realScript(fifty),
		),
	);
	cases.push(
		await runEarnings(
			mixed,
			{ limits: [], abortAt: null, preAborted: true },
			{ finnhub: [{ results: [], beforePerStock: [] }] },
			null,
		),
	);
	for (let index = 0; index < 400; index += 1) {
		const count = rng.int(0, 7);
		const stocks = Array.from({ length: count }, () => ({
			stockId: rng.pick(STOCK_IDS),
			name: rng.pick([null, null, "Known Name"]),
		}));
		// The groups the body will form, to size the scripted batches.
		const sizes = { finnhub: 0, jpx: 0 };
		for (const stock of stocks) {
			if (/^us:[A-Z][A-Z0-9.-]{0,9}$/.test(stock.stockId)) sizes.finnhub += 1;
			else if (/^jp:[0-9][0-9A-Z]{3}$/.test(stock.stockId)) sizes.jpx += 1;
		}
		const sources: { [source: string]: EarningsAnswer[] | "unconfigured" } = {};
		for (const source of ["finnhub", "jpx"] as const) {
			const roll = rng.float();
			if (roll < 0.1) continue;
			sources[source] = roll < 0.2 ? "unconfigured" : [earningsAnswer(rng, sizes[source])];
		}
		const limits = rng.chance(0.5) ? standardLimits(8) : [];
		const abortAt = rng.chance(0.25)
			? { where: rng.pick(["sleep", "before"] as const), n: rng.int(1, 4) }
			: null;
		cases.push(
			await runEarnings(stocks, { limits, abortAt, preAborted: rng.chance(0.04) }, sources, null),
		);
	}
	return cases;
}

export async function jobsFiles(): Promise<{ path: string; content: unknown }[]> {
	return [
		{ path: "finance/pacing.json", content: await pacerCases() },
		{ path: "finance/jobs_market.json", content: await marketCases() },
		{ path: "finance/jobs_earnings.json", content: await earningsCases() },
	];
}
