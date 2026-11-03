/**
 * The stored earnings calendars (ADR-0068): one market's every upcoming
 * announcement of its stock-list stocks (`stock_earnings_calendar`) and
 * when it was stored (`stock_earnings_calendar_market`). An
 * `earnings-calendar-synced` completion replaces a market's rows in its
 * job's guarded batch; the Stocks page reads one stock's rows.
 */
import type {
	EarningsCalendarEffects,
	EarningsCalendarMarketState,
	EarningsCalendarRepository,
} from "@research/application";
import { type EarningsEvent, earningsEventSchema, type WatchMarket } from "@research/contracts";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { chunkEquityRows } from "./equitySync.ts";

/**
 * Statements replacing one market's calendar: delete the market's rows,
 * insert the new ones in byte-bounded `json_each` chunks — only symbols of
 * the owner's stock list for the market, one primary-key seek of
 * `stock_directory` per row (`CROSS JOIN` keeps the JSON outermost, as the
 * stock list's profile insert learned) — and upsert the market's row. Every
 * statement is guarded on the job compare-and-set, so a lost race changes
 * nothing and the calendar is replaced all or nothing.
 */
export function earningsCalendarStatements(
	db: SqlDatabase,
	ownerId: string,
	effects: EarningsCalendarEffects,
	guard: { readonly sql: string; readonly values: readonly SqlValue[] },
): SqlStatement[] {
	const statements: SqlStatement[] = [
		db
			.prepare(
				`DELETE FROM stock_earnings_calendar
				WHERE owner_id = ? AND market = ? AND ${guard.sql}`,
			)
			.bind(ownerId, effects.market, ...guard.values),
	];
	const tuples = effects.events.map((event): SqlValue[] => [
		event.symbol,
		event.periodKey,
		event.announcementDate,
		event.fiscalPeriodLabel,
		event.fiscalPeriodEnd,
		event.timing,
	]);
	for (const chunk of chunkEquityRows(tuples)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO stock_earnings_calendar (owner_id, market, symbol, period_key,
						announcement_date, fiscal_period_label, fiscal_period_end, timing)
					SELECT ?, ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
						json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'),
						json_extract(incoming.value, '$[4]'), json_extract(incoming.value, '$[5]')
					FROM json_each(?) AS incoming
					CROSS JOIN stock_directory AS sd
					WHERE sd.owner_id = ? AND sd.market = ?
						AND sd.symbol = json_extract(incoming.value, '$[0]')
						AND ${guard.sql}`,
				)
				.bind(ownerId, effects.market, chunk, ownerId, effects.market, ...guard.values),
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO stock_earnings_calendar_market (owner_id, market, synced_at, from_date, to_date,
					event_count, truncated_dates)
				SELECT ?, ?, ?, ?, ?, ?, ?
				WHERE ${guard.sql}
				ON CONFLICT (owner_id, market) DO UPDATE SET
					synced_at = excluded.synced_at, from_date = excluded.from_date,
					to_date = excluded.to_date, event_count = excluded.event_count,
					truncated_dates = excluded.truncated_dates`,
			)
			.bind(
				ownerId,
				effects.market,
				effects.syncedAt,
				effects.fromDate,
				effects.toDate,
				effects.events.length,
				JSON.stringify(effects.truncatedDates),
				...guard.values,
			),
	);
	return statements;
}

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function createEarningsCalendarRepository(db: SqlDatabase): EarningsCalendarRepository {
	async function marketState(
		ownerId: string,
		market: WatchMarket,
	): Promise<EarningsCalendarMarketState | null> {
		const row = await db
			.prepare(
				`SELECT synced_at, from_date, to_date FROM stock_earnings_calendar_market
				WHERE owner_id = ? AND market = ?`,
			)
			.bind(ownerId, market)
			.first();
		const syncedAt = text(row?.synced_at);
		const fromDate = text(row?.from_date);
		const toDate = text(row?.to_date);
		if (syncedAt === null || fromDate === null || toDate === null) return null;
		return { syncedAt, fromDate, toDate };
	}

	return {
		marketState,
		async stockEvents(ownerId, market, symbol, fromDate, limit) {
			const state = await marketState(ownerId, market);
			if (state === null) return null;
			const { results } = await db
				.prepare(
					`SELECT period_key, announcement_date, fiscal_period_label, fiscal_period_end, timing
					FROM stock_earnings_calendar
					WHERE owner_id = ? AND market = ? AND symbol = ?
						AND (announcement_date IS NULL OR announcement_date >= ?)
					ORDER BY announcement_date IS NULL, announcement_date, period_key
					LIMIT ?`,
				)
				.bind(ownerId, market, symbol, fromDate, limit)
				.all();
			const events: EarningsEvent[] = [];
			for (const row of results) {
				// A row the contract does not accept is skipped, never served.
				const parsed = earningsEventSchema.safeParse({
					periodKey: row.period_key,
					announcementDate: row.announcement_date,
					fiscalPeriodLabel: row.fiscal_period_label,
					fiscalPeriodEnd: row.fiscal_period_end,
					timing: row.timing,
				});
				if (parsed.success) events.push(parsed.data);
			}
			return { syncedAt: state.syncedAt, events };
		},
	};
}
