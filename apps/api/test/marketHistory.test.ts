import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import type { MarketCompletionSeries } from "@research/application";
import {
	homeDataResponseSchema,
	MARKET_LIMITS,
	researchRunResponseSchema,
} from "@research/contracts";
import {
	HISTORY_FULL_CHECK_DAYS,
	HISTORY_OVERLAP_OBSERVATIONS,
	type HistoryPoint,
	type HistoryWrite,
	mergeHistory,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	claim,
	createHarness,
	errorCode,
	type Harness,
	idempotencyKey,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/**
 * ADR-0044 §3 through the routes on real persistence (workerd D1 and
 * `node:sqlite`): the claim carries each series' history anchor and full-check
 * flag, the completion's `history` write replaces only what the answer
 * covers, the page reads the result, and a completion from a runner before
 * ADR-0044 (no `history`) is still accepted and only merges.
 */

const VIX_META = {
	title: "VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis (FRED)",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
} as const;

const DAY_MS = 86_400_000;
/**
 * The runner's clock runs a year ahead of the API's in these completions:
 * the full-check stamp must still be the API's time, or the next full check
 * would wait a year (ADR-0044 §3, write step 4).
 */
const RUNNER_CLOCK_AHEAD_MS = 365 * DAY_MS;

type Observation = readonly [string, number];

/** `count` daily observations from 2026-01-01, value = index. */
function daily(count: number): Observation[] {
	const start = Date.UTC(2026, 0, 1);
	return Array.from({ length: count }, (_, index) => [
		new Date(start + index * DAY_MS).toISOString().slice(0, 10),
		index,
	]);
}

async function trackVix(harness: Harness): Promise<void> {
	const saved = await harness.call("PUT", "/home/dashboard", {
		dashboard: {
			schemaVersion: 2,
			widgets: [
				{
					type: "market-metric",
					widgetId: "w-vix",
					title: "VIX",
					size: "small",
					seriesId: "fred:VIXCLS",
				},
			],
		},
		expectedVersion: 0,
	});
	expect(saved.status).toBe(200);
}

/** Queues a refresh, claims it and moves it to publishing. */
async function claimRefresh(harness: Harness, token: string) {
	const queued = await harness.call("POST", "/home/refresh", undefined, idempotencyKey());
	expect(queued.status).toBe(202);
	const runId = (await body(queued, researchRunResponseSchema)).run.runId;
	const job = await claim(harness, token);
	if (job?.kind !== "market-refresh" || job.runId !== runId) {
		throw new Error("expected the market-refresh job");
	}
	await advanceToPublishing(harness, token, job);
	return job;
}

async function complete(
	harness: Harness,
	token: string,
	job: { readonly runId: string; readonly leaseGeneration: number },
	observations: readonly Observation[],
	history: unknown,
): Promise<Response> {
	return harness.runner(token, `/jobs/${job.runId}/complete`, {
		outcome: "market-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: USAGE,
		series: [
			{
				seriesId: "fred:VIXCLS",
				fetchedAt: new Date(harness.time.clock.nowMs() + RUNNER_CLOCK_AHEAD_MS).toISOString(),
				meta: { ...VIX_META },
				observations: [...observations],
				errorCode: null,
				...(history === undefined ? {} : { history }),
			},
		],
	});
}

async function vixObservations(harness: Harness) {
	const data = await body(await harness.call("GET", "/home/data"), homeDataResponseSchema);
	return data.series.find((entry) => entry.seriesId === "fred:VIXCLS")?.observations;
}

describe("incremental market history (ADR-0044)", () => {
	it("claims with an anchor, stores a window write and fetches in full again after 7 days", async () => {
		const harness = createHarness();
		await trackVix(harness);
		const token = await issueRunnerToken(harness);

		// First refresh: nothing stored, so no anchor and no full check.
		const first = await claimRefresh(harness, token);
		expect(first.series).toEqual([
			{ seriesId: "fred:VIXCLS", latestObservedOn: null, anchor: null, fullCheck: false },
		]);
		const history = daily(40);
		const full = await complete(harness, token, first, history, {
			mode: "full",
			replaceFrom: null,
		});
		expect(full.status).toBe(200);
		expect(await vixObservations(harness)).toEqual(history);
		const checked = await env.DB.prepare(
			"SELECT history_checked_at AS at, last_refreshed_at AS refreshed FROM market_series WHERE owner_id = ? AND series_id = 'fred:VIXCLS'",
		)
			.bind(harness.ownerId)
			.first<{ at: string | null; refreshed: string | null }>();
		// The API's completion time, not the runner's (a year ahead) fetchedAt.
		expect(checked?.at).toBe(harness.time.clock.nowIso());
		expect(checked?.refreshed).toBe(
			new Date(harness.time.clock.nowMs() + RUNNER_CLOCK_AHEAD_MS).toISOString(),
		);
		const etag = (await harness.call("GET", "/home/data")).headers.get("ETag");
		expect(etag).not.toBeNull();

		// Second refresh, an hour later: the anchor is the 32nd newest row and
		// the full check is not due.
		harness.time.advance(60 * 60 * 1000);
		const second = await claimRefresh(harness, token);
		const anchor = history[history.length - HISTORY_OVERLAP_OBSERVATIONS];
		if (anchor === undefined) throw new Error("fixture too short");
		expect(second.series).toEqual([
			{
				seriesId: "fred:VIXCLS",
				latestObservedOn: history.at(-1)?.[0] ?? null,
				anchor: { observedOn: anchor[0], value: anchor[1] },
				fullCheck: false,
			},
		]);
		// The window answer from the anchor withdraws one point, revises one
		// and adds a new day.
		const withdrawn = history[35]?.[0];
		const revised = history[38]?.[0];
		const answered: Observation[] = [
			...history
				.slice(history.length - HISTORY_OVERLAP_OBSERVATIONS)
				.filter(([on]) => on !== withdrawn),
			["2026-02-10", 99],
		];
		const window = answered.map(
			([on, value]): Observation => [on, on === revised ? value + 0.5 : value],
		);
		const windowed = await complete(harness, token, second, window, {
			mode: "window",
			replaceFrom: anchor[0],
		});
		expect(windowed.status).toBe(200);
		expect(await vixObservations(harness)).toEqual([
			...history.slice(0, history.length - HISTORY_OVERLAP_OBSERVATIONS),
			...window,
		]);
		// The page sees the change: the ETag moved with the completion.
		const reread = await harness.call("GET", "/home/data", undefined, {
			"If-None-Match": etag ?? "",
		});
		expect(reread.status).toBe(200);
		expect(reread.headers.get("ETag")).not.toBe(etag);
		// A window write leaves the full-fetch stamp alone, so…
		harness.time.advance(HISTORY_FULL_CHECK_DAYS * DAY_MS);
		const third = await claimRefresh(harness, token);
		// …7 days (API time) after the full fetch the series is due a full
		// check again, however far ahead the runner's clock was.
		expect(third.series[0]?.fullCheck).toBe(true);
	});

	it("accepts a completion without history (a runner from before ADR-0044) and only merges", async () => {
		const harness = createHarness();
		await trackVix(harness);
		const token = await issueRunnerToken(harness);
		const first = await claimRefresh(harness, token);
		expect(
			(
				await complete(harness, token, first, daily(3), {
					mode: "full",
					replaceFrom: null,
				})
			).status,
		).toBe(200);
		harness.time.advance(60 * 60 * 1000);
		const second = await claimRefresh(harness, token);
		const legacy = await complete(harness, token, second, [["2026-01-05", 7]], undefined);
		expect(legacy.status).toBe(200);
		expect(await vixObservations(harness)).toEqual([...daily(3), ["2026-01-05", 7]]);
	});

	it("refuses a history write whose replaceFrom is not an answered date", async () => {
		const harness = createHarness();
		await trackVix(harness);
		const token = await issueRunnerToken(harness);
		const job = await claimRefresh(harness, token);
		const refused = await complete(harness, token, job, daily(3), {
			mode: "window",
			replaceFrom: "2025-12-31",
		});
		expect(refused.status).toBe(400);
		expect(await errorCode(refused)).toBe("VALIDATION_FAILED");
	});

	it("stores a maximal completion (60 series x 800 points) in one batch as mergeHistory describes", async () => {
		const harness = createHarness();
		await trackVix(harness);
		const token = await issueRunnerToken(harness);
		const job = await claimRefresh(harness, token);
		const version = await env.DB.prepare(
			"SELECT version FROM research_jobs WHERE owner_id = ? AND run_id = ?",
		)
			.bind(harness.ownerId, job.runId)
			.first<{ version: number }>();
		if (version === null) throw new Error("job row missing");
		const day = (offset: number) =>
			new Date(Date.UTC(2020, 0, 1) + offset * DAY_MS).toISOString().slice(0, 10);
		const ids = Array.from({ length: MARKET_LIMITS.maxTrackedSeries }, (_, s) => `fred:S${s}`);
		const stored = (s: number): HistoryPoint[] =>
			Array.from({ length: MARKET_LIMITS.maxStoredObservations }, (_, index) => ({
				observedOn: day(index),
				value: index + s,
			}));
		for (const [s, seriesId] of ids.entries()) {
			await env.DB.prepare(
				`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
				SELECT ?, ?, json_extract(value, '$.observedOn'), json_extract(value, '$.value') FROM json_each(?)`,
			)
				.bind(harness.ownerId, seriesId, JSON.stringify(stored(s)))
				.run();
		}
		const fetched = (s: number): HistoryPoint[] =>
			Array.from({ length: MARKET_LIMITS.maxObservationsPerResponse }, (_, index) => ({
				observedOn: day(900 + index * 2),
				value: 900 + index * 2 + s + (index % 3 === 0 ? 0.5 : 0),
			}));
		const write = (s: number): HistoryWrite =>
			s % 2 === 0 ? { mode: "full", replaceFrom: null } : { mode: "window", replaceFrom: day(900) };
		const series: MarketCompletionSeries[] = ids.map((seriesId, s) => ({
			seriesId,
			provider: "fred",
			symbol: seriesId.slice(5),
			fetchedAt: harness.time.clock.nowIso(),
			meta: { ...VIX_META },
			observations: fetched(s),
			errorCode: null,
			upstreamStatus: null,
			history: write(s),
		}));
		const outcome = await createD1Adapters(env.DB).unitOfWork.commitCompletion(
			harness.ownerId,
			{
				runId: job.runId,
				expectedVersion: version.version,
				patch: { state: "completed" },
				audits: [],
				at: harness.time.clock.nowIso(),
			},
			{
				bundle: null,
				articles: [],
				sourceReports: [],
				workspace: null,
				assistantMessage: null,
				marketSeries: series,
				earnings: [],
				google: null,
				notebook: null,
				notebookTurn: null,
				stockDirectory: null,
			},
		);
		expect(outcome.kind).toBe("committed");
		for (const [s, seriesId] of ids.entries()) {
			const { results } = await env.DB.prepare(
				"SELECT observed_on AS observedOn, value FROM market_observations WHERE owner_id = ? AND series_id = ? ORDER BY observed_on",
			)
				.bind(harness.ownerId, seriesId)
				.all<HistoryPoint>();
			expect(results).toEqual(
				mergeHistory(stored(s), fetched(s), write(s), MARKET_LIMITS.maxStoredObservations),
			);
		}
	});
});
