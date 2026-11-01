import {
	GOOGLE_CALENDAR_FAILURE_REASONS,
	type GoogleCalendarFailureCode,
	type StockListing,
	type WatchMarket,
} from "@research/contracts";
import { defineMessages } from "@research/i18n";
import { commonMessages } from "../i18n/common.messages.ts";
import { reasonWithUpstreamStatus, withUpstreamStatus } from "../i18n/upstreamStatus.ts";

/** The fixed Japanese sentence per Google Calendar failure code (English is the contract's). */
const JA_GOOGLE_FAILURES: { readonly [C in GoogleCalendarFailureCode]: string } = {
	GOOGLE_NOT_CONFIGURED:
		"Google Calendar が設定されていません。apps/runner/.env に GOOGLE_OAUTH_CLIENT_ID と GOOGLE_OAUTH_CLIENT_SECRET を設定してください。",
	GOOGLE_AUTH_TIMEOUT:
		"Google のサインインが 5 分でタイムアウトしました。もう一度接続してください。",
	GOOGLE_CONSENT_DENIED: "Google のサインインが完了しませんでした。同意が拒否されました。",
	GOOGLE_SCOPE_MISSING:
		"Google がカレンダーへのアクセスを許可しませんでした。再接続してアクセスを許可してください。",
	GOOGLE_AUTH_EXPIRED:
		"Google との接続の有効期限が切れました。Google Calendar に再接続してください。",
	GOOGLE_CLIENT_REJECTED:
		"Google が OAuth クライアントを拒否しました。apps/runner/.env の GOOGLE_OAUTH_CLIENT_ID と GOOGLE_OAUTH_CLIENT_SECRET を確認してください。",
	GOOGLE_RATE_LIMITED:
		"Google Calendar の利用回数の上限に達しました。しばらくしてから再試行してください。",
	GOOGLE_REQUEST_FAILED: "Google Calendar へのリクエストに失敗しました。",
	GOOGLE_NOT_CONNECTED: "Google Calendar が接続されていません。同期する前に接続してください。",
};

/** "No US stock …" / "The Japanese stock list …": the market as an adjective. */
const EN_MARKET_ADJECTIVES: { readonly [M in WatchMarket]: string } = {
	US: "US",
	JP: "Japanese",
};

const JA_MARKET_NAMES: { readonly [M in WatchMarket]: string } = { US: "米国", JP: "日本" };

/** Where a listing trades, as the search results name it (ADR-0034). */
const EN_LISTINGS: { readonly [L in StockListing]: string } = {
	nasdaq: "Nasdaq",
	nyse: "NYSE",
	cboe: "Cboe",
	txse: "Texas SE",
	"tse-prime": "Prime",
	"tse-standard": "Standard",
	"tse-growth": "Growth",
};

const JA_LISTINGS: { readonly [L in StockListing]: string } = {
	nasdaq: "ナスダック",
	nyse: "NYSE",
	cboe: "Cboe",
	txse: "テキサス証券取引所",
	"tse-prime": "プライム",
	"tse-standard": "スタンダード",
	"tse-growth": "グロース",
};

/**
 * The sentences the pure watchlist model builds (ADR-0032), shared by the
 * Watchlist page and Home's earnings-calendar widget. The model takes this
 * table as a parameter; tickers, codes, run ids and instants stay as they are.
 * Google Calendar is a product name and is not translated.
 */
