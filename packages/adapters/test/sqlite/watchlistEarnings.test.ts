import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SqlDatabase, SqlStatement } from "../../src/sql/database.ts";
import {
	createCalendarFeedRepository,
	createEarningsRepository,
	createWatchlistRepository,
} from "../../src/sql/repositories.ts";
import { createResearchUnitOfWork } from "../../src/sql/unitOfWork.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * Watchlist, earnings-event and calendar-feed repositories (FR-018): ordering,
 * idempotent add, atomic remove-with-events and feed upsert/lookup, pinned
 * against the real migrations (0007's index-free tables) on `node:sqlite`;
 * D1 runs the same SQL text through the API suite.
 */
function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

describe("watchlist repository (FR-018)", () => {
	it("lists stocks in the order they were added", async () => {
		const db = openMigrated();
		try {
			const repository = createWatchlistRepository(db);
			await repository.insertStock(
				"owner_1",
				{
					stockId: "jp:7203",
					market: "JP",
					symbol: "7203",
					name: null,
					addedAt: "2026-10-13T00:00:01.000Z",
				},
				50,
			);
			await repository.insertStock(
				"owner_1",
				{
					stockId: "us:AAPL",
					market: "US",
					symbol: "AAPL",
					name: null,
					addedAt: "2026-10-13T00:00:00.000Z",
				},
				50,
			);
			const stocks = await repository.listStocks("owner_1");
			expect(stocks.map((stock) => stock.stockId)).toEqual(["us:AAPL", "jp:7203"]);
			expect(stocks[0]).toMatchObject({
				market: "US",
				symbol: "AAPL",
				name: null,
				lastRefreshedAt: null,
				retrievedAt: null,
				unavailableCode: null,
			});
			expect(await repository.countStocks("owner_1")).toBe(2);
			expect(await repository.countStocks("owner_2")).toBe(0);
			expect(await repository.getStock("owner_1", "us:AAPL")).not.toBeNull();
			expect(await repository.getStock("owner_1", "us:MSFT")).toBeNull();
			// Owner isolation: another owner's identical add is a separate row.
			expect(
				await repository.insertStock(
					"owner_2",
					{
						stockId: "us:AAPL",
						market: "US",
						symbol: "AAPL",
						name: null,
						addedAt: "2026-10-13T00:00:00.000Z",
					},
					50,
				),
			).toBe("added");
			expect(await repository.listStocks("owner_2")).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("treats a repeated add as a no-op success", async () => {
		const db = openMigrated();
		try {
			const repository = createWatchlistRepository(db);
			const stock = {
				stockId: "us:AAPL",
				market: "US",
				symbol: "AAPL",
				name: null,
				addedAt: "2026-10-13T00:00:00.000Z",
			} as const;
			expect(await repository.insertStock("owner_1", stock, 50)).toBe("added");
			expect(await repository.insertStock("owner_1", stock, 50)).toBe("already-present");
			expect(await repository.countStocks("owner_1")).toBe(1);
		} finally {
			db.close();
		}
	});

	it("enforces the cap inside the INSERT: a full list refuses the 51st add", async () => {
		const db = openMigrated();
		try {
			const repository = createWatchlistRepository(db);
			for (let index = 0; index < 50; index += 1) {
				const outcome = await repository.insertStock(
					"owner_1",
					{
						stockId: `us:T${index}`,
						market: "US",
						symbol: `T${index}`,
						name: null,
						addedAt: "2026-10-13T00:00:00.000Z",
					},
					50,
				);
				expect(outcome).toBe("added");
			}
			// Two interleaved adds at 49 would both have read count 49 under
			// check-then-insert; the guarded INSERT leaves 50 rows and
			// reports the loser as full instead of writing a 51st row.
			expect(
				await repository.insertStock(
					"owner_1",
					{
						stockId: "us:EXTRA",
						market: "US",
						symbol: "EXTRA",
						name: null,
						addedAt: "2026-10-13T00:00:00.000Z",
					},
					50,
				),
			).toBe("full");
			expect(await repository.countStocks("owner_1")).toBe(50);
			// A re-add of a present stock still succeeds when the list is full.
			expect(
				await repository.insertStock(
					"owner_1",
					{
						stockId: "us:T0",
						market: "US",
						symbol: "T0",
						name: null,
						addedAt: "2026-10-13T00:00:00.000Z",
					},
					50,
				),
			).toBe("already-present");
			expect(await repository.countStocks("owner_1")).toBe(50);
			// The cap is per owner.
			expect(
				await repository.insertStock(
					"owner_2",
					{
						stockId: "us:EXTRA",
						market: "US",
						symbol: "EXTRA",
						name: null,
						addedAt: "2026-10-13T00:00:00.000Z",
					},
					50,
				),
			).toBe("added");
		} finally {
			db.close();
		}
	});

	it("removes a stock with its events and reports unknown ids", async () => {
		const db = openMigrated();
		try {
			const watchlist = createWatchlistRepository(db);
			const earnings = createEarningsRepository(db);
			await watchlist.insertStock(
				"owner_1",
				{
					stockId: "us:AAPL",
					market: "US",
					symbol: "AAPL",
					name: null,
					addedAt: "2026-10-13T00:00:00.000Z",
				},
				50,
			);
			await db
				.prepare(
					`INSERT INTO earnings_events
						(owner_id, stock_id, period_key, announcement_date, fiscal_period_label, fiscal_period_end, timing)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind("owner_1", "us:AAPL", "2026-q4", "2026-10-29", "Q4 2026", null, "after-close")
				.run();
			expect(await watchlist.removeStock("owner_1", "us:MSFT")).toBe(false);
			expect(await watchlist.removeStock("owner_1", "us:AAPL")).toBe(true);
			expect(await watchlist.listStocks("owner_1")).toEqual([]);
			expect(await earnings.getEvents("owner_1", ["us:AAPL"])).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe("earnings repository (FR-018)", () => {
	it("returns dated events ascending then undecided last, per stock", async () => {
		const db = openMigrated();
		try {
			const earnings = createEarningsRepository(db);
			const insert = (stockId: string, periodKey: string, date: string | null, label: string) =>
				db
					.prepare(
						`INSERT INTO earnings_events
							(owner_id, stock_id, period_key, announcement_date, fiscal_period_label, fiscal_period_end, timing)
						VALUES ('owner_1', ?, ?, ?, ?, NULL, 'unknown')`,
					)
					.bind(stockId, periodKey, date, label)
					.run();
			await insert("jp:7203", "k-late", "2026-11-05", "Second quarter");
			await insert("jp:7203", "k-early", "2026-10-05", "First quarter");
			await insert("jp:7203", "k-undecided", null, "Third quarter");
			await insert("us:AAPL", "2026-q4", "2026-10-29", "Q4 2026");
			const rows = await earnings.getEvents("owner_1", ["jp:7203", "us:AAPL"]);
			expect(rows.map((row) => [row.stockId, row.periodKey])).toEqual([
				["jp:7203", "k-early"],
				["jp:7203", "k-late"],
				["jp:7203", "k-undecided"],
				["us:AAPL", "2026-q4"],
			]);
			expect(rows[2]).toMatchObject({ announcementDate: null, timing: "unknown" });
			expect(await earnings.getEvents("owner_1", [])).toEqual([]);
			expect(await earnings.getEvents("owner_2", ["jp:7203"])).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe("earnings completion unit of work (FR-018 item 4)", () => {
	it("writes no stock that left the watchlist and no orphan events", async () => {
		const db = openMigrated();
		try {
			const watchlist = createWatchlistRepository(db);
			const earnings = createEarningsRepository(db);
			const unitOfWork = createResearchUnitOfWork(db);
			await watchlist.insertStock(
				"owner_1",
				{
					stockId: "us:AAPL",
					market: "US",
					symbol: "AAPL",
					name: null,
					addedAt: "2026-10-13T00:00:00.000Z",
				},
				50,
			);
			await watchlist.insertStock(
				"owner_1",
				{
					stockId: "jp:7203",
					market: "JP",
					symbol: "7203",
					name: null,
					addedAt: "2026-10-13T00:00:00.000Z",
				},
				50,
			);
			// One job row so the completion guard passes.
			await db
				.prepare(
					`INSERT INTO research_jobs
						(owner_id, run_id, kind, state, idempotency_key, request_fingerprint,
						request_json, workspace_id, usage_json, attempt, max_attempts, lease_generation,
						lease_owner_id, lease_expires_at, last_event_seq, cancel_requested, failure_code,
						approval_request_json, retry_of_run_id, verification_status, provider_model,
						provider_session_ref, completed_generation, provenance_json, version,
						last_mutation_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					"owner_1",
					"run_1",
					"earnings-refresh",
					"publishing",
					"key-1",
					"earnings-refresh",
					null,
					null,
					"{}",
					1,
					3,
					2,
					null,
					null,
					-1,
					0,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					0,
					"mutation-0",
					"2026-10-13T00:00:00.000Z",
					"2026-10-13T00:00:00.000Z",
				)
				.run();
			const outcome = await unitOfWork.commitCompletion(
				"owner_1",
				{
					runId: "run_1",
					expectedVersion: 0,
					patch: { state: "completed" },
					audits: [],
					at: "2026-10-13T01:00:00.000Z",
				},
				{
					bundle: null,
					articles: [],
					sourceReports: [],
					workspace: null,
					assistantMessage: null,
					marketSeries: [],
					google: null,
					notebook: null,
					notebookTurn: null,
					stockDirectory: null,
					earnings: [
						{
							stockId: "us:AAPL",
							market: "US",
							symbol: "AAPL",
							fetchedAt: "2026-10-13T01:00:00.000Z",
							name: "Apple Inc",
							events: [
								{
									periodKey: "2026-q4",
									announcementDate: "2026-10-29",
									fiscalPeriodLabel: "Q4 2026",
									fiscalPeriodEnd: null,
									timing: "after-close",
								},
							],
							errorCode: null,
						},
						{
							stockId: "jp:7203",
							market: "JP",
							symbol: "7203",
							fetchedAt: "2026-10-13T01:00:00.000Z",
							name: null,
							events: [],
							errorCode: "SOURCE_FAILED",
						},
						// Left the watchlist between the service's check and
						// the batch: neither may gain a stock row nor events.
						{
							stockId: "us:MSFT",
							market: "US",
							symbol: "MSFT",
							fetchedAt: "2026-10-13T01:00:00.000Z",
							name: "Microsoft Corp.",
							events: [
								{
									periodKey: "2026-q4",
									announcementDate: "2026-10-29",
									fiscalPeriodLabel: "Q4 2026",
									fiscalPeriodEnd: null,
									timing: "after-close",
								},
							],
							errorCode: null,
						},
						{
							stockId: "us:GOOG",
							market: "US",
							symbol: "GOOG",
							fetchedAt: "2026-10-13T01:00:00.000Z",
							name: null,
							events: [],
							errorCode: "SOURCE_FAILED",
						},
					],
				},
			);
			expect(outcome.kind).toBe("committed");
			// No removed stock is re-inserted, by success or by failure.
			expect((await watchlist.listStocks("owner_1")).map((stock) => stock.stockId)).toEqual([
				"us:AAPL",
				"jp:7203",
			]);
			// No orphan event rows for stocks with no watchlist row.
			expect(
				await earnings.getEvents("owner_1", ["us:MSFT", "us:GOOG", "us:AAPL", "jp:7203"]),
			).toEqual([expect.objectContaining({ stockId: "us:AAPL", periodKey: "2026-q4" })]);
			// The stocks still present are stored as usual.
			expect(await watchlist.getStock("owner_1", "us:AAPL")).toMatchObject({
				name: "Apple Inc",
				retrievedAt: "2026-10-13T01:00:00.000Z",
				unavailableCode: null,
			});
			expect(await watchlist.getStock("owner_1", "jp:7203")).toMatchObject({
				lastRefreshedAt: "2026-10-13T01:00:00.000Z",
				unavailableCode: "SOURCE_FAILED",
			});
		} finally {
			db.close();
		}
	});

	it("clears stored events on NO_SCHEDULED_DATE but keeps them on other errors", async () => {
		const db = openMigrated();
		try {
			const watchlist = createWatchlistRepository(db);
			const earnings = createEarningsRepository(db);
			const unitOfWork = createResearchUnitOfWork(db);
			for (const stock of [
				{ stockId: "us:AAPL", market: "US", symbol: "AAPL" },
				{ stockId: "jp:7203", market: "JP", symbol: "7203" },
			] as const) {
				await watchlist.insertStock(
					"owner_1",
					{ ...stock, name: null, addedAt: "2026-10-13T00:00:00.000Z" },
					50,
				);
				await db
					.prepare(
						`INSERT INTO earnings_events
							(owner_id, stock_id, period_key, announcement_date, fiscal_period_label, fiscal_period_end, timing)
						VALUES ('owner_1', ?, '2026-q4', '2026-10-29', 'Q4 2026', NULL, 'after-close')`,
					)
					.bind(stock.stockId)
					.run();
			}
			await db
				.prepare(
					`INSERT INTO research_jobs
						(owner_id, run_id, kind, state, idempotency_key, request_fingerprint,
						request_json, workspace_id, usage_json, attempt, max_attempts, lease_generation,
						lease_owner_id, lease_expires_at, last_event_seq, cancel_requested, failure_code,
						approval_request_json, retry_of_run_id, verification_status, provider_model,
						provider_session_ref, completed_generation, provenance_json, version,
						last_mutation_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					"owner_1",
					"run_1",
					"earnings-refresh",
					"publishing",
					"key-1",
					"earnings-refresh",
					null,
					null,
					"{}",
					1,
					3,
					2,
					null,
					null,
					-1,
					0,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					0,
					"mutation-0",
					"2026-10-13T00:00:00.000Z",
					"2026-10-13T00:00:00.000Z",
				)
				.run();
			const outcome = await unitOfWork.commitCompletion(
				"owner_1",
				{
					runId: "run_1",
					expectedVersion: 0,
					patch: { state: "completed" },
					audits: [],
					at: "2026-10-13T01:00:00.000Z",
				},
				{
					bundle: null,
					articles: [],
					sourceReports: [],
					workspace: null,
					assistantMessage: null,
					marketSeries: [],
					google: null,
					notebook: null,
					notebookTurn: null,
					stockDirectory: null,
					earnings: [
						{
							stockId: "us:AAPL",
							market: "US",
							symbol: "AAPL",
							fetchedAt: "2026-10-13T01:00:00.000Z",
							name: "Apple Inc",
							events: [],
							errorCode: "NO_SCHEDULED_DATE",
						},
						{
							stockId: "jp:7203",
							market: "JP",
							symbol: "7203",
							fetchedAt: "2026-10-13T01:00:00.000Z",
							name: null,
							events: [],
							errorCode: "SOURCE_FAILED",
						},
					],
				},
			);
			expect(outcome.kind).toBe("committed");
			// NO_SCHEDULED_DATE is a successful retrieval with nothing
			// listed: the stale dates are cleared, both stamps are set, the
			// code is recorded, and the name is stored.
			expect(await watchlist.getStock("owner_1", "us:AAPL")).toMatchObject({
				name: "Apple Inc",
				lastRefreshedAt: "2026-10-13T01:00:00.000Z",
				retrievedAt: "2026-10-13T01:00:00.000Z",
				unavailableCode: "NO_SCHEDULED_DATE",
			});
			expect(await earnings.getEvents("owner_1", ["us:AAPL"])).toEqual([]);
			// Every other error keeps the stored events and records only the
			// code and attempt time.
			expect(await watchlist.getStock("owner_1", "jp:7203")).toMatchObject({
				lastRefreshedAt: "2026-10-13T01:00:00.000Z",
				retrievedAt: null,
				unavailableCode: "SOURCE_FAILED",
			});
			expect(await earnings.getEvents("owner_1", ["jp:7203"])).toEqual([
				expect.objectContaining({ stockId: "jp:7203", periodKey: "2026-q4" }),
			]);
		} finally {
			db.close();
		}
	});
});

describe("calendar feed repository (FR-018)", () => {
	it("issues, rotates, looks up by hash and revokes", async () => {
		const db = openMigrated();
		try {
			const feeds = createCalendarFeedRepository(db);
			expect(await feeds.get("owner_1")).toBeNull();
			expect(await feeds.findOwnerByTokenHash("hash-a")).toBeNull();
			await feeds.put("owner_1", "hash-a", "2026-10-13T00:00:00.000Z");
			expect(await feeds.get("owner_1")).toEqual({
				tokenHash: "hash-a",
				createdAt: "2026-10-13T00:00:00.000Z",
			});
			expect(await feeds.findOwnerByTokenHash("hash-a")).toBe("owner_1");
			// Rotation replaces the hash: the old token stops resolving.
			await feeds.put("owner_1", "hash-b", "2026-10-14T00:00:00.000Z");
			expect(await feeds.findOwnerByTokenHash("hash-a")).toBeNull();
			expect(await feeds.findOwnerByTokenHash("hash-b")).toBe("owner_1");
			expect(await feeds.revoke("owner_1")).toBe(true);
			expect(await feeds.revoke("owner_1")).toBe(false);
			expect(await feeds.get("owner_1")).toBeNull();
			expect(await feeds.findOwnerByTokenHash("hash-b")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("fails closed on a corrupt feed row instead of an unchecked cast", async () => {
		// A driver may hand back anything for a stored row (`SqlRow` is
		// untyped by contract); the lookup decodes with zod instead of
		// casting, so a non-string owner fails closed instead of resolving
		// null (which would answer 404 for a row that exists).
		const corruptRow = { owner_id: 42 };
		const statement: SqlStatement = {
			bind: () => statement,
			first: () => Promise.resolve(corruptRow),
			all: () => Promise.resolve({ results: [] }),
			run: () => Promise.resolve({ meta: { changes: 0 } }),
		};
		const corruptDb: SqlDatabase = {
			prepare: () => statement,
			batch: () => Promise.resolve([]),
		};
		const feeds = createCalendarFeedRepository(corruptDb);
		await expect(feeds.findOwnerByTokenHash("hash-corrupt")).rejects.toThrow(
			/stored calendar_feeds row failed validation/,
		);
	});
});
