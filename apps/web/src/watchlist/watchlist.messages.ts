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
		didNotRefresh: "The watchlist did not refresh.",
		googleSyncNotQueued: (reason: string) => `The Google Calendar sync was not queued: ${reason}`,
		followUpQueued: "A stock was added while the refresh ran, so one follow-up refresh was queued.",
		alreadyQueuing: "An earnings-date refresh is already being queued.",
		refreshNotQueued: "The earnings-date refresh was not queued.",
		refreshQueued: "Earnings-date refresh queued for the local runner.",
		notAdded: "The stock was not added.",
		added: (symbol: string) =>
			`Added ${symbol}. Its earnings dates are being fetched by the local runner.`,
		notRemoved: "The stock was not removed.",
		removed: (symbol: string) => `Removed ${symbol}.`,

		addStockTitle: "Add a stock",
		addStockHint:
			"Search every US and Japanese listed stock by company name or symbol, pick one, then add it. Its earnings announcement dates appear below after the next refresh.",
		searchStocks: "Search stocks",
		searchPlaceholder: "Company name or symbol, e.g. Toyota or 7203",
		matchingStocks: "Matching stocks",
		alreadyAdded: "Added",
		enterSymbolInstead: "Enter a symbol instead",
		updateStockList: "Update stock list",
		directoryLoadFailed: "Could not load the stock list status.",
		directoryNotQueued: "The stock list update was not queued.",
		directoryQueued: "Stock list update queued for the local runner.",
		toAddThisStock: "To add this stock:",
		beforeYouCanAdd: "Before you can add this stock",
		market: "Market",
		symbol: "Symbol",
		addStock: "Add stock",

		registeredStocks: "Registered stocks",
		refreshEarningsDates: "Refresh earnings dates",
		/** The noun in "Loading watchlist…". */
		watchlistThing: "watchlist",
		noStocks:
			"No stocks registered yet. Add a US or Japanese stock above to track its earnings dates.",
		stocksCaption: "Stocks you follow, with their next earnings announcement date",
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
		didNotRefresh: "ウォッチリストを更新できませんでした。",
		googleSyncNotQueued: (reason) => `Google Calendar の同期を予約できませんでした: ${reason}`,
		followUpQueued: "更新中に銘柄が追加されたため、追加の更新を 1 回予約しました。",
		alreadyQueuing: "決算発表日の更新はすでに予約中です。",
		refreshNotQueued: "決算発表日の更新を予約できませんでした。",
		refreshQueued: "決算発表日の更新をローカルのランナーに予約しました。",
		notAdded: "銘柄を追加できませんでした。",
		added: (symbol) => `${symbol} を追加しました。決算発表日はローカルのランナーが取得しています。`,
		notRemoved: "銘柄を削除できませんでした。",
		removed: (symbol) => `${symbol} を削除しました。`,

		addStockTitle: "銘柄を追加",
		addStockHint:
			"米国と日本のすべての上場銘柄を会社名または銘柄コードで検索し、選んでから追加します。次回の更新後、決算発表日が下に表示されます。",
		searchStocks: "銘柄を検索",
		searchPlaceholder: "会社名または銘柄コード（例: トヨタ、7203）",
		matchingStocks: "一致する銘柄",
		alreadyAdded: "登録済み",
		enterSymbolInstead: "銘柄コードを直接入力",
		updateStockList: "銘柄一覧を更新",
		directoryLoadFailed: "銘柄一覧の状態を読み込めませんでした。",
		directoryNotQueued: "銘柄一覧の更新を予約できませんでした。",
		directoryQueued: "銘柄一覧の更新をローカルのランナーに予約しました。",
		toAddThisStock: "この銘柄を追加するには:",
		beforeYouCanAdd: "銘柄を追加する前に",
		market: "市場",
		symbol: "銘柄コード",
		addStock: "追加",

		registeredStocks: "登録済みの銘柄",
		refreshEarningsDates: "決算発表日を更新",
		watchlistThing: "ウォッチリスト",
		noStocks:
			"まだ銘柄が登録されていません。上で米国または日本の銘柄を追加すると、決算発表日を追跡できます。",
		stocksCaption: "フォロー中の銘柄と次回の決算発表日",
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
