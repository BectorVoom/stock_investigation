/**
 * Every directory stock's daily prices (ADR-0058 §2): what one market's
 * `stock-prices-sync` job asks for, and what its completion stores.
 *
 * The plan is read from the stored day outcomes and series rows each time
 * it is needed — when the schedule decides whether a job is due and again
 * when the claim is prepared — so a job that waited asks for the days that
 * are due when it runs. The unit of work is one trading date of one market
 * (`planSyncDays`, newest first); once no date of the window is due, the
 * plan names the stocks whose window history is pending: owed split
 * refetches, then stocks whose history was never filled. The claim records
 * what it asked for in the job's request, and the completion is held to it.
 */
import {
	type CompleteJobRequest,
	STOCK_PRICE_LIMITS,
	STOCK_PRICE_PUBLISHERS,
	type StockHistoryRequest,
	type StockPriceProvider,
	stockPriceSymbolSchema,
	type WatchMarket,
} from "@research/contracts";
import {
	addDaysIso,
	isoDateOfDayNumber,
	isoDayNumber,
	type KnownSyncDay,
	localMinuteToUtcMs,
	planSyncDays,
	utcMsToLocalMinute,
} from "@research/domain";
import type {
	StockPricePoint,
	StockPriceRepository,
	StockPricesClaimRecord,
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
	massive: { publisher: STOCK_PRICE_PUBLISHERS.massive, sourceUrl: "https://massive.com/" },
	jquants: { publisher: STOCK_PRICE_PUBLISHERS.jquants, sourceUrl: "https://jpx-jquants.com/" },
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

/**
 * A history answered `unavailable` (the plan refused or the request failed
 * for that stock) is not asked again for this long, so the stocks behind it
 * get their turn (ADR-0058 §2).
 */
export const STOCK_HISTORY_BACKOFF_HOURS = 24;

/** The content of one market's `stock-prices-sync` claim. */
export interface StockPricesPlan {
	readonly market: WatchMarket;
	/** Newest first, at most `maxDaysPerJob`. */
	readonly days: readonly string[];
	/** Only when no day is due: owed split refetches, then stocks never filled. */
	readonly histories: readonly StockHistoryRequest[];
	/** The market's split watermark (`stock_price_market`), null when never checked. */
	readonly adjustmentsSince: string | null;
	readonly windowStart: string;
	/** The window's last day: the market's local today. */
	readonly newest: string;
}

/** Whether a plan asks the runner for anything. */
export function planHasWork(plan: StockPricesPlan): boolean {
	return plan.days.length > 0 || plan.histories.length > 0;
}

/** What the claim records in the job's request, so its completion is held to it. */
export function claimRecordOf(plan: StockPricesPlan): StockPricesClaimRecord {
	return {
		days: [...plan.days],
		histories: plan.histories.map((history) => ({ ...history })),
		windowStart: plan.windowStart,
		newest: plan.newest,
	};
}

/**
 * A stored day as `planSyncDays` reads it: final exactly when it has no
 * retry time. An unreadable retry time is due (never stuck).
 */
function knownDay(row: StoredStockPriceDay): KnownSyncDay {
	if (row.retryAt === null) return { day: row.day, final: true, retryAtMs: 0 };
	const retryAtMs = Date.parse(row.retryAt);
	return { day: row.day, final: false, retryAtMs: Number.isFinite(retryAtMs) ? retryAtMs : 0 };
}

/**
 * One market's plan (ADR-0058 §2 "Day planning", "Per-stock history",
 * "Splits"): the due days of the last `historyDays` calendar days, newest
 * first; only when none is due, up to `maxHistoriesPerJob` stocks, each over
 * the whole window: those that owe a refetch after a split (oldest request
 * first), then directory stocks whose history was never filled (Watchlist
 * stocks first) — neither while backed off. `adjustmentsSince` is how far
 * the market's splits were checked. Reads: the window's day rows (≤ ~520,
 * one key range), the split watermark (one key) and, only when no day is
 * due, the owed refetches and one bounded directory walk.
 */
export async function planStockPrices(
	repository: Pick<
		StockPriceRepository,
		"listDays" | "getSplitCheckedOn" | "listRefetchSymbols" | "listUnfilledSymbols"
	>,
	ownerId: string,
	market: WatchMarket,
	nowMs: number,
): Promise<StockPricesPlan> {
	const newest = marketToday(market, nowMs);
	const shifted = addDaysIso(newest, -STOCK_PRICE_LIMITS.historyDays);
	// `newest` comes from the clock and is always a real date.
	const oldest = shifted.ok ? shifted.value : newest;
	const [rows, adjustmentsSince] = await Promise.all([
		repository.listDays(ownerId, market, oldest, newest),
		repository.getSplitCheckedOn(ownerId, market),
	]);
	const days = planSyncDays({
		newest,
		oldest,
		known: rows.map(knownDay),
		nowMs,
		max: STOCK_PRICE_LIMITS.maxDaysPerJob,
	});
	const histories: StockHistoryRequest[] = [];
	if (days.length === 0) {
		const cap = STOCK_PRICE_LIMITS.maxHistoriesPerJob;
		const nowIso = new Date(nowMs).toISOString();
		// Owed split refetches first (their stored bars are inconsistent),
		// then the stocks whose window was never filled.
		const owed = await repository.listRefetchSymbols(ownerId, market, nowIso, cap);
		const unfilled =
			owed.length >= cap ? [] : await repository.listUnfilledSymbols(ownerId, market, nowIso, cap);
		const named = new Set<string>();
		for (const symbol of [...owed, ...unfilled]) {
			if (histories.length >= cap || named.has(symbol)) continue;
			named.add(symbol);
			// A directory symbol the contract cannot carry is left out, not
			// allowed to make the whole claim invalid.
			if (stockPriceSymbolSchema.safeParse(symbol).success) {
				histories.push({ symbol, from: oldest, to: newest });
			}
		}
	}
	return { market, days, histories, adjustmentsSince, windowStart: oldest, newest };
}

type StockPricesCompletion = Extract<CompleteJobRequest, { outcome: "stock-prices-synced" }>;

/** The UTC instant a market-local date begins. */
function localDayStartMs(market: WatchMarket, dayNumber: number): number {
	return localMinuteToUtcMs(dayNumber * MINUTES_PER_DAY, STOCK_PRICE_TIME_ZONE[market]);
}

/** `[from, to]` ∩ `[lowest, highest]`, or null when empty. */
function clampWindow(
	from: string,
	to: string,
	lowest: string,
	highest: string,
): { readonly from: string; readonly to: string } | null {
	const start = from > lowest ? from : lowest;
	const end = to < highest ? to : highest;
	return start <= end ? { from: start, to: end } : null;
}

/**
 * The writes of a `stock-prices-synced` completion (ADR-0058 §2), held to
 * the claim it answers (`claim`, recorded when the lease was granted):
 *
 * - Only claimed days count; a day the runner reports beside them is ignored.
 *   A day's finality: `not-yet-available` is asked again after
 *   `retryHours`; `no-trading` is final only when a stored day newer than it
 *   proves the provider has data past it (this completion's, or — checked
 *   in SQL — one already stored), else it is asked again after
 *   `retryHours`; `stored` is final unless the day was at most `settleDays`
 *   old in the market's zone, then it is asked once more from the local
 *   start of the day after it settled; `too-old` is final.
 * - A requested history counts only for a claimed stock, and only within
 *   its claimed window; a split history only within `[windowStart, the
 *   newest claimed day]` (the window's end when no day was claimed). Bars
 *   outside the window are dropped, so a stored history replaces exactly
 *   that window. Histories are upserted after the days, so a split refetch
 *   wins a shared date.
 * - `not-found` marks a stock with no series yet; `unavailable` backs the
 *   stock off for `STOCK_HISTORY_BACKOFF_HOURS`. A stored or not-found
 *   history fills the stock's window and settles any refetch it owed; a
 *   split stock (`splitSymbols`) without one owes a refetch.
 * - The split watermark advances to `splitCheckedThrough`, never past the
 *   claim's window.
 *
 * The SQL keeps only symbols of the market's directory.
 */
export function stockPricesEffects(
	completion: StockPricesCompletion,
	claim: StockPricesClaimRecord,
	committedAtMs: number,
): StockPricesEffects {
	const retryAt = new Date(committedAtMs + STOCK_PRICE_LIMITS.retryHours * HOUR_MS).toISOString();
	const market = completion.market;
	const todayNumber = Math.floor(
		utcMsToLocalMinute(committedAtMs, STOCK_PRICE_TIME_ZONE[market]) / MINUTES_PER_DAY,
	);
	const claimedDays = new Set(claim.days);
	const reportedDays = completion.days.filter((day) => claimedDays.has(day.date));
	const newestStored = reportedDays.reduce<string | null>(
		(newest, day) =>
			day.outcome === "stored" && (newest === null || day.date > newest) ? day.date : newest,
		null,
	);
	const points: StockPricePoint[] = [];
	const seriesSymbols = new Set<string>();
	const days: StockPricesEffects["days"][number][] = [];
	for (const day of reportedDays) {
		let dayRetryAt: string | null = null;
		if (day.outcome === "not-yet-available") {
			dayRetryAt = retryAt;
		} else if (day.outcome === "no-trading") {
			dayRetryAt = newestStored !== null && newestStored > day.date ? null : retryAt;
		} else if (day.outcome === "stored") {
			const dayNumber = isoDayNumber(day.date);
			if (dayNumber !== null && todayNumber - dayNumber <= STOCK_PRICE_LIMITS.settleDays) {
				dayRetryAt = new Date(
					localDayStartMs(market, dayNumber + STOCK_PRICE_LIMITS.settleDays + 1),
				).toISOString();
			}
		}
		days.push({
			day: day.date,
			outcome: day.outcome,
			barCount: day.bars.length,
			retryAt: dayRetryAt,
		});
		if (day.outcome !== "stored") continue;
		for (const [symbol, close, [open, high, low, volume]] of day.bars) {
			points.push([symbol, day.date, close, open, high, low, volume]);
			seriesSymbols.add(symbol);
		}
	}
	const requested = new Map(claim.histories.map((history) => [history.symbol, history]));
	const newestClaimedDay = claim.days.reduce<string | null>(
		(newest, day) => (newest === null || day > newest ? day : newest),
		null,
	);
	const splitWindowEnd = newestClaimedDay ?? claim.newest;
	const replacements: StockPricesEffects["replacements"][number][] = [];
	const notFound = new Set<string>();
	const backoff = new Set<string>();
	const stored = new Set<string>();
	for (const history of completion.histories) {
		const asked = requested.get(history.symbol);
		const bounds =
			history.reason === "requested"
				? asked === undefined
					? null
					: clampWindow(history.from, history.to, asked.from, asked.to)
				: clampWindow(history.from, history.to, claim.windowStart, splitWindowEnd);
		// A history the claim did not ask for, or outside its window, is ignored.
		if (bounds === null) continue;
		if (history.outcome === "not-found") {
			notFound.add(history.symbol);
			continue;
		}
		if (history.outcome === "unavailable") {
			backoff.add(history.symbol);
			continue;
		}
		const dates: string[] = [];
		for (const [date, close, [open, high, low, volume]] of history.bars) {
			if (date < bounds.from || date > bounds.to) continue;
			points.push([history.symbol, date, close, open, high, low, volume]);
			dates.push(date);
		}
		replacements.push({ symbol: history.symbol, from: bounds.from, to: bounds.to, dates });
		seriesSymbols.add(history.symbol);
		stored.add(history.symbol);
	}
	// A stock both stored and not found (or unavailable) in one answer keeps its stored row.
	const notFoundSymbols = [...notFound].filter((symbol) => !stored.has(symbol));
	const settled = new Set([...stored, ...notFoundSymbols]);
	const source = STOCK_PRICE_SOURCE[completion.provider];
	const splitCheckedOn =
		completion.splitCheckedThrough === null
			? null
			: completion.splitCheckedThrough < claim.newest
				? completion.splitCheckedThrough
				: claim.newest;
	return {
		market,
		provider: completion.provider,
		fetchedAt: completion.fetchedAt,
		committedAt: new Date(committedAtMs).toISOString(),
		windowStart: claim.windowStart,
		publisher: source.publisher,
		sourceUrl: source.sourceUrl,
		unit: STOCK_PRICE_UNIT[market],
		days,
		seriesSymbols: [...seriesSymbols],
		replacements,
		points,
		notFoundSymbols,
		filledSymbols: [...settled],
		historyCleared: [...settled],
		refetchOwed: completion.splitSymbols.filter((symbol) => !settled.has(symbol)),
		backoffSymbols: [...backoff].filter((symbol) => !settled.has(symbol)),
		backoffUntil: new Date(committedAtMs + STOCK_HISTORY_BACKOFF_HOURS * HOUR_MS).toISOString(),
		splitCheckedOn,
	};
}
