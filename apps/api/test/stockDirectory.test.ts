import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import { chunkStockDirectoryRows, STOCK_DIRECTORY_CHUNK_BYTES } from "@research/adapters/sql";
import { stockDirectoryRows } from "@research/application";
import {
	type ClaimedJob,
	completeJobResponseSchema,
	MAX_REQUEST_BODY_BYTES,
	STOCK_DIRECTORY_LIMITS,
	type StockDirectoryEntry,
	stockDirectoryRefreshResponseSchema,
	stockDirectorySearchResponseSchema,
	stockDirectoryStatusResponseSchema,
	type WatchMarket,
	watchlistResponseSchema,
} from "@research/contracts";
import { rankStockSearch, STOCK_SEARCH_FOLD_VERSION } from "@research/domain";
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
import {
	generateJpEntries,
	generateQueries,
	generateUsEntries,
	type ReferenceRow,
	referenceRows,
} from "./stockDirectoryFixtures.ts";

/* ---------- helpers ---------- */

async function queueDirectory(
	harness: Harness,
	requestBody?: unknown,
	key: Record<string, string> = idempotencyKey(),
) {
	return harness.call("POST", "/watchlist/directory/refresh", requestBody, key);
}

async function status(harness: Harness) {
	const response = await harness.call("GET", "/watchlist/directory");
	expect(response.status).toBe(200);
	return body(response, stockDirectoryStatusResponseSchema);
}

async function search(harness: Harness, query: string) {
	const response = await harness.call("GET", `/watchlist/directory/search?${query}`);
	expect(response.status).toBe(200);
	return (await body(response, stockDirectorySearchResponseSchema)).hits;
}

type DirectoryLease = Extract<ClaimedJob, { kind: "stock-directory-refresh" }>;

/** Queues one market's refresh and claims it, walked to `publishing`. */
async function claimDirectory(
	harness: Harness,
	token: string,
	market: WatchMarket,
): Promise<DirectoryLease> {
	const queued = await queueDirectory(harness, { markets: [market] });
	expect(queued.status).toBe(202);
	const job = await claim(harness, token);
	if (job?.kind !== "stock-directory-refresh") throw new Error("expected a directory job");
	expect(job.market).toBe(market);
	await advanceToPublishing(harness, token, job);
	return job;
}

function directoryCompletion(
	lease: { readonly leaseGeneration: number },
	market: WatchMarket,
	entries: readonly StockDirectoryEntry[],
	asOf: string | null,
	fetchedAt: string,
) {
	return {
		outcome: "stock-directory-refreshed",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		market,
		asOf,
		fetchedAt,
		entries: [...entries],
	};
}

/** Stores one market's list through the real queue → claim → complete path. */
async function storeDirectory(
	harness: Harness,
	token: string,
	market: WatchMarket,
	entries: readonly StockDirectoryEntry[],
	asOf: string | null = null,
) {
	const lease = await claimDirectory(harness, token, market);
	const response = await harness.runner(
		token,
		`/jobs/${lease.runId}/complete`,
		directoryCompletion(lease, market, entries, asOf, harness.time.clock.nowIso()),
	);
	expect(response.status).toBe(200);
	expect((await body(response, completeJobResponseSchema)).state).toBe("completed");
	return lease;
}

async function storedCount(ownerId: string, market: WatchMarket): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM stock_directory WHERE owner_id = ? AND market = ?",
	)
		.bind(ownerId, market)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

const APPLE: StockDirectoryEntry = { symbol: "AAPL", name: "Apple Inc.", listing: "nasdaq" };
const TOYOTA: StockDirectoryEntry = {
	symbol: "7203",
	name: "TOYOTA MOTOR CORPORATION",
	localName: "トヨタ自動車",
	listing: "tse-prime",
};

/** A valid US list: Apple plus generated filler up to the contract floor. */
function usList(extra: readonly StockDirectoryEntry[] = [APPLE]): StockDirectoryEntry[] {
	const symbols = new Set(extra.map((entry) => entry.symbol));
	const filler = generateUsEntries(11, STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 50).filter(
		(entry) => !symbols.has(entry.symbol),
	);
	return [...extra, ...filler.slice(0, STOCK_DIRECTORY_LIMITS.minEntriesPerMarket)];
}

/** A valid JP list: Toyota plus filler that never mentions Toyota (so searches for it are exact). */
function jpList(extra: readonly StockDirectoryEntry[] = [TOYOTA]): StockDirectoryEntry[] {
	const symbols = new Set(extra.map((entry) => entry.symbol));
	const filler = generateJpEntries(12, STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 400).filter(
		(entry) =>
			!symbols.has(entry.symbol) &&
			!entry.name.includes("Toyota") &&
			!(entry.localName ?? "").includes("トヨタ"),
	);
	return [...extra, ...filler.slice(0, STOCK_DIRECTORY_LIMITS.minEntriesPerMarket)];
}

/**
 * Seeds rows straight into the table for one owner — with the keys the
 * completion path computes — so the ranking test can hold rows no single
 * completion could (both markets' edge cases in a few dozen rows).
 */
