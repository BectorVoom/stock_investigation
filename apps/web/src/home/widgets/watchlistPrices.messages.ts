import { defineMessages } from "@research/i18n";

/**
 * Words of the Watchlist prices widget (ADR-0040 §5). List titles, symbols,
 * company names, prices and dates are data and never pass through here; the
 * column names and the change cells are the Stock table's
 * (`marketWidgets.messages.ts`).
 */
export const watchlistPricesMessages = defineMessages({
	en: {
		stockCount: (count: number) => `${count} stock${count === 1 ? "" : "s"}`,
		/** The table's accessible name: the list's title, then what it shows. */
		tableLabel: (title: string) => `${title}: last close and change from the previous close`,
		/** The row-header column. */
		stock: "Stock",
		/** The noun in "Loading the watchlist…". */
		watchlistThing: "the watchlist",
		loadFailed: "The watchlist did not load.",
		deleted: "This list was deleted.",
		deletedHint: "Remove this widget from its menu.",
		empty: "No stocks in this list yet.",
		openWatchlist: "Add stocks on the Watchlist page",
		notShown: (limit: number) => `Not shown: this page already shows ${limit} price series`,
		/** A Small widget's last line when the list has more stocks than fit. */
		moreRows: (count: number) => `${count} more — a larger size shows every stock`,
	},
	ja: {
		stockCount: (count) => `${count} 銘柄`,
		tableLabel: (title) => `${title}：終値と前日終値からの変化`,
		stock: "銘柄",
		watchlistThing: "ウォッチリスト",
		loadFailed: "ウォッチリストを読み込めませんでした。",
		deleted: "このリストは削除されました。",
		deletedHint: "ウィジェットのメニューからこのウィジェットを削除してください。",
		empty: "このリストにはまだ銘柄がありません。",
		openWatchlist: "ウォッチリストのページで銘柄を追加",
		notShown: (limit) => `表示されません：このページはすでに ${limit} 件の価格系列を表示しています`,
		moreRows: (count) => `ほかに ${count} 銘柄（大きいサイズですべて表示）`,
	},
});
