/**
 * Every listed stock's upcoming earnings announcements, one job per market
 * (ADR-0068): the `earnings-calendar-sync` claim and completion, and the
 * per-stock view the Stocks page reads.
 *
 * US dates come from Finnhub's earnings calendar asked without a symbol
 * (every company in a date range, at most `finnhubRowCap` rows an answer),
 * JP dates from every row of JPX's announcement workbooks. The runner maps
 * each row to the stock list's symbol form; the API keeps only stocks of the
 * owner's stored stock list and replaces the market's stored rows.
 *
 * Separate from the Watchlist's earnings dates (`earnings-refresh`,
 * FR-018), which feed the Google Calendar and the `.ics` exports: these
 * rows feed no calendar.
 */
import { z } from "zod";
import { httpsUrlSchema, isoDateSchema, isoDateTimeSchema } from "./primitives.ts";
import { stockPriceSymbolSchema } from "./stockPrices.ts";
import {
	EARNINGS_LIMITS,
	earningsEventSchema,
	earningsSourceIdSchema,
	watchMarketSchema,
} from "./watchlist.ts";

export const EARNINGS_CALENDAR_LIMITS = {
	/** The window, as the Watchlist's: [today, today + 185 days] (UTC dates). */
	horizonDays: EARNINGS_LIMITS.horizonDays,
	/** Days in one Finnhub request; a capped answer is asked again day by day. */
	windowDays: 7,
	/**
	 * Finnhub's all-companies answer stops at this many rows (measured
	 * 2026-11-03: a 7-day window answered exactly 1,500; one busy day 567).
	 */
	finnhubRowCap: 1_500,
	/** Rows one completion may carry: ~26 weeks of US announcements with room. */
	maxEvents: 60_000,
	/** Events the Stocks page gets for one stock, soonest first. */
	maxEventsPerStock: EARNINGS_LIMITS.maxEventsPerStock,
	/** A market's calendar is synced again once its last sync is this old. */
	intervalHours: 24,
} as const;

/** The claim's fields: the market and the window to fetch. */
export const earningsCalendarClaimShape = {
	market: watchMarketSchema,
	fromDate: isoDateSchema,
	toDate: isoDateSchema,
} as const;

/** One announcement of one stock, the symbol in the stock list's form (`BH-A`, `130A`). */
export const earningsCalendarEventSchema = earningsEventSchema.extend({
	symbol: stockPriceSymbolSchema,
});
export type EarningsCalendarEvent = z.infer<typeof earningsCalendarEventSchema>;

export const earningsCalendarCompletionShape = {
	market: watchMarketSchema,
	fromDate: isoDateSchema,
	toDate: isoDateSchema,
	fetchedAt: isoDateTimeSchema,
	/** Every row of the market's calendar in the window; undated ones (JPX 未定) too. */
	events: z.array(earningsCalendarEventSchema).max(EARNINGS_CALENDAR_LIMITS.maxEvents),
	/**
	 * Days whose one-day answer still hit Finnhub's row cap: their rows are
	 * kept, but some announcements of that day may be missing.
	 */
	truncatedDates: z.array(isoDateSchema).max(EARNINGS_CALENDAR_LIMITS.horizonDays + 1),
} as const;

/** What a completion's fields must agree on; null when they do. */
export function earningsCalendarCompletionProblem(completion: {
	readonly fromDate: string;
	readonly toDate: string;
	readonly events: readonly EarningsCalendarEvent[];
	readonly truncatedDates: readonly string[];
}): string | null {
	const { fromDate, toDate } = completion;
	if (fromDate > toDate) return "fromDate must not be after toDate";
	const keys = new Set<string>();
	for (const event of completion.events) {
		const date = event.announcementDate;
		if (date !== null && (date < fromDate || date > toDate)) {
			return "every dated event must lie in [fromDate, toDate]";
		}
		const key = `${event.symbol}\u0000${event.periodKey}`;
		if (keys.has(key)) return "a stock's period keys must be distinct";
		keys.add(key);
	}
	const truncated = new Set(completion.truncatedDates);
	if (truncated.size !== completion.truncatedDates.length) {
		return "truncated dates must be distinct";
	}
	for (const date of completion.truncatedDates) {
		if (date < fromDate || date > toDate) return "truncated dates must lie in the window";
	}
	return null;
}

/**
 * One stock's stored calendar rows (ADR-0068), in `GET /api/v1/stocks/:id`:
 * dated soonest first, then undated; null when the market's calendar was
 * never synced. Events before the read's UTC date are not returned.
 */
export const stockEarningsCalendarViewSchema = z.strictObject({
	source: earningsSourceIdSchema,
	publisher: z.string().trim().min(1).max(200),
	sourceUrl: httpsUrlSchema,
	/** When the market's calendar was last stored. */
	syncedAt: isoDateTimeSchema,
	events: z.array(earningsEventSchema).max(EARNINGS_CALENDAR_LIMITS.maxEventsPerStock),
});
export type StockEarningsCalendarView = z.infer<typeof stockEarningsCalendarViewSchema>;
