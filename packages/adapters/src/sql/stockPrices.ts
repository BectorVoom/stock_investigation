/**
 * Every directory stock's daily prices (ADR-0058 §2): the reads the day
 * planner and the claim make, and the statements a `stock-prices-synced`
 * completion commits in its job's guarded batch.
 *
 * Bars are stored in `market_observations` under the stock's existing price
 * series id (`stockPriceSeriesId`: `twelve-data:AAPL`, `twelve-data:1380:JPX`
 * — a legacy namespace, not the source). Every statement computes that id
 * in SQL from the directory row it joins (`SERIES_ID_SQL`), so only symbols
 * of the market's directory are ever stored and the service never reads
 * the directory to filter a completion.
 */
import type {
	StockPricePoint,
	StockPriceRepository,
	StockPricesEffects,
	StoredStockPriceDay,
} from "@research/application";
import { stockPriceDayOutcomeSchema } from "@research/contracts";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { decode } from "./rows.ts";

/** A batch guard: SQL that is true only inside the batch whose job compare-and-set won. */
export interface StockPriceGuard {
	readonly sql: string;
	readonly values: readonly SqlValue[];
}

/** The id namespace of a stock's price series (ADR-0058 §2: legacy, kept so widgets read on). */
const SERIES_PROVIDER = "twelve-data";

/**
 * `stockPriceSeriesId(sd.market, sd.symbol)` in SQL: `twelve-data:<symbol>`
 * for US, `twelve-data:<symbol>:JPX` for JP.
 */
const SERIES_ID_SQL = `'twelve-data:' || sd.symbol || CASE sd.market WHEN 'JP' THEN ':JPX' ELSE '' END`;
/** The series' `symbol` column: the id without the namespace. */
const SERIES_SYMBOL_SQL = `sd.symbol || CASE sd.market WHEN 'JP' THEN ':JPX' ELSE '' END`;
/** Titles like Twelve Data's stock titles: `AAPL (NASDAQ)`, `1380 (JPX)`. */
const SERIES_TITLE_SQL = `sd.symbol || ' (' || CASE sd.market WHEN 'JP' THEN 'JPX' ELSE upper(sd.listing) END || ')'`;

/**
 * Symbols one series upsert binds at most: a symbol serializes to at most
 * ~20 bytes, so a full statement binds under 200 KB; a US completion
 * (~11,000 symbols) needs two.
 */
export const STOCK_SERIES_CHUNK_SYMBOLS = 8_000;

/**
 * Dates one history-delete statement carries at most (13 bytes each in
 * the JSON list: ~320 KB), like `MARKET_HISTORY_DELETE_CHUNK_DATES`. A
 * completion holds at most 20 histories of ≤ 600 dates, so one statement.
 */
export const STOCK_HISTORY_DELETE_CHUNK_DATES = 24_000;

/** Slices `items` into chunks of at most `size`. */
function chunksOf<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		chunks.push(items.slice(start, start + size));
	}
	return chunks;
}

/**
 * Bars one upsert binds at most — the bound of the market-refresh upsert
 * (`MARKET_OBSERVATION_CHUNK_POINTS`, S5): a point serializes to at most
 * ~205 bytes, so a chunk stays under 1 MB (real bars: ~60 bytes, ~250 KB).
 * A full 10-day US completion (~110,000 bars) needs 28 statements.
 */
export const STOCK_PRICE_CHUNK_POINTS = 4_000;

/** Bar upsert chunks of at most `STOCK_PRICE_CHUNK_POINTS`. */
export function chunkStockPricePoints(points: readonly StockPricePoint[]): StockPricePoint[][] {
	return chunksOf(points, STOCK_PRICE_CHUNK_POINTS);
}

/**
 * Packs whole histories into delete chunks of at most
 * `STOCK_HISTORY_DELETE_CHUNK_DATES` dates (a history is never split: its
 * delete must see every date it answered).
 */
