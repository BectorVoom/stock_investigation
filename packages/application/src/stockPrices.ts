/**
 * Every directory stock's daily prices (ADR-0058 §2): what one market's
 * `stock-prices-sync` job asks for, and what its completion stores.
 *
 * The plan is read from the stored day outcomes and series rows each time
 * it is needed — when the schedule decides whether a job is due and again
 * when the claim is prepared — so a job that waited asks for the days that
 * are due when it runs. The unit of work is one trading date of one market
 * (`planSyncDays`, newest first); once no date of the window is due, the
 * plan names directory stocks with no stored price series at all.
 */
import {
	type CompleteJobRequest,
	STOCK_PRICE_LIMITS,
	type StockHistoryRequest,
	type StockPriceProvider,
	stockPriceSymbolSchema,
	type WatchMarket,
} from "@research/contracts";
import {
	addDaysIso,
	isoDateOfDayNumber,
	type KnownSyncDay,
	planSyncDays,
	utcMsToLocalMinute,
} from "@research/domain";
import type {
	StockPricePoint,
	StockPriceRepository,
	StockPricesEffects,
	StoredStockPriceDay,
} from "./ports.ts";

/** The markets whose stock prices the schedule keeps, US first. */
export const STOCK_PRICE_MARKETS: readonly WatchMarket[] = ["US", "JP"];

/** The zone of each market's trading dates (callers of `planSyncDays` pass local dates). */
export const STOCK_PRICE_TIME_ZONE = {
	US: "America/New_York",
	JP: "Asia/Tokyo",
} as const satisfies Record<WatchMarket, string>;

/** `market_series.publisher` / `source_url` of the provider that wrote the bars (ADR-0058 §2). */
export const STOCK_PRICE_SOURCE = {
	massive: { publisher: "Massive", sourceUrl: "https://massive.com/" },
	jquants: { publisher: "J-Quants", sourceUrl: "https://jpx-jquants.com/" },
} as const satisfies Record<
	StockPriceProvider,
	{ readonly publisher: string; readonly sourceUrl: string }
>;

/** Each market's currency: the unit of its stocks' price series. */
export const STOCK_PRICE_UNIT = { US: "USD", JP: "JPY" } as const satisfies Record<
	WatchMarket,
	string
>;

const MINUTES_PER_DAY = 1440;
const HOUR_MS = 60 * 60_000;

/** Today's date in the market's zone (YYYY-MM-DD). */
export function marketToday(market: WatchMarket, nowMs: number): string {
	const localMinute = utcMsToLocalMinute(nowMs, STOCK_PRICE_TIME_ZONE[market]);
	return isoDateOfDayNumber(Math.floor(localMinute / MINUTES_PER_DAY));
}

/** The content of one market's `stock-prices-sync` claim. */
export interface StockPricesPlan {
	readonly market: WatchMarket;
	/** Newest first, at most `maxDaysPerJob`. */
	readonly days: readonly string[];
	/** Only when no day is due: directory stocks with no stored series. */
	readonly histories: readonly StockHistoryRequest[];
	readonly adjustmentsSince: string | null;
	readonly windowStart: string;
}

/** Whether a plan asks the runner for anything. */
export function planHasWork(plan: StockPricesPlan): boolean {
	return plan.days.length > 0 || plan.histories.length > 0;
}

/** A stored day as `planSyncDays` reads it; an unreadable retry time is due (never stuck). */
function knownDay(row: StoredStockPriceDay): KnownSyncDay {
	if (row.outcome !== "not-yet-available") return { day: row.day, final: true, retryAtMs: 0 };
	const retryAtMs = row.retryAt === null ? 0 : Date.parse(row.retryAt);
	return { day: row.day, final: false, retryAtMs: Number.isFinite(retryAtMs) ? retryAtMs : 0 };
}

/**
 * One market's plan (ADR-0058 §2 "Day planning", "Per-stock history",
 * "Splits"): the due days of the last `historyDays` calendar days, newest
 * first; only when none is due, up to `maxHistoriesPerJob` directory stocks
 * with no stored series (Watchlist stocks first), each over the whole
 * window. Two reads at most: the window's day rows (≤ ~520, one key range)
 * and, only when no day is due, one bounded directory walk.
 */
