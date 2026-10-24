import {
	type EarningsTiming,
	GOOGLE_CALENDAR_FAILURE_REASONS,
	type GoogleCalendarFailureCode,
	type StockDirectoryFailureCode,
	type StockListing,
	type WatchMarket,
} from "@research/contracts";
import { defineMessages } from "@research/i18n";
import { runStateMessages } from "../i18n/runState.messages.ts";

type StatedTiming = Exclude<EarningsTiming, "unknown">;

/** Why the view queues one automatic earnings-date refresh (`earningsAutoRefreshReason`). */
export type EarningsAutoRefreshReason = "never-refreshed" | "stale";

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
 * The fixed sentence per stock-list failure code (ADR-0034). Provider text
 * never reaches the UI; a code the contract does not know gets the generic
 * sentence with the code itself (`directoryFailedWithCode`).
 */
const EN_DIRECTORY_FAILURES: { readonly [C in StockDirectoryFailureCode]: string } = {
	DIRECTORY_NOT_CONFIGURED:
		"Set SEC_USER_AGENT in apps/runner/.env (the name and contact e-mail address SEC asks for) to download the US list.",
	DIRECTORY_RATE_LIMITED: "The source limited requests; try again later.",
	DIRECTORY_SOURCE_FAILED: "The source could not be reached.",
	DIRECTORY_PARSE_FAILED: "The downloaded list could not be read, so the stored list was kept.",
};

