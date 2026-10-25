import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import {
	homeDataResponseSchema,
	researchRunResponseSchema,
	watchlistResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	apiError,
	body,
	type ClaimedLease,
	claim,
	createHarness,
	idempotencyKey,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/**
 * ADR-0039 decision 1: `POST /home/refresh` and `POST /watchlist/refresh`
 * take an optional `{ scope }`. These run the use cases through the routes
 * on real persistence (workerd D1 and `node:sqlite`): what is stored, what
 * the runner's claim carries, the widening of a queued partial job and the
 * scope in the idempotency fingerprint.
 */

type Harness = ReturnType<typeof createHarness>;

const VIX_META = {
	title: "VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis (FRED)",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
} as const;

const TRACKED = ["fred:VIXCLS", "fred:DGS10", "twelve-data:AAPL"] as const;

async function trackThreeSeries(harness: Harness): Promise<void> {
	const response = await harness.call("PUT", "/home/dashboard", {
		dashboard: {
			schemaVersion: 2,
			widgets: TRACKED.map((seriesId, index) => ({
				type: "market-metric",
				widgetId: `w-${index}`,
				title: `Widget ${index}`,
				size: "small",
				seriesId,
			})),
		},
		expectedVersion: 0,
	});
	expect(response.status).toBe(200);
}

/** Queues a refresh; `scope` undefined sends no body at all. */
async function queue(
	harness: Harness,
	path: "/home/refresh" | "/watchlist/refresh",
	scope?: string,
	key: Record<string, string> = idempotencyKey(),
): Promise<Response> {
	return harness.call("POST", path, scope === undefined ? undefined : { scope }, key);
}

async function queuedRunId(response: Response): Promise<string> {
	expect(response.status).toBe(202);
	return (await body(response, researchRunResponseSchema)).run.runId;
}

async function storedJob(
	harness: Harness,
	runId: string,
): Promise<{ readonly request_json: string | null; readonly state: string }> {
	const row = await env.DB.prepare(
		"SELECT request_json, state FROM research_jobs WHERE owner_id = ? AND run_id = ?",
	)
		.bind(harness.ownerId, runId)
		.first<{ request_json: string | null; state: string }>();
	if (row === null) throw new Error(`no stored job ${runId}`);
	return row;
}

async function auditActions(harness: Harness, runId: string): Promise<string[]> {
	const rows = await env.DB.prepare(
		"SELECT action FROM audit_log WHERE owner_id = ? AND resource = ? ORDER BY audit_id",
	)
		.bind(harness.ownerId, runId)
		.all<{ action: string }>();
	return rows.results.map((row) => row.action);
}

async function auditDetails(harness: Harness, runId: string): Promise<string[]> {
	const rows = await env.DB.prepare(
		"SELECT detail FROM audit_log WHERE owner_id = ? AND resource = ? ORDER BY audit_id",
	)
		.bind(harness.ownerId, runId)
		.all<{ detail: string }>();
	return rows.results.map((row) => row.detail);
}

/**
 * A harness for the same owner whose job INSERT first lets a second request
 * queue an `"unrefreshed"` job: the race where a request for everything
 * found no active job but loses the insert to a narrow one.
 */
function racingHarness(
	harness: Harness,
	path: "/home/refresh" | "/watchlist/refresh",
): { readonly harness: Harness; readonly narrowRunId: () => string | null } {
	const persistence = createD1Adapters(env.DB);
	let narrowRunId: string | null = null;
	const racing = createHarness({
		ownerId: harness.ownerId,
		time: harness.time,
		persistence: {
			...persistence,
			jobs: {
				...persistence.jobs,
				insert: async (job, idempotencyKeyValue, fingerprint, maxUnfinished) => {
					if (narrowRunId === null) {
						narrowRunId = await queuedRunId(await queue(harness, path, "unrefreshed"));
					}
					return persistence.jobs.insert(job, idempotencyKeyValue, fingerprint, maxUnfinished);
				},
			},
		},
	});
	return { harness: racing, narrowRunId: () => narrowRunId };
}

async function claimMarketSeries(harness: Harness, token: string) {
	const job = await claim(harness, token);
	if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
	return { job, ids: job.series.map((entry) => entry.seriesId) };
}

async function claimEarningsStocks(harness: Harness, token: string) {
	const job = await claim(harness, token);
	if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
	return { job, ids: job.stocks.map((entry) => entry.stockId) };
}

/**
 * One whole refresh that stores VIXCLS only: afterwards VIXCLS has data and
 * a stamp, AAPL a failure stamp without observations, DGS10 nothing.
 * Returns the completed run's id.
 */
async function refreshVixOnly(harness: Harness, token: string): Promise<string> {
	const runId = await queuedRunId(await queue(harness, "/home/refresh", "all"));
	const { job } = await claimMarketSeries(harness, token);
	await advanceToPublishing(harness, token, job);
	const completed = await harness.runner(token, `/jobs/${runId}/complete`, {
		outcome: "market-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: USAGE,
		series: [
			{
				seriesId: "fred:VIXCLS",
				fetchedAt: harness.time.clock.nowIso(),
				meta: { ...VIX_META },
				observations: [["2026-10-02", 15.8]],
				errorCode: null,
			},
			{
				seriesId: "twelve-data:AAPL",
				fetchedAt: harness.time.clock.nowIso(),
				meta: null,
				observations: [],
				errorCode: "SOURCE_NOT_CONFIGURED",
			},
		],
	});
	expect(completed.status).toBe(200);
	return runId;
}

/** Completes a claimed market run with nothing stored. */
async function completeEmptyMarketRun(
	harness: Harness,
	token: string,
	job: ClaimedLease,
): Promise<void> {
	await advanceToPublishing(harness, token, job);
	const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
		outcome: "market-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: USAGE,
		series: [],
	});
	expect(completed.status).toBe(200);
}

