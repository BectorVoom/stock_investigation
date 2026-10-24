import type {
	EarningsEvent,
	EarningsTiming,
	WatchlistResponse,
	WatchlistStock,
	WatchMarket,
} from "@research/contracts";
import {
	type GoogleCalendarState,
	googleCalendarFailureCodeSchema,
	parseStockId,
} from "@research/contracts";
import type { MessagesOf } from "@research/i18n";
import type { ApiFailure } from "../api/http.ts";
import { formatInstant } from "../lib/format.ts";
import type { watchlistModelMessages } from "./watchlistModel.messages.ts";

/**
 * Pure view-model for the Watchlist page and the Home earnings-calendar
 * widget (FR-018). No DOM, no fetch, no clock: every function is a pure
 * derivation over contract types, unit-tested in
 * `apps/web/test/watchlistModel.test.ts` with hand-worked values. The
 * sentences come from `watchlistModelMessages` (ADR-0032), passed in by the
 * view as `text` in the current language.
 */

/** The words the model's sentences are built from, in one language. */
export type WatchlistModelText = MessagesOf<typeof watchlistModelMessages>;

export const WATCH_MARKETS: readonly WatchMarket[] = ["US", "JP"];

/**
 * Problems with a candidate `{ market, symbol }`, listed the guideline way
 * (complete sentences, shown above the form). Empty when the stock can be
 * added. The symbol is trimmed and upper-cased before checking, exactly like
 * the contract's `addWatchlistStockRequestSchema` — and validity is the
 * domain/contract parser alone (`parseStockId`), the one source of truth for
 * the market shapes, never a re-declared pattern.
 */
export function validateNewStock(
	market: string,
	symbol: string,
	text: WatchlistModelText,
): readonly string[] {
	const found: string[] = [];
	if (market !== "US" && market !== "JP") {
		found.push(text.chooseMarket);
		return found;
	}
	const cleaned = symbol.trim().toUpperCase();
	if (cleaned === "") {
		found.push(text.enterSymbol);
		return found;
	}
	const hint = market === "US" ? text.usSymbolHint : text.jpCodeHint;
	if (parseStockId(`${market.toLowerCase()}:${cleaned}`) === null) {
		found.push(text.invalidSymbol(symbol.trim(), hint));
	}
	return found;
}

/** Normalises a symbol the way the contract does before validation. */
export function normaliseSymbol(symbol: string): string {
	return symbol.trim().toUpperCase();
}

