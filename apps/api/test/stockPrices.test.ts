import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import {
	completeJobResponseSchema,
	MAX_REQUEST_BODY_BYTES,
	STOCK_PRICE_LIMITS,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	type ClaimedLease,
	claim,
	createHarness,
	errorCode,
	type Harness,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/**
 * ADR-0058 §2: every directory stock's daily prices, one request per market
 * and date. The claim-time schedule queues one `stock-prices-sync` per
 * market (`planSyncDays`, newest first; then the stocks with no stored
 * series), the claim plans the job's days, and the completion stores only
 * directory stocks' bars under their price series ids. Real persistence on
 * both engines; the clock starts on Sunday 2026-10-11 00:00 UTC (Saturday
 * 20:00 in New York, Sunday 09:00 in Tokyo).
 */

type PricesLease = Extract<ClaimedLease, { kind: "stock-prices-sync" }>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Past the per-owner check period and the least gap between two jobs. */
const GAP = 20_000;

/** The ten newest US weekdays on the test clock's New York date (Saturday 2026-10-10). */
const US_FIRST_DAYS = [
	"2026-10-09",
	"2026-10-08",
	"2026-10-07",
	"2026-10-06",
	"2026-10-05",
	"2026-10-02",
	"2026-10-01",
	"2026-09-30",
	"2026-09-29",
	"2026-09-28",
];

function setup() {
	return createHarness({ serverDataSync: true, serverSyncKinds: ["stock-prices-sync"] });
}

async function seedDirectory(
	harness: Harness,
	market: "US" | "JP",
	rows: readonly { readonly symbol: string; readonly listing: string }[],
): Promise<void> {
	await env.DB.batch([
		...rows.map((row) =>
			env.DB.prepare(
				`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
					symbol_key, name_key, local_name_key, search_key)
				VALUES (?, ?, ?, ?, NULL, ?, ?, ?, '', ?)`,
			).bind(
				harness.ownerId,
				market,
				row.symbol,
				`${row.symbol} Inc.`,
				row.listing,
				row.symbol.toLowerCase(),
				row.symbol.toLowerCase(),
				row.symbol.toLowerCase(),
			),
		),
		env.DB.prepare(
			`INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at, fold_version)
			VALUES (?, ?, ?, NULL, '2026-10-10T00:00:00.000Z', 2)
			ON CONFLICT (owner_id, market) DO UPDATE
				SET entry_count = stock_directory_meta.entry_count + excluded.entry_count`,
		).bind(harness.ownerId, market, rows.length),
	]);
}

const US_DIRECTORY = [
	{ symbol: "AAPL", listing: "nasdaq" },
	{ symbol: "BRK-B", listing: "nyse" },
	{ symbol: "MSFT", listing: "nasdaq" },
	{ symbol: "ZTS", listing: "nyse" },
];

async function claimPrices(harness: Harness, token: string): Promise<PricesLease> {
	const job = await claim(harness, token);
	if (job?.kind !== "stock-prices-sync") throw new Error(`expected stock prices, got ${job?.kind}`);
	await advanceToPublishing(harness, token, job);
	return job;
}

function completion(
	harness: Harness,
	lease: PricesLease,
	fields: {
		readonly days?: readonly unknown[];
		readonly histories?: readonly unknown[];
		readonly market?: "US" | "JP";
		readonly splitSymbols?: readonly string[];
		readonly splitCheckedThrough?: string | null;
	},
) {
	const market = fields.market ?? lease.market;
	return {
		outcome: "stock-prices-synced",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		market,
		provider: market === "US" ? "massive" : "jquants",
		fetchedAt: harness.time.clock.nowIso(),
		days: fields.days ?? [],
		histories: fields.histories ?? [],
		splitSymbols: fields.splitSymbols ?? [],
		splitCheckedThrough: fields.splitCheckedThrough ?? null,
	};
}

async function complete(harness: Harness, token: string, lease: PricesLease, payload: unknown) {
	const response = await harness.runner(token, `/jobs/${lease.runId}/complete`, payload);
	expect(response.status).toBe(200);
	expect((await body(response, completeJobResponseSchema)).state).toBe("completed");
}

async function observations(harness: Harness, seriesId: string) {
	const rows = await env.DB.prepare(
		`SELECT observed_on, value, open_value, high_value, low_value, volume FROM market_observations
		WHERE owner_id = ? AND series_id = ? ORDER BY observed_on`,
	)
		.bind(harness.ownerId, seriesId)
		.all<{
			observed_on: string;
			value: number;
			open_value: number | null;
			high_value: number | null;
			low_value: number | null;
			volume: number | null;
		}>();
	return rows.results;
}

async function seriesRow(harness: Harness, seriesId: string) {
	return env.DB.prepare(
		`SELECT provider, symbol, title, unit, frequency, publisher, source_url, last_refreshed_at,
			retrieved_at, unavailable_code FROM market_series WHERE owner_id = ? AND series_id = ?`,
	)
		.bind(harness.ownerId, seriesId)
		.first<{
			provider: string;
			symbol: string;
			title: string;
			unit: string;
			frequency: string;
			publisher: string;
			source_url: string;
			last_refreshed_at: string | null;
			retrieved_at: string | null;
			unavailable_code: string | null;
		}>();
}

async function dayRows(harness: Harness, market: "US" | "JP") {
	const rows = await env.DB.prepare(
		`SELECT trading_on, outcome_code, bar_count, retry_at FROM stock_price_day
		WHERE owner_id = ? AND market = ? ORDER BY trading_on DESC`,
	)
		.bind(harness.ownerId, market)
		.all<{
			trading_on: string;
			outcome_code: string;
			bar_count: number;
			retry_at: string | null;
		}>();
	return rows.results;
}

async function jobsOfKind(harness: Harness) {
	const rows = await env.DB.prepare(
		`SELECT run_id, state, request_json FROM research_jobs
		WHERE owner_id = ? AND kind = 'stock-prices-sync' ORDER BY created_at`,
	)
		.bind(harness.ownerId)
		.all<{ run_id: string; state: string; request_json: string }>();
	return rows.results;
}

async function audit(harness: Harness, runId: string): Promise<string[]> {
	const rows = await env.DB.prepare(
		"SELECT action, detail FROM audit_log WHERE owner_id = ? AND resource = ? ORDER BY audit_id",
	)
		.bind(harness.ownerId, runId)
		.all<{ action: string; detail: string }>();
	return rows.results.map((row) => `${row.action} ${row.detail}`);
}

/** Every weekday of the US window answered, so only the per-stock rule has work. */
async function finishEveryDay(harness: Harness, market: "US" | "JP", newest: string) {
	const statements = [];
	const start = Date.parse(`${newest}T00:00:00.000Z`);
	for (let offset = 0; offset <= STOCK_PRICE_LIMITS.historyDays; offset += 1) {
		const day = new Date(start - offset * 24 * HOUR);
		const weekday = day.getUTCDay();
		if (weekday === 0 || weekday === 6) continue;
		statements.push(
			env.DB.prepare(
				`INSERT INTO stock_price_day (owner_id, market, trading_on, outcome_code, bar_count, checked_at, retry_at)
				VALUES (?, ?, ?, 'stored', 1, '2026-10-10T00:00:00.000Z', NULL)`,
			).bind(harness.ownerId, market, day.toISOString().slice(0, 10)),
		);
	}
	await env.DB.batch(statements);
}

describe("stock-prices-sync scheduling (ADR-0058 §2)", () => {
	it("queues nothing for a market whose stock list is not stored", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		expect(await claim(harness, token)).toBeNull();
		expect(await jobsOfKind(harness)).toEqual([]);
	});

	it("plans the newest ten weekdays in the market's zone, one job per market", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", US_DIRECTORY);
		await seedDirectory(harness, "JP", [{ symbol: "1380", listing: "tse-standard" }]);
		// Both markets are queued in the same check (the claim order between
		// them is the candidate scan's): one job each.
		const leases = [await claimPrices(harness, token), await claimPrices(harness, token)];
		const us = leases.find((lease) => lease.market === "US");
		const jp = leases.find((lease) => lease.market === "JP");
		if (us === undefined || jp === undefined) throw new Error("expected one job per market");
		expect(us.days).toEqual(US_FIRST_DAYS);
		expect(us.histories).toEqual([]);
		expect(us.adjustmentsSince).toBeNull();
		expect(us.windowStart).toBe("2024-10-10");
		expect(await audit(harness, us.runId)).toEqual([
			"run.sync_stock_prices market=US days=10 histories=0 reason=new-days",
		]);
		// Tokyo is already on Sunday the 11th: its window starts a day later.
		expect(jp.days[0]).toBe("2026-10-09");
		expect(jp.windowStart).toBe("2024-10-11");
		// One active job per market: no second one while they run.
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		expect(
			(await jobsOfKind(harness)).map((job) => JSON.parse(job.request_json).market).sort(),
		).toEqual(["JP", "US"]);
	});

	it("stores only directory stocks' bars, under their price series, with a series row", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", US_DIRECTORY);
		const lease = await claimPrices(harness, token);
		await complete(
			harness,
			token,
			lease,
			completion(harness, lease, {
				days: [
					{
						date: "2026-10-09",
						outcome: "stored",
						bars: [
							["AAPL", 230.5, [228, 231, 227.5, 51_000_000]],
							["BRK-B", 470.25, [468, 471, 467, null]],
							// Not in the directory: never stored.
							["NOTLISTED", 10, [10, 10, 10, 1]],
						],
					},
					{ date: "2026-10-08", outcome: "no-trading", bars: [] },
					{ date: "2026-10-07", outcome: "not-yet-available", bars: [], upstreamStatus: 403 },
				],
			}),
		);
		expect(await observations(harness, "twelve-data:AAPL")).toEqual([
			{
				observed_on: "2026-10-09",
				value: 230.5,
				open_value: 228,
				high_value: 231,
				low_value: 227.5,
				volume: 51_000_000,
			},
		]);
		expect((await observations(harness, "twelve-data:BRK-B"))[0]?.volume).toBeNull();
		expect(await observations(harness, "twelve-data:NOTLISTED")).toEqual([]);
		expect(await seriesRow(harness, "twelve-data:NOTLISTED")).toBeNull();
		expect(await seriesRow(harness, "twelve-data:AAPL")).toEqual({
			provider: "twelve-data",
			symbol: "AAPL",
			title: "AAPL (NASDAQ)",
			unit: "USD",
			frequency: "daily",
			publisher: "Massive",
			source_url: "https://massive.com/",
			last_refreshed_at: harness.time.clock.nowIso(),
			retrieved_at: harness.time.clock.nowIso(),
			unavailable_code: null,
		});
		expect(await dayRows(harness, "US")).toEqual([
			// Stored one day old (within settleDays): asked once more after it
			// settles, from 2026-10-13 00:00 in New York (04:00 UTC).
			{
				trading_on: "2026-10-09",
				outcome_code: "stored",
				bar_count: 3,
				retry_at: "2026-10-13T04:00:00.000Z",
			},
			// Older than a stored day: the provider has data past it, so it is final.
			{ trading_on: "2026-10-08", outcome_code: "no-trading", bar_count: 0, retry_at: null },
			{
				trading_on: "2026-10-07",
				outcome_code: "not-yet-available",
				bar_count: 0,
				retry_at: new Date(harness.time.clock.nowMs() + 6 * HOUR).toISOString(),
			},
		]);
		const transition = await env.DB.prepare(
			`SELECT reason FROM job_transitions WHERE owner_id = ? AND run_id = ? AND to_state = 'completed'`,
		)
			.bind(harness.ownerId, lease.runId)
			.first<{ reason: string }>();
		expect(transition?.reason).toBe(
			"completion: stock-prices-synced, market=US days=3 stored=1 bars=3 histories=0 not-found=0 refetch-owed=0 backed-off=0",
		);
	});

	it("never asks a final day again and asks a not-yet-available day again after retryHours", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", US_DIRECTORY);
		const first = await claimPrices(harness, token);
		await complete(
			harness,
			token,
			first,
			completion(harness, first, {
				days: [
					{ date: "2026-10-09", outcome: "not-yet-available", bars: [] },
					{ date: "2026-10-08", outcome: "stored", bars: [["AAPL", 1, [1, 1, 1, 1]]] },
					...first.days.slice(2).map((date) => ({ date, outcome: "no-trading", bars: [] })),
				],
			}),
		);
		harness.time.advance(GAP);
		const second = await claimPrices(harness, token);
		// Older days only, and the stored day is the split watermark.
		expect(second.days[0]).toBe("2026-09-25");
		expect(second.days).not.toContain("2026-10-09");
		// No split check finished yet: every stored day is still to be checked.
		expect(second.adjustmentsSince).toBeNull();
		await complete(harness, token, second, completion(harness, second, {}));
		harness.time.advance(6 * HOUR);
		const third = await claimPrices(harness, token);
		expect(third.days[0]).toBe("2026-10-09");
	});

	it("waits SYNC_RETRY_MS after a failed job and stores nothing of it", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", US_DIRECTORY);
		const lease = await claimPrices(harness, token);
		const failed = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "SOURCE_NOT_CONFIGURED",
			retryable: false,
		});
		expect(failed.status).toBe(200);
		expect(await dayRows(harness, "US")).toEqual([]);
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(30 * MINUTE);
		const again = await claimPrices(harness, token);
		expect(again.days).toEqual(US_FIRST_DAYS);
	});

	it("stores a ten-day completion over 1 MB in chunks, every bar of every stock", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		const symbols = Array.from(
			{ length: 4_000 },
			(_, index) => `S${String(index).padStart(4, "0")}`,
		);
		// D1 caps a batch's bound values: seed the directory in slices.
		for (let start = 0; start < symbols.length; start += 500) {
			await seedDirectory(
				harness,
				"US",
				symbols.slice(start, start + 500).map((symbol) => ({ symbol, listing: "nyse" })),
			);
		}
		const lease = await claimPrices(harness, token);
		const payload = completion(harness, lease, {
			days: lease.days.map((date, dayIndex) => ({
				date,
				outcome: "stored",
				bars: symbols.map((symbol, index) => [
					symbol,
					100 + index / 100,
					[100 + index / 100, 101 + index / 100, 99 + index / 100, 1_000 + dayIndex],
				]),
			})),
		});
		expect(JSON.stringify(payload).length).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);
		await complete(harness, token, lease, payload);
		const counts = await env.DB.prepare(
			`SELECT count(*) AS bar_count, count(DISTINCT series_id) AS series_count
			FROM market_observations WHERE owner_id = ?`,
		)
			.bind(harness.ownerId)
			.first<{ bar_count: number; series_count: number }>();
		expect(counts).toEqual({ bar_count: 40_000, series_count: 4_000 });
		expect((await observations(harness, "twelve-data:S3999")).at(-1)).toMatchObject({
			observed_on: "2026-10-09",
			value: 139.99,
			volume: 1_000,
		});
	}, 60_000);

	it("refuses an answer for the other market", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", US_DIRECTORY);
		const lease = await claimPrices(harness, token);
		const response = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			completion(harness, lease, { market: "JP" }),
		);
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
	});
});

