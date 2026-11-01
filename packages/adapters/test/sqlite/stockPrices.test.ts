import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMarketRepository } from "../../src/sql/repositories.ts";
import { chunkStockPricePoints, createStockPriceRepository } from "../../src/sql/stockPrices.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * ADR-0058 §2: the stock-price reads at a realistic size — one owner with
 * 8,000 US directory stocks, most of them with a stored price series — on
 * the real migrations. The plans are pinned: every lookup is a key seek,
 * never a scan of `market_series` or `market_observations` per row.
 */

const OWNER = "owner_prices";
const STOCKS = 8_000;
const SYMBOLS = Array.from({ length: STOCKS }, (_, index) => `S${String(index).padStart(4, "0")}`);

type Db = ReturnType<typeof openNodeSqlite>;
let db: Db;

beforeAll(async () => {
	db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	await db
		.prepare(
			`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
				symbol_key, name_key, local_name_key, search_key)
			SELECT ?, 'US', incoming.value, incoming.value, NULL, 'nyse', incoming.value, incoming.value, '', incoming.value
			FROM json_each(?) AS incoming`,
		)
		.bind(OWNER, JSON.stringify(SYMBOLS))
		.run();
	// Every stock but the last ten has a series; S7995 is on the Watchlist.
	await db
		.prepare(
			`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
				publisher, source_url)
			SELECT ?, 'twelve-data:' || incoming.value, 'twelve-data', incoming.value, incoming.value, 'USD',
				'daily', 'Massive', 'https://massive.com/'
			FROM json_each(?) AS incoming`,
		)
		.bind(OWNER, JSON.stringify(SYMBOLS.slice(0, STOCKS - 10)))
		.run();
	await db
		.prepare(
			`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
			VALUES (?, 'us:S7995', 'US', 'S7995', NULL, '2026-10-01T00:00:00.000Z')`,
		)
		.bind(OWNER)
		.run();
});

afterAll(() => db.close());

async function plan(sql: string, ...values: (string | number)[]): Promise<string> {
	const { results } = await db
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.bind(...values)
		.all();
	return results.map((row) => z.object({ detail: z.string() }).parse(row).detail).join(" | ");
}

describe("stock-price reads (ADR-0058 §2)", () => {
	it("lists the unstored directory stocks, Watchlist first, then by symbol", async () => {
		const repository = createStockPriceRepository(db);
		expect(await repository.listUnstoredSymbols(OWNER, "US", 4)).toEqual([
			"S7995",
			"S7990",
			"S7991",
			"S7992",
		]);
		expect(await repository.listUnstoredSymbols(OWNER, "US", 0)).toEqual([]);
		expect(await repository.listUnstoredSymbols(OWNER, "JP", 10)).toEqual([]);
	});

	it("walks the directory by its key and seeks each series (no scan, no per-row series range)", async () => {
		// The directory branch of `listUnstoredSymbols`, as the repository runs it.
		const detail = await plan(
			`SELECT sd.symbol AS symbol
			FROM stock_directory AS sd
			WHERE sd.owner_id = ?1 AND sd.market = ?2
				AND NOT EXISTS (
					SELECT 1
					FROM market_series AS ms
					WHERE ms.owner_id = ?1
						AND ms.series_id = 'twelve-data:' || sd.symbol || CASE sd.market WHEN 'JP' THEN ':JPX' ELSE '' END
				)
			ORDER BY sd.symbol
			LIMIT ?3`,
			OWNER,
			"US",
			10,
		);
		expect(detail).toContain("SEARCH sd USING PRIMARY KEY (owner_id=? AND market=?)");
		expect(detail).toContain(
			"SEARCH ms USING COVERING INDEX sqlite_autoindex_market_series_1 (owner_id=? AND series_id=?)",
		);
		expect(detail).not.toContain("TEMP B-TREE");
	});

	it("answers which page series are US directory stocks in one statement", async () => {
		const repository = createStockPriceRepository(db);
		const found = await repository.usDirectorySeriesIds(OWNER, [
			"twelve-data:S0001",
			"twelve-data:SPY",
			"twelve-data:S0002:JPX",
			"fred:DGS10",
		]);
		expect([...found]).toEqual(["twelve-data:S0001"]);
	});

	it("reads the day window as one key range", async () => {
		const detail = await plan(
			`SELECT trading_on, outcome_code, retry_at FROM stock_price_day
			WHERE owner_id = ? AND market = ? AND trading_on >= ? AND trading_on <= ?
			ORDER BY trading_on DESC`,
			OWNER,
			"US",
			"2024-10-10",
			"2026-10-10",
		);
		expect(detail).toBe(
			"SEARCH stock_price_day USING PRIMARY KEY (owner_id=? AND market=? AND trading_on>? AND trading_on<?)",
		);
	});

	it("the series clean-up keeps every directory stock's series and seeks the directory per series", async () => {
		await db
			.prepare(
				`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
					publisher, source_url)
				VALUES (?, 'twelve-data:GONE', 'twelve-data', 'GONE', 'GONE', 'USD', 'daily', 'x', 'https://example.test/')`,
			)
			.bind(OWNER)
			.run();
		expect(await createMarketRepository(db).deleteSeriesNotIn(OWNER, [])).toBe(1);
		const { results } = await db
			.prepare("SELECT count(*) AS series_count FROM market_series WHERE owner_id = ?")
			.bind(OWNER)
			.all();
		expect(results).toEqual([{ series_count: STOCKS - 10 }]);
	});

	it("chunks bars at 4,000 per upsert", () => {
		const points = Array.from(
			{ length: 9_001 },
			(_, index) => [`S${index}`, "2026-10-09", 1, null, null, null, null] as const,
		);
		expect(chunkStockPricePoints(points).map((chunk) => chunk.length)).toEqual([
			4_000, 4_000, 1_001,
		]);
	});
});
