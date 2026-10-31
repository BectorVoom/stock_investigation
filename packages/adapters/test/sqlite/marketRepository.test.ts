import { fileURLToPath } from "node:url";
import { HISTORY_OVERLAP_OBSERVATIONS } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createMarketRepository } from "../../src/sql/repositories.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * The home service maps repository rows straight to the tuple wire format:
 * it must be able to trust that `getObservations` returns the newest
 * `limitPerSeries` rows per series, ascending by date, from the SQL alone.
 * These tests pin that contract against the real migrations (including
 * 0006's index-free WITHOUT ROWID table) on `node:sqlite`; D1 runs the same
 * SQL text through the API suite.
 */
function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

async function insertObservations(
	db: ReturnType<typeof openNodeSqlite>,
	rows: readonly (readonly [string, string, number])[],
): Promise<void> {
	for (const [seriesId, observedOn, value] of rows) {
		await db
			.prepare(
				"INSERT INTO market_observations (owner_id, series_id, observed_on, value) VALUES (?, ?, ?, ?)",
			)
			.bind("owner_1", seriesId, observedOn, value)
			.run();
	}
}

describe("market repository observation order (FR-017)", () => {
	it("returns rows ascending by date however they were inserted", async () => {
		const db = openMigrated();
		try {
			await insertObservations(db, [
				["fred:VIXCLS", "2026-10-03", 15.1],
				["fred:VIXCLS", "2026-10-01", 15.3],
				["fred:VIXCLS", "2026-10-02", 15.2],
				["twelve-data:AAPL", "2026-10-02", 340.42],
				["twelve-data:AAPL", "2026-10-01", 336.67],
			]);
			const repository = createMarketRepository(db);
			const rows = await repository.getObservations(
				"owner_1",
				["fred:VIXCLS", "twelve-data:AAPL"],
				800,
			);
			expect(rows).toEqual([
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-01", value: 15.3 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-02", value: 15.2 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-03", value: 15.1 },
				{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-01", value: 336.67 },
				{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-02", value: 340.42 },
			]);
		} finally {
			db.close();
		}
	});

	it("keeps the newest limitPerSeries rows per series, still ascending", async () => {
		const db = openMigrated();
		try {
			await insertObservations(db, [
				["fred:VIXCLS", "2026-10-05", 5],
				["fred:VIXCLS", "2026-10-01", 1],
				["fred:VIXCLS", "2026-10-04", 4],
				["fred:VIXCLS", "2026-10-02", 2],
				["fred:VIXCLS", "2026-10-03", 3],
			]);
			const repository = createMarketRepository(db);
			const rows = await repository.getObservations("owner_1", ["fred:VIXCLS"], 3);
			expect(rows).toEqual([
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-03", value: 3 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-04", value: 4 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-05", value: 5 },
			]);
			expect(await repository.getObservations("owner_1", [], 3)).toEqual([]);
		} finally {
			db.close();
		}
	});
});

const NOTHING_STORED = {
	latestObservedOn: null,
	lastRefreshedAt: null,
	unavailableCode: null,
	anchor: null,
	historyCheckedAt: null,
} as const;

describe("market repository refresh state (ADR-0039)", () => {
	it("answers every requested series in one statement, nulls where nothing is stored", async () => {
		const db = openMigrated();
		try {
			await insertObservations(db, [
				["fred:VIXCLS", "2026-10-01", 15.3],
				["fred:VIXCLS", "2026-10-03", 15.1],
			]);
			const seriesRow = (seriesId: string, lastRefreshedAt: string | null) =>
				db
					.prepare(
						`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
							publisher, source_url, last_refreshed_at)
						VALUES ('owner_1', ?, 'fred', ?, 't', '', 'daily', '', 'https://fred.stlouisfed.org/', ?)`,
					)
					.bind(seriesId, seriesId.slice(5), lastRefreshedAt)
					.run();
			await seriesRow("fred:VIXCLS", "2026-10-03T12:00:00.000Z");
			// A failed refresh: stamped, but no observations.
			await seriesRow("fred:DGS10", "2026-10-03T12:00:00.000Z");
			let statements = 0;
			const counting = {
				prepare: (sql: string) => {
					statements += 1;
					return db.prepare(sql);
				},
				batch: db.batch.bind(db),
			};
			const repository = createMarketRepository(counting);
			const state = await repository.getRefreshState("owner_1", [
				"fred:VIXCLS",
				"fred:DGS10",
				"fred:NEVER",
			]);
			expect(statements).toBe(1);
			expect([...state.entries()]).toEqual([
				[
					"fred:VIXCLS",
					{
						latestObservedOn: "2026-10-03",
						lastRefreshedAt: "2026-10-03T12:00:00.000Z",
						unavailableCode: null,
						// Fewer than 32 stored: the oldest stored row is the anchor.
						anchor: { observedOn: "2026-10-01", value: 15.3 },
						historyCheckedAt: null,
					},
				],
				[
					"fred:DGS10",
					{
						latestObservedOn: null,
						lastRefreshedAt: "2026-10-03T12:00:00.000Z",
						unavailableCode: null,
						anchor: null,
						historyCheckedAt: null,
					},
				],
				["fred:NEVER", NOTHING_STORED],
			]);
			// Another owner's rows are never read.
			expect(await repository.getRefreshState("owner_2", ["fred:VIXCLS"])).toEqual(
				new Map([["fred:VIXCLS", NOTHING_STORED]]),
			);
			expect((await repository.getRefreshState("owner_1", [])).size).toBe(0);
		} finally {
			db.close();
		}
	});
});

/** `count` consecutive daily dates from 2020-01-01, ascending. */
function dailyDates(count: number): string[] {
	const start = Date.UTC(2020, 0, 1);
	return Array.from({ length: count }, (_, index) =>
		new Date(start + index * 86_400_000).toISOString().slice(0, 10),
	);
}

describe("market repository history anchor (ADR-0044)", () => {
	it.each([
		0, 1, 31, 32, 33, 1_500,
	])("with %i stored rows the anchor is the 32nd newest, or the oldest when fewer are stored", async (count) => {
		const db = openMigrated();
		try {
			const dates = dailyDates(count);
			// Values distinct per date, so a wrong row cannot pass by an equal value.
			await db
				.prepare(
					`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
					SELECT 'owner_1', 'fred:VIXCLS', value, key + 0.25 FROM json_each(?)`,
				)
				.bind(JSON.stringify(dates))
				.run();
			// Another series' and another owner's rows never shift the anchor.
			await insertObservations(db, [["fred:DGS10", "2030-01-01", 9]]);
			await db
				.prepare(
					"INSERT INTO market_observations (owner_id, series_id, observed_on, value) VALUES ('owner_2', 'fred:VIXCLS', '2019-01-01', 7)",
				)
				.run();
			const state = await createMarketRepository(db).getRefreshState("owner_1", ["fred:VIXCLS"]);
			const anchorIndex = Math.max(0, count - HISTORY_OVERLAP_OBSERVATIONS);
			const anchorDate = dates[anchorIndex];
			expect(state.get("fred:VIXCLS")).toEqual({
				...NOTHING_STORED,
				latestObservedOn: dates.at(-1) ?? null,
				anchor:
					anchorDate === undefined ? null : { observedOn: anchorDate, value: anchorIndex + 0.25 },
			});
		} finally {
			db.close();
		}
	});

	it("reads back the stored history_checked_at of each series", async () => {
		const db = openMigrated();
		try {
			await db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, history_checked_at)
					VALUES ('owner_1', 'fred:VIXCLS', 'fred', 'VIXCLS', 't', '', 'daily', '',
						'https://fred.stlouisfed.org/', '2026-10-30T09:00:00.000Z', '2026-10-28T09:00:00.000Z'),
					('owner_1', 'fred:DGS10', 'fred', 'DGS10', 't', '', 'daily', '',
						'https://fred.stlouisfed.org/', '2026-10-30T09:00:00.000Z', NULL)`,
				)
				.run();
			const state = await createMarketRepository(db).getRefreshState("owner_1", [
				"fred:VIXCLS",
				"fred:DGS10",
			]);
			expect(state.get("fred:VIXCLS")?.historyCheckedAt).toBe("2026-10-28T09:00:00.000Z");
			expect(state.get("fred:DGS10")?.historyCheckedAt).toBeNull();
		} finally {
			db.close();
		}
	});
});
