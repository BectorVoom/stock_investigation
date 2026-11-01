import { defineMessages } from "@research/i18n";

/**
 * The Watchlist page (ADR-0032). Tickers, exchange codes, company names,
 * fiscal-period labels and dates stay as they are; the sentences the pure
 * model builds are in `watchlistModel.messages.ts`.
 */
export const watchlistMessages = defineMessages({
	en: {
		addToGoogleCalendar: "Add to Google Calendar",
		addToOutlook: "Add to Outlook",
		dateUndecided: "date undecided",
		furtherDates: (count: number) => `${count} further date${count === 1 ? "" : "s"}`,
		oneFurtherUndecided: "One further announcement has its date undecided.",
		notRetrievedYet: "not retrieved yet",
		removeNamed: (symbol: string) => `Remove ${symbol}`,

		loadFailed: "Could not load the watchlist.",
		didNotRefresh: "The watchlist could not be re-read; what is shown may be out of date.",
		googleSyncNotQueued: (reason: string) => `The Google Calendar sync was not queued: ${reason}`,
		notAdded: "The stock was not added.",
		notRemoved: "The stock was not removed.",
		removed: (symbol: string) => `Removed ${symbol}.`,

		searchStocks: "Search stocks",
		searchPlaceholder: "Company name or symbol, e.g. Toyota or 7203",
		matchingStocks: "Matching stocks",
		alreadyAdded: "Added",
		market: "Market",
		symbol: "Symbol",

		stocksAndLists: "Stocks and lists",
		/** The noun in "Loading watchlist…". */
		watchlistThing: "watchlist",
		nextAnnouncementColumn: "Next announcement",
		retrievedColumn: "Retrieved",
		sourceColumn: "Source",
		actionsColumn: "Actions",

		removeTitle: (symbol: string) => `Remove ${symbol}?`,
		removeStock: "Remove stock",
		removeBody: (symbol: string) =>
			`${symbol} and its earnings dates are removed from the watchlist. This cannot be undone.`,
	},
	ja: {
		addToGoogleCalendar: "Google Calendar に追加",
		addToOutlook: "Outlook に追加",
		dateUndecided: "日付未定",
		furtherDates: (count) => `ほかに ${count} 件の日付`,
		oneFurtherUndecided: "ほかに日付未定の発表が 1 件あります。",
		notRetrievedYet: "未取得",
		removeNamed: (symbol) => `${symbol} を削除`,

		loadFailed: "ウォッチリストを読み込めませんでした。",
		didNotRefresh: "ウォッチリストを再読み込みできませんでした。表示内容は古い可能性があります。",
		googleSyncNotQueued: (reason) => `Google Calendar の同期を予約できませんでした: ${reason}`,
		notAdded: "銘柄を追加できませんでした。",
		notRemoved: "銘柄を削除できませんでした。",
		removed: (symbol) => `${symbol} を削除しました。`,

		searchStocks: "銘柄を検索",
		searchPlaceholder: "会社名または銘柄コード（例: トヨタ、7203）",
		matchingStocks: "一致する銘柄",
		alreadyAdded: "登録済み",
		market: "市場",
		symbol: "銘柄コード",

		stocksAndLists: "銘柄とリスト",
		watchlistThing: "ウォッチリスト",
		nextAnnouncementColumn: "次回発表",
		retrievedColumn: "取得日時",
		sourceColumn: "出典",
		actionsColumn: "操作",

		removeTitle: (symbol) => `${symbol} を削除しますか？`,
		removeStock: "銘柄を削除",
		removeBody: (symbol) =>
			`${symbol} とその決算発表日をウォッチリストから削除します。この操作は取り消せません。`,
	},
});
