/**
 * Daily prices of every directory stock, one request per market and date
 * (ADR-0058 §2): the `stock-prices-sync` claim and completion.
 *
 * US bars come from Massive's grouped daily endpoint, JP bars from
 * J-Quants' daily bars by date. The API plans the days (`planSyncDays`,
 * newest first) and the per-stock histories; the runner fetches, maps each
 * provider ticker to the directory's symbol form, and reports one outcome
 * per day. The API stores only directory stocks' bars.
 */
import { z } from "zod";
import { isConsistentBar, marketBarSchema } from "./market.ts";
import { isoDateSchema, isoDateTimeSchema } from "./primitives.ts";
import { watchMarketSchema } from "./watchlist.ts";

export const STOCK_PRICE_LIMITS = {
	/** Days one job asks for: 2 minutes at the free plans' 5 requests a minute. */
	maxDaysPerJob: 10,
	/** Per-stock window fetches one job asks for or adds (splits). */
	maxHistoriesPerJob: 10,
	/** Massive's grouped daily answered ~11,000 tickers in 2026; room above it. */
	maxBarsPerDay: 15_000,
	/** Two years of weekdays and room for the provider's extra days. */
	maxBarsPerHistory: 600,
	/** How far back the day walk goes (both free plans keep two years). */
	historyDays: 730,
	/** A `not-yet-available` day is asked again after this long. */
	retryHours: 6,
	/** An empty answer for a day at most this many days old is `not-yet-available`, older `no-trading`. */
	settleDays: 3,
} as const;

/** The providers that write directory stocks' daily bars. */
export const stockPriceProviderSchema = z.enum(["massive", "jquants"]);
export type StockPriceProvider = z.infer<typeof stockPriceProviderSchema>;

/** The provider of each market's stock prices (ADR-0058 §2). */
export const STOCK_PRICE_PROVIDER_OF_MARKET = {
	US: "massive",
	JP: "jquants",
} as const satisfies Record<z.infer<typeof watchMarketSchema>, StockPriceProvider>;

/**
 * A directory symbol as the runner reports it, already mapped from the
 * provider's form (Massive `BRK.B` → `BRK-B`, J-Quants `13800` → `1380`).
 * Loose on purpose: the API keeps only symbols its directory holds.
 */
export const stockPriceSymbolSchema = z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,15}$/);

/** One stock's bar of one day: `[symbol, close, [open, high, low, volume|null]]`. */
export const stockDayBarSchema = z
	.tuple([stockPriceSymbolSchema, z.number().finite(), marketBarSchema])
	.refine(([, close, bar]) => isConsistentBar(close, bar), {
		message: "a bar needs low ≤ open, close ≤ high",
	});
export type StockDayBar = z.infer<typeof stockDayBarSchema>;

/** One day of one stock's history: `[date, close, [open, high, low, volume|null]]`. */
export const stockHistoryBarSchema = z
	.tuple([isoDateSchema, z.number().finite(), marketBarSchema])
	.refine(([, close, bar]) => isConsistentBar(close, bar), {
		message: "a bar needs low ≤ open, close ≤ high",
	});
export type StockHistoryBar = z.infer<typeof stockHistoryBarSchema>;

/** What became of one requested day (ADR-0058 §2 table). */
export const stockPriceDayOutcomeSchema = z.enum([
	"stored",
	"no-trading",
	"not-yet-available",
	"too-old",
]);
export type StockPriceDayOutcome = z.infer<typeof stockPriceDayOutcomeSchema>;

/** One stock whose whole window the runner fetches. */
export const stockHistoryRequestSchema = z.strictObject({
	symbol: stockPriceSymbolSchema,
	from: isoDateSchema,
	to: isoDateSchema,
});
export type StockHistoryRequest = z.infer<typeof stockHistoryRequestSchema>;

/** The fields of a `stock-prices-sync` claimed job besides the lease shape. */
export const stockPricesClaimShape = {
	market: watchMarketSchema,
	/** Newest first, distinct weekdays. */
	days: z.array(isoDateSchema).max(STOCK_PRICE_LIMITS.maxDaysPerJob),
	/** Directory stocks with no stored price series (only once no day is due). */
	histories: z.array(stockHistoryRequestSchema).max(STOCK_PRICE_LIMITS.maxHistoriesPerJob),
	/**
	 * The newest stored day before this job, null when none: a split
	 * effective after it makes the older stored bars inconsistent, so the
	 * runner refetches that stock's window (reason `split`).
	 */
	adjustmentsSince: isoDateSchema.nullable(),
	/** The first day of the window, for split refetches. */
	windowStart: isoDateSchema,
};

export const stockPriceDayResultSchema = z.strictObject({
	date: isoDateSchema,
	outcome: stockPriceDayOutcomeSchema,
	bars: z.array(stockDayBarSchema).max(STOCK_PRICE_LIMITS.maxBarsPerDay),
	/** The provider's HTTP status when it answered with an error, else absent (ADR-0037). */
	upstreamStatus: z.number().int().min(100).max(599).optional(),
});
export type StockPriceDayResult = z.infer<typeof stockPriceDayResultSchema>;

export const stockHistoryResultSchema = z.strictObject({
	symbol: stockPriceSymbolSchema,
	reason: z.enum(["requested", "split"]),
	/** `not-found`: the provider does not know the stock; stored as `SERIES_NOT_FOUND`. */
	outcome: z.enum(["stored", "not-found"]),
	from: isoDateSchema,
	to: isoDateSchema,
	bars: z.array(stockHistoryBarSchema).max(STOCK_PRICE_LIMITS.maxBarsPerHistory),
});
export type StockHistoryResult = z.infer<typeof stockHistoryResultSchema>;

/** The fields of a `stock-prices-synced` completion besides the completion base. */
export const stockPricesCompletionShape = {
	market: watchMarketSchema,
	provider: stockPriceProviderSchema,
	fetchedAt: isoDateTimeSchema,
	days: z.array(stockPriceDayResultSchema).max(STOCK_PRICE_LIMITS.maxDaysPerJob),
	histories: z.array(stockHistoryResultSchema).max(STOCK_PRICE_LIMITS.maxHistoriesPerJob * 2),
};

/** The first problem of a completion's cross-field rules, or null. */
export function stockPricesCompletionProblem(completion: {
	readonly market: "US" | "JP";
	readonly provider: StockPriceProvider;
	readonly days: readonly StockPriceDayResult[];
	readonly histories: readonly StockHistoryResult[];
}): string | null {
	if (STOCK_PRICE_PROVIDER_OF_MARKET[completion.market] !== completion.provider) {
		return `${completion.market} prices come from ${STOCK_PRICE_PROVIDER_OF_MARKET[completion.market]}`;
	}
	const dates = new Set<string>();
	for (const day of completion.days) {
		if (dates.has(day.date)) return `day ${day.date} is reported twice`;
		dates.add(day.date);
		if ((day.outcome === "stored") !== day.bars.length > 0) {
			return `day ${day.date}: only a stored day carries bars`;
		}
	}
	for (const history of completion.histories) {
		if (history.outcome === "not-found" && history.bars.length > 0) {
			return `history ${history.symbol}: a not-found history carries no bars`;
		}
		if (history.from > history.to) return `history ${history.symbol}: from is after to`;
	}
	return null;
}
