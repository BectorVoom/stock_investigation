import type { MarketFrequency } from "@research/contracts";
import type { ChartInterval, ChartPreset } from "@research/domain";
import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";
import type { ComparisonBasis } from "./comparisonBasis.ts";

type Direction = "up" | "down" | "unchanged";
type ChartType = "line" | "candlestick";

/*
 * Volume numbers per UI language (ADR-0056 §7): compact on the axis and in
 * the readout ("1.2M", "120万"), grouped in full in the data table. Built
 * once; formatting is on the readout's per-frame path.
 */
const COMPACT_EN = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const COMPACT_JA = new Intl.NumberFormat("ja", { notation: "compact", maximumFractionDigits: 1 });
const FULL_EN = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const FULL_JA = new Intl.NumberFormat("ja", { maximumFractionDigits: 0 });

const INTERVAL_NAMES_EN: { readonly [I in ChartInterval]: string } = {
	daily: "Daily",
	weekly: "Weekly",
	monthly: "Monthly",
	quarterly: "Quarterly",
	yearly: "Yearly",
};

/** A change against the bar one whole interval earlier, named like the widgets' 前日比. */
const PERIOD_CHANGE_EN: { readonly [I in ChartInterval]: string } = {
	daily: "1-day change",
	weekly: "1-week change",
	monthly: "1-month change",
	quarterly: "1-quarter change",
	yearly: "1-year change",
};
const PERIOD_CHANGE_JA: { readonly [I in ChartInterval]: string } = {
	daily: "前日比",
	weekly: "前週比",
	monthly: "前月比",
	quarterly: "前四半期比",
	yearly: "前年比",
};

/**
 * The detailed chart viewer (ADR-0025, ADR-0032). Series names, values,
 * units and dates are data and stay as they are; numbers keep one notation
 * in every language (ADR-0032 decision 7).
 */
