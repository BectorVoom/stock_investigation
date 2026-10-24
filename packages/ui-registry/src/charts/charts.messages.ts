import { defineMessages } from "@research/i18n";

/**
 * The charts' own words: accessible descriptions, readouts, notices and the
 * data-table twin. Titles, axis labels, series names, units and values are
 * the chart's content and are shown as written.
 */
export const chartMessages = defineMessages({
	en: {
		/** "<y title> by <x title>. " in a chart's accessible name. */
		axesBoth: (yTitle: string, xTitle: string) => `${yTitle} by ${xTitle}. `,
		axesYOnly: (yTitle: string) => `${yTitle}. `,
		axesXOnly: (xTitle: string) => `By ${xTitle}. `,
		lineChartLabel: (title: string, axes: string, series: readonly string[]) =>
			`Line chart: ${title}. ${axes}Series: ${series.join(", ")}.`,
		barChartLabel: (title: string, axes: string, series: readonly string[]) =>
			`Bar chart: ${title}. ${axes}Series: ${series.join(", ")}.`,
		readoutHint: "Point at the chart to read values; the data table below lists every value.",
		/** A value the readout cannot show. */
		unavailable: "unavailable",
		legend: "Legend",
		assumptions: (count: number) => `${count} ${count === 1 ? "assumption" : "assumptions"}`,
		derivedValues: (count: number) =>
			`${count} ${count === 1 ? "derived value" : "derived values"}`,
		unstatedValues: (count: number) =>
			`${count} ${count === 1 ? "value with no stated basis" : "values with no stated basis"}`,
		basisNote: (parts: readonly string[]) =>
			`Not sourced measurements: ${parts.join(", ")}. Each is marked in the data table.`,
		withheldSeries: (label: string, reason: string) => `Series "${label}" — ${reason}.`,
		missingColumns: (keys: readonly string[]) =>
			`Not in the dataset, so not plotted: ${keys.join(", ")}.`,
		unavailablePoints: (count: number) =>
			`${count} ${count === 1 ? "point" : "points"} unavailable — not plotted (never drawn as 0). See the data table for the reasons.`,
		noRows: "No data — this dataset has no rows.",
		noPlottableValues: "No plottable data — every requested value is unavailable.",
		dataTableSummary: (title: string) => `Data table: ${title}`,
		dataTableCaption: (title: string) => `Values plotted in "${title}"`,
		candlestickLabel: (title: string, priceUnit: string) =>
			`Candlestick chart: ${title}. Open, high, low and close price (${priceUnit}) by date.`,
		candleUp: "Close at or above open",
		candleDown: "Close below open",
		dateAxis: "Date",
		priceAxis: (priceUnit: string) => `Price (${priceUnit})`,
		/** One candle's prices, already formatted. */
		candlePrices: (open: string, high: string, low: string, close: string, priceUnit: string) =>
			`open ${open}, high ${high}, low ${low}, close ${close} ${priceUnit}`,
		dateUnavailable: "date unavailable",
		pricesUnavailable: "prices unavailable",
	},
	ja: {
		axesBoth: (yTitle, xTitle) => `${yTitle}（${xTitle}別）。`,
		axesYOnly: (yTitle) => `${yTitle}。`,
		axesXOnly: (xTitle) => `${xTitle}別。`,
		lineChartLabel: (title, axes, series) =>
			`折れ線グラフ：${title}。${axes}系列：${series.join("、")}。`,
		barChartLabel: (title, axes, series) =>
			`棒グラフ：${title}。${axes}系列：${series.join("、")}。`,
		readoutHint:
			"チャートにポインタを合わせると値を表示します。すべての値は下のデータ表にあります。",
		unavailable: "取得できません",
		legend: "凡例",
		assumptions: (count) => `仮定 ${count} 件`,
		derivedValues: (count) => `算出値 ${count} 件`,
		unstatedValues: (count) => `根拠の記載がない値 ${count} 件`,
		basisNote: (parts) =>
			`出典に基づく実測値ではない値：${parts.join("、")}。それぞれデータ表に印があります。`,
		withheldSeries: (label, reason) => `系列「${label}」— ${reason}。`,
		missingColumns: (keys) => `データセットにないため描画していません：${keys.join("、")}。`,
		unavailablePoints: (count) =>
			`${count} 点を取得できないため描画していません（0 としては描きません）。理由はデータ表をご覧ください。`,
		noRows: "データがありません — このデータセットには行がありません。",
		noPlottableValues: "描画できるデータがありません — 要求された値はすべて取得できません。",
		dataTableSummary: (title) => `データ表：${title}`,
		dataTableCaption: (title) => `「${title}」に描画した値`,
		candlestickLabel: (title, priceUnit) =>
			`ローソク足チャート：${title}。日付ごとの始値・高値・安値・終値（${priceUnit}）。`,
		candleUp: "終値が始値以上",
		candleDown: "終値が始値未満",
		dateAxis: "日付",
		priceAxis: (priceUnit) => `価格（${priceUnit}）`,
		candlePrices: (open, high, low, close, priceUnit) =>
			`始値 ${open}、高値 ${high}、安値 ${low}、終値 ${close} ${priceUnit}`,
		dateUnavailable: "日付を取得できません",
		pricesUnavailable: "価格を取得できません",
	},
});
