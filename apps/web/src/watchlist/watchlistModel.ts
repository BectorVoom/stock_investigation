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
	STOCK_DIRECTORY_LIMITS,
	type StockDirectoryHit,
	type StockDirectoryMarketStatus,
	type StockDirectoryStatusResponse,
	stockDirectoryFailureCodeSchema,
} from "@research/contracts";
import type { Locale, MessagesOf } from "@research/i18n";
import type { ApiFailure } from "../api/http.ts";
import { formatInstant, formatInteger } from "../lib/format.ts";
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

/* ----- stock directory search (ADR-0033) ----- */

const DAY_MS = 86_400_000;

/** A stored list older than this is refreshed once when the Watchlist opens. */
export const STOCK_DIRECTORY_STALE_MS = STOCK_DIRECTORY_LIMITS.staleAfterDays * DAY_MS;

type DirectoryFailure = NonNullable<StockDirectoryMarketStatus["lastFailure"]>;

/**
 * The market's failure that still stands, or null. A failure at or before
 * the stored list's download was followed by a success, so it no longer
 * describes the list (the API may keep it beside the last success, like the
 * earnings refresh does).
 */
export function currentDirectoryFailure(
	market: StockDirectoryMarketStatus,
): DirectoryFailure | null {
	const failure = market.lastFailure;
	if (failure === null) return null;
	if (market.retrievedAt === null) return failure;
	const failedMs = Date.parse(failure.at);
	const retrievedMs = Date.parse(market.retrievedAt);
	if (Number.isFinite(failedMs) && Number.isFinite(retrievedMs) && retrievedMs >= failedMs) {
		return null;
	}
	return failure;
}

/** True when the market has no stored list, or its list is older than `STOCK_DIRECTORY_STALE_MS`. */
export function isDirectoryListStale(market: StockDirectoryMarketStatus, nowMs: number): boolean {
	if (market.entryCount === 0 || market.retrievedAt === null) return true;
	const retrievedMs = Date.parse(market.retrievedAt);
	if (!Number.isFinite(retrievedMs)) return true;
	return nowMs - retrievedMs > STOCK_DIRECTORY_STALE_MS;
}

/**
 * The markets the Watchlist queues a list download for when it opens
 * (ADR-0033 decision 4), evaluated once per visit by the view: a market
 * whose list is missing or stale, with no run of its own active, and whose
 * standing failure is not `DIRECTORY_NOT_CONFIGURED` — a configuration
 * error fails the same way until the owner edits `apps/runner/.env`, so it
 * is never queued automatically (the "Update stock list" button still
 * can). Pure: `nowMs` is passed in.
 */
export function directoryAutoRefreshMarkets(
	status: StockDirectoryStatusResponse,
	nowMs: number,
): readonly WatchMarket[] {
	const markets: WatchMarket[] = [];
	for (const market of status.markets) {
		if (market.activeRunId !== null) continue;
		if (currentDirectoryFailure(market)?.code === "DIRECTORY_NOT_CONFIGURED") continue;
		if (isDirectoryListStale(market, nowMs)) markets.push(market.market);
	}
	return markets;
}

/** True only when a status is LOADED and some market has a list download active. */
export function isStockDirectoryRunActive(
	status: StockDirectoryStatusResponse | null | undefined,
): boolean {
	return status?.markets.some((market) => market.activeRunId !== null) ?? false;
}

/**
 * The poll signal of a directory status: fast while a download is leased,
 * slow while every active one still waits for a runner, idle otherwise.
 */
export function stockDirectoryPollSignal(
	status: StockDirectoryStatusResponse,
): "active" | "queued" | "unchanged" {
	const active = status.markets.filter((market) => market.activeRunId !== null);
	if (active.length === 0) return "unchanged";
	return active.every((market) => market.activeRunState === "pending") ? "queued" : "active";
}

/**
 * True when some market has a stored list, false when none has, null before
 * the status is known. Lets the search say "no list yet" instead of "no
 * match" when an empty answer only means nothing is downloaded.
 */
export function hasStoredDirectoryList(
	status: StockDirectoryStatusResponse | null,
): boolean | null {
	if (status === null) return null;
	return status.markets.some((market) => market.entryCount > 0);
}

/** The fixed sentence for a stock-list failure: one per contract code, a generic one otherwise. */
export function directoryFailureReason(
	failure: DirectoryFailure,
	text: WatchlistModelText,
): string {
	const known = stockDirectoryFailureCodeSchema.safeParse(failure.code);
	return known.success
		? text.directoryFailure(known.data)
		: text.directoryFailedWithCode(failure.code);
}

/**
 * One market's status line: "US list: 7,691 stocks, retrieved …", with the
 * source's own as-of date when it states one (JPX), then the active
 * download and the failure that still stands.
 */
