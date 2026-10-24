import { defineMessages } from "@research/i18n";

/**
 * Words of Home's market widgets: metric, line chart, stock table and
 * indicator table. Series names, symbols, units and numbers are data and
 * never pass through here.
 */
export const marketWidgetMessages = defineMessages({
	en: {
		/** The start of a chart opener's accessible name; the visible values follow. */
		openChart: "Open chart: ",
		/** A metric's chart opener: the series name, then its visible values. */
		openChartOf: (title: string) => `Open chart: ${title}, `,
		change: "Change",
		yearChange: "1-year change",
		/** A change line's label before its value. */
		changeLabel: (label: string) => `${label}: `,
		lastRefreshFailed: (reason: string) => `last refresh failed (${reason})`,
		seriesLastRefreshFailed: (title: string, reason: string) =>
			`${title}: last refresh failed (${reason})`,
		seriesUnavailable: (title: string, reason: string) => `${title}: unavailable (${reason})`,
		// Tables.
		asOf: "As of",
		source: "Source",
		previous: "Previous",
		indicatorCaption: (title: string) => `${title}: latest per indicator`,
		indicator: "Indicator",
		latest: "Latest",
		unit: "Unit",
		stockCaption: (title: string) => `${title}: last close per series`,
		series: "Series",
		lastClose: "Last close",
		changePercent: "Change %",
		notApplicable: "not applicable",
		// Line chart.
		range: "Range",
		noPlottablePoints: "no plottable points in this range",
		chartImage: (title: string, unit: string) => `Line chart: ${title}. ${unit} by date.`,
		date: "Date",
		pointHint: "Point at the chart to read values; the data table below lists every value.",
		/** One series in the hover readout, e.g. "VIX: 15.41 Index". */
		readoutEntry: (label: string, value: string) => `${label}: ${value}`,
		/** A value the hover readout has none for. */
		readoutUnavailable: "unavailable",
		staleSeries: "Stale series",
		unavailableSeries: "Unavailable series",
		mixedUnits: (units: string) =>
			`This chart cannot be drawn: its series do not share one unit (${units}). Edit the widget so every series uses the same unit.`,
		dataTable: (title: string) => `Data table: ${title}`,
		valuesPlotted: (title: string, unit: string) => `Values plotted in "${title}" (${unit})`,
		dateNotStated: "date not stated",
		noValue: "no value",
		sources: "Sources: ",
	},
	ja: {
		openChart: "チャートを開く：",
		openChartOf: (title) => `チャートを開く：${title}、`,
		change: "前回比",
		yearChange: "1年前比",
		changeLabel: (label) => `${label}：`,
		lastRefreshFailed: (reason) => `前回の更新に失敗（${reason}）`,
		seriesLastRefreshFailed: (title, reason) => `${title}：前回の更新に失敗（${reason}）`,
		seriesUnavailable: (title, reason) => `${title}：取得できません（${reason}）`,
		asOf: "時点",
		source: "出典",
		previous: "前回値",
		indicatorCaption: (title) => `${title}：指標ごとの最新値`,
		indicator: "指標",
		latest: "最新値",
		unit: "単位",
		stockCaption: (title) => `${title}：系列ごとの直近の終値`,
		series: "系列",
		lastClose: "終値",
		changePercent: "前回比（%）",
		notApplicable: "該当なし",
		range: "期間",
		noPlottablePoints: "この期間に描画できる点がありません",
		chartImage: (title, unit) => `折れ線チャート：${title}。日付ごとの${unit}。`,
		date: "日付",
		pointHint: "チャートにポインターを合わせると値を読めます。下のデータ表にすべての値があります。",
		readoutEntry: (label, value) => `${label}：${value}`,
		readoutUnavailable: "取得できません",
		staleSeries: "更新に失敗した系列",
		unavailableSeries: "取得できない系列",
		mixedUnits: (units) =>
			`このチャートは描画できません。系列の単位が一致していません（${units}）。すべての系列が同じ単位になるようウィジェットを編集してください。`,
		dataTable: (title) => `データ表：${title}`,
		valuesPlotted: (title, unit) => `「${title}」に描画した値（${unit}）`,
		dateNotStated: "日付の記載なし",
		noValue: "値なし",
		sources: "出典：",
	},
});