async function seedDirectly(ownerId: string, rows: readonly ReferenceRow[]): Promise<void> {
	const statements = (["US", "JP"] as const).flatMap((market) => {
		const stored = stockDirectoryRows(
			market,
			rows
				.filter((row) => row.market === market)
				.map((row) => ({
					symbol: row.symbol,
					name: row.name,
					...(row.localName === null ? {} : { localName: row.localName }),
					listing: market === "US" ? ("nasdaq" as const) : ("tse-prime" as const),
				})),
		);
		if (stored.length === 0) return [];
		return [
			env.DB.prepare(
				`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
					symbol_key, name_key, local_name_key, search_key)
				SELECT ?, ?, json_extract(value, '$.symbol'), json_extract(value, '$.name'),
					json_extract(value, '$.localName'), json_extract(value, '$.listing'),
					json_extract(value, '$.symbolKey'), json_extract(value, '$.nameKey'),
					json_extract(value, '$.localNameKey'), json_extract(value, '$.searchKey')
				FROM json_each(?)`,
			).bind(ownerId, market, JSON.stringify(stored)),
		];
	});
	await env.DB.batch(statements);
}

const hitKey = (row: { readonly market: string; readonly symbol: string }) =>
	`${row.market}:${row.symbol}`;

/** The SQL hits and the reference hits for one query, as comparable keys. */
async function bothRankings(
	ownerId: string,
	rows: readonly ReferenceRow[],
	text: string,
	market: WatchMarket | null,
	limit: number,
) {
	const persistence = createD1Adapters(env.DB);
	const sql = await persistence.stockDirectory.search(ownerId, { text, market, limit });
	const scoped = market === null ? rows : rows.filter((row) => row.market === market);
	return {
		sql: sql.map(hitKey),
		reference: rankStockSearch(scoped, text, limit).map(hitKey),
	};
}

/* ---------- refresh queue and status ---------- */