export const chartViewerMessages = defineMessages({
	en: {
		preset: (preset: ChartPreset): string =>
			({
				"1d": "1D",
				"1w": "1W",
				"1m": "1M",
				"3m": "3M",
				"6m": "6M",
				ytd: "YTD",
				"1y": "1Y",
				"3y": "3Y",
				"5y": "5Y",
				max: "Max",
			})[preset],
		interval: (interval: ChartInterval): string => INTERVAL_NAMES_EN[interval],
		/** "Daily bars": the bars of one interval. */
		intervalBars: (interval: ChartInterval): string => `${INTERVAL_NAMES_EN[interval]} bars`,
		/** A provider's native frequency, as the source states it. */
		frequency: (frequency: MarketFrequency): string => frequency,
		intervalBlocked: (interval: string, frequency: string) =>
			`${interval} — source is ${frequency}`,
		auto: "Auto",
		autoResolved: (interval: string) => `Auto · ${interval}`,

		seriesRegion: "Series",
		asOf: (date: JSX.Element): JSX.Element => <>as of {date}</>,
		/** What the series line's change spans: the visible window's first to last bar (ADR-0069 §7). */
		windowChange: (from: string, to: string): string => `Change ${from} – ${to}:`,
		timeRange: "Time range",
		presets: "Presets",
		from: "From",
		to: "To",
		reset: "Reset",
		bothDatesNeeded: "Enter both dates as calendar days.",
		fromAfterTo: "The From date is after the To date; nothing changed.",

		displayControls: "Display controls",
		chartTypeLabel: "Chart type",
		line: "Line",
		candlestick: "Candlestick",
		candlestickOneSeries: "Candlestick — one series only",
		candlestickNoBars: "Candlestick — no open/high/low from this source",
		/** The plot's accessible name: the chart type first, so the title still ends it. */
		chartLabel: (title: string, type: ChartType): string =>
			`${type === "candlestick" ? "Candlestick" : "Line"} chart: ${title}`,
		legend: "Legend",
		legendUp: "Up",
		legendDown: "Down",
		notFromBarsNote: "Some bars have a close only — their open, high and low are not known.",
		volumeColumn: "Volume",
		volumeFull: (volume: number): string => FULL_EN.format(volume),
		intervalLabel: "Interval",
		scaleLabel: "Scale",
		linear: "Linear",
		log: "Log",
		logBlocked: "Log — needs values above zero",
		logSwitchedBack:
			"Log scale needs values above zero in the visible window, so the chart switched back to Linear. Zoom to a positive range to use Log.",
		valuesLabel: "Values",
		value: "Value",
		percentChange: "% change",
		movingAverage: "Moving average",
		movingAverageShort: (period: number) => `MA ${period}`,
		movingAverageNeedsOne: "Moving averages need exactly one series.",

		chartRegion: "Chart",
		mixedUnits: "Mixed units — values share one axis",
		zeroBaseNote: "unavailable (zero base): percent change cannot be computed from a zero value.",
		overviewRegion: "Overview",
		overviewWindow: (from: string, to: string) =>
			`Overview of all held data; visible window ${from} to ${to}`,
		logNeedsPositive:
			"Log scale needs values above zero in the visible window. Switch to Linear or zoom to a positive range.",

		statsRegion: "Statistics for the visible window",
		statsCaption: (bars: string) => `Statistics for the visible window (${bars})`,
		seriesColumn: "Series",
		openColumn: "Open",
		closeColumn: "Close",
		changeColumn: "Change",
		percentChangeColumn: "% change",
		highColumn: "High",
		lowColumn: "Low",
		averageColumn: "Average",
		maxDrawdownColumn: "Max drawdown",
		barsColumn: "Bars",

		dataTable: (title: string) => `Data table: ${title}`,
		// The English caption has no closing parenthesis; kept byte for byte (see the i18n report).
		dataTableCaption: (title: string, unit: string, bars: string, percent: boolean): string =>
			`Values plotted in "${title}" (${unit}; ${bars}${percent ? "; % change from the first visible bar" : ""}`,
		dateColumn: "Date",
		newest800: "This viewer shows the newest 800 held observations.",
		withRebasedUnavailable: (value: string) => `${value} (rebased unavailable (zero base))`,

		/** Reasons shown inside "unavailable (…)". */
		noVisibleBars: "no visible bars",
		noBar: "no bar",
		zeroBase: "zero base",
		percentOfPercent: "percent of a percent",
		noHeldObservations: "this widget holds no observations",
		noBarsInWindow: "no bars in the visible window",
		noObservations: "no observations",
		nonPositivePeak: "non-positive peak",

		loadFailed: "The chart viewer could not be loaded.",
		/** The noun in "Loading chart…". */
		chartThing: "chart",
	},
	ja: {
		preset: (preset) =>
			({
				"1d": "1日",
				"1w": "1週",
				"1m": "1か月",
				"3m": "3か月",
				"6m": "6か月",
				ytd: "年初来",
				"1y": "1年",
				"3y": "3年",
				"5y": "5年",
				max: "最大",
			})[preset],
		interval: (interval) =>
			({
				daily: "日次",
				weekly: "週次",
				monthly: "月次",
				quarterly: "四半期",
				yearly: "年次",
			})[interval],
		intervalBars: (interval) =>
			({
				daily: "日足",
				weekly: "週足",
				monthly: "月足",
				quarterly: "四半期足",
				yearly: "年足",
			})[interval],
		frequency: (frequency) =>
			({
				daily: "日次",
				weekly: "週次",
				monthly: "月次",
				quarterly: "四半期",
				annual: "年次",
				unknown: "不明",
			})[frequency],
		intervalBlocked: (interval, frequency) => `${interval} — 元データは${frequency}です`,
		auto: "自動",
		autoResolved: (interval) => `自動 · ${interval}`,

		seriesRegion: "系列",
		asOf: (date) => <>{date} 時点</>,
		windowChange: (from, to) => `${from}〜${to}の変化：`,
		timeRange: "期間",
		presets: "プリセット",
		from: "開始日",
		to: "終了日",
		reset: "リセット",
		bothDatesNeeded: "両方の日付を暦日で入力してください。",
		fromAfterTo: "開始日が終了日より後のため、変更しませんでした。",

		displayControls: "表示の設定",
		chartTypeLabel: "チャートの種類",
		line: "ライン",
		candlestick: "ローソク足",
		candlestickOneSeries: "ローソク足 — 系列が 1 つのときだけ使えます",
		candlestickNoBars: "ローソク足 — この提供元には始値・高値・安値がありません",
		chartLabel: (title, type) =>
			`${type === "candlestick" ? "ローソク足" : "ライン"}チャート: ${title}`,
		legend: "凡例",
		legendUp: "上昇",
		legendDown: "下落",
		notFromBarsNote: "終値だけの足があります — その始値・高値・安値は分かりません。",
		volumeColumn: "出来高",
		volumeFull: (volume) => FULL_JA.format(volume),
		intervalLabel: "間隔",
		scaleLabel: "目盛り",
		linear: "線形",
		log: "対数",
		logBlocked: "対数 — ゼロより大きい値が必要です",
		logSwitchedBack:
			"対数目盛りには表示範囲内でゼロより大きい値が必要なため、線形に戻しました。対数を使うには正の値の範囲に拡大してください。",
		valuesLabel: "値の表示",
		value: "値",
		percentChange: "変化率（%）",
		movingAverage: "移動平均",
		movingAverageShort: (period) => `MA ${period}`,
		movingAverageNeedsOne: "移動平均は系列が 1 つのときだけ使えます。",

		chartRegion: "チャート",
		mixedUnits: "単位が混在しています — 値は 1 本の軸を共有します",
		zeroBaseNote: "取得できません（基準値がゼロ）: ゼロの値からは変化率を計算できません。",
		overviewRegion: "全体",
		overviewWindow: (from, to) => `保有データ全体の概要。表示範囲 ${from} 〜 ${to}`,
		logNeedsPositive:
			"対数目盛りには表示範囲内でゼロより大きい値が必要です。線形に切り替えるか、正の値の範囲に拡大してください。",

		statsRegion: "表示範囲の統計",
		statsCaption: (bars) => `表示範囲の統計（${bars}）`,
		seriesColumn: "系列",
		openColumn: "始値",
		closeColumn: "終値",
		changeColumn: "変化",
		percentChangeColumn: "変化率",
		highColumn: "高値",
		lowColumn: "安値",
		averageColumn: "平均",
		maxDrawdownColumn: "最大下落率",
		barsColumn: "バー数",

		dataTable: (title) => `データ表: ${title}`,
		dataTableCaption: (title, unit, bars, percent) =>
			`「${title}」に描いた値（${unit}、${bars}${percent ? "、最初の表示バーからの変化率" : ""}）`,
		dateColumn: "日付",
		newest800: "このビューアーには、保有する観測値のうち新しい 800 件を表示します。",
		withRebasedUnavailable: (value) => `${value}（起点比は取得できません: 基準値がゼロ）`,

		noVisibleBars: "表示中のバーがありません",
		noBar: "バーなし",
		zeroBase: "基準値がゼロ",
		percentOfPercent: "パーセントの変化率は出せません",
		noHeldObservations: "このウィジェットには観測値がありません",
		noBarsInWindow: "表示範囲にバーがありません",
		noObservations: "観測値がありません",
		nonPositivePeak: "ピークがゼロ以下",

		loadFailed: "チャートビューアーを読み込めませんでした。",
		chartThing: "チャート",
	},
});