async function lastMarketSuccess(harness: Harness): Promise<string | null> {
	return (await body(await harness.call("GET", "/home/data"), homeDataResponseSchema)).refresh
		.lastSucceededAt;
}

async function lastEarningsSuccess(harness: Harness): Promise<string | null> {
	return (await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema)).refresh
		.lastSucceededAt;
}

async function addStock(harness: Harness, market: string, symbol: string): Promise<void> {
	const response = await harness.call("POST", "/watchlist/stocks", { market, symbol });
	expect(response.status).toBe(200);
}

describe("market refresh scope (ADR-0039)", () => {
	it("no body refreshes everything: request null, every tracked series claimed", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		const runId = await queuedRunId(await queue(harness, "/home/refresh"));
		// Stored like every row written before the scope existed.
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		expect((await claimMarketSeries(harness, token)).ids).toEqual([...TRACKED]);
	});

	it("an unrefreshed claim carries only the series without observations or never refreshed", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		await refreshVixOnly(harness, token);

		const runId = await queuedRunId(await queue(harness, "/home/refresh", "unrefreshed"));
		expect(JSON.parse((await storedJob(harness, runId)).request_json ?? "null")).toEqual({
			scope: "unrefreshed",
		});
		const second = await claimMarketSeries(harness, token);
		expect(second.job.runId).toBe(runId);
		// Tracked order kept; VIXCLS (data and a stamp) is left out.
		expect(second.ids).toEqual(["fred:DGS10", "twelve-data:AAPL"]);
		expect(second.job.series.every((entry) => entry.latestObservedOn === null)).toBe(true);
	});

	it("a request for everything widens a pending unrefreshed job instead of queueing a second", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		// VIXCLS has data, so the narrow job alone would claim DGS10 and AAPL only.
		await refreshVixOnly(harness, token);
		const runId = await queuedRunId(await queue(harness, "/home/refresh", "unrefreshed"));
		expect(await queuedRunId(await queue(harness, "/home/refresh"))).toBe(runId);
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		expect(await auditActions(harness, runId)).toEqual([
			"run.create_market_refresh",
			"run.widen_market_refresh",
		]);
		expect((await claimMarketSeries(harness, token)).ids).toEqual([...TRACKED]);
	});

	it("widens the narrow job that won the insert race against a request for everything", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		await refreshVixOnly(harness, token);
		const racing = racingHarness(harness, "/home/refresh");
		const runId = await queuedRunId(await queue(racing.harness, "/home/refresh", "all"));
		expect(racing.narrowRunId()).toBe(runId);
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		expect(await auditActions(harness, runId)).toEqual([
			"run.create_market_refresh",
			"run.widen_market_refresh",
		]);
		expect((await claimMarketSeries(harness, token)).ids).toEqual([...TRACKED]);
	});

	it("never widens a claimed job, and never narrows a job for everything", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		await refreshVixOnly(harness, token);
		const partial = await queuedRunId(await queue(harness, "/home/refresh", "unrefreshed"));
		expect((await claimMarketSeries(harness, token)).ids).toEqual([
			"fred:DGS10",
			"twelve-data:AAPL",
		]);
		// Claimed: the claim already chose its series, so the run is returned as it is.
		expect(await queuedRunId(await queue(harness, "/home/refresh", "all"))).toBe(partial);
		const stored = await storedJob(harness, partial);
		expect(stored.state).toBe("claimed");
		expect(JSON.parse(stored.request_json ?? "null")).toEqual({ scope: "unrefreshed" });
		expect(await auditActions(harness, partial)).toEqual(["run.create_market_refresh"]);

		const other = createHarness();
		const whole = await queuedRunId(await queue(other, "/home/refresh", "all"));
		expect(await queuedRunId(await queue(other, "/home/refresh", "unrefreshed"))).toBe(whole);
		expect((await storedJob(other, whole)).request_json).toBeNull();
	});

	it("puts the scope in the idempotency fingerprint", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		const key = idempotencyKey();
		const runId = await queuedRunId(await queue(harness, "/home/refresh", undefined, key));
		const { job } = await claimMarketSeries(harness, token);
		await completeEmptyMarketRun(harness, token, job);
		// The same key for the other scope is a different request.
		const reused = await queue(harness, "/home/refresh", "unrefreshed", key);
		expect(reused.status).toBe(409);
		expect((await apiError(reused)).code).toBe("IDEMPOTENCY_KEY_REUSED");
		// `{}` and no body are the same request ("all"): a replay of the run.
		const replayed = await harness.call("POST", "/home/refresh", {}, key);
		expect(await queuedRunId(replayed)).toBe(runId);
	});

	it("a narrow success leaves the last successful refresh where it was; a whole one moves it", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		await refreshVixOnly(harness, token);
		const whole = await lastMarketSuccess(harness);
		expect(whole).not.toBeNull();

		harness.time.advance(60_000);
		const partial = await queuedRunId(await queue(harness, "/home/refresh", "unrefreshed"));
		const narrow = await claimMarketSeries(harness, token);
		expect(narrow.ids).toEqual(["fred:DGS10", "twelve-data:AAPL"]);
		await completeEmptyMarketRun(harness, token, narrow.job);
		expect((await storedJob(harness, partial)).state).toBe("completed");
		expect(await lastMarketSuccess(harness)).toBe(whole);

		harness.time.advance(60_000);
		await queuedRunId(await queue(harness, "/home/refresh", "all"));
		const all = await claimMarketSeries(harness, token);
		await completeEmptyMarketRun(harness, token, all.job);
		const moved = await lastMarketSuccess(harness);
		expect(moved).not.toBe(whole);
		expect(moved).toBe(harness.time.clock.nowIso());
	});

	it("a narrow job that covers every tracked series is stored as a whole refresh at the claim", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await trackThreeSeries(harness);
		// Nothing has data yet: the first-ever refresh, asked for narrowly.
		const runId = await queuedRunId(await queue(harness, "/home/refresh", "unrefreshed"));
		const claimed = await claimMarketSeries(harness, token);
		expect(claimed.ids).toEqual([...TRACKED]);
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		expect(await auditActions(harness, runId)).toEqual([
			"run.create_market_refresh",
			"run.widen_market_refresh",
		]);
		expect(await auditDetails(harness, runId)).toContain("scope=unrefreshed->all at claim");
		await completeEmptyMarketRun(harness, token, claimed.job);
		// So its success is the last refresh of everything.
		expect(await lastMarketSuccess(harness)).toBe(harness.time.clock.nowIso());
	});

	it("answers 400 with the usual validation shape for a bad scope", async () => {
		const harness = createHarness();
		for (const payload of [{ scope: "some" }, { scope: null }, { scope: "all", extra: 1 }]) {
			const response = await harness.call("POST", "/home/refresh", payload, idempotencyKey());
			expect(response.status).toBe(400);
			const error = await apiError(response);
			expect(error.code).toBe("VALIDATION_FAILED");
			expect(error.message).toBe("Request body failed validation.");
		}
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = 'market-refresh'",
		)
			.bind(harness.ownerId)
			.all<{ n: number }>();
		expect(rows.results[0]?.n).toBe(0);
	});
});

