import { env } from "cloudflare:test";
import { homeDataResponseSchema, watchlistResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	type ClaimedLease,
	claim,
	createHarness,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/**
 * ADR-0051: the API queues market and earnings syncs itself when a runner
 * asks for work; no page asks for a refresh. These drive the claim on real
 * persistence (workerd D1 and `node:sqlite`) and check what is queued,
 * when, and what the claim then carries (the ADR-0039 scope rules).
 * The decision itself is Lean-verified (`tests/formal/syncSchedule…`).
 */

type Harness = ReturnType<typeof createHarness>;

const MINUTE = 60_000;
/** Past the per-owner check period and the least gap between two jobs. */
const GAP = 20_000;

const VIX_META = {
	title: "VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis (FRED)",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
} as const;

const TRACKED = ["fred:VIXCLS", "fred:DGS10", "twelve-data:AAPL"] as const;

async function setup(): Promise<{ readonly harness: Harness; readonly token: string }> {
	const harness = createHarness({ serverDataSync: true });
	return { harness, token: await issueRunnerToken(harness) };
}

async function trackSeries(harness: Harness, seriesIds: readonly string[]): Promise<void> {
	const response = await harness.call("PUT", "/home/dashboard", {
		dashboard: {
			schemaVersion: 2,
			widgets: seriesIds.map((seriesId, index) => ({
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

async function storedRequest(harness: Harness, runId: string): Promise<unknown> {
	const row = await env.DB.prepare(
		"SELECT request_json FROM research_jobs WHERE owner_id = ? AND run_id = ?",
	)
		.bind(harness.ownerId, runId)
		.first<{ request_json: string | null }>();
	if (row === null) throw new Error(`no stored job ${runId}`);
	return row.request_json === null ? null : JSON.parse(row.request_json);
}

async function audits(harness: Harness, runId: string): Promise<string[]> {
	const rows = await env.DB.prepare(
		"SELECT actor, action, detail FROM audit_log WHERE owner_id = ? AND resource = ? ORDER BY audit_id",
	)
		.bind(harness.ownerId, runId)
		.all<{ actor: string; action: string; detail: string }>();
	return rows.results.map((row) => `${row.actor} ${row.action} ${row.detail}`);
}

async function jobCount(harness: Harness, kind: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = ?",
	)
		.bind(harness.ownerId, kind)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function claimMarket(harness: Harness, token: string) {
	const job = await claim(harness, token);
	if (job?.kind !== "market-refresh")
		throw new Error(`expected a market-refresh, got ${job?.kind}`);
	return { job, ids: job.series.map((entry) => entry.seriesId) };
}

async function claimEarnings(harness: Harness, token: string) {
	const job = await claim(harness, token);
	if (job?.kind !== "earnings-refresh") {
		throw new Error(`expected an earnings-refresh, got ${job?.kind}`);
	}
	return { job, ids: job.stocks.map((entry) => entry.stockId) };
}

type SeriesResult = {
	readonly seriesId: string;
	readonly errorCode: null | "SOURCE_NOT_CONFIGURED" | "PLAN_NOT_ENTITLED";
};

async function completeMarket(
	harness: Harness,
	token: string,
	job: ClaimedLease,
	results: readonly SeriesResult[],
): Promise<void> {
	await advanceToPublishing(harness, token, job);
	const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
		outcome: "market-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: USAGE,
		series: results.map((result) => ({
			seriesId: result.seriesId,
			fetchedAt: harness.time.clock.nowIso(),
			meta: result.errorCode === null ? { ...VIX_META } : null,
			observations: result.errorCode === null ? [["2026-10-02", 15.8]] : [],
			errorCode: result.errorCode,
		})),
	});
	expect(completed.status).toBe(200);
}

async function failJob(harness: Harness, token: string, job: ClaimedLease): Promise<void> {
	await advanceToPublishing(harness, token, job);
	const failed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
		outcome: "failed",
		leaseGeneration: job.leaseGeneration,
		usage: USAGE,
		failureCode: "SOURCE_FAILED",
		retryable: false,
	});
	expect(failed.status).toBe(200);
}

const everySeriesFresh = TRACKED.map((seriesId) => ({ seriesId, errorCode: null }));

async function lastMarketSuccess(harness: Harness): Promise<string | null> {
	return (await body(await harness.call("GET", "/home/data"), homeDataResponseSchema)).refresh
		.lastSucceededAt;
}

async function lastEarningsSuccess(harness: Harness): Promise<string | null> {
	return (await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema)).refresh
		.lastSucceededAt;
}

describe("server-side market sync (ADR-0051)", () => {
	it("the first claim queues and hands out a sync of every tracked series", async () => {
		const { harness, token } = await setup();
		await trackSeries(harness, TRACKED);
		const { job, ids } = await claimMarket(harness, token);
		expect(ids).toEqual([...TRACKED]);
		// Asked for the new items; covering everything, it is stored as a whole sync at the claim.
		expect(await storedRequest(harness, job.runId)).toBeNull();
		expect(await audits(harness, job.runId)).toEqual([
			"scheduler run.sync_market scope=unrefreshed reason=new-items",
			expect.stringContaining("run.widen_market_refresh scope=unrefreshed->all at claim"),
		]);
	});

	it("queues nothing while a sync is active or the data is fresh, and everything once it is 30 minutes old", async () => {
		const { harness, token } = await setup();
		await trackSeries(harness, TRACKED);
		const { job } = await claimMarket(harness, token);
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		await completeMarket(harness, token, job, everySeriesFresh);
		harness.time.advance(29 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(MINUTE);
		const next = await claimMarket(harness, token);
		expect(next.ids).toEqual([...TRACKED]);
		expect(await storedRequest(harness, next.job.runId)).toBeNull();
		expect(await audits(harness, next.job.runId)).toEqual([
			"scheduler run.sync_market scope=all reason=stale",
		]);
		expect(await jobCount(harness, "market-refresh")).toBe(2);
	});

	it("a series added later is fetched alone at the next claim, without moving the last full sync", async () => {
		const { harness, token } = await setup();
		await trackSeries(harness, TRACKED);
		const first = await claimMarket(harness, token);
		await completeMarket(harness, token, first.job, everySeriesFresh);
		const whole = await lastMarketSuccess(harness);
		expect(whole).not.toBeNull();

		harness.time.advance(GAP);
		const put = await harness.call("PUT", "/home/dashboard", {
			dashboard: {
				schemaVersion: 2,
				widgets: [...TRACKED, "fred:UNRATE"].map((seriesId, index) => ({
					type: "market-metric",
					widgetId: `w-${index}`,
					title: `Widget ${index}`,
					size: "small",
					seriesId,
				})),
			},
			expectedVersion: 1,
		});
		expect(put.status).toBe(200);
		const narrow = await claimMarket(harness, token);
		expect(narrow.ids).toEqual(["fred:UNRATE"]);
		expect(await storedRequest(harness, narrow.job.runId)).toEqual({ scope: "unrefreshed" });
		await completeMarket(harness, token, narrow.job, [
			{ seriesId: "fred:UNRATE", errorCode: null },
		]);
		expect(await lastMarketSuccess(harness)).toBe(whole);
	});

	it("waits at least 15 seconds after a job before queueing for a series it did not stamp", async () => {
		const { harness, token } = await setup();
		await trackSeries(harness, TRACKED);
		const first = await claimMarket(harness, token);
		// The answer leaves DGS10 out (never refreshed) and AAPL without data.
		await completeMarket(harness, token, first.job, [
			{ seriesId: "fred:VIXCLS", errorCode: null },
			{ seriesId: "twelve-data:AAPL", errorCode: "SOURCE_NOT_CONFIGURED" },
		]);
		harness.time.advance(10_000);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(10_000);
		// DGS10 is new; AAPL, refreshed without data, rides along (ADR-0039).
		expect((await claimMarket(harness, token)).ids).toEqual(["fred:DGS10", "twelve-data:AAPL"]);
	});

	it("a narrow job skips a series the provider refused on the plan; the full sync asks again (ADR-0040)", async () => {
		const { harness, token } = await setup();
		await trackSeries(harness, TRACKED);
		const first = await claimMarket(harness, token);
		await completeMarket(harness, token, first.job, [
			{ seriesId: "fred:VIXCLS", errorCode: null },
			{ seriesId: "twelve-data:AAPL", errorCode: "PLAN_NOT_ENTITLED" },
		]);
		harness.time.advance(GAP);
		const narrow = await claimMarket(harness, token);
		expect(narrow.ids).toEqual(["fred:DGS10"]);
		await completeMarket(harness, token, narrow.job, [{ seriesId: "fred:DGS10", errorCode: null }]);
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(30 * MINUTE);
		expect((await claimMarket(harness, token)).ids).toEqual([...TRACKED]);
	});

	it("after a failed sync waits 30 minutes before the next", async () => {
		const { harness, token } = await setup();
		await trackSeries(harness, TRACKED);
		const first = await claimMarket(harness, token);
		await failJob(harness, token, first.job);
		harness.time.advance(29 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(MINUTE);
		expect((await claimMarket(harness, token)).ids).toEqual([...TRACKED]);
	});

	it("stretches the interval when many Twelve Data series would exceed the daily budget", async () => {
		const { harness, token } = await setup();
		// 13 series × 48 syncs a day would be 624 requests; the budget is 600.
		const symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "KO"];
		const seriesIds = [...symbols, "JPM", "V", "WMT", "XOM"].map((s) => `twelve-data:${s}`);
		await trackSeries(harness, seriesIds);
		const first = await claimMarket(harness, token);
		expect(first.ids).toHaveLength(13);
		await completeMarket(
			harness,
			token,
			first.job,
			seriesIds.map((seriesId) => ({ seriesId, errorCode: null })),
		);
		// 13 × 24 h / 600 = 31.2 minutes.
		harness.time.advance(31 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(MINUTE);
		expect((await claimMarket(harness, token)).ids).toHaveLength(13);
	});

	it("queues nothing when switched off (SERVER_DATA_SYNC=off)", async () => {
		const harness = createHarness({ serverDataSync: false });
		const token = await issueRunnerToken(harness);
		await trackSeries(harness, TRACKED);
		expect(await claim(harness, token)).toBeNull();
		expect(await jobCount(harness, "market-refresh")).toBe(0);
	});
});

type EarningsResult = {
	readonly stockId: string;
	readonly errorCode: "NO_SCHEDULED_DATE" | "SOURCE_FAILED" | "RATE_LIMITED" | "SYMBOL_NOT_FOUND";
};

async function completeEarnings(
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

async function addStock(harness: Harness, market: string, symbol: string): Promise<void> {
	const response = await harness.call("POST", "/watchlist/stocks", { market, symbol });
	expect(response.status).toBe(200);
}

/** A harness whose Home tracks nothing, so only earnings are synced. */
async function earningsSetup(): Promise<{ readonly harness: Harness; readonly token: string }> {
	const context = await setup();
	await trackSeries(context.harness, []);
	return context;
}

describe("server-side earnings sync (ADR-0051)", () => {
	it("a stock added is synced at the next claim; nothing is queued for an empty watchlist", async () => {
		const { harness, token } = await earningsSetup();
		expect(await claim(harness, token)).toBeNull();
		await addStock(harness, "US", "AAPL");
		harness.time.advance(GAP);
		const { job, ids } = await claimEarnings(harness, token);
		expect(ids).toEqual(["us:AAPL"]);
		expect(await storedRequest(harness, job.runId)).toBeNull();
		expect((await audits(harness, job.runId))[0]).toBe(
			"scheduler run.sync_earnings scope=unrefreshed reason=new-items",
		);
	});

	it("retries failed fetches after 30 minutes, not real provider answers, and syncs everything daily", async () => {
		const { harness, token } = await earningsSetup();
		for (const symbol of ["AAPL", "MSFT", "NVDA"]) await addStock(harness, "US", symbol);
		await addStock(harness, "JP", "7203");
		const first = await claimEarnings(harness, token);
		await completeEarnings(harness, token, first.job, [
			{ stockId: "us:AAPL", errorCode: "SOURCE_FAILED" },
			{ stockId: "us:MSFT", errorCode: "NO_SCHEDULED_DATE" },
			{ stockId: "us:NVDA", errorCode: "RATE_LIMITED" },
			{ stockId: "jp:7203", errorCode: "SYMBOL_NOT_FOUND" },
		]);
		const whole = await lastEarningsSuccess(harness);
		harness.time.advance(29 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(MINUTE);
		const retry = await claimEarnings(harness, token);
		expect(retry.ids).toEqual(["us:AAPL", "us:NVDA"]);
		expect((await audits(harness, retry.job.runId))[0]).toBe(
			"scheduler run.sync_earnings scope=unrefreshed reason=retry",
		);
		await completeEarnings(harness, token, retry.job, [
			{ stockId: "us:AAPL", errorCode: "NO_SCHEDULED_DATE" },
			{ stockId: "us:NVDA", errorCode: "NO_SCHEDULED_DATE" },
		]);
		expect(await lastEarningsSuccess(harness)).toBe(whole);

		harness.time.advance(23 * 60 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(31 * MINUTE);
		const daily = await claimEarnings(harness, token);
		expect(daily.ids).toEqual(["us:AAPL", "us:MSFT", "us:NVDA", "jp:7203"]);
		expect(await storedRequest(harness, daily.job.runId)).toBeNull();
	});
});