export async function planStockPrices(
	repository: Pick<StockPriceRepository, "listDays" | "listUnstoredSymbols">,
	ownerId: string,
	market: WatchMarket,
	nowMs: number,
): Promise<StockPricesPlan> {
	const newest = marketToday(market, nowMs);
	const shifted = addDaysIso(newest, -STOCK_PRICE_LIMITS.historyDays);
	// `newest` comes from the clock and is always a real date.
	const oldest = shifted.ok ? shifted.value : newest;
	const rows = await repository.listDays(ownerId, market, oldest, newest);
	const days = planSyncDays({
		newest,
		oldest,
		known: rows.map(knownDay),
		nowMs,
		max: STOCK_PRICE_LIMITS.maxDaysPerJob,
	});
	// Rows come newest first: the first stored one is the newest stored day.
	const adjustmentsSince = rows.find((row) => row.outcome === "stored")?.day ?? null;
	const histories: StockHistoryRequest[] = [];
	if (days.length === 0) {
		const symbols = await repository.listUnstoredSymbols(
			ownerId,
			market,
			STOCK_PRICE_LIMITS.maxHistoriesPerJob,
		);
		for (const symbol of symbols) {
			// A directory symbol the contract cannot carry is left out, not
			// allowed to make the whole claim invalid.
			if (stockPriceSymbolSchema.safeParse(symbol).success) {
				histories.push({ symbol, from: oldest, to: newest });
			}
		}
	}
	return { market, days, histories, adjustmentsSince, windowStart: oldest };
}

type StockPricesCompletion = Extract<CompleteJobRequest, { outcome: "stock-prices-synced" }>;

/**
 * The writes of a `stock-prices-synced` completion (ADR-0058 §2). Day
 * outcomes are stored as reported (`retry_at` = API time + `retryHours`
 * for `not-yet-available`); bars of stored days and stored histories are
 * upserted (histories after the days, so a split refetch wins a shared
 * date); a stored history replaces its window; a `not-found` history only
 * marks a stock that has no series yet. The SQL keeps only symbols of the
 * market's directory.
 */
export function stockPricesEffects(
	completion: StockPricesCompletion,
	committedAtMs: number,
): StockPricesEffects {
	const retryAt = new Date(committedAtMs + STOCK_PRICE_LIMITS.retryHours * HOUR_MS).toISOString();
	const points: StockPricePoint[] = [];
	const seriesSymbols = new Set<string>();
	const days: StockPricesEffects["days"][number][] = [];
	for (const day of completion.days) {
		days.push({
			day: day.date,
			outcome: day.outcome,
			barCount: day.bars.length,
			retryAt: day.outcome === "not-yet-available" ? retryAt : null,
		});
		if (day.outcome !== "stored") continue;
		for (const [symbol, close, [open, high, low, volume]] of day.bars) {
			points.push([symbol, day.date, close, open, high, low, volume]);
			seriesSymbols.add(symbol);
		}
	}
	const replacements: StockPricesEffects["replacements"][number][] = [];
	const notFoundSymbols: string[] = [];
	for (const history of completion.histories) {
		if (history.outcome === "not-found") {
			notFoundSymbols.push(history.symbol);
			continue;
		}
		const dates: string[] = [];
		for (const [date, close, [open, high, low, volume]] of history.bars) {
			// Only the window the history replaces; a bar outside it is not its answer.
			if (date < history.from || date > history.to) continue;
			points.push([history.symbol, date, close, open, high, low, volume]);
			dates.push(date);
		}
		replacements.push({ symbol: history.symbol, from: history.from, to: history.to, dates });
		seriesSymbols.add(history.symbol);
	}
	const source = STOCK_PRICE_SOURCE[completion.provider];
	return {
		market: completion.market,
		provider: completion.provider,
		fetchedAt: completion.fetchedAt,
		publisher: source.publisher,
		sourceUrl: source.sourceUrl,
		unit: STOCK_PRICE_UNIT[completion.market],
		days,
		seriesSymbols: [...seriesSymbols],
		replacements,
		points,
		// A stock both stored and not found in one answer keeps its stored row.
		notFoundSymbols: notFoundSymbols.filter((symbol) => !seriesSymbols.has(symbol)),
	};
}
