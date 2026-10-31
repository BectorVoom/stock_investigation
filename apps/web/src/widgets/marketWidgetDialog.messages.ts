import type { MarketCatalogEntry, MarketProviderId } from "@research/contracts";
import { defineMessages } from "@research/i18n";
import { WIDGET_SIZE_SHAPES } from "@research/widget-grid/core";

type Category = MarketCatalogEntry["category"];
/** The page a market widget's bounds belong to (`MarketWidgetLimits.scope`). */
type Scope = "dashboard" | "notebook";

/** The provider's product name (never translated). */
function providerName(provider: MarketProviderId): string {
	return provider === "materials" ? "Materials DB" : provider === "fred" ? "FRED" : "Twelve Data";
}

const ENGLISH_CATEGORIES: { readonly [C in Category]: string } = {
	volatility: "Volatility",
	rates: "Rates",
	inflation: "Inflation",
	labour: "Labour",
	growth: "Growth",
	"equity-index": "Equity indices",
	fx: "Currencies",
	commodity: "Commodities",
	equity: "Equities",
};

const JAPANESE_CATEGORIES: { readonly [C in Category]: string } = {
	volatility: "ボラティリティ",
	rates: "金利",
	inflation: "インフレ",
	labour: "雇用",
	growth: "成長",
	"equity-index": "株価指数",
	fx: "為替",
	commodity: "商品",
	equity: "株式",
};

const ENGLISH_SYMBOL_EXAMPLES: { readonly [P in MarketProviderId]: string } = {
	fred: "e.g. VIXCLS",
	materials: "Select an imported material series",
	"twelve-data": "e.g. AAPL, XAU/USD, 7203:JPX",
};

const JAPANESE_SYMBOL_EXAMPLES: { readonly [P in MarketProviderId]: string } = {
	fred: "例: VIXCLS",
	materials: "インポート済みの素材系列を選択",
	"twelve-data": "例: AAPL, XAU/USD, 7203:JPX",
};

const JAPANESE_SCOPES: { readonly [S in Scope]: string } = {
	dashboard: "ダッシュボード",
	notebook: "ノートブック",
};

/**
 * The live market widgets' add / edit dialog, the same on Home and in the
 * Notebook (ADR-0024). Series ids, tickers, units and provider names stay
 * as they are in every language.
 */
export const marketWidgetDialogMessages = defineMessages({
	en: {
		providerName: (provider: MarketProviderId): string => providerName(provider),
		category: (category: Category): string => ENGLISH_CATEGORIES[category],
		customGroup: "Custom",
		customOption: (symbol: string, provider: MarketProviderId) =>
			`${symbol} (custom ${providerName(provider)})`,
		customDescription: "Custom series.",
		enterTitle: "Enter a title.",
		shortenTitle: (max: number) => `Shorten the title to ${max} characters or fewer.`,
		chooseSeries: (min: number): string =>
			min === 1 ? "Choose a series." : `Choose at least ${min} series.`,
		tooManySeries: (max: number) => `This widget holds at most ${max} series.`,
		repeatedSeries: "A widget must not repeat a series.",
		invalidSeriesId: (id: string) => `"${id}" is not a valid series id.`,
		unitsDiffer: (units: string) => `Line-chart series must share one unit (found: ${units}).`,
		pageFull: (scope: Scope, max: number) =>
			`The ${scope} already holds ${max} widgets; remove one first.`,
		pageSeriesFull: (scope: Scope, max: number) =>
			`The ${scope} holds at most ${max} distinct series; remove one first.`,
		unitUnknown: (ids: string) =>
			`Unit unknown until refreshed: ${ids}. Units must match before saving with data.`,
		fixBeforeSaving: "Fix before saving:",
		toAdd: "To add this widget:",
		toSave: "To save this widget:",
		invalidSymbol: (symbol: string, provider: MarketProviderId) =>
			`"${symbol}" is not a valid ${providerName(provider)} symbol id.`,
		problemsList: "Before you can save this widget",
		title: "Title",
		size: "Size",
		sizeHelp: `Small is ${WIDGET_SIZE_SHAPES.small}, Medium is ${WIDGET_SIZE_SHAPES.medium}, Large is ${WIDGET_SIZE_SHAPES.large}.`,
		small: "Small",
		medium: "Medium",
		large: "Large",
		daysAhead: "Days ahead",
		nextDays: (days: number) => `Next ${days} days`,
		series: "Series",
		catalogUnavailable: "Catalog unavailable",
		customSeriesId: "Use a custom series id",
		provider: "Provider",
		symbol: "Symbol",
		symbolExample: (provider: MarketProviderId): string => ENGLISH_SYMBOL_EXAMPLES[provider],
		addSeries: "Add series",
		range: "Range",
		addWidget: "Add widget",
		saveWidget: "Save widget",
	},
	ja: {
		providerName: (provider) => providerName(provider),
		category: (category) => JAPANESE_CATEGORIES[category],
		customGroup: "カスタム",
		customOption: (symbol, provider) => `${symbol}（カスタム、${providerName(provider)}）`,
		customDescription: "カスタム系列。",
		enterTitle: "タイトルを入力してください。",
		shortenTitle: (max) => `タイトルを ${max} 文字以内にしてください。`,
		chooseSeries: (min) =>
			min === 1 ? "系列を選んでください。" : `系列を ${min} 個以上選んでください。`,
		tooManySeries: (max) => `このウィジェットに入れられる系列は ${max} 個までです。`,
		repeatedSeries: "同じ系列を 1 つのウィジェットに重ねて入れることはできません。",
		invalidSeriesId: (id) => `「${id}」は有効な系列 ID ではありません。`,
		unitsDiffer: (units) => `折れ線チャートの系列は単位をそろえてください（現在: ${units}）。`,
		pageFull: (scope, max) =>
			`${JAPANESE_SCOPES[scope]}にはすでに ${max} 個のウィジェットがあります。先に 1 つ削除してください。`,
		pageSeriesFull: (scope, max) =>
			`${JAPANESE_SCOPES[scope]}で使える系列は ${max} 個までです。先に 1 つ削除してください。`,
		unitUnknown: (ids) =>
			`更新するまで単位がわかりません: ${ids}。データ付きで保存するには単位がそろっている必要があります。`,
		fixBeforeSaving: "保存する前に修正してください:",
		toAdd: "このウィジェットを追加するには:",
		toSave: "このウィジェットを保存するには:",
		invalidSymbol: (symbol, provider) =>
			`「${symbol}」は有効な ${providerName(provider)} のシンボル ID ではありません。`,
		problemsList: "このウィジェットを保存する前に",
		title: "タイトル",
		size: "サイズ",
		sizeHelp: "小は 1 × 1、中は 2 × 2、大は全幅 × 2 です。",
		small: "小",
		medium: "中",
		large: "大",
		daysAhead: "表示する期間",
		nextDays: (days) => `今後 ${days} 日`,
		series: "系列",
		catalogUnavailable: "系列の一覧を取得できません",
		customSeriesId: "カスタムの系列 ID を使う",
		provider: "提供元",
		symbol: "シンボル",
		symbolExample: (provider) => JAPANESE_SYMBOL_EXAMPLES[provider],
		addSeries: "系列を追加",
		range: "期間",
		addWidget: "ウィジェットを追加",
		saveWidget: "ウィジェットを保存",
	},
});
