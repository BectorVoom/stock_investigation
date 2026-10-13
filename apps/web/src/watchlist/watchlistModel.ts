import type {
	EarningsEvent,
	EarningsTiming,
	WatchlistResponse,
	WatchlistStock,
	WatchMarket,
} from "@research/contracts";
import { parseStockId } from "@research/contracts";
import type { ApiFailure } from "../api/http.ts";
import { formatInstant } from "../lib/format.ts";

/**
 * Pure view-model for the Watchlist page and the Home earnings-calendar
 * widget (FR-018). No DOM, no fetch, no clock: every function is a pure
 * derivation over contract types, unit-tested in
 * `apps/web/test/watchlistModel.test.ts` with hand-worked values.
 */

export const WATCH_MARKETS: readonly WatchMarket[] = ["US", "JP"];

export const MARKET_LABELS: { readonly [M in WatchMarket]: string } = {
	US: "US",
	JP: "Japan",
};

/**
 * Problems with a candidate `{ market, symbol }`, listed the guideline way
 * (complete sentences, shown above the form). Empty when the stock can be
 * added. The symbol is trimmed and upper-cased before checking, exactly like
 * the contract's `addWatchlistStockRequestSchema` — and validity is the
 * domain/contract parser alone (`parseStockId`), the one source of truth for
 * the market shapes, never a re-declared pattern.
 */
export function validateNewStock(market: string, symbol: string): readonly string[] {
	const found: string[] = [];
	if (market !== "US" && market !== "JP") {
		found.push("Choose a market.");
		return found;
	}
	const cleaned = symbol.trim().toUpperCase();
	if (cleaned === "") {
		found.push("Enter a symbol.");
		return found;
	}
	const hint =
		market === "US"
			? "A US symbol starts with a letter, e.g. AAPL."
			: "A Japanese code has four characters, e.g. 7203.";
	if (parseStockId(`${market.toLowerCase()}:${cleaned}`) === null) {
		found.push(`"${symbol.trim()}" is not a valid symbol. ${hint}`);
	}
	return found;
}

/** Normalises a symbol the way the contract does before validation. */
export function normaliseSymbol(symbol: string): string {
	return symbol.trim().toUpperCase();
}

const TIMING_TEXT: { readonly [T in Exclude<EarningsTiming, "unknown">]: string } = {
	"before-open": "before market open",
	"after-close": "after market close",
	"during-session": "during the trading session",
};

/** Human timing ("after market close"), or null when the source states none. */
export function timingText(timing: EarningsTiming): string | null {
	return timing === "unknown" ? null : TIMING_TEXT[timing];
}

/**
 * The first dated event on or after `today` (events arrive dated ascending,
 * undecided last), or null. Stored dates are only replaced by a successful
 * refresh, so without the `today` floor a past date would show as the "next"
 * announcement. `today` is passed in (UTC `YYYY-MM-DD`) — the pure model
 * never reads the clock itself.
 */
export function nextDatedEvent(stock: WatchlistStock, today: string): EarningsEvent | null {
	for (const event of stock.events) {
		if (event.announcementDate !== null && event.announcementDate >= today) return event;
	}
	return null;
}

/** True when the stock lists dated events but every one lies before `today`. */
export function storedDatesPassed(stock: WatchlistStock, today: string): boolean {
	let dated = false;
	for (const event of stock.events) {
		if (event.announcementDate === null) continue;
		dated = true;
		if (event.announcementDate >= today) return false;
	}
	return dated;
}

/** Stated as text when every stored date has passed (never a past date shown as next). */
export const STORED_DATES_PASSED_NOTICE =
	"unavailable (the stored dates have passed; refresh to update)";

/** True when the stock lists at least one announcement with the date undecided. */
export function hasUndecidedEvent(stock: WatchlistStock): boolean {
	return stock.events.some((event) => event.announcementDate === null);
}

/**
 * Why a stock has no upcoming date inside the widget window: its stored
 * unavailable reason, "date undecided" when it lists only undecided
 * announcements, or that nothing falls in the window. Never a guess.
 */
export function withoutUpcomingReason(
	stock: WatchlistStock,
	daysAhead: number,
	today: string,
): string {
	// Stale stored dates say so first: the display would otherwise show a
	// past date (or a failure reason beside dates that no longer hold).
	if (storedDatesPassed(stock, today)) return STORED_DATES_PASSED_NOTICE;
	if (stock.unavailable !== null) return stock.unavailable.reason;
	if (stock.events.length === 0)
		return "No earnings dates have been refreshed yet; queue a refresh.";
	if (nextDatedEvent(stock, today) === null)
		return "The source lists the announcement with the date undecided.";
	return `The source lists no announcement in the next ${daysAhead} days.`;
}

