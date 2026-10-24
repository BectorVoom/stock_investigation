import {
	type EarningsTiming,
	GOOGLE_CALENDAR_FAILURE_REASONS,
	type GoogleCalendarFailureCode,
	type WatchMarket,
} from "@research/contracts";
import { defineMessages } from "@research/i18n";

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
		enterSymbol: "Enter a symbol.",
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
	},
	ja: {
		googleFailure: (code) => JA_GOOGLE_FAILURES[code],
		marketName: (market) => ({ US: "米国", JP: "日本" })[market],
		chooseMarket: "市場を選んでください。",
		enterSymbol: "銘柄コードを入力してください。",
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
			`決算発表日を更新中…（${state}、実行 ${runId}）。ローカルのランナーが取得します。ランナーがオフラインの間は、再接続するまで予約されたままです。`,
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
	},
});