export function directoryStatusLine(
	market: StockDirectoryMarketStatus,
	text: WatchlistModelText,
): string {
	const parts: string[] = [];
	if (market.entryCount > 0 && market.retrievedAt !== null) {
		// "7,691": the same digits and separators in both UI languages.
		const count = formatInteger(market.entryCount);
		parts.push(
			market.asOf === null
				? text.directoryCountRetrieved(count, formatInstant(market.retrievedAt))
				: text.directoryCountAsOf(count, market.asOf),
		);
	} else {
		parts.push(text.directoryNotDownloaded);
	}
	if (market.activeRunId !== null) {
		parts.push(text.directoryUpdating(market.activeRunState ?? "pending"));
	}
	const failure = currentDirectoryFailure(market);
	if (failure !== null) {
		parts.push(
			failure.state === "cancelled"
				? text.directoryCancelled
				: text.directoryLastFailed(directoryFailureReason(failure, text)),
		);
	}
	return `${text.directoryListName(market.market)}: ${text.joinSentences(parts)}`;
}

/**
 * The query a search box text asks, or null when there is nothing to search:
 * trimmed and cut to the contract's `maxQueryChars`, so the request always
 * passes `stockDirectorySearchQuerySchema`.
 */
export function stockSearchQuery(text: string): string | null {
	const query = text.trim().slice(0, STOCK_DIRECTORY_LIMITS.maxQueryChars).trim();
	return query === "" ? null : query;
}

/** What the search box shows: nothing yet, a request on its way, its hits, or its failure. */
export type StockSearchState =
	| { readonly kind: "idle" }
	| { readonly kind: "searching"; readonly query: string }
	| {
			readonly kind: "results";
			readonly query: string;
			readonly hits: readonly StockDirectoryHit[];
	  }
	| { readonly kind: "failed"; readonly query: string; readonly error: ApiFailure };

/** The hits a state holds (empty unless it holds results). */
export function stockSearchHits(state: StockSearchState): readonly StockDirectoryHit[] {
	return state.kind === "results" ? state.hits : [];
}

/**
 * The search box's live status line. `listsStored` is false when no market
 * has a list, so an empty answer is explained as "nothing downloaded" rather
 * than "no match"; `reason` words an API failure in the UI language.
 */
export function stockSearchStatusText(
	state: StockSearchState,
	listsStored: boolean | null,
	text: WatchlistModelText,
	reason: (error: ApiFailure) => string,
): string {
	switch (state.kind) {
		case "idle":
			return "";
		case "searching":
			return text.searching;
		case "failed":
			return text.searchFailed(reason(state.error));
		case "results":
			if (state.hits.length > 0) return text.searchResults(state.hits.length);
			return listsStored === false ? text.noListDownloaded : text.noStockMatches(state.query);
	}
}

/** A hit's names in the UI language: the Japanese name leads in Japanese, the English one in English. */
export interface StockHitNames {
	readonly primary: string;
	/** The other language's name, or null when the row has only one (US rows). */
	readonly secondary: string | null;
}

export function stockHitNames(hit: StockDirectoryHit, locale: Locale): StockHitNames {
	if (hit.localName === null || hit.localName === hit.name) {
		return { primary: hit.name, secondary: null };
	}
	return locale === "ja"
		? { primary: hit.localName, secondary: hit.name }
		: { primary: hit.name, secondary: hit.localName };
}

/** "Japan · Prime": the market and the listing, in the UI language. */
export function stockHitPlace(hit: StockDirectoryHit, text: WatchlistModelText): string {
	return text.marketAndListing(text.marketName(hit.market), text.listingName(hit.listing));
}

/** "Selected: 7203 Toyota Motor Corp. (Japan)". */
export function selectedStockText(
	hit: StockDirectoryHit,
	locale: Locale,
	text: WatchlistModelText,
): string {
	return text.selectedStock(
		hit.symbol,
		stockHitNames(hit, locale).primary,
		text.marketName(hit.market),
	);
}

/**
 * The picked hit while the form still holds its market and symbol, else
 * null: editing the symbol or the market by hand ends the pick, so
 * "Selected: …" never names a stock other than the one "Add stock" adds.
 */
export function pickedStockFor(
	picked: StockDirectoryHit | null,
	market: string,
	symbol: string,
): StockDirectoryHit | null {
	if (picked === null) return null;
	return picked.market === market && picked.symbol === normaliseSymbol(symbol) ? picked : null;
}

/**
 * The option ↓/↑ moves to in a list of `count` (WAI-ARIA combobox: from no
 * option, ↓ goes to the first and ↑ to the last; both wrap). -1 when the
 * list is empty.
 */
export function moveActiveOption(
	active: number,
	count: number,
	direction: "next" | "previous",
): number {
	if (count <= 0) return -1;
	if (direction === "next") return active < 0 || active >= count - 1 ? 0 : active + 1;
	return active <= 0 || active > count - 1 ? count - 1 : active - 1;
}