/** Today's UTC date (`YYYY-MM-DD`) from a millisecond clock reading. */
export function utcTodayIso(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 10);
}

export type WatchlistPollSignal = "active" | "queued" | "changed" | "unchanged" | "failed";

/**
 * True only when a response is LOADED and names an active run. `undefined` or
 * a null id means nothing is active — in particular a failed first load
 * (`data()` still null) must not start the poller as if a refresh were
 * running (`undefined !== null` and `null` checks alone both get this wrong).
 */
export function isWatchlistRefreshActive(current: WatchlistResponse | null | undefined): boolean {
	return current !== null && current !== undefined && current.refresh.activeRunId !== null;
}

/**
 * The run signal carried by the watchlist response itself (like Home's V7):
 * "pending" polls at the slow cadence; a leased run polls fast.
 */
export function watchlistRefreshSignal(
	current: WatchlistResponse | null,
): "active" | "queued" | "unchanged" {
	if (current !== null && current.refresh.activeRunId !== null) {
		return current.refresh.activeRunState === "pending" ? "queued" : "active";
	}
	return "unchanged";
}

/**
 * The refresh status line, with the same states as Home's (last success, the
 * active run id + state while refreshing, the last failure code beside the
 * last success, and the waits-for-the-local-runner note).
 */
export function watchlistStatusText(current: WatchlistResponse): string {
	if (current.refresh.activeRunId !== null) {
		const state = current.refresh.activeRunState ?? "queued";
		return `Refreshing earnings dates… (${state}, run ${current.refresh.activeRunId}). It is fetched by the local runner; if the runner is offline it stays queued until the runner reconnects.`;
	}
	const parts: string[] = [];
	if (current.refresh.lastSucceededAt !== null) {
		parts.push(`Last successful refresh: ${formatInstant(current.refresh.lastSucceededAt)}.`);
	}
	if (current.refresh.lastFailure !== null) {
		parts.push(
			`Last refresh failed (${current.refresh.lastFailure.code}) at ${formatInstant(current.refresh.lastFailure.at)}.`,
		);
	}
	if (parts.length > 0) return parts.join(" ");
	return "No earnings-date refresh has completed yet.";
}

/** True when the failure means the request never reached the server (safe to retry with the key). */
export function isNetworkFailure(failure: ApiFailure): boolean {
	return failure.kind === "network";
}

/**
 * Twenty-four hours: a watchlist whose newest earnings-date refresh is older
 * queues one automatic refresh per view mount (mirrors Home's
 * `HOME_AUTO_REFRESH_STALE_MS`, which is thirty minutes for market data).
 */
export const EARNINGS_AUTO_REFRESH_STALE_MS = 24 * 3_600_000;

export type EarningsAutoRefreshReason = "never-refreshed" | "stale";

/** The announce text per reason, shared by the Watchlist page and Home. */
export const EARNINGS_AUTO_REFRESH_NOTICE: {
	readonly [R in EarningsAutoRefreshReason]: string;
} = {
	"never-refreshed": "Earnings dates had not been fetched yet, so one refresh was queued.",
	stale: "Earnings dates were more than a day old, so one refresh was queued.",
};

/** True when at least one stock was never refreshed (`lastRefreshedAt === null`). */
export function hasNeverRefreshedStock(current: WatchlistResponse): boolean {
	return current.stocks.some((stock) => stock.lastRefreshedAt === null);
}

/**
 * Why the view should queue one automatic earnings-date refresh, or null
 * when none is needed: an empty list never queues, an active run means a
 * refresh is already underway, and otherwise a never-refreshed stock (or an
 * unparsable stamp, like Home's `needsAutoRefresh`) beats the staleness
 * check on the newest stamp. Pure: `nowMs` is passed in, never read here.
 */
export function earningsAutoRefreshReason(
	current: WatchlistResponse,
	nowMs: number,
): EarningsAutoRefreshReason | null {
	if (current.stocks.length === 0) return null;
	if (current.refresh.activeRunId !== null) return null;
	let newest = Number.NEGATIVE_INFINITY;
	for (const stock of current.stocks) {
		const at = stock.lastRefreshedAt;
		if (at === null) return "never-refreshed";
		const ms = Date.parse(at);
		if (!Number.isFinite(ms)) return "never-refreshed";
		if (ms > newest) newest = ms;
	}
	if (newest === Number.NEGATIVE_INFINITY) return "never-refreshed";
	return nowMs - newest > EARNINGS_AUTO_REFRESH_STALE_MS ? "stale" : null;
}