export const watchlistModelMessages = defineMessages({
	en: {
		googleFailure: (code: GoogleCalendarFailureCode): string =>
			GOOGLE_CALENDAR_FAILURE_REASONS[code],
		marketName: (market: WatchMarket): string => ({ US: "US", JP: "Japan" })[market],
		/** A provider's reason sentence with its own answer status after it (ADR-0037). */
		reasonWithUpstreamStatus: (reason: string, upstreamStatus: number | null): string =>
			reasonWithUpstreamStatus(reason, upstreamStatus, commonMessages.en),
		/** A failure code with the service's own answer status after it (ADR-0037). */
		codeWithUpstreamStatus: (code: string, upstreamStatus: number | null): string =>
			withUpstreamStatus(code, upstreamStatus, commonMessages.en),
		googleDisconnecting: "Google Calendar: disconnecting…",
		googleSyncing: "Google Calendar: syncing…",
		googleSynced: (when: string) => `Google Calendar: synced ${when}.`,
		googleConnectedNotSynced: "Google Calendar: connected, not synced yet.",
		googleConnecting: "Google Calendar: connecting…",
		googleReconnectNeeded: "Google Calendar: reconnect needed.",
		googleNotConnected: "Google Calendar: not connected.",

		listingName: (listing: StockListing): string => EN_LISTINGS[listing],
		marketAndListing: (market: string, listing: string) => `${market} · ${listing}`,
		selectedStock: (symbol: string, name: string, market: string) =>
			`Selected: ${symbol} ${name} (${market})`,
		searching: "Searching…",
		searchResults: (count: number) => `${count} result${count === 1 ? "" : "s"}`,
		noStockMatches: (query: string) => `No stock matches "${query}".`,
		/** Only one market's list is stored, so only that market was searched. */
		searchResultsIn: (count: number, market: WatchMarket) =>
			`${count} ${EN_MARKET_ADJECTIVES[market]} result${count === 1 ? "" : "s"}.`,
		noStockMatchesIn: (query: string, market: WatchMarket) =>
			`No ${EN_MARKET_ADJECTIVES[market]} stock matches "${query}".`,
		listNotDownloaded: (market: WatchMarket) =>
			`The ${EN_MARKET_ADJECTIVES[market]} stock list is not downloaded yet.`,
		noListDownloaded:
			"No stock list is downloaded yet. The server downloads them when the local runner next takes work.",
		searchFailed: (reason: string) => `The search failed: ${reason}`,
		/** Sentences of one line: English puts a space between them, Japanese none. */
		joinSentences: (sentences: readonly string[]): string => sentences.join(" "),
	},
	ja: {
		googleFailure: (code) => JA_GOOGLE_FAILURES[code],
		marketName: (market) => JA_MARKET_NAMES[market],
		reasonWithUpstreamStatus: (reason, upstreamStatus) =>
			reasonWithUpstreamStatus(reason, upstreamStatus, commonMessages.ja),
		codeWithUpstreamStatus: (code, upstreamStatus) =>
			withUpstreamStatus(code, upstreamStatus, commonMessages.ja),
		googleDisconnecting: "Google Calendar: 切断中…",
		googleSyncing: "Google Calendar: 同期中…",
		googleSynced: (when) => `Google Calendar: ${when} に同期しました。`,
		googleConnectedNotSynced: "Google Calendar: 接続済み、まだ同期していません。",
		googleConnecting: "Google Calendar: 接続中…",
		googleReconnectNeeded: "Google Calendar: 再接続が必要です。",
		googleNotConnected: "Google Calendar: 未接続です。",

		listingName: (listing) => JA_LISTINGS[listing],
		marketAndListing: (market, listing) => `${market}・${listing}`,
		selectedStock: (symbol, name, market) => `選択中: ${symbol} ${name}（${market}）`,
		searching: "検索中…",
		searchResults: (count) => `${count} 件`,
		noStockMatches: (query) => `「${query}」に一致する銘柄はありません。`,
		searchResultsIn: (count, market) => `${JA_MARKET_NAMES[market]}の銘柄 ${count} 件。`,
		noStockMatchesIn: (query, market) =>
			`「${query}」に一致する${JA_MARKET_NAMES[market]}の銘柄はありません。`,
		listNotDownloaded: (market) => `${JA_MARKET_NAMES[market]}の銘柄一覧はまだ取得されていません。`,
		noListDownloaded:
			"銘柄一覧はまだ取得されていません。ローカルランナーが次に処理を受け取ったときに、サーバーが取得します。",
		searchFailed: (reason) => `検索に失敗しました: ${reason}`,
		joinSentences: (sentences) => sentences.join(""),
	},
});