describe("per-stock histories (ADR-0058 §2)", () => {
	it("names unstored directory stocks once no day is due, Watchlist first, then by symbol", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", US_DIRECTORY);
		await finishEveryDay(harness, "US", "2026-10-10");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
				VALUES (?, 'us:ZTS', 'US', 'ZTS', 'Zoetis', '2026-10-01T00:00:00.000Z')`,
			).bind(harness.ownerId),
			// MSFT already has a filled series: not asked again.
			env.DB.prepare(
				`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
					publisher, source_url, last_refreshed_at, retrieved_at, history_checked_at)
				VALUES (?, 'twelve-data:MSFT', 'twelve-data', 'MSFT', 'MSFT (NASDAQ)', 'USD', 'daily',
					'Twelve Data', 'https://twelvedata.com/', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
					'2026-10-01T00:00:00.000Z')`,
			).bind(harness.ownerId),
			// An earlier job's split check covered the market through 2026-10-09.
			env.DB.prepare(
				`INSERT INTO stock_price_market (owner_id, market, split_checked_on)
				VALUES (?, 'US', '2026-10-09')`,
			).bind(harness.ownerId),
		]);
		const lease = await claimPrices(harness, token);
		expect(lease.days).toEqual([]);
		// The claim carries the market's split watermark (`stock_price_market`).
		expect(lease.adjustmentsSince).toBe("2026-10-09");
		expect(lease.histories).toEqual([
			{ symbol: "ZTS", from: "2024-10-10", to: "2026-10-10" },
			{ symbol: "AAPL", from: "2024-10-10", to: "2026-10-10" },
			{ symbol: "BRK-B", from: "2024-10-10", to: "2026-10-10" },
		]);
		expect(await audit(harness, lease.runId)).toEqual([
			"run.sync_stock_prices market=US days=0 histories=3 reason=unstored-stocks",
		]);
		// AAPL had an older bar inside the window the answer no longer holds.
		await env.DB.prepare(
			`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
			VALUES (?, 'twelve-data:AAPL', '2025-01-02', 99), (?, 'twelve-data:AAPL', '2024-01-02', 50)`,
		)
			.bind(harness.ownerId, harness.ownerId)
			.run();
		await complete(
			harness,
			token,
			lease,
			completion(harness, lease, {
				histories: [
					{
						symbol: "AAPL",
						reason: "requested",
						outcome: "stored",
						from: "2024-10-10",
						to: "2026-10-10",
						bars: [
							["2026-10-08", 229, [228, 230, 227, 100]],
							["2026-10-09", 230.5, [229, 231, 228, 200]],
						],
					},
					{
						symbol: "BRK-B",
						reason: "requested",
						outcome: "not-found",
						from: "2024-10-10",
						to: "2026-10-10",
						bars: [],
					},
					{
						symbol: "ZTS",
						reason: "requested",
						outcome: "stored",
						from: "2024-10-10",
						to: "2026-10-10",
						bars: [["2026-10-09", 150, [149, 151, 148, 10]]],
					},
				],
			}),
		);
		// The window is replaced; the bar before the window stays.
		expect((await observations(harness, "twelve-data:AAPL")).map((row) => row.observed_on)).toEqual(
			["2024-01-02", "2026-10-08", "2026-10-09"],
		);
		expect((await seriesRow(harness, "twelve-data:BRK-B"))?.unavailable_code).toBe(
			"SERIES_NOT_FOUND",
		);
		expect((await seriesRow(harness, "twelve-data:ZTS"))?.title).toBe("ZTS (NYSE)");
		// Every directory stock has a series now: nothing more to do, and the
		// market is not planned again at every claim.
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		expect(await jobsOfKind(harness)).toHaveLength(1);
	});

	it("records split stocks the job could not refetch, plans them first, and clears them when stored", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", US_DIRECTORY);
		await finishEveryDay(harness, "US", "2026-10-10");
		// Every directory stock already has a filled series: only owed refetches are work.
		for (const { symbol } of US_DIRECTORY) {
			await env.DB.prepare(
				`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
					publisher, source_url, history_checked_at)
				VALUES (?, ?, 'twelve-data', ?, ?, 'USD', 'daily', 'Massive', 'https://massive.com/',
					'2026-10-01T00:00:00.000Z')`,
			)
				.bind(harness.ownerId, `twelve-data:${symbol}`, symbol, symbol)
				.run();
		}
		// The newest day is still due: the job that finds the splits asks for it.
		await env.DB.prepare(
			"DELETE FROM stock_price_day WHERE owner_id = ? AND market = 'US' AND trading_on = '2026-10-09'",
		)
			.bind(harness.ownerId)
			.run();
		const first = await claimPrices(harness, token);
		expect(first.days).toEqual(["2026-10-09"]);
		expect(first.histories).toEqual([]);
		const window = { from: "2024-10-10", to: "2026-10-10" };
		await complete(
			harness,
			token,
			first,
			completion(harness, first, {
				days: [{ date: "2026-10-09", outcome: "stored", bars: [["MSFT", 1, [1, 1, 1, 1]]] }],
				// Four splits; the job refetched only AAPL (its cap), and one is not listed.
				splitSymbols: ["AAPL", "BRK-B", "NOTLISTED", "ZTS"],
				// A check reported past the window's end is clamped to it.
				splitCheckedThrough: "2026-10-12",
				histories: [
					{
						symbol: "AAPL",
						reason: "split",
						outcome: "stored",
						...window,
						bars: [["2026-10-09", 230.5, [229, 231, 228, 200]]],
					},
				],
			}),
		);
		const owed = await env.DB.prepare(
			`SELECT symbol, refetch_requested_at, retry_at FROM stock_price_history
			WHERE owner_id = ? ORDER BY symbol`,
		)
			.bind(harness.ownerId)
			.all<{ symbol: string; refetch_requested_at: string; retry_at: string | null }>();
		expect(owed.results).toEqual([
			{ symbol: "BRK-B", refetch_requested_at: harness.time.clock.nowIso(), retry_at: null },
			{ symbol: "ZTS", refetch_requested_at: harness.time.clock.nowIso(), retry_at: null },
		]);
		harness.time.advance(GAP);
		const second = await claimPrices(harness, token);
		expect(second.days).toEqual([]);
		expect(second.adjustmentsSince).toBe("2026-10-10");
		expect(second.histories).toEqual([
			{ symbol: "BRK-B", ...window },
			{ symbol: "ZTS", ...window },
		]);
		await complete(
			harness,
			token,
			second,
			completion(harness, second, {
				histories: [
					{ symbol: "BRK-B", reason: "requested", outcome: "stored", ...window, bars: [] },
				],
			}),
		);
		const left = await env.DB.prepare(
			"SELECT symbol FROM stock_price_history WHERE owner_id = ? ORDER BY symbol",
		)
			.bind(harness.ownerId)
			.all<{ symbol: string }>();
		expect(left.results).toEqual([{ symbol: "ZTS" }]);
	});

	it("never overwrites a stored series with a not-found answer", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", [{ symbol: "AAPL", listing: "nasdaq" }]);
		await finishEveryDay(harness, "US", "2026-10-10");
		const lease = await claimPrices(harness, token);
		// A concurrent writer stored AAPL meanwhile.
		await env.DB.prepare(
			`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
				publisher, source_url, last_refreshed_at, retrieved_at)
			VALUES (?, 'twelve-data:AAPL', 'twelve-data', 'AAPL', 'AAPL (NASDAQ)', 'USD', 'daily',
				'Massive', 'https://massive.com/', '2026-10-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
		)
			.bind(harness.ownerId)
			.run();
		await complete(
			harness,
			token,
			lease,
			completion(harness, lease, {
				histories: [
					{
						symbol: "AAPL",
						reason: "requested",
						outcome: "not-found",
						from: "2024-10-10",
						to: "2026-10-10",
						bars: [],
					},
				],
			}),
		);
		const row = await seriesRow(harness, "twelve-data:AAPL");
		expect(row?.unavailable_code).toBeNull();
		expect(row?.retrieved_at).toBe("2030-01-01T00:00:00.000Z");
	});

	it("never moves a newer retrieved_at backwards", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", [{ symbol: "AAPL", listing: "nasdaq" }]);
		await env.DB.prepare(
			`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
				publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code)
			VALUES (?, 'twelve-data:AAPL', 'twelve-data', 'AAPL', 'AAPL', '', 'unknown',
				'Twelve Data', 'https://twelvedata.com/', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', 'PLAN_NOT_ENTITLED')`,
		)
			.bind(harness.ownerId)
			.run();
		const lease = await claimPrices(harness, token);
		await complete(
			harness,
			token,
			lease,
			completion(harness, lease, {
				days: [{ date: "2026-10-09", outcome: "stored", bars: [["AAPL", 1, [1, 1, 1, 1]]] }],
			}),
		);
		expect(await seriesRow(harness, "twelve-data:AAPL")).toMatchObject({
			publisher: "Massive",
			unit: "USD",
			retrieved_at: "2030-01-01T00:00:00.000Z",
			last_refreshed_at: "2030-01-01T00:00:00.000Z",
			unavailable_code: null,
		});
	});
});

