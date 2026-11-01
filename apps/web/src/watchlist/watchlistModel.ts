import type { WatchlistResponse, WatchMarket } from "@research/contracts";
import {
	type GoogleCalendarState,
	googleCalendarFailureCodeSchema,
	STOCK_DIRECTORY_LIMITS,
	type StockDirectoryHit,
	type StockDirectoryStatusResponse,
} from "@research/contracts";
import type { Locale, MessagesOf } from "@research/i18n";
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

/** True when at least one stock was never refreshed (`lastRefreshedAt === null`). */
export function hasNeverRefreshedStock(current: WatchlistResponse): boolean {
	return current.stocks.some((stock) => stock.lastRefreshedAt === null);
}

/* ----- stock directory search (ADR-0034) ----- */

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
 * The markets whose list is stored (US first), or null before the status is
 * known. Lets the search say what an answer covers: "no list yet" instead
 * of "no match" when nothing is stored, and which market alone was searched
 * when only one list is.
 */
export function storedDirectoryMarkets(
	status: StockDirectoryStatusResponse | null,
): readonly WatchMarket[] | null {
	if (status === null) return null;
	return status.markets.filter((market) => market.entryCount > 0).map((market) => market.market);
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
	| {
			readonly kind: "searching";
			readonly query: string;
			/** The previous answer's hits, kept on screen until the new answer arrives. */
			readonly hits: readonly StockDirectoryHit[];
	  }
	| {
			readonly kind: "results";
			readonly query: string;
			readonly hits: readonly StockDirectoryHit[];
	  }
	| { readonly kind: "failed"; readonly query: string; readonly error: ApiFailure };

/** The hits a state shows: an answer's, or the previous answer's while the next one runs. */
export function stockSearchHits(state: StockSearchState): readonly StockDirectoryHit[] {
	return state.kind === "results" || state.kind === "searching" ? state.hits : [];
}

/**
 * The search box's live status line. `storedMarkets` names the markets
 * whose list is stored (null before the status is known): with none, an
 * empty answer is explained as "nothing downloaded" rather than "no match";
 * with one, the line says the search covered only that market and which
 * list is missing. `reason` words an API failure in the UI language.
 */
export function stockSearchStatusText(
	state: StockSearchState,
	storedMarkets: readonly WatchMarket[] | null,
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
		case "results": {
			if (storedMarkets !== null && storedMarkets.length === 0) {
				return state.hits.length > 0
					? text.searchResults(state.hits.length)
					: text.noListDownloaded;
			}
			const only = storedMarkets?.length === 1 ? storedMarkets[0] : undefined;
			if (only === undefined) {
				return state.hits.length > 0
					? text.searchResults(state.hits.length)
					: text.noStockMatches(state.query);
			}
			const missing: WatchMarket = only === "US" ? "JP" : "US";
			return text.joinSentences([
				state.hits.length > 0
					? text.searchResultsIn(state.hits.length, only)
					: text.noStockMatchesIn(state.query, only),
				text.listNotDownloaded(missing),
			]);
		}
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
