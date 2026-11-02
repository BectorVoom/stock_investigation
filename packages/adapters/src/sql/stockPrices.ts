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
const splitRowSchema = z.object({ split_checked_on: z.string() });
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
		async getSplitCheckedOn(ownerId, market) {
			const row = await db
				.prepare(
					"SELECT split_checked_on FROM stock_price_market WHERE owner_id = ? AND market = ?",
				)
				.bind(ownerId, market)
				.first();
			return row === null
				? null
				: decode("stock_price_market", splitRowSchema, row).split_checked_on;
		},
		async listUnfilledSymbols(ownerId, market, nowIso, limit) {
			if (limit <= 0) return [];
			// Two bounded branches, merged: the market's Watchlist stocks (at
			// most WATCHLIST_LIMITS.maxStocks rows of the owner), then the
			// directory in symbol order — a primary-key walk that stops after
			// `limit` unfilled rows, one market_series key seek and one
			// stock_price_history key seek per row. A stock is unfilled while it
			// has no series row with a `history_checked_at`; a backed-off stock
			// (an `unavailable` answer) waits for its `retry_at`.
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
										AND ms.history_checked_at IS NOT NULL
								)
								AND NOT EXISTS (
									SELECT 1
									FROM stock_price_history AS sph
									WHERE sph.owner_id = ?1 AND sph.market = ?2 AND sph.symbol = ws.symbol
										AND sph.retry_at > ?3
								)
							ORDER BY ws.symbol
							LIMIT ?4
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
										AND ms.history_checked_at IS NOT NULL
								)
								AND NOT EXISTS (
									SELECT 1
									FROM stock_price_history AS sph
									WHERE sph.owner_id = ?1 AND sph.market = ?2 AND sph.symbol = sd.symbol
										AND sph.retry_at > ?3
								)
							ORDER BY sd.symbol
							LIMIT ?4
						) AS listed
					) AS candidate
					GROUP BY candidate.symbol
					ORDER BY min(candidate.priority), candidate.symbol
					LIMIT ?4`,
				)
				.bind(ownerId, market, nowIso, limit)
				.all();
			return results.map((row) => decode("stock_directory", symbolRowSchema, row).symbol);
		},
		async listRefetchSymbols(ownerId, market, nowIso, limit) {
			if (limit <= 0) return [];
			// One market's pending histories are a key range (a few hundred rows
			// at most): sorted by request time without an index. A stock that
			// left the directory, or is backed off, is not asked for.
			const { results } = await db
				.prepare(
					`SELECT sph.symbol
					FROM stock_price_history AS sph
					WHERE sph.owner_id = ?1 AND sph.market = ?2
						AND sph.refetch_requested_at IS NOT NULL
						AND (sph.retry_at IS NULL OR sph.retry_at <= ?3)
						AND EXISTS (
							SELECT 1
							FROM stock_directory AS sd
							WHERE sd.owner_id = ?1 AND sd.market = ?2 AND sd.symbol = sph.symbol
						)
					ORDER BY sph.refetch_requested_at, sph.symbol
					LIMIT ?4`,
				)
				.bind(ownerId, market, nowIso, limit)
				.all();
			return results.map((row) => decode("stock_price_history", symbolRowSchema, row).symbol);
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
 * Statements storing a `stock-prices-synced` completion (ADR-0058 §2), held
 * to its claim by the service, in order: the series rows (created with the
 * directory's name and listing, or re-stamped), the not-found rows (only
 * where none exists), the filled histories' `history_checked_at`, the
 * stored histories' range deletes, the bar upserts, the day outcomes, the
 * pending-history rows (cleared, owed refetches, back-offs) and the split
 * watermark. Every statement is guarded on the job compare-and-set; every
 * insert joins the market's directory. A full 10-day US completion costs
 * 2 + 28 + 1 statements here, plus at most 6 for histories and splits.
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
	// a stored answer clears an earlier SERIES_NOT_FOUND. A NEW row's history
	// counts as filled (`history_checked_at`) only while no day of the window
	// is stored yet: the day walk then brings it every day. A row created
	// once days are stored (a stock that joined the directory later, or that
	// had no bar on the days already stored) missed those days for good, so
	// it stays NULL and the per-stock rule fetches its window.
	for (const chunk of chunksOf(effects.seriesSymbols, STOCK_SERIES_CHUNK_SYMBOLS)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code,
						unavailable_upstream_status, history_checked_at)
					SELECT ?, ${SERIES_ID_SQL}, '${SERIES_PROVIDER}', ${SERIES_SYMBOL_SQL}, ${SERIES_TITLE_SQL},
						?, 'daily', ?, ?, ?, ?, NULL, NULL,
						CASE WHEN EXISTS (
							SELECT 1
							FROM stock_price_day AS spd
							WHERE spd.owner_id = ? AND spd.market = ? AND spd.outcome_code = 'stored'
								AND spd.trading_on >= ?
						) THEN NULL ELSE ? END
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
					ownerId,
					effects.market,
					effects.windowStart,
					effects.committedAt,
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
	if (effects.filledSymbols.length > 0) {
		// A stored (or not-found) history settles the stock's window: the
		// per-stock rule does not name it again.
		statements.push(
			db
				.prepare(
					`UPDATE market_series SET history_checked_at = ?
					WHERE owner_id = ?
						AND series_id IN (
							SELECT ${SERIES_ID_SQL}
							FROM json_each(?) AS incoming
							CROSS JOIN stock_directory AS sd
								ON sd.owner_id = ? AND sd.market = ? AND sd.symbol = incoming.value
						)
						AND ${g}`,
				)
				.bind(
					effects.committedAt,
					ownerId,
					JSON.stringify(effects.filledSymbols),
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
		// A `no-trading` day the service could not prove final is final after
		// all when the market already has a stored day newer than it. Only a
		// row that is not final (`retry_at` set) is overwritten; a stored day
		// asked again keeps its bars' record unless the answer stores again
		// (a later empty answer only decides when it is asked next).
		statements.push(
			db
				.prepare(
					`INSERT INTO stock_price_day (owner_id, market, trading_on, outcome_code, bar_count, checked_at, retry_at)
					SELECT ?, ?, json_extract(incoming.value, '$.day'), json_extract(incoming.value, '$.outcome'),
						json_extract(incoming.value, '$.barCount'), ?,
						CASE
							WHEN json_extract(incoming.value, '$.outcome') = 'no-trading'
								AND EXISTS (
									SELECT 1
									FROM stock_price_day AS spd_newer
									WHERE spd_newer.owner_id = ? AND spd_newer.market = ?
										AND spd_newer.outcome_code = 'stored'
										AND spd_newer.trading_on > json_extract(incoming.value, '$.day')
								)
							THEN NULL
							ELSE json_extract(incoming.value, '$.retryAt')
						END
					FROM json_each(?) AS incoming
					WHERE ${g}
					ON CONFLICT (owner_id, market, trading_on) DO UPDATE SET
						outcome_code = CASE
							WHEN stock_price_day.outcome_code = 'stored' AND excluded.outcome_code <> 'stored'
							THEN 'stored' ELSE excluded.outcome_code END,
						bar_count = CASE
							WHEN stock_price_day.outcome_code = 'stored' AND excluded.outcome_code <> 'stored'
							THEN stock_price_day.bar_count ELSE excluded.bar_count END,
						checked_at = excluded.checked_at,
						retry_at = CASE
							WHEN stock_price_day.outcome_code = 'stored' AND excluded.outcome_code <> 'stored'
							THEN CASE WHEN excluded.outcome_code = 'not-yet-available' THEN excluded.retry_at END
							ELSE excluded.retry_at END
					WHERE stock_price_day.retry_at IS NOT NULL`,
				)
				.bind(
					ownerId,
					effects.market,
					effects.fetchedAt,
					ownerId,
					effects.market,
					JSON.stringify(effects.days),
					...gv,
				),
		);
	}
	if (effects.historyCleared.length > 0) {
		// A stored history settles whatever the stock owed or waited for.
		statements.push(
			db
				.prepare(
					`DELETE FROM stock_price_history
					WHERE owner_id = ? AND market = ? AND symbol IN (SELECT incoming.value FROM json_each(?) AS incoming)
						AND ${g}`,
				)
				.bind(ownerId, effects.market, JSON.stringify(effects.historyCleared), ...gv),
		);
	}
	if (effects.refetchOwed.length > 0) {
		// The first request time is kept: a stock that keeps missing the cap
		// moves to the front of the queue, never to its back.
		statements.push(
			db
				.prepare(
					`INSERT INTO stock_price_history (owner_id, market, symbol, refetch_requested_at, retry_at)
					SELECT ?, sd.market, sd.symbol, ?, NULL
					FROM json_each(?) AS incoming
					CROSS JOIN stock_directory AS sd
						ON sd.owner_id = ? AND sd.market = ? AND sd.symbol = incoming.value
					WHERE ${g}
					ON CONFLICT (owner_id, market, symbol) DO UPDATE SET
						refetch_requested_at = coalesce(stock_price_history.refetch_requested_at, excluded.refetch_requested_at)`,
				)
				.bind(
					ownerId,
					effects.committedAt,
					JSON.stringify(effects.refetchOwed),
					ownerId,
					effects.market,
					...gv,
				),
		);
	}
	if (effects.backoffSymbols.length > 0) {
		// An `unavailable` history: not named again before `retry_at`, so the
		// stocks behind it in the queue get their turn.
		statements.push(
			db
				.prepare(
					`INSERT INTO stock_price_history (owner_id, market, symbol, refetch_requested_at, retry_at)
					SELECT ?, sd.market, sd.symbol, NULL, ?
					FROM json_each(?) AS incoming
					CROSS JOIN stock_directory AS sd
						ON sd.owner_id = ? AND sd.market = ? AND sd.symbol = incoming.value
					WHERE ${g}
					ON CONFLICT (owner_id, market, symbol) DO UPDATE SET retry_at = excluded.retry_at`,
				)
				.bind(
					ownerId,
					effects.backoffUntil,
					JSON.stringify(effects.backoffSymbols),
					ownerId,
					effects.market,
					...gv,
				),
		);
	}
	if (effects.splitCheckedOn !== null) {
		// Only forward: an older job finishing last never re-opens checked days.
		statements.push(
			db
				.prepare(
					`INSERT INTO stock_price_market (owner_id, market, split_checked_on)
					SELECT ?, ?, ?
					WHERE ${g}
					ON CONFLICT (owner_id, market) DO UPDATE SET
						split_checked_on = max(stock_price_market.split_checked_on, excluded.split_checked_on)`,
				)
				.bind(ownerId, effects.market, effects.splitCheckedOn, ...gv),
		);
	}
	return statements;
}
