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
		noPrices: (symbol: string) =>
			`No prices are stored for ${symbol}. Prices are downloaded for stocks shown on Home or in a notebook.`,
		openHome: "Open Home",
		oneClose:
			"The chart needs at least two stored closes; only one is stored. It draws once the next close is downloaded.",
	},
	ja: {
		chartTitle: (stock) => `${stock} — 日次終値`,
		summaryLabel: "最新の終値",
		pricesThing: "保存された株価",
		pricesFailed: "保存された株価を読み込めませんでした。",
		noPrices: (symbol) =>
			`${symbol} の株価は保存されていません。株価はホームまたはノートブックに表示されている銘柄についてダウンロードされます。`,
		openHome: "ホームを開く",
		oneClose:
			"チャートには保存された終値が2つ以上必要ですが、保存されているのは1つだけです。次の終値がダウンロードされると表示されます。",
	},
});