describe("Twelve Data hands stock series over (ADR-0058 §2)", () => {
	it("the series clean-up never deletes a directory stock's price series", async () => {
		const harness = createHarness();
		await seedDirectory(harness, "US", [{ symbol: "AAPL", listing: "nasdaq" }]);
		await seedDirectory(harness, "JP", [{ symbol: "1380", listing: "tse-standard" }]);
		const statements = [];
		for (const [seriesId, symbol] of [
			["twelve-data:AAPL", "AAPL"],
			["twelve-data:1380:JPX", "1380:JPX"],
			["twelve-data:GONE", "GONE"],
			["fred:DGS10", "DGS10"],
		] as const) {
			statements.push(
				env.DB.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url)
					VALUES (?, ?, 'twelve-data', ?, ?, 'USD', 'daily', 'x', 'https://example.test/')`,
				).bind(harness.ownerId, seriesId, symbol, symbol),
				env.DB.prepare(
					`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
					VALUES (?, ?, '2026-10-09', 1)`,
				).bind(harness.ownerId, seriesId),
			);
		}
		await env.DB.batch(statements);
		const deleted = await createD1Adapters(env.DB).market.deleteSeriesNotIn(harness.ownerId, [
			"fred:DGS10",
		]);
		expect(deleted).toBe(1);
		const left = await env.DB.prepare(
			"SELECT series_id FROM market_series WHERE owner_id = ? ORDER BY series_id",
		)
			.bind(harness.ownerId)
			.all<{ series_id: string }>();
		expect(left.results.map((row) => row.series_id)).toEqual([
			"fred:DGS10",
			"twelve-data:1380:JPX",
			"twelve-data:AAPL",
		]);
		expect(await observations(harness, "twelve-data:GONE")).toEqual([]);
		expect(await observations(harness, "twelve-data:AAPL")).toHaveLength(1);
	});

	it("the market sync no longer fetches a page's directory stock series", async () => {
		const harness = createHarness({ serverDataSync: true, serverSyncKinds: ["market-refresh"] });
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", [{ symbol: "AAPL", listing: "nasdaq" }]);
		await env.DB.prepare(
			"INSERT INTO home_dashboards (owner_id, dashboard_json, version, updated_at) VALUES (?, ?, 1, ?)",
		)
			.bind(
				harness.ownerId,
				JSON.stringify({
					schemaVersion: 2,
					widgets: [
						metricWidget("w-1", "twelve-data:AAPL"),
						metricWidget("w-2", "twelve-data:7974:JPX"),
						metricWidget("w-3", "twelve-data:SPY"),
						metricWidget("w-4", "fred:DGS10"),
					],
				}),
				harness.time.clock.nowIso(),
			)
			.run();
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error(`expected a market sync, got ${job?.kind}`);
		expect(job.series.map((series) => series.seriesId)).toEqual(["twelve-data:SPY", "fred:DGS10"]);
	});
});

function metricWidget(widgetId: string, seriesId: string) {
	return { type: "market-metric", widgetId, title: widgetId, size: "small", seriesId };
}
