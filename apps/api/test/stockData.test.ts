import { env } from "cloudflare:test";
import {
	type ClaimedJob,
	type StockDataSearchResponse,
	stockDataSearchResponseSchema,
} from "@research/contracts";
import { stockPriceSeriesId } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	businessDescription,
	expectedValue,
	syncedCompletion,
	tenK,
} from "./equitySyncFixtures.ts";
import {
	advanceToPublishing,
	body,
	claim,
	createHarness,
	createWorkspace,
	errorCode,
	type Harness,
	issueRunnerToken,
	queueRun,
	trackCompany,
} from "./helpers.ts";

/**
 * `POST /api/v1/runner/jobs/:id/stock-data/search` (ADR-0071) on a real
 * local D1: Apple's statements arrive through a real financial sync, its
 * closes and directory row as the runner's completions leave them; a
 * research run's lease holder then searches them. Only the current lease of
 * a research run may search.
 */

async function seedDirectory(harness: Harness): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
				symbol_key, name_key, local_name_key, search_key)
			VALUES (?, 'US', 'AAPL', 'Apple Inc.', NULL, 'nasdaq', 'aapl', 'apple inc.', '', 'aapl apple inc.')`,
		).bind(harness.ownerId),
		env.DB.prepare(
			`INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at, fold_version)
			VALUES (?, 'US', 1, NULL, ?, 1)`,
		).bind(harness.ownerId, harness.time.clock.nowIso()),
	]);
}

async function seedCloses(harness: Harness): Promise<void> {
	const seriesId = stockPriceSeriesId("US", "AAPL");
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
				publisher, source_url, last_refreshed_at, retrieved_at)
			VALUES (?, ?, 'twelve-data', 'AAPL', 'AAPL', 'USD', 'daily', 'Twelve Data',
				'https://twelvedata.com/', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`,
		).bind(harness.ownerId, seriesId),
		env.DB.prepare(
			`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
			VALUES (?1, ?2, '2026-10-28', 260.5), (?1, ?2, '2026-10-29', 262), (?1, ?2, '2026-10-30', 270.25)`,
		).bind(harness.ownerId, seriesId),
	]);
}

/** Apple synced from SEC (FY2024, FY2025 with a business section), then a research run claimed. */
async function setup() {
	const harness = createHarness();
	const token = await issueRunnerToken(harness);
	await seedDirectory(harness);
	await seedCloses(harness);
	await trackCompany(harness, "us:AAPL");
	const sync = await claim(harness, token);
	if (sync?.kind !== "financial-sync")
		throw new Error(`expected a financial sync, got ${sync?.kind}`);
	await advanceToPublishing(harness, token, sync);
	const filings = [tenK(2024), tenK(2025)];
	const latest = filings[1];
	if (latest === undefined) throw new Error("no filing");
	const completed = await harness.runner(
		token,
		`/jobs/${sync.runId}/complete`,
		syncedCompletion(sync, "sec", filings, { description: businessDescription(latest) }),
	);
	expect(completed.status).toBe(200);

	const workspaceId = await createWorkspace(harness);
	await queueRun(harness, workspaceId);
	const run = await claim(harness, token);
	if (run?.kind !== "research") throw new Error(`expected a research run, got ${run?.kind}`);
	return { harness, token, run, sync };
}

async function search(
	harness: Harness,
	token: string,
	run: ClaimedJob,
	request: Record<string, unknown>,
): Promise<StockDataSearchResponse> {
	const response = await harness.runner(token, `/jobs/${run.runId}/stock-data/search`, {
		leaseGeneration: run.leaseGeneration,
		...request,
	});
	expect(response.status).toBe(200);
	return body(response, stockDataSearchResponseSchema);
}

describe("runner stock-data search (ADR-0071)", () => {
	it("answers a financial question with the stored statement passage first, cited to the 10-K", async () => {
		const { harness, token, run } = await setup();
		const found = await search(harness, token, run, {
			query: "revenue operating income fiscal year 2025",
			stockIds: ["us:AAPL"],
		});
		expect(found.searchedStocks).toEqual(["us:AAPL"]);
		const best = found.passages[0];
		expect(best?.section).toBe("financials");
		expect(best?.title).toContain("FY2025");
		expect(best?.text).toContain(`revenue (net sales) ${expectedValue("revenue", 2025)} USD`);
		expect(best?.sourceUrl).toMatch(/^https:\/\/www\.sec\.gov\//);
		expect(best?.sourceClass).toBe("regulatory-filing");
		expect(best?.aiWritten).toBe(false);
		const scores = found.passages.map((passage) => passage.score);
		expect([...scores].sort((a, b) => b - a)).toEqual(scores);
	});

	it("finds the stock from a ticker in the query and serves the business text and closes", async () => {
		const { harness, token, run } = await setup();
		const business = await search(harness, token, run, {
			query: "What does AAPL design? smartphones",
		});
		expect(business.searchedStocks).toEqual(["us:AAPL"]);
		expect(business.passages[0]?.section).toBe("business");
		expect(business.passages[0]?.text).toContain("designs smartphones");

		const prices = await search(harness, token, run, {
			query: "AAPL latest daily close",
			sections: ["prices"],
			limit: 1,
		});
		expect(prices.passages).toHaveLength(1);
		expect(prices.passages[0]?.text).toContain("270.25 USD on 2026-10-30");
		expect(prices.passages[0]?.text).toContain("Previous close 262 on 2026-10-29");
	});

	it("searches no stock when the query names none", async () => {
		const { harness, token, run } = await setup();
		const found = await search(harness, token, run, { query: "which company grew fastest" });
		expect(found).toEqual({ searchedStocks: [], passages: [] });
	});

	it("refuses a stale lease, a non-research run and an invalid body", async () => {
		const { harness, token, run, sync } = await setup();
		const stale = await harness.runner(token, `/jobs/${run.runId}/stock-data/search`, {
			leaseGeneration: run.leaseGeneration + 1,
			query: "revenue",
			stockIds: ["us:AAPL"],
		});
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("STALE_LEASE");

		const other = await harness.runner(token, `/jobs/${sync.runId}/stock-data/search`, {
			leaseGeneration: sync.leaseGeneration,
			query: "revenue",
		});
		// The sync's lease ended with its completion.
		expect(other.status).toBe(409);

		const invalid = await harness.runner(token, `/jobs/${run.runId}/stock-data/search`, {
			leaseGeneration: run.leaseGeneration,
			query: "",
		});
		expect(invalid.status).toBe(400);
	});

	it("does not answer another owner's run", async () => {
		const { run } = await setup();
		const stranger = createHarness();
		const strangerToken = await issueRunnerToken(stranger);
		const response = await stranger.runner(strangerToken, `/jobs/${run.runId}/stock-data/search`, {
			leaseGeneration: run.leaseGeneration,
			query: "revenue",
			stockIds: ["us:AAPL"],
		});
		expect(response.status).toBe(404);
	});
});