type EarningsResult = {
	readonly stockId: string;
	readonly errorCode: "NO_SCHEDULED_DATE" | "SOURCE_FAILED" | "RATE_LIMITED" | "SYMBOL_NOT_FOUND";
};

/** Completes a claimed earnings run with the given per-stock outcomes (no dated events). */
async function completeEarningsRun(
	harness: Harness,
	token: string,
	job: ClaimedLease,
	results: readonly EarningsResult[],
): Promise<void> {
	await advanceToPublishing(harness, token, job);
	const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
		outcome: "earnings-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: USAGE,
		stocks: results.map((result) => ({
			stockId: result.stockId,
			name: null,
			fetchedAt: harness.time.clock.nowIso(),
			events: [],
			errorCode: result.errorCode,
		})),
	});
	expect(completed.status).toBe(200);
}

/** One whole earnings refresh that stores the given outcomes; returns its run id. */
async function refreshStocks(
	harness: Harness,
	token: string,
	results: readonly EarningsResult[],
): Promise<string> {
	const runId = await queuedRunId(await queue(harness, "/watchlist/refresh"));
	const { job } = await claimEarningsStocks(harness, token);
	await completeEarningsRun(harness, token, job, results);
	return runId;
}

describe("earnings refresh scope (ADR-0039)", () => {
	it("no body refreshes every stock; an unrefreshed claim carries only those never refreshed", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "JP", "7203");
		const runId = await queuedRunId(await queue(harness, "/watchlist/refresh"));
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		const first = await claimEarningsStocks(harness, token);
		expect(first.ids).toEqual(["us:AAPL", "jp:7203"]);
		// Only AAPL is reported, so 7203 stays never refreshed.
		await completeEarningsRun(harness, token, first.job, [
			{ stockId: "us:AAPL", errorCode: "NO_SCHEDULED_DATE" },
		]);
		await addStock(harness, "US", "MSFT");

		const partial = await queuedRunId(await queue(harness, "/watchlist/refresh", "unrefreshed"));
		expect(JSON.parse((await storedJob(harness, partial)).request_json ?? "null")).toEqual({
			scope: "unrefreshed",
		});
		expect((await claimEarningsStocks(harness, token)).ids).toEqual(["jp:7203", "us:MSFT"]);
	});

	it("an unrefreshed claim retries stocks whose last fetch failed, not real provider answers", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "US", "MSFT");
		await addStock(harness, "US", "NVDA");
		await addStock(harness, "JP", "7203");
		await refreshStocks(harness, token, [
			{ stockId: "us:AAPL", errorCode: "SOURCE_FAILED" },
			{ stockId: "us:MSFT", errorCode: "NO_SCHEDULED_DATE" },
			{ stockId: "us:NVDA", errorCode: "RATE_LIMITED" },
			{ stockId: "jp:7203", errorCode: "SYMBOL_NOT_FOUND" },
		]);
		await addStock(harness, "US", "AMZN");
		await queuedRunId(await queue(harness, "/watchlist/refresh", "unrefreshed"));
		// The failed fetches are retried with the new stock; the answers are not.
		expect((await claimEarningsStocks(harness, token)).ids).toEqual([
			"us:AAPL",
			"us:NVDA",
			"us:AMZN",
		]);
	});

	it("a narrow success leaves the last successful refresh where it was", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await refreshStocks(harness, token, [{ stockId: "us:AAPL", errorCode: "NO_SCHEDULED_DATE" }]);
		const whole = await lastEarningsSuccess(harness);
		expect(whole).toBe(harness.time.clock.nowIso());

		harness.time.advance(60_000);
		await addStock(harness, "JP", "7203");
		await queuedRunId(await queue(harness, "/watchlist/refresh", "unrefreshed"));
		const narrow = await claimEarningsStocks(harness, token);
		expect(narrow.ids).toEqual(["jp:7203"]);
		await completeEarningsRun(harness, token, narrow.job, []);
		expect(await lastEarningsSuccess(harness)).toBe(whole);
	});

	it("a narrow job that covers every stock is stored as a whole refresh at the claim", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		// The first stock of the list, asked for narrowly.
		await addStock(harness, "US", "AAPL");
		const runId = await queuedRunId(await queue(harness, "/watchlist/refresh", "unrefreshed"));
		const claimed = await claimEarningsStocks(harness, token);
		expect(claimed.ids).toEqual(["us:AAPL"]);
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		expect(await auditActions(harness, runId)).toEqual([
			"run.create_earnings_refresh",
			"run.widen_earnings_refresh",
		]);
		expect(await auditDetails(harness, runId)).toContain("scope=unrefreshed->all at claim");
		await completeEarningsRun(harness, token, claimed.job, []);
		expect(await lastEarningsSuccess(harness)).toBe(harness.time.clock.nowIso());
	});

	it("a request for everything widens a pending unrefreshed job", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "JP", "7203");
		// AAPL has its answer, so the narrow job alone would claim 7203 only.
		await refreshStocks(harness, token, [{ stockId: "us:AAPL", errorCode: "NO_SCHEDULED_DATE" }]);
		const runId = await queuedRunId(await queue(harness, "/watchlist/refresh", "unrefreshed"));
		expect(await queuedRunId(await queue(harness, "/watchlist/refresh", "all"))).toBe(runId);
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		expect(await auditActions(harness, runId)).toEqual([
			"run.create_earnings_refresh",
			"run.widen_earnings_refresh",
		]);
		expect((await claimEarningsStocks(harness, token)).ids).toEqual(["us:AAPL", "jp:7203"]);
	});

	it("widens the narrow job that won the insert race against a request for everything", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "JP", "7203");
		await refreshStocks(harness, token, [{ stockId: "us:AAPL", errorCode: "NO_SCHEDULED_DATE" }]);
		const racing = racingHarness(harness, "/watchlist/refresh");
		const runId = await queuedRunId(await queue(racing.harness, "/watchlist/refresh", "all"));
		expect(racing.narrowRunId()).toBe(runId);
		expect((await storedJob(harness, runId)).request_json).toBeNull();
		expect((await claimEarningsStocks(harness, token)).ids).toEqual(["us:AAPL", "jp:7203"]);
	});

	it("puts the scope in the idempotency fingerprint", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		const key = idempotencyKey();
		const runId = await queuedRunId(await queue(harness, "/watchlist/refresh", undefined, key));
		const { job } = await claimEarningsStocks(harness, token);
		await completeEarningsRun(harness, token, job, []);
		const reused = await queue(harness, "/watchlist/refresh", "unrefreshed", key);
		expect(reused.status).toBe(409);
		expect((await apiError(reused)).code).toBe("IDEMPOTENCY_KEY_REUSED");
		expect(await queuedRunId(await harness.call("POST", "/watchlist/refresh", {}, key))).toBe(
			runId,
		);
	});

	it("answers 400 for a bad scope and queues nothing", async () => {
		const harness = createHarness();
		await addStock(harness, "US", "AAPL");
		const response = await queue(harness, "/watchlist/refresh", "everything");
		expect(response.status).toBe(400);
		expect((await apiError(response)).code).toBe("VALIDATION_FAILED");
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = 'earnings-refresh'",
		)
			.bind(harness.ownerId)
			.all<{ n: number }>();
		expect(rows.results[0]?.n).toBe(0);
	});
});