describe("stock directory status and refresh queue (ADR-0034)", () => {
	it("reports both markets, US then JP, with nothing stored yet", async () => {
		const harness = createHarness();
		const current = await status(harness);
		expect(current.markets).toEqual([
			{
				market: "US",
				sourceId: "sec",
				publisher: "U.S. Securities and Exchange Commission (SEC)",
				sourceUrl: "https://www.sec.gov/files/company_tickers_exchange.json",
				entryCount: 0,
				asOf: null,
				retrievedAt: null,
				activeRunId: null,
				activeRunState: null,
				lastFailure: null,
			},
			{
				market: "JP",
				sourceId: "jpx",
				publisher: "Japan Exchange Group (JPX)",
				sourceUrl: "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html",
				entryCount: 0,
				asOf: null,
				retrievedAt: null,
				activeRunId: null,
				activeRunState: null,
				lastFailure: null,
			},
		]);
	});

	it("queues one run per market and reuses a market's active run", async () => {
		const harness = createHarness();
		// No body refreshes both markets.
		const first = await queueDirectory(harness);
		expect(first.status).toBe(202);
		const queued = (await body(first, stockDirectoryRefreshResponseSchema)).runs;
		expect(queued.map((run) => run.market)).toEqual(["US", "JP"]);
		expect(new Set(queued.map((run) => run.runId)).size).toBe(2);

		// A new request (new key) while both are active queues nothing new.
		const again = await queueDirectory(harness, { markets: ["JP", "US"] });
		expect(again.status).toBe(202);
		const reused = (await body(again, stockDirectoryRefreshResponseSchema)).runs;
		expect(reused).toEqual([
			{ market: "JP", runId: queued[1]?.runId },
			{ market: "US", runId: queued[0]?.runId },
		]);
		const jobs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = 'stock-directory-refresh'",
		)
			.bind(harness.ownerId)
			.first<{ n: number }>();
		expect(jobs?.n).toBe(2);

		const current = await status(harness);
		expect(current.markets.map((market) => market.activeRunId)).toEqual(
			queued.map((run) => run.runId),
		);
		expect(current.markets.map((market) => market.activeRunState)).toEqual(["pending", "pending"]);
	});

	it("queues only the requested market", async () => {
		const harness = createHarness();
		const response = await queueDirectory(harness, { markets: ["JP"] });
		expect(response.status).toBe(202);
		const runs = (await body(response, stockDirectoryRefreshResponseSchema)).runs;
		expect(runs.map((run) => run.market)).toEqual(["JP"]);
		const current = await status(harness);
		expect(current.markets[0]?.activeRunId).toBeNull();
		expect(current.markets[1]?.activeRunId).toBe(runs[0]?.runId);
	});

	it("replays a key, and refuses the same key for a different market set", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const key = idempotencyKey();
		const first = await queueDirectory(harness, { markets: ["US"] }, key);
		const runId = (await body(first, stockDirectoryRefreshResponseSchema)).runs[0]?.runId;
		// Finish the run, so the replay is answered from the stored key, not
		// from the active-run reuse.
		const job = await claim(harness, token);
		if (job?.kind !== "stock-directory-refresh") throw new Error("expected a directory job");
		await harness.runner(token, `/jobs/${job.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			failureCode: "DIRECTORY_SOURCE_FAILED",
			retryable: false,
		});
		const replay = await queueDirectory(harness, { markets: ["US"] }, key);
		expect(replay.status).toBe(202);
		expect((await body(replay, stockDirectoryRefreshResponseSchema)).runs).toEqual([
			{ market: "US", runId },
		]);
		const reused = await queueDirectory(harness, { markets: ["US", "JP"] }, key);
		expect(reused.status).toBe(409);
		expect(await errorCode(reused)).toBe("IDEMPOTENCY_KEY_REUSED");
	});

	it("refuses a cross-site refresh (CSRF)", async () => {
		const harness = createHarness();
		const response = await harness.raw("POST", "/watchlist/directory/refresh", {
			body: {},
			headers: { Origin: "https://evil.example", ...idempotencyKey() },
		});
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe("CSRF_REJECTED");
	});

	it("requires an idempotency key and a valid body", async () => {
		const harness = createHarness();
		const noKey = await harness.call("POST", "/watchlist/directory/refresh", {});
		expect(noKey.status).toBe(400);
		expect(await errorCode(noKey)).toBe("VALIDATION_FAILED");
		for (const invalid of [{ markets: ["US", "US"] }, { markets: [] }, { markets: ["EU"] }, []]) {
			const response = await queueDirectory(harness, invalid);
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe("VALIDATION_FAILED");
		}
		const empty = await queueDirectory(harness, {});
		expect(empty.status).toBe(202);
	});

	it("reports a market's failure without touching its stored list", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await storeDirectory(harness, token, "US", usList());
		const lease = await claimDirectory(harness, token, "US");
		harness.time.advance(60_000);
		const failed = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "DIRECTORY_NOT_CONFIGURED",
			retryable: false,
		});
		expect(failed.status).toBe(200);
		const current = await status(harness);
		expect(current.markets[0]).toMatchObject({
			market: "US",
			entryCount: STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1,
			activeRunId: null,
			lastFailure: {
				state: "failed",
				code: "DIRECTORY_NOT_CONFIGURED",
				at: harness.time.clock.nowIso(),
			},
		});
		// The JP line never sees the US failure.
		expect(current.markets[1]?.lastFailure).toBeNull();
		expect(await storedCount(harness.ownerId, "US")).toBe(
			STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1,
		);
	});

	it("clears a failure on a later success by the API's own times; cancels never count", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const fetchedBeforeFailure = harness.time.clock.nowIso();
		const failRun = async (code: string, failureUpstreamStatus: number | null = null) => {
			const lease = await claimDirectory(harness, token, "US");
			harness.time.advance(60_000);
			const failed = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
				outcome: "failed",
				leaseGeneration: lease.leaseGeneration,
				usage: USAGE,
				failureCode: code,
				...(failureUpstreamStatus === null ? {} : { failureUpstreamStatus }),
				retryable: false,
			});
			expect(failed.status).toBe(200);
			return harness.time.clock.nowIso();
		};
		const cancelRun = async () => {
			const queued = await queueDirectory(harness, { markets: ["US"] });
			const runId = (await body(queued, stockDirectoryRefreshResponseSchema)).runs[0]?.runId;
			harness.time.advance(60_000);
			const cancelled = await harness.call(
				"POST",
				`/research-runs/${runId}/cancel`,
				undefined,
				idempotencyKey(),
			);
			expect(cancelled.status).toBe(200);
		};
		const usFailure = async () => (await status(harness)).markets[0]?.lastFailure ?? null;

		await failRun("DIRECTORY_SOURCE_FAILED");
		expect(await usFailure()).toMatchObject({ code: "DIRECTORY_SOURCE_FAILED" });
		// The runner says it fetched BEFORE the failure; the API completed the
		// run after it, and only the API's time counts.
		harness.time.advance(60_000);
		const lease = await claimDirectory(harness, token, "US");
		const stored = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			directoryCompletion(lease, "US", usList(), null, fetchedBeforeFailure),
		);
		expect(stored.status).toBe(200);
		expect(await usFailure()).toBeNull();
		await cancelRun();
		expect(await usFailure()).toBeNull();

		// Success, then a failure: the failure is current, and a later cancel
		// neither replaces nor hides it.
		const failedAt = await failRun("DIRECTORY_RATE_LIMITED", 429);
		await cancelRun();
		expect(await usFailure()).toEqual({
			state: "failed",
			code: "DIRECTORY_RATE_LIMITED",
			// SEC's own 429, stored and returned unchanged (§4a).
			upstreamStatus: 429,
			at: failedAt,
		});
	});

	it("refuses a reused key for another market set while the first run is active", async () => {
		const harness = createHarness();
		const key = idempotencyKey();
		const first = await queueDirectory(harness, { markets: ["US"] }, key);
		expect(first.status).toBe(202);
		for (const markets of [["US", "JP"], ["JP"]]) {
			const reused = await queueDirectory(harness, { markets }, key);
			expect(reused.status, markets.join(",")).toBe(409);
			expect(await errorCode(reused)).toBe("IDEMPOTENCY_KEY_REUSED");
		}
		expect((await status(harness)).markets[1]?.activeRunId).toBeNull();
	});

	it("queues no market when admission refuses one of them (all or nothing)", async () => {
		const harness = createHarness();
		// Spend 29 of the 30 hourly job allowances, cancelling each run so the
		// unfinished-run cap is not what refuses.
		for (let index = 0; index < 29; index += 1) {
			const queued = await queueDirectory(harness, { markets: ["US"] });
			expect(queued.status).toBe(202);
			const runId = (await body(queued, stockDirectoryRefreshResponseSchema)).runs[0]?.runId;
			await harness.call("POST", `/research-runs/${runId}/cancel`, undefined, idempotencyKey());
		}
		const both = await queueDirectory(harness, { markets: ["US", "JP"] });
		expect(both.status).toBe(429);
		expect(await errorCode(both)).toBe("RATE_LIMITED");
		const current = await status(harness);
		expect(current.markets.map((market) => market.activeRunId)).toEqual([null, null]);
	});
});

/* ---------- completion commit ---------- */

describe("stock directory completion (ADR-0034)", () => {
	it("stores a market's list, its meta row and search keys", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await storeDirectory(harness, token, "JP", jpList(), "2026-09-30");
		const current = await status(harness);
		expect(current.markets[1]).toMatchObject({
			market: "JP",
			entryCount: STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1,
			asOf: "2026-09-30",
			retrievedAt: harness.time.clock.nowIso(),
			activeRunId: null,
			lastFailure: null,
		});
		expect(current.markets[0]?.entryCount).toBe(0);
		const row = await env.DB.prepare(
			"SELECT * FROM stock_directory WHERE owner_id = ? AND market = 'JP' AND symbol = '7203'",
		)
			.bind(harness.ownerId)
			.first();
		expect(row).toEqual({
			owner_id: harness.ownerId,
			market: "JP",
			symbol: "7203",
			name: "TOYOTA MOTOR CORPORATION",
			local_name: "トヨタ自動車",
			listing: "tse-prime",
			symbol_key: "7203",
			name_key: "toyota motor corporation",
			local_name_key: "トヨタ自動車",
			search_key: "7203\ntoyota motor corporation\nトヨタ自動車",
		});
		const audit = await env.DB.prepare(
			"SELECT reason FROM job_transitions WHERE owner_id = ? AND to_state = 'completed'",
		)
			.bind(harness.ownerId)
			.first<{ reason: string }>();
		expect(audit?.reason).toBe(
			`completion: stock-directory-refreshed, market=JP entries=${STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1}`,
		);
	});

	it("replaces only that market's rows, all of them", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await storeDirectory(harness, token, "US", usList());
		await storeDirectory(harness, token, "JP", jpList());
		expect((await search(harness, "q=aapl")).map(hitKey)).toContain("US:AAPL");
		// The new US list drops Apple and renames nothing else.
		const renamed: StockDirectoryEntry = { symbol: "ZZZZ", name: "Newco Ltd", listing: "nyse" };
		await storeDirectory(harness, token, "US", usList([renamed]));
		expect((await search(harness, "q=AAPL")).map(hitKey)).not.toContain("US:AAPL");
		expect((await search(harness, "q=newco")).map(hitKey)).toEqual(["US:ZZZZ"]);
		expect(await storedCount(harness.ownerId, "US")).toBe(
			STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1,
		);
		// JP is untouched.
		expect((await search(harness, "q=7203")).map(hitKey)).toEqual(["JP:7203"]);
	});

	it("stores a list at the per-market maximum through several insert chunks", {
		timeout: 60_000,
	}, async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		// The largest list a completion can carry: 10,000 rows with names
		// padded until the request body nearly reaches its 1 MB cap. Stored
		// with its keys, that is ~1.9 MB of bound JSON — several chunks.
		const entries = generateUsEntries(21, STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket).map(
			(entry) => ({
				...entry,
				name: `${entry.name} ${"Holdings Group ".repeat(4)}`.slice(0, 46).trim(),
			}),
		);
		const payloadBytes = new TextEncoder().encode(
			JSON.stringify(
				directoryCompletion(
					{ leaseGeneration: 1 },
					"US",
					entries,
					null,
					harness.time.clock.nowIso(),
				),
			),
		).length;
		expect(payloadBytes).toBeGreaterThan(900_000);
		expect(payloadBytes).toBeLessThan(MAX_REQUEST_BODY_BYTES);
		const chunks = chunkStockDirectoryRows(stockDirectoryRows("US", entries));
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		for (const chunk of chunks) {
			expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(
				STOCK_DIRECTORY_CHUNK_BYTES,
			);
		}
		await storeDirectory(harness, token, "US", entries);
		expect(await storedCount(harness.ownerId, "US")).toBe(
			STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket,
		);
		const last = entries[entries.length - 1];
		if (last === undefined) throw new Error("no entries");
		const found = await search(harness, `q=${encodeURIComponent(last.symbol)}&limit=20`);
		expect(found.map(hitKey)).toContain(`US:${last.symbol}`);
		expect((await status(harness)).markets[0]?.entryCount).toBe(
			STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket,
		);
	});

	it("changes nothing when the job compare-and-set loses (stale lease)", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await storeDirectory(harness, token, "US", usList());
		const lease = await claimDirectory(harness, token, "US");
		const persistence = createD1Adapters(env.DB);
		const job = await persistence.jobs.get(harness.ownerId, lease.runId);
		if (job === null) throw new Error("job missing");
		const stale = await persistence.unitOfWork.commitCompletion(
			harness.ownerId,
			{
				runId: lease.runId,
				// One version behind: exactly what a concurrent write leaves.
				expectedVersion: job.version - 1,
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
				marketSeries: [],
				earnings: [],
				google: null,
				notebook: null,
				notebookTurn: null,
				stockDirectory: {
					market: "US",
					asOf: "2026-01-01",
					retrievedAt: "2026-01-01T00:00:00.000Z",
					foldVersion: STOCK_SEARCH_FOLD_VERSION,
					rows: stockDirectoryRows("US", [
						{ symbol: "NEW", name: "Never Stored", listing: "nyse" },
					]),
				},
			},
		);
		expect(stale.kind).toBe("job-conflict");
		expect(await storedCount(harness.ownerId, "US")).toBe(
			STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1,
		);
		const current = await status(harness);
		expect(current.markets[0]?.asOf).toBeNull();
		expect(current.markets[0]?.activeRunId).toBe(lease.runId);
		expect((await search(harness, "q=AAPL")).map(hitKey)).toEqual(["US:AAPL"]);
	});

	it("rejects a stale generation, a wrong market and a list below the floor", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const lease = await claimDirectory(harness, token, "US");
		const now = harness.time.clock.nowIso();
		const stale = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			directoryCompletion(
				{ leaseGeneration: lease.leaseGeneration + 1 },
				"US",
				usList(),
				null,
				now,
			),
		);
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("STALE_LEASE");
		const wrongMarket = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			directoryCompletion(lease, "JP", jpList(), null, now),
		);
		expect(wrongMarket.status).toBe(400);
		expect(await errorCode(wrongMarket)).toBe("VALIDATION_FAILED");
		const tooFew = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			directoryCompletion(lease, "US", [APPLE], null, now),
		);
		expect(tooFew.status).toBe(400);
		expect(await storedCount(harness.ownerId, "US")).toBe(0);
		expect(await storedCount(harness.ownerId, "JP")).toBe(0);
		// The lease is still good: the right list completes, and a duplicate
		// completion replays without writing twice.
		const payload = directoryCompletion(lease, "US", usList(), null, now);
		const first = await harness.runner(token, `/jobs/${lease.runId}/complete`, payload);
		expect((await body(first, completeJobResponseSchema)).replayed).toBe(false);
		const replay = await harness.runner(token, `/jobs/${lease.runId}/complete`, payload);
		expect((await body(replay, completeJobResponseSchema)).replayed).toBe(true);
		expect(await storedCount(harness.ownerId, "US")).toBe(
			STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1,
		);
	});

	it("refuses a directory outcome for another kind of job", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const refresh = await harness.call("POST", "/home/refresh", undefined, idempotencyKey());
		expect(refresh.status).toBe(202);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		await advanceToPublishing(harness, token, job);
		const response = await harness.runner(
			token,
			`/jobs/${job.runId}/complete`,
			directoryCompletion(job, "US", usList(), null, harness.time.clock.nowIso()),
		);
		expect(response.status).toBe(400);
		expect(await storedCount(harness.ownerId, "US")).toBe(0);
	});
});

/* ---------- search and adding a stock ---------- */

describe("stock directory search (ADR-0034)", () => {
	it("re-keys a market stored under another fold version before answering", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await storeDirectory(harness, token, "US", usList());
		await storeDirectory(harness, token, "JP", jpList());
		const versions = async () =>
			(
				await env.DB.prepare(
					"SELECT market, fold_version FROM stock_directory_meta WHERE owner_id = ? ORDER BY market",
				)
					.bind(harness.ownerId)
					.all<{ market: string; fold_version: number }>()
			).results;
		expect(await versions()).toEqual([
			{ market: "JP", fold_version: STOCK_SEARCH_FOLD_VERSION },
			{ market: "US", fold_version: STOCK_SEARCH_FOLD_VERSION },
		]);
		// Simulate lists stored by an older fold: keys that no query matches.
		await env.DB.batch(
			(["US", "JP"] as const).flatMap((market) => [
				env.DB.prepare(
					`UPDATE stock_directory SET symbol_key = '-', name_key = '-', local_name_key = '-',
						search_key = '-' WHERE owner_id = ? AND market = ?`,
				).bind(harness.ownerId, market),
				env.DB.prepare(
					"UPDATE stock_directory_meta SET fold_version = ? WHERE owner_id = ? AND market = ?",
				).bind(STOCK_SEARCH_FOLD_VERSION - 1, harness.ownerId, market),
			]),
		);
		// Searching JP re-keys JP only, and the very first answer is right.
		expect((await search(harness, "q=%E3%81%A8%E3%82%88%E3%81%9F&market=JP")).map(hitKey)).toEqual([
			"JP:7203",
		]);
		expect(await versions()).toEqual([
			{ market: "JP", fold_version: STOCK_SEARCH_FOLD_VERSION },
			{ market: "US", fold_version: STOCK_SEARCH_FOLD_VERSION - 1 },
		]);
		const toyota = await env.DB.prepare(
			"SELECT search_key FROM stock_directory WHERE owner_id = ? AND market = 'JP' AND symbol = '7203'",
		)
			.bind(harness.ownerId)
			.first<{ search_key: string }>();
		expect(toyota?.search_key).toBe("7203\ntoyota motor corporation\nトヨタ自動車");
		const stale = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM stock_directory WHERE owner_id = ? AND search_key = '-'",
		)
			.bind(harness.ownerId)
			.first<{ n: number }>();
		expect(stale?.n).toBe(STOCK_DIRECTORY_LIMITS.minEntriesPerMarket + 1);
		// A search over both markets re-keys US too.
		expect((await search(harness, "q=aapl")).map(hitKey)).toEqual(["US:AAPL"]);
		expect((await versions()).map((row) => row.fold_version)).toEqual([
			STOCK_SEARCH_FOLD_VERSION,
			STOCK_SEARCH_FOLD_VERSION,
		]);
	});

	it("writes re-computed keys only onto rows whose names they were computed from", async () => {
		const ownerId = `owner-rekey-${crypto.randomUUID()}`;
		await seedDirectly(ownerId, [
			{ market: "JP", symbol: "7203", name: "TOYOTA MOTOR CORPORATION", localName: "トヨタ自動車" },
		]);
		await env.DB.prepare(
			"INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at, fold_version) VALUES (?, 'JP', 1, NULL, '2026-10-01T00:00:00.000Z', 1)",
		)
			.bind(ownerId)
			.run();
		const persistence = createD1Adapters(env.DB);
		// Keys computed from a name the row no longer has (a list replaced
		// between the read and the write) must not land on it.
		await persistence.stockDirectory.storeKeys(ownerId, {
			market: "JP",
			rows: stockDirectoryRows("JP", [
				{ symbol: "7203", name: "Old Name", localName: "旧名", listing: "tse-prime" },
			]),
			fromVersion: 1,
			toVersion: STOCK_SEARCH_FOLD_VERSION,
		});
		const row = await env.DB.prepare(
			"SELECT name_key FROM stock_directory WHERE owner_id = ? AND symbol = '7203'",
		)
			.bind(ownerId)
			.first<{ name_key: string }>();
		expect(row?.name_key).toBe("toyota motor corporation");
		const meta = await persistence.stockDirectory.listMeta(ownerId);
		expect(meta[0]?.foldVersion).toBe(STOCK_SEARCH_FOLD_VERSION);
	});

	it("finds by name, symbol, kana and full-width text and marks watched stocks", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await storeDirectory(harness, token, "US", usList());
		await storeDirectory(harness, token, "JP", jpList());
		// Generated filler names contain "Apple" too; the symbol is unambiguous.
		expect(await search(harness, "q=aapl")).toContainEqual({
			stockId: "us:AAPL",
			market: "US",
			symbol: "AAPL",
			name: "Apple Inc.",
			localName: null,
			listing: "nasdaq",
			registered: false,
		});
		for (const query of ["トヨタ", "とよた", "toyota", "7203", "７２０３", "ＴＯＹＯＴＡ"]) {
			// US filler names say "Toyota" too: the market filter keeps this exact.
			const hits = await search(harness, `q=${encodeURIComponent(query)}&market=JP`);
			expect(hits.map(hitKey), query).toEqual(["JP:7203"]);
		}
		// A form-encoded space ("+", what URLSearchParams writes) separates terms.
		const params = new URLSearchParams({ q: "toyota motor", market: "JP" });
		expect(params.toString()).toContain("+");
		expect((await search(harness, params.toString())).map(hitKey)).toEqual(["JP:7203"]);
		const added = await harness.call("POST", "/watchlist/stocks", { market: "JP", symbol: "7203" });
		expect(added.status).toBe(200);
		const [toyota] = await search(harness, "q=7203&market=JP&limit=1");
		expect(toyota).toMatchObject({ stockId: "jp:7203", registered: true });
		expect(await search(harness, "q=7203&market=US")).toEqual([]);
	});

	it("returns nothing before any list is stored", async () => {
		const harness = createHarness();
		expect(await search(harness, "q=apple")).toEqual([]);
	});

	it("validates the query string", async () => {
		const harness = createHarness();
		for (const query of [
			"",
			"q=",
			"q=%20%20",
			`q=${"a".repeat(STOCK_DIRECTORY_LIMITS.maxQueryChars + 1)}`,
			"q=a&market=EU",
			"q=a&limit=0",
			`q=a&limit=${STOCK_DIRECTORY_LIMITS.maxResults + 1}`,
			"q=a&other=1",
		]) {
			const response = await harness.call("GET", `/watchlist/directory/search?${query}`);
			expect(response.status, query).toBe(400);
			expect(await errorCode(response)).toBe("VALIDATION_FAILED");
		}
	});

	it("stores the directory's English name when a listed stock is added", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await storeDirectory(harness, token, "JP", jpList());
		const added = await body(
			await harness.call("POST", "/watchlist/stocks", { market: "JP", symbol: "7203" }),
			watchlistResponseSchema,
		);
		expect(added.stocks[0]).toMatchObject({ stockId: "jp:7203", name: "TOYOTA MOTOR CORPORATION" });
		// A stock outside the directory keeps a null name for the earnings
		// refresh to fill.
		const unlisted = await body(
			await harness.call("POST", "/watchlist/stocks", { market: "US", symbol: "AAPL" }),
			watchlistResponseSchema,
		);
		expect(unlisted.stocks[1]).toMatchObject({ stockId: "us:AAPL", name: null });
	});
});

/* ---------- SQL ranking ≡ domain reference ---------- */

/**
 * Rows chosen to hit every rule of the ranking: exact and prefix symbols of
 * different lengths, the same symbol in both markets (impossible from real
 * lists, whose symbol shapes differ by market, but the tie rule still holds),
 * name and local-name prefixes, kana in all forms, full-width text, and
 * punctuation that must match literally.
 */
const CURATED: readonly ReferenceRow[] = [
	{ market: "US", symbol: "A", name: "Agilent Technologies, Inc.", localName: null },
	{ market: "US", symbol: "AA", name: "Alcoa Corp", localName: null },
	{ market: "US", symbol: "AAL", name: "American Airlines Group Inc.", localName: null },
	{ market: "US", symbol: "AAPL", name: "Apple Inc.", localName: null },
	{ market: "US", symbol: "APLE", name: "Apple Hospitality REIT, Inc.", localName: null },
	{ market: "US", symbol: "APP", name: "AppLovin Corp", localName: null },
	{ market: "US", symbol: "PAPL", name: "Pineapple Energy", localName: null },
	{ market: "US", symbol: "BRK.B", name: "Berkshire Hathaway Inc", localName: null },
	{ market: "US", symbol: "BRK-A", name: "BERKSHIRE HATHAWAY INC", localName: null },
	{ market: "US", symbol: "T", name: "AT&T Inc.", localName: null },
	{ market: "US", symbol: "TM", name: "Toyota Motor Corp/", localName: null },
	{ market: "US", symbol: "SONY", name: "Sony Group Corp", localName: null },
	{ market: "US", symbol: "X", name: "United States Steel Corp", localName: null },
	{ market: "US", symbol: "XYZ", name: "Block, Inc.", localName: null },
	{ market: "US", symbol: "PCT", name: "100% Pure_Chars Inc", localName: null },
	{ market: "US", symbol: "NUL", name: "Nul\u0000Byte Co", localName: null },
	{ market: "US", symbol: "EMJ", name: "Emoji 😀 Corp", localName: null },
	{ market: "US", symbol: "WIDE", name: "ＷＩＤＥ Ｈｏｌｄｉｎｇｓ １", localName: null },
	{ market: "US", symbol: "1301", name: "Cross Market Tie Inc", localName: null },
	{ market: "JP", symbol: "1301", name: "KYOKUYO CO.,LTD.", localName: "極洋" },
	{ market: "US", symbol: "130A", name: "Cross Market Letter Inc", localName: null },
	{
		market: "JP",
		symbol: "130A",
		name: "Veritas In Silico Inc.",
		localName: "ベリタス・イン・シリコ",
	},
	{ market: "JP", symbol: "7203", name: "TOYOTA MOTOR CORPORATION", localName: "トヨタ自動車" },
	{ market: "JP", symbol: "7267", name: "HONDA MOTOR CO.,LTD.", localName: "本田技研工業" },
	{ market: "JP", symbol: "6758", name: "Sony Group Corporation", localName: "ソニーグループ" },
	{
		market: "JP",
		symbol: "8306",
		name: "Mitsubishi UFJ Financial Group,Inc.",
		localName: "三菱ＵＦＪフィナンシャル・グループ",
	},
	{
		market: "JP",
		symbol: "9432",
		name: "NIPPON TELEGRAPH AND TELEPHONE CORPORATION",
		localName: "日本電信電話",
	},
	{
		market: "JP",
		symbol: "9613",
		name: "NTT DATA GROUP CORPORATION",
		localName: "ＮＴＴデータグループ",
	},
	{ market: "JP", symbol: "7182", name: "JAPAN POST BANK Co.,Ltd.", localName: "ゆうちょ銀行" },
	{ market: "JP", symbol: "8035", name: "Tokyo Electron Limited", localName: "東京エレクトロン" },
	{ market: "JP", symbol: "7951", name: "YAMAHA CORPORATION", localName: "ヤマハ" },
	{ market: "JP", symbol: "6501", name: "Hitachi,Ltd.", localName: "日立製作所" },
	{ market: "JP", symbol: "6503", name: "Mitsubishi Electric Corporation", localName: "三菱電機" },
	{
		market: "JP",
		symbol: "4502",
		name: "Takeda Pharmaceutical Company Limited",
		localName: "武田薬品工業",
	},
	{ market: "JP", symbol: "2914", name: "JAPAN TOBACCO INC.", localName: "ＪＴ" },
	{ market: "JP", symbol: "9984", name: "SoftBank Group Corp.", localName: "ソフトバンクグループ" },
	{ market: "JP", symbol: "3778", name: "SAKURA internet Inc.", localName: "さくらインターネット" },
	{ market: "JP", symbol: "4689", name: "LY Corporation", localName: "ＬＩＮＥヤフー" },
	{ market: "JP", symbol: "6981", name: "Murata Manufacturing Co., Ltd.", localName: "村田製作所" },
	{ market: "JP", symbol: "7974", name: "Nintendo Co., Ltd.", localName: "任天堂" },
	{ market: "JP", symbol: "9101", name: "Nippon Yusen Kabushiki Kaisha", localName: "日本郵船" },
	{
		market: "JP",
		symbol: "3382",
		name: "Seven & i Holdings Co., Ltd.",
		localName: "セブン＆アイ・ホールディングス",
	},
	{ market: "JP", symbol: "2501", name: "Sapporo Holdings Limited", localName: "ｻｯﾎﾟﾛﾎｰﾙﾃﾞｨﾝｸﾞｽ" },
];

const CURATED_QUERIES: readonly string[] = [
	"a",
	"A",
	"aa",
	"aapl",
	"AAPL",
	"ａａｐｌ",
	"apple",
	"Apple Inc",
	"app",
	"apple hosp",
	"inc apple",
	"pl",
	"brk",
	"brk.b",
	"BRK-A",
	"berkshire  hathaway",
	"t",
	"T",
	"at&t",
	"&",
	"%",
	"_",
	"100%",
	"toyota",
	"Toyota motor",
	"トヨタ",
	"とよた",
	"ﾄﾖﾀ",
	"自動車",
	"とよた　じどうしゃ",
	"トヨタ 自動車",
	"sony",
	"ソニー",
	"そにー",
	"1301",
	"130",
	"130a",
	"130A",
	"13",
	"1",
	"7",
	"72",
	"7203",
	"７２０３",
	"ufj",
	"ＵＦＪ",
	"三菱",
	"三菱 ufj",
	"ntt",
	"ＮＴＴ",
	"ゆうちょ",
	"ユウチョ",
	"さくら",
	"サクラ",
	"wide",
	"ｗｉｄｅ",
	"holdings 1",
	"サッポロ",
	"ｻｯﾎﾟﾛ",
	"さっぽろ",
	"ホールディングス",
	"セブン＆アイ",
	"セブン&アイ",
	"corp",
	"corporation",
	"group",
	"inc",
	"co., ltd.",
	"x",
	"xyz",
	"zzz",
	"nothing matches",
	"a b c d e f",
	"日本",
	"electr",
	"   apple   ",
	"\tsony\n",
	"a　a",
	".",
	"-",
	",",
	"/",
	"l\u0000b",
	"\u0000",
	"byte",
	"😀",
	"emoji 😀",
	"😀 corp",
];

describe("stock directory ranking: SQL equals rankStockSearch (ADR-0034 section 6)", () => {
	it("matches the reference on curated rows and queries, for every market filter and limit", async () => {
		const ownerId = `owner-ranking-${crypto.randomUUID()}`;
		await seedDirectly(ownerId, CURATED);
		let compared = 0;
		for (const query of CURATED_QUERIES) {
			for (const market of [null, "US", "JP"] as const) {
				for (const limit of [1, 3, STOCK_DIRECTORY_LIMITS.maxResults]) {
					const { sql, reference } = await bothRankings(ownerId, CURATED, query, market, limit);
					expect(sql, `${JSON.stringify(query)} market=${market} limit=${limit}`).toEqual(
						reference,
					);
					compared += 1;
				}
			}
		}
		expect(compared).toBe(CURATED_QUERIES.length * 9);
		// The cross-market tie: same symbol, so market decides (JP before US).
		const tie = await bothRankings(ownerId, CURATED, "1301", null, 5);
		expect(tie.sql).toEqual(["JP:1301", "US:1301"]);
	});

	it("matches the reference on 400 seeded generated queries", async () => {
		const ownerId = `owner-generated-${crypto.randomUUID()}`;
		const rows = [
			...CURATED,
			...referenceRows("US", generateUsEntries(31, 300)),
			...referenceRows("JP", generateJpEntries(32, 300)),
		].filter(
			(row, index, all) =>
				all.findIndex((other) => other.market === row.market && other.symbol === row.symbol) ===
				index,
		);
		await seedDirectly(ownerId, rows);
		const queries = generateQueries(33, rows, 400);
		let nonEmpty = 0;
		for (const [index, query] of queries.entries()) {
			const market = index % 5 === 0 ? "JP" : index % 7 === 0 ? "US" : null;
			const limit = 1 + (index % STOCK_DIRECTORY_LIMITS.maxResults);
			const { sql, reference } = await bothRankings(ownerId, rows, query, market, limit);
			expect(sql, `${JSON.stringify(query)} market=${market} limit=${limit}`).toEqual(reference);
			if (reference.length > 0) nonEmpty += 1;
		}
		// The generator must exercise matches, not only misses.
		expect(nonEmpty).toBeGreaterThan(250);
	});

	it("matches the reference on a full-size directory and reports the search time", {
		timeout: 120_000,
	}, async ({ annotate }) => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		// Measured 2026-10-24: US 7,691, JP 3,707 (ADR-0034).
		const us = [APPLE, ...generateUsEntries(41, 7_690).filter((entry) => entry.symbol !== "AAPL")];
		const jp = [TOYOTA, ...generateJpEntries(42, 3_706).filter((entry) => entry.symbol !== "7203")];
		const storeStarted = Date.now();
		await storeDirectory(harness, token, "US", us);
		await storeDirectory(harness, token, "JP", jp);
		const storeMs = Date.now() - storeStarted;
		const rows = [...referenceRows("US", us), ...referenceRows("JP", jp)];
		expect(await storedCount(harness.ownerId, "US")).toBe(us.length);
		expect(await storedCount(harness.ownerId, "JP")).toBe(jp.length);

		const persistence = createD1Adapters(env.DB);
		const queries = generateQueries(43, rows, 200);
		const timings: number[] = [];
		for (const [index, query] of queries.entries()) {
			const market = index % 4 === 0 ? "JP" : null;
			const started = Date.now();
			const sql = await persistence.stockDirectory.search(harness.ownerId, {
				text: query,
				market,
				limit: STOCK_DIRECTORY_LIMITS.defaultResults,
			});
			timings.push(Date.now() - started);
			const scoped = market === null ? rows : rows.filter((row) => row.market === market);
			expect(sql.map(hitKey), JSON.stringify(query)).toEqual(
				rankStockSearch(scoped, query, STOCK_DIRECTORY_LIMITS.defaultResults).map(hitKey),
			);
		}
		// The end-to-end route (auth, validation, watchlist join) on top.
		const routeStarted = Date.now();
		const routeQueries = ["apple", "toyota", "とよた", "7203", "a", "holdings group"];
		for (const query of routeQueries) {
			await search(harness, `q=${encodeURIComponent(query)}`);
		}
		const routeMs = (Date.now() - routeStarted) / routeQueries.length;
		const sorted = [...timings].sort((a, b) => a - b);
		const mean = timings.reduce((sum, value) => sum + value, 0) / timings.length;
		const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
		const max = sorted[sorted.length - 1] ?? 0;
		// Reported, not budgeted: the reporter prints the annotation.
		await annotate(
			`stock_directory_search rows=${rows.length} queries=${timings.length} mean_ms=${mean.toFixed(2)} p95_ms=${p95} max_ms=${max} route_mean_ms=${routeMs.toFixed(2)} store_both_ms=${storeMs}`,
		);
	});
});