const JA_DIRECTORY_FAILURES: { readonly [C in StockDirectoryFailureCode]: string } = {
	DIRECTORY_NOT_CONFIGURED:
		"米国の銘柄一覧を取得するには、apps/runner/.env に SEC_USER_AGENT（SEC が求める名前と連絡先メールアドレス）を設定してください。",
	DIRECTORY_RATE_LIMITED:
		"取得元の利用回数の上限に達しました。しばらくしてから再試行してください。",
	DIRECTORY_SOURCE_FAILED: "取得元に接続できませんでした。",
	DIRECTORY_PARSE_FAILED:
		"取得した一覧を読み取れなかったため、保存済みの一覧をそのまま使っています。",
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
		chooseMarket: "Choose a market.",
		enterSymbol: "Search for a stock and pick it, or enter its symbol.",
		usSymbolHint: "A US symbol starts with a letter, e.g. AAPL.",
		jpCodeHint: "A Japanese code has four characters, e.g. 7203.",
		invalidSymbol: (symbol: string, hint: string) => `"${symbol}" is not a valid symbol. ${hint}`,
		timing: (timing: StatedTiming): string =>
			({
				"before-open": "before market open",
				"after-close": "after market close",
				"during-session": "during the trading session",
			})[timing],
		storedDatesPassed: "unavailable (the stored dates have passed; refresh to update)",
		noRefreshYet: "No earnings dates have been refreshed yet; queue a refresh.",
		onlyUndecided: "The source lists the announcement with the date undecided.",
		noneInWindow: (days: number) => `The source lists no announcement in the next ${days} days.`,
		statusRefreshing: (state: string, runId: string) =>
			`Refreshing earnings dates… (${state}, run ${runId}). It is fetched by the local runner; if the runner is offline it stays queued until the runner reconnects.`,
		lastSuccess: (when: string) => `Last successful refresh: ${when}.`,
		lastFailure: (code: string, when: string) => `Last refresh failed (${code}) at ${when}.`,
		noRefreshCompleted: "No earnings-date refresh has completed yet.",
		googleDisconnecting: "Google Calendar: disconnecting…",
		googleSyncing: "Google Calendar: syncing…",
		googleSynced: (when: string) => `Google Calendar: synced ${when}.`,
		googleConnectedNotSynced: "Google Calendar: connected, not synced yet.",
		googleConnecting: "Google Calendar: connecting…",
		googleReconnectNeeded: "Google Calendar: reconnect needed.",
		googleNotConnected: "Google Calendar: not connected.",
		autoRefreshNotice: (reason: EarningsAutoRefreshReason): string =>
			({
				"never-refreshed": "Earnings dates had not been fetched yet, so one refresh was queued.",
				stale: "Earnings dates were more than a day old, so one refresh was queued.",
			})[reason],

		listingName: (listing: StockListing): string => EN_LISTINGS[listing],
		marketAndListing: (market: string, listing: string) => `${market} · ${listing}`,
		selectedStock: (symbol: string, name: string, market: string) =>
			`Selected: ${symbol} ${name} (${market})`,
		/** Beside "Add stock": the market and symbol it will add, whichever way they were set. */
		addTarget: (symbol: string, market: string) => `To add: ${symbol} (${market})`,
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
			"No stock list is downloaded yet. Enter the symbol under “Enter a symbol instead”.",
		searchFailed: (reason: string) => `The search failed: ${reason}`,
		directoryListName: (market: WatchMarket): string =>
			({ US: "US list", JP: "Japan list" })[market],
		directoryCountRetrieved: (count: string, when: string) => `${count} stocks, retrieved ${when}.`,
		directoryCountAsOf: (count: string, asOf: string) => `${count} stocks, as of ${asOf}.`,
		directoryNotDownloaded: "not downloaded yet.",
		directoryUpdating: (state: string) => `Updating (${state})…`,
		directoryLastFailed: (reason: string) => `The last update failed: ${reason}`,
		directoryFailure: (code: StockDirectoryFailureCode): string => EN_DIRECTORY_FAILURES[code],
		directoryFailedWithCode: (code: string) => `The update failed (${code}).`,
		/** Sentences of one line: English puts a space between them, Japanese none. */
		joinSentences: (sentences: readonly string[]): string => sentences.join(" "),
	},
	ja: {
		googleFailure: (code) => JA_GOOGLE_FAILURES[code],
		marketName: (market) => JA_MARKET_NAMES[market],
		chooseMarket: "市場を選んでください。",
		enterSymbol: "銘柄を検索して選ぶか、銘柄コードを入力してください。",
		usSymbolHint: "米国のティッカーは英字で始まります（例: AAPL）。",
		jpCodeHint: "日本の銘柄コードは 4 文字です（例: 7203）。",
		invalidSymbol: (symbol, hint) => `「${symbol}」は有効な銘柄コードではありません。${hint}`,
		timing: (timing) =>
			({
				"before-open": "取引開始前",
				"after-close": "取引終了後",
				"during-session": "取引時間中",
			})[timing],
		storedDatesPassed: "取得できません（保存された日付は過ぎています。更新してください）",
		noRefreshYet: "決算発表日はまだ更新されていません。更新を予約してください。",
		onlyUndecided: "出典では発表日が未定です。",
		noneInWindow: (days) => `出典には今後 ${days} 日以内の発表がありません。`,
		statusRefreshing: (state, runId) =>
			`決算発表日を更新中…（${runStateMessages.ja.name(state)}、実行 ${runId}）。ローカルのランナーが取得します。ランナーがオフラインの間は、再接続するまで予約されたままです。`,
		lastSuccess: (when) => `最後に成功した更新: ${when}。`,
		lastFailure: (code, when) => `${when} の更新に失敗しました（${code}）。`,
		noRefreshCompleted: "決算発表日の更新はまだ完了していません。",
		googleDisconnecting: "Google Calendar: 切断中…",
		googleSyncing: "Google Calendar: 同期中…",
		googleSynced: (when) => `Google Calendar: ${when} に同期しました。`,
		googleConnectedNotSynced: "Google Calendar: 接続済み、まだ同期していません。",
		googleConnecting: "Google Calendar: 接続中…",
		googleReconnectNeeded: "Google Calendar: 再接続が必要です。",
		googleNotConnected: "Google Calendar: 未接続です。",
		autoRefreshNotice: (reason) =>
			({
				"never-refreshed": "決算発表日がまだ取得されていなかったため、更新を 1 回予約しました。",
				stale: "決算発表日が 1 日以上前のものだったため、更新を 1 回予約しました。",
			})[reason],

		listingName: (listing) => JA_LISTINGS[listing],
		marketAndListing: (market, listing) => `${market}・${listing}`,
		selectedStock: (symbol, name, market) => `選択中: ${symbol} ${name}（${market}）`,
		addTarget: (symbol, market) => `追加する銘柄: ${symbol}（${market}）`,
		searching: "検索中…",
		searchResults: (count) => `${count} 件`,
		noStockMatches: (query) => `「${query}」に一致する銘柄はありません。`,
		searchResultsIn: (count, market) => `${JA_MARKET_NAMES[market]}の銘柄 ${count} 件。`,
		noStockMatchesIn: (query, market) =>
			`「${query}」に一致する${JA_MARKET_NAMES[market]}の銘柄はありません。`,
		listNotDownloaded: (market) => `${JA_MARKET_NAMES[market]}の銘柄一覧はまだ取得されていません。`,
		noListDownloaded:
			"銘柄一覧はまだ取得されていません。「銘柄コードを直接入力」で銘柄コードを入力してください。",
		searchFailed: (reason) => `検索に失敗しました: ${reason}`,
		directoryListName: (market) => ({ US: "米国の銘柄一覧", JP: "日本の銘柄一覧" })[market],
		directoryCountRetrieved: (count, when) => `${count} 銘柄、${when} に取得。`,
		directoryCountAsOf: (count, asOf) => `${count} 銘柄、${asOf} 時点。`,
		directoryNotDownloaded: "まだ取得していません。",
		directoryUpdating: (state) => `更新中（${runStateMessages.ja.name(state)}）…`,
		directoryLastFailed: (reason) => `前回の更新に失敗しました: ${reason}`,
		directoryFailure: (code) => JA_DIRECTORY_FAILURES[code],
		directoryFailedWithCode: (code) => `更新に失敗しました（${code}）。`,
		joinSentences: (sentences) => sentences.join(""),
	},
});
