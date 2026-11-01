import { defineMessages } from "@research/i18n";

/**
 * The Stocks page's Chart tab (ADR-0049 §4, ADR-0032). The column words of
 * its summary line are the Stock table's (`marketWidgetMessages`); the
 * viewer's own words are the chart viewer's (`chartViewerMessages`).
 * Symbols, names, values, units and dates are data and stay as they are.
 */
export const stockChartMessages = defineMessages({
	en: {
		/** The inline viewer's heading, plot name and data-table name. */
		chartTitle: (stock: string) => `${stock} — daily closes`,
		/** The summary line's accessible name. */
		summaryLabel: "Latest close",
		/** "Loading <thing>…". */
		pricesThing: "stored prices",
		pricesFailed: "The stored prices could not be loaded.",
		/** A Watchlist stock whose first closes have not been downloaded yet (ADR-0055). */
		noPricesYet: (symbol: string) =>
			`No prices are stored for ${symbol} yet. The server downloads the daily closes of every Watchlist stock; they appear here once stored.`,
		noPricesNotWatched: (symbol: string) =>
			`No prices are stored for ${symbol}. The server downloads the daily closes of every Watchlist stock. Add ${symbol} to the Watchlist to see its prices.`,
		oneClose:
			"The chart needs at least two stored closes; only one is stored. It draws once the next close is downloaded.",
	},
	ja: {
		chartTitle: (stock) => `${stock} — 日次終値`,
		summaryLabel: "最新の終値",
		pricesThing: "保存された株価",
		pricesFailed: "保存された株価を読み込めませんでした。",
		noPricesYet: (symbol) =>
			`${symbol} の株価はまだ保存されていません。サーバーはウォッチリストのすべての銘柄の日次終値をダウンロードします。保存されるとここに表示されます。`,
		noPricesNotWatched: (symbol) =>
			`${symbol} の株価は保存されていません。サーバーはウォッチリストのすべての銘柄の日次終値をダウンロードします。株価を見るには、${symbol} をウォッチリストに追加してください。`,
		oneClose:
			"チャートには保存された終値が2つ以上必要ですが、保存されているのは1つだけです。次の終値がダウンロードされると表示されます。",
	},
});