/**
 * The readout line and the keyboard instructions of the main chart, used by
 * the pure `buildReadoutText` (which takes this table) and `DetailChart`.
 */
export const chartReadoutMessages = defineMessages({
	en: {
		hint: "Point at the chart to read values; the data table below lists every value.",
		hintNoTable: "Point at the chart, or use the arrow keys, to read values.",
		dateNotStated: "date not stated",
		seriesUnavailable: (label: string) => `${label}: unavailable`,
		direction: (direction: Direction): string =>
			({ up: "up", down: "down", unchanged: "unchanged" })[direction],
		/** What a change is against (ADR-0069): one whole period, or the base bar's date. */
		comparedWith: (basis: ComparisonBasis): string =>
			basis.kind === "period" ? PERIOD_CHANGE_EN[basis.interval] : `change since ${basis.iso}`,
		rebased: (percent: string) => `rebased ${percent}%`,
		rebasedUnavailable: "rebased unavailable (zero base)",
		/** A bar's prices in the readout (ADR-0056 §7). */
		barPrices: (open: string, high: string, low: string, close: string): string =>
			`Open ${open} · High ${high} · Low ${low} · Close ${close}`,
		volume: (volume: string): string => `Volume ${volume}`,
		volumeNotReported: "volume not reported",
		/** The bar's own direction (close against open), never colour alone. */
		barDirection: (direction: Direction): string =>
			({ up: "up bar", down: "down bar", unchanged: "unchanged bar" })[direction],
		compactVolume: (volume: number): string => COMPACT_EN.format(volume),
		roleDescription: "interactive chart",
		instructions:
			"Interactive chart. Left and right arrows move the readout one bar; holding Shift with the arrows pans the window; plus and minus zoom; Home and End jump to the first and last bar; zero resets the window.",
	},
	ja: {
		hint: "チャートを指すと値を読み取れます。下のデータ表にすべての値があります。",
		hintNoTable: "チャートを指すか矢印キーで値を読み取れます。",
		dateNotStated: "日付の記載なし",
		seriesUnavailable: (label) => `${label}: 取得できません`,
		direction: (direction) => ({ up: "上昇", down: "下落", unchanged: "変化なし" })[direction],
		comparedWith: (basis) =>
			basis.kind === "period" ? PERIOD_CHANGE_JA[basis.interval] : `${basis.iso}比`,
		rebased: (percent) => `起点比 ${percent}%`,
		rebasedUnavailable: "起点比は取得できません（基準値がゼロ）",
		barPrices: (open, high, low, close) =>
			`始値 ${open} · 高値 ${high} · 安値 ${low} · 終値 ${close}`,
		volume: (volume) => `出来高 ${volume}`,
		volumeNotReported: "出来高なし",
		barDirection: (direction) =>
			({ up: "陽線（上昇）", down: "陰線（下落）", unchanged: "同時線（変化なし）" })[direction],
		compactVolume: (volume) => COMPACT_JA.format(volume),
		roleDescription: "操作できるチャート",
		instructions:
			"操作できるチャートです。左右の矢印キーで読み取り位置を 1 本ずつ動かします。Shift キーを押しながら矢印キーで表示範囲を移動し、プラスとマイナスで拡大・縮小します。Home と End で最初と最後のバーに移動し、ゼロで表示範囲を元に戻します。",
	},
});