/** Human timing ("after market close"), or null when the source states none. */
export function timingText(timing: EarningsTiming, text: WatchlistModelText): string | null {
	return timing === "unknown" ? null : text.timing(timing);
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
	text: WatchlistModelText,
): string {
	// Stale stored dates say so first: the display would otherwise show a
	// past date (or a failure reason beside dates that no longer hold).
	// `storedDatesPassed` is the sentence shown whenever every stored date has
	// passed (never a past date shown as next).
	if (storedDatesPassed(stock, today)) return text.storedDatesPassed;
	if (stock.unavailable !== null) return stock.unavailable.reason;
	if (stock.events.length === 0) return text.noRefreshYet;
	if (nextDatedEvent(stock, today) === null) return text.onlyUndecided;
	return text.noneInWindow(daysAhead);
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
 * "pending" polls at the slow cadence; a leased run polls fast. An active
 * `google-calendar` run (connect or sync) keeps the poll alive too (FR-019):
 * both the sign-in URL and the sync counts arrive through the poll the views
 * already run.
 */
export function watchlistRefreshSignal(
	current: WatchlistResponse | null,
): "active" | "queued" | "unchanged" {
	if (current !== null && current.refresh.activeRunId !== null) {
		return current.refresh.activeRunState === "pending" ? "queued" : "active";
	}
	if (current !== null && current.googleCalendar.activeRunId !== null) {
		return current.googleCalendar.activeRunState === "pending" ? "queued" : "active";
	}
	return "unchanged";
}

/** True when a `google-calendar` run (connect, sync or disconnect) is active. */
export function isGoogleCalendarRunActive(current: WatchlistResponse | null | undefined): boolean {
	return current !== null && current !== undefined && current.googleCalendar.activeRunId !== null;
}

/**
 * The refresh status line, with the same states as Home's (last success, the
 * active run id + state while refreshing, the last failure code beside the
 * last success, and the waits-for-the-local-runner note).
 */
export function watchlistStatusText(current: WatchlistResponse, text: WatchlistModelText): string {
	if (current.refresh.activeRunId !== null) {
		const state = current.refresh.activeRunState ?? "queued";
		return text.statusRefreshing(state, current.refresh.activeRunId);
	}
	const parts: string[] = [];
	if (current.refresh.lastSucceededAt !== null) {
		parts.push(text.lastSuccess(formatInstant(current.refresh.lastSucceededAt)));
	}
	if (current.refresh.lastFailure !== null) {
		parts.push(
			text.lastFailure(
				current.refresh.lastFailure.code,
				formatInstant(current.refresh.lastFailure.at),
			),
		);
	}
	if (parts.length > 0) return parts.join(" ");
	return text.noRefreshCompleted;
}

/** True when the failure means the request never reached the server (safe to retry with the key). */
export function isNetworkFailure(failure: ApiFailure): boolean {
	return failure.kind === "network";
}

/**
 * The fixed human reason sentence for a Google Calendar failure code
 * (FR-019 section 2.2): the contract's sentence per code, the generic
 * reason for a code the contract does not know (a runner that sent a
 * non-GOOGLE code) — provider text never reaches the UI.
 */
export function googleFailureReason(code: string, text: WatchlistModelText): string {
	const known = googleCalendarFailureCodeSchema.safeParse(code);
	return text.googleFailure(known.success ? known.data : "GOOGLE_REQUEST_FAILED");
}

/**
 * Whether the view should queue one automatic Google Calendar sync (FR-019
 * section 2.7), used by BOTH `WatchlistView` and `HomeView` when a calendar
 * widget is shown. Pure: every input arrives as an argument.
 *
 * Two things keep this from ever looping:
 *   - a recorded failure stops automatic syncing altogether, until a sync
 *     the owner starts ("Sync now") succeeds and clears it. The failure is
 *     stored by the API, so the stop holds across reloads and tabs. (A rule
 *     keyed on the ETag alone would loop: every failed run records a new
 *     `lastFailure`, which is itself an ETag change.)
 *   - within one mount, at most one attempt per watchlist ETag — the caller
 *     records the ETag it attempted for and passes it back — which covers
 *     the outcomes that record nothing (a queue request that failed, a run
 *     the owner cancelled).
 */
export function googleAutoSyncWanted(
	current: WatchlistResponse,
	currentEtag: string,
	attemptedEtag: string | null,
): boolean {
	if (current.googleCalendar.status !== "connected") return false;
	if (current.googleCalendar.inSync !== false) return false;
	if (current.googleCalendar.lastFailure !== null) return false;
	if (current.googleCalendar.activeRunId !== null) return false;
	if (current.refresh.activeRunId !== null) return false;
	if (attemptedEtag === currentEtag) return false;
	return true;
}

/**
 * The Google part of the Home widget's single status line (FR-019 section 2.7).
 * `text` defaults to English only so Home's existing call keeps compiling
 * while it is translated; every caller should pass the current language's
 * table.
 */
export function googleWidgetStatus(state: GoogleCalendarState, text: WatchlistModelText): string {
	switch (state.status) {
		case "connected":
			if (state.activeRunId !== null) {
				return state.activeAction === "disconnect" ? text.googleDisconnecting : text.googleSyncing;
			}
			if (state.lastSyncedAt !== null) {
				return text.googleSynced(formatInstant(state.lastSyncedAt));
			}
			return text.googleConnectedNotSynced;
		case "connecting":
			return text.googleConnecting;
		case "needs-reconnect":
			return text.googleReconnectNeeded;
		default:
			return text.googleNotConnected;
	}
}

/**
 * Twenty-four hours: a watchlist whose newest earnings-date refresh is older
 * queues one automatic refresh per view mount (mirrors Home's
 * `HOME_AUTO_REFRESH_STALE_MS`, which is thirty minutes for market data).
 */
export const EARNINGS_AUTO_REFRESH_STALE_MS = 24 * 3_600_000;

export type { EarningsAutoRefreshReason } from "./watchlistModel.messages.ts";

import type { EarningsAutoRefreshReason } from "./watchlistModel.messages.ts";

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