function chunkReplacements(
	replacements: StockPricesEffects["replacements"],
): StockPricesEffects["replacements"][number][][] {
	const chunks: StockPricesEffects["replacements"][number][][] = [];
	let current: StockPricesEffects["replacements"][number][] = [];
	let dates = 0;
	for (const replacement of replacements) {
		if (current.length > 0 && dates + replacement.dates.length > STOCK_HISTORY_DELETE_CHUNK_DATES) {
			chunks.push(current);
			current = [];
			dates = 0;
		}
		current.push(replacement);
		dates += replacement.dates.length;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

const dayRowSchema = z.object({
	trading_on: z.string(),
	outcome_code: stockPriceDayOutcomeSchema,
	retry_at: z.string().nullable(),
});
const symbolRowSchema = z.object({ symbol: z.string() });
const seriesIdRowSchema = z.object({ series_id: z.string() });

export function createStockPriceRepository(db: SqlDatabase): StockPriceRepository {
	return {
		async listDays(ownerId, market, oldest, newest) {
			const { results } = await db
				.prepare(
					`SELECT trading_on, outcome_code, retry_at FROM stock_price_day
					WHERE owner_id = ? AND market = ? AND trading_on >= ? AND trading_on <= ?
					ORDER BY trading_on DESC`,
				)
				.bind(ownerId, market, oldest, newest)
				.all();
			return results.map((row): StoredStockPriceDay => {
				const decoded = decode("stock_price_day", dayRowSchema, row);
				return {
					day: decoded.trading_on,
					outcome: decoded.outcome_code,
					retryAt: decoded.retry_at,
				};
			});
		},
		async listUnstoredSymbols(ownerId, market, limit) {
			if (limit <= 0) return [];
			// Two bounded branches, merged: the market's Watchlist stocks (at
			// most WATCHLIST_LIMITS.maxStocks rows of the owner), then the
			// directory in symbol order — a primary-key walk that stops after
			// `limit` unstored rows, one market_series key seek per row.
			const { results } = await db
				.prepare(
					`SELECT candidate.symbol AS symbol
					FROM (
						SELECT watched.priority AS priority, watched.symbol AS symbol
						FROM (
							SELECT 0 AS priority, ws.symbol AS symbol
							FROM watchlist_stocks AS ws
							WHERE ws.owner_id = ?1 AND ws.market = ?2
								AND EXISTS (
									SELECT 1
									FROM stock_directory AS sd
									WHERE sd.owner_id = ?1 AND sd.market = ?2 AND sd.symbol = ws.symbol
								)
								AND NOT EXISTS (
									SELECT 1
									FROM market_series AS ms
									WHERE ms.owner_id = ?1
										AND ms.series_id = 'twelve-data:' || ws.symbol || CASE ?2 WHEN 'JP' THEN ':JPX' ELSE '' END
								)
							ORDER BY ws.symbol
							LIMIT ?3
						) AS watched
						UNION ALL
						SELECT listed.priority AS priority, listed.symbol AS symbol
						FROM (
							SELECT 1 AS priority, sd.symbol AS symbol
							FROM stock_directory AS sd
							WHERE sd.owner_id = ?1 AND sd.market = ?2
								AND NOT EXISTS (
									SELECT 1
									FROM market_series AS ms
									WHERE ms.owner_id = ?1 AND ms.series_id = ${SERIES_ID_SQL}
								)
							ORDER BY sd.symbol
							LIMIT ?3
						) AS listed
					) AS candidate
					GROUP BY candidate.symbol
					ORDER BY min(candidate.priority), candidate.symbol
					LIMIT ?3`,
				)
				.bind(ownerId, market, limit)
				.all();
			return results.map((row) => decode("stock_directory", symbolRowSchema, row).symbol);
		},
		async usDirectorySeriesIds(ownerId, seriesIds) {
			const candidates = seriesIds.filter(
				(seriesId) =>
					seriesId.startsWith(`${SERIES_PROVIDER}:`) &&
					!seriesId.includes(":", SERIES_PROVIDER.length + 1),
			);
			if (candidates.length === 0) return new Set();
			const { results } = await db
				.prepare(
					`SELECT candidate.value AS series_id
					FROM json_each(?2) AS candidate
					CROSS JOIN stock_directory AS sd
						ON sd.owner_id = ?1 AND sd.market = 'US' AND sd.symbol = substr(candidate.value, 13)`,
				)
				.bind(ownerId, JSON.stringify(candidates))
				.all();
			return new Set(
				results.map((row) => decode("stock_directory", seriesIdRowSchema, row).series_id),
			);
		},
	};
}

/**
 * Statements storing a `stock-prices-synced` completion (ADR-0058 §2), in
 * order: the series rows (created with the directory's name and listing, or
 * re-stamped), the not-found rows (only where none exists), the stored
 * histories' range deletes, the bar upserts, the day outcomes. Every
 * statement is guarded on the job compare-and-set and joins the market's
 * directory. A full 10-day US completion costs 2 + 28 + 1 statements here.
 */
export function stockPriceStatements(
	db: SqlDatabase,
	ownerId: string,
	effects: StockPricesEffects,
	guard: StockPriceGuard,
): SqlStatement[] {
	const statements: SqlStatement[] = [];
	const g = guard.sql;
	const gv = guard.values;
	// The series row: publisher and source name the provider that wrote the
	// bars; the stamps never move back (a slower, older job finishing last);
	// a stored answer clears an earlier SERIES_NOT_FOUND.
	for (const chunk of chunksOf(effects.seriesSymbols, STOCK_SERIES_CHUNK_SYMBOLS)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code,
						unavailable_upstream_status, history_checked_at)
					SELECT ?, ${SERIES_ID_SQL}, '${SERIES_PROVIDER}', ${SERIES_SYMBOL_SQL}, ${SERIES_TITLE_SQL},
						?, 'daily', ?, ?, ?, ?, NULL, NULL, NULL
					FROM json_each(?) AS incoming
					CROSS JOIN stock_directory AS sd
						ON sd.owner_id = ? AND sd.market = ? AND sd.symbol = incoming.value
					WHERE ${g}
					ON CONFLICT (owner_id, series_id) DO UPDATE SET
						provider = excluded.provider, symbol = excluded.symbol, title = excluded.title,
						unit = excluded.unit, frequency = excluded.frequency,
						publisher = excluded.publisher, source_url = excluded.source_url,
						last_refreshed_at = max(coalesce(market_series.last_refreshed_at, ''), excluded.last_refreshed_at),
						retrieved_at = max(coalesce(market_series.retrieved_at, ''), excluded.retrieved_at),
						unavailable_code = NULL, unavailable_upstream_status = NULL`,
				)
				.bind(
					ownerId,
					effects.unit,
					effects.publisher,
					effects.sourceUrl,
					effects.fetchedAt,
					effects.fetchedAt,
					JSON.stringify(chunk),
					ownerId,
					effects.market,
					...gv,
				),
		);
	}
	if (effects.notFoundSymbols.length > 0) {
		// A stock the provider does not know: a row that says so, so the
		// per-stock rule does not ask again — never over a stored series.
		statements.push(
			db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code,
						unavailable_upstream_status, history_checked_at)
					SELECT ?, ${SERIES_ID_SQL}, '${SERIES_PROVIDER}', ${SERIES_SYMBOL_SQL}, ${SERIES_TITLE_SQL},
						?, 'daily', ?, ?, ?, NULL, 'SERIES_NOT_FOUND', NULL, NULL
					FROM json_each(?) AS incoming
					CROSS JOIN stock_directory AS sd
						ON sd.owner_id = ? AND sd.market = ? AND sd.symbol = incoming.value
					WHERE ${g}
					ON CONFLICT (owner_id, series_id) DO NOTHING`,
				)
				.bind(
					ownerId,
					effects.unit,
					effects.publisher,
					effects.sourceUrl,
					effects.fetchedAt,
					JSON.stringify(effects.notFoundSymbols),
					ownerId,
					effects.market,
					...gv,
				),
		);
	}
	// A stored history replaces the stock's rows in [from, to]: rows in the
	// range the answer does not hold are deleted (the upserts below write the
	// rest). The answer is parsed once (MATERIALIZED), each stock's range is
	// a key range seek (CROSS JOIN keeps the answer outer), and the answered
	// dates are removed by EXCEPT — the shape of the ADR-0044 history delete.
	for (const replacements of chunkReplacements(effects.replacements)) {
		statements.push(
			db
				.prepare(
					`WITH answer (series_id, from_on, to_on, dates) AS MATERIALIZED (
						SELECT ${SERIES_ID_SQL}, json_extract(incoming.value, '$.from'),
							json_extract(incoming.value, '$.to'), json_extract(incoming.value, '$.dates')
						FROM json_each(?) AS incoming
						CROSS JOIN stock_directory AS sd
							ON sd.owner_id = ? AND sd.market = ?
							AND sd.symbol = json_extract(incoming.value, '$.symbol')
					)
					DELETE FROM market_observations
					WHERE market_observations.owner_id = ?
						AND market_observations.series_id IN (SELECT answer.series_id FROM answer)
						AND (market_observations.series_id, market_observations.observed_on) IN (
							SELECT mo.series_id, mo.observed_on
							FROM answer
							CROSS JOIN market_observations AS mo
								ON mo.owner_id = ?
								AND mo.series_id = answer.series_id
								AND mo.observed_on >= answer.from_on
								AND mo.observed_on <= answer.to_on
							EXCEPT
							SELECT answer.series_id, answered_date.value
							FROM answer, json_each(answer.dates) AS answered_date
						)
						AND ${g}`,
				)
				.bind(JSON.stringify(replacements), ownerId, effects.market, ownerId, ownerId, ...gv),
		);
	}
	// S5: one upsert per chunk, each under 1 MB of bound JSON; a row is
	// rewritten only when a column changed (like the market-refresh upsert).
	for (const points of chunkStockPricePoints(effects.points)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO market_observations
						(owner_id, series_id, observed_on, value, open_value, high_value, low_value, volume)
					SELECT ?, ${SERIES_ID_SQL}, json_extract(incoming.value, '$[1]'),
						json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'),
						json_extract(incoming.value, '$[4]'), json_extract(incoming.value, '$[5]'),
						json_extract(incoming.value, '$[6]')
					FROM json_each(?) AS incoming
					CROSS JOIN stock_directory AS sd
						ON sd.owner_id = ? AND sd.market = ?
						AND sd.symbol = json_extract(incoming.value, '$[0]')
					WHERE ${g}
					ON CONFLICT (owner_id, series_id, observed_on) DO UPDATE
						SET value = excluded.value, open_value = excluded.open_value,
							high_value = excluded.high_value, low_value = excluded.low_value,
							volume = excluded.volume
						WHERE excluded.value <> market_observations.value
							OR excluded.open_value IS NOT market_observations.open_value
							OR excluded.high_value IS NOT market_observations.high_value
							OR excluded.low_value IS NOT market_observations.low_value
							OR excluded.volume IS NOT market_observations.volume`,
				)
				.bind(ownerId, JSON.stringify(points), ownerId, effects.market, ...gv),
		);
	}
	if (effects.days.length > 0) {
		// A final outcome is final: a later answer (a stale duplicate job)
		// only replaces a `not-yet-available` row.
		statements.push(
			db
				.prepare(
					`INSERT INTO stock_price_day (owner_id, market, trading_on, outcome_code, bar_count, checked_at, retry_at)
					SELECT ?, ?, json_extract(incoming.value, '$.day'), json_extract(incoming.value, '$.outcome'),
						json_extract(incoming.value, '$.barCount'), ?, json_extract(incoming.value, '$.retryAt')
					FROM json_each(?) AS incoming
					WHERE ${g}
					ON CONFLICT (owner_id, market, trading_on) DO UPDATE SET
						outcome_code = excluded.outcome_code, bar_count = excluded.bar_count,
						checked_at = excluded.checked_at, retry_at = excluded.retry_at
					WHERE stock_price_day.outcome_code = 'not-yet-available'`,
				)
				.bind(ownerId, effects.market, effects.fetchedAt, JSON.stringify(effects.days), ...gv),
		);
	}
	return statements;
}
