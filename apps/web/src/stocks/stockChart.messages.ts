import { defineMessages } from "@research/i18n";

/**
 * The Stocks page's Chart tab (ADR-0049 §4, ADR-0058 §6, ADR-0032). Its
 * stale note is the Stock table's (`marketWidgetMessages`); the viewer's
 * own words are the chart viewer's (`chartViewerMessages`).
 * Symbols, names, publishers, values, units and dates are data and stay as
 * they are.
 */
export const stockChartMessages = defineMessages({
	en: {
		/** "Loading <thing>…". */
		pricesThing: "stored prices",
		pricesFailed: "The stored prices could not be loaded.",
		/** A listed stock whose first prices the server has not downloaded yet (ADR-0058 §2). */
		noPricesYet: (symbol: string) =>
			`No prices are stored for ${symbol} yet. The server downloads every listed stock's daily prices; they appear here once stored.`,
		/** A stock outside the stored stock lists: the server never downloads its prices. */
		noPricesNotListed: (symbol: string) =>
			`No prices are stored for ${symbol}. The server downloads the daily prices of the stocks in the stored US and Japanese stock lists, and ${symbol} is not in them.`,
		oneClose:
			"The chart needs at least two stored closes; only one is stored. It draws once the next close is downloaded.",
		/** Before the stored series' publisher (a link to its source). */
		source: "Source: ",
		/** Under a Japanese stock's chart (ADR-0058 §2: J-Quants Free is about 12 weeks behind). */
		japaneseDelay: "Japanese prices come from J-Quants Free and end about 12 weeks ago.",
	},
	ja: {
		pricesThing: "保存された株価",
		pricesFailed: "保存された株価を読み込めませんでした。",
		noPricesYet: (symbol) =>
			`${symbol} の株価はまだ保存されていません。サーバーは上場しているすべての銘柄の日次株価をダウンロードします。保存されるとここに表示されます。`,
		noPricesNotListed: (symbol) =>
			`${symbol} の株価は保存されていません。サーバーは保存済みの米国・日本の銘柄一覧にある銘柄の日次株価をダウンロードしますが、${symbol} は一覧にありません。`,
		oneClose:
			"チャートには保存された終値が2つ以上必要ですが、保存されているのは1つだけです。次の終値がダウンロードされると表示されます。",
		source: "出典：",
		japaneseDelay:
			"日本株の株価は J-Quants（Free プラン）から取得しており、約12週間前までのものです。",
	},
});
