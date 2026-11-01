import { defineMessages } from "@research/i18n";

/**
 * The Watchlist page (ADR-0032). Tickers, exchange codes, company names,
 * fiscal-period labels and dates stay as they are; the sentences the pure
 * model builds are in `watchlistModel.messages.ts`.
 */
export const watchlistMessages = defineMessages({
	en: {
		loadFailed: "Could not load the watchlist.",
		didNotRefresh: "The watchlist could not be re-read; what is shown may be out of date.",
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
		sourceColumn: "Source",
		actionsColumn: "Actions",

		removeTitle: (symbol: string) => `Remove ${symbol}?`,
		removeStock: "Remove stock",
		removeBody: (symbol: string) =>
			`${symbol} and its earnings dates are removed from the watchlist. This cannot be undone.`,
	},
	ja: {
		loadFailed: "ウォッチリストを読み込めませんでした。",
		didNotRefresh: "ウォッチリストを再読み込みできませんでした。表示内容は古い可能性があります。",
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
		sourceColumn: "出典",
		actionsColumn: "操作",

		removeTitle: (symbol) => `${symbol} を削除しますか？`,
		removeStock: "銘柄を削除",
		removeBody: (symbol) =>
			`${symbol} とその決算発表日をウォッチリストから削除します。この操作は取り消せません。`,
	},
});
