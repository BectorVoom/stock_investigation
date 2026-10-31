import type {
	EquityAccountingStandard,
	EquityMetricCode,
	EquityReportForm,
	EquityScope,
	EquityStatement,
	EquityUnavailableReason,
} from "@research/domain";
import { defineMessages } from "@research/i18n";

/**
 * The words of the financial statement and financial history widgets and of
 * the Equities page's statement view (ADR-0048 §8), shared so a metric, a
 * statement or a reason reads the same everywhere. Metric names follow each
 * metric's exact definition (ADR-0048 §3).
 */

const EN_METRICS: { readonly [M in EquityMetricCode]: string } = {
	revenue: "Revenue",
	"gross-profit": "Gross profit",
	"operating-income": "Operating income",
	"ordinary-income": "Ordinary income",
	"profit-attributable-to-owners": "Profit attributable to owners of parent",
	"total-assets": "Total assets",
	"total-liabilities": "Total liabilities",
	"total-equity": "Total equity",
	"cash-and-cash-equivalents": "Cash and cash equivalents",
	"net-cash-from-operating-activities": "Net cash from operating activities",
	"net-cash-from-investing-activities": "Net cash from investing activities",
	"net-cash-from-financing-activities": "Net cash from financing activities",
	"capital-expenditures": "Capital expenditures",
	"free-cash-flow": "Free cash flow",
};

const JA_METRICS: { readonly [M in EquityMetricCode]: string } = {
	revenue: "売上高",
	"gross-profit": "売上総利益",
	"operating-income": "営業利益",
	"ordinary-income": "経常利益",
	"profit-attributable-to-owners": "親会社株主に帰属する当期純利益",
	"total-assets": "資産合計",
	"total-liabilities": "負債合計",
	"total-equity": "純資産合計",
	"cash-and-cash-equivalents": "現金及び現金同等物",
	"net-cash-from-operating-activities": "営業活動によるキャッシュ・フロー",
	"net-cash-from-investing-activities": "投資活動によるキャッシュ・フロー",
	"net-cash-from-financing-activities": "財務活動によるキャッシュ・フロー",
	"capital-expenditures": "設備投資（有形固定資産の取得）",
	"free-cash-flow": "フリー・キャッシュ・フロー",
};

const EN_STATEMENTS: { readonly [S in EquityStatement]: string } = {
	"income-statement": "Income statement",
	"balance-sheet": "Balance sheet",
	"cash-flow": "Cash flow statement",
};

const JA_STATEMENTS: { readonly [S in EquityStatement]: string } = {
	"income-statement": "損益計算書",
	"balance-sheet": "貸借対照表",
	"cash-flow": "キャッシュ・フロー計算書",
};

/** The segmented control's short names (a Medium widget fits all three). */
const EN_STATEMENT_SHORT: { readonly [S in EquityStatement]: string } = {
	"income-statement": "Income",
	"balance-sheet": "Balance sheet",
	"cash-flow": "Cash flow",
};

const JA_STATEMENT_SHORT: { readonly [S in EquityStatement]: string } = {
	"income-statement": "損益",
	"balance-sheet": "貸借",
	"cash-flow": "CF",
};

const EN_REASONS: { readonly [R in EquityUnavailableReason]: string } = {
	"not-reported": "Not reported",
	"no-mapping-for-standard": "Not mapped for this accounting standard",
	ambiguous: "Ambiguous: the filing reports two values",
	"unexpected-sign": "Unexpected sign",
	"unsupported-unit": "Unsupported unit",
	"not-derivable": "Cannot be derived",
};

const JA_REASONS: { readonly [R in EquityUnavailableReason]: string } = {
	"not-reported": "開示なし",
	"no-mapping-for-standard": "この会計基準は未対応",
	ambiguous: "判定不能（報告書に値が 2 つ）",
	"unexpected-sign": "符号が想定外",
	"unsupported-unit": "単位が未対応",
	"not-derivable": "算出不能",
};

const EN_FORMS: { readonly [F in EquityReportForm]: string } = {
	"10-K": "Form 10-K",
	"10-K/A": "Form 10-K/A",
	"securities-report": "Annual securities report",
	"amended-securities-report": "Amended annual securities report",
};

const JA_FORMS: { readonly [F in EquityReportForm]: string } = {
	"10-K": "Form 10-K",
	"10-K/A": "Form 10-K/A",
	"securities-report": "有価証券報告書",
	"amended-securities-report": "訂正有価証券報告書",
};

const EN_STANDARDS: { readonly [S in EquityAccountingStandard]: string } = {
	"US-GAAP": "US GAAP",
	JGAAP: "Japanese GAAP",
	IFRS: "IFRS",
};

const JA_STANDARDS: { readonly [S in EquityAccountingStandard]: string } = {
	"US-GAAP": "米国基準",
	JGAAP: "日本基準",
	IFRS: "IFRS",
};

const EN_SCOPES: { readonly [S in EquityScope]: string } = {
	consolidated: "Consolidated",
	separate: "Separate (parent only)",
};

const JA_SCOPES: { readonly [S in EquityScope]: string } = {
	consolidated: "連結",
	separate: "個別",
};

/** Japanese currency words for the unit caption; any other code is written as it is. */
const JA_CURRENCIES: Readonly<Record<string, string>> = { JPY: "円", USD: "米ドル" };

/**
 * The profit metric of a separate (parent-only) statement: it has no
 * "attributable to owners of parent" line, so its value is plain net income
 * (当期純利益, ADR-0048 §3 maps `jppfs_cor:ProfitLoss` there).
 */
const EN_SEPARATE_PROFIT = "Net income (separate)";
const JA_SEPARATE_PROFIT = "当期純利益（個別）";

/** Scale words of a chart's unit by power of ten (the scales `chartScaleExponent` picks). */
const EN_SCALES: Readonly<Record<number, string>> = {
	6: "millions",
	9: "billions",
	12: "trillions",
};
const JA_SCALES: Readonly<Record<number, string>> = { 6: "百万", 8: "億", 9: "十億", 12: "兆" };

export const financialsMessages = defineMessages({
	en: {
		metric: (code: EquityMetricCode): string => EN_METRICS[code],
		/** A metric's name for values of one scope: a separate statement's profit is net income. */
		metricInScope: (code: EquityMetricCode, scope: EquityScope): string =>
			scope === "separate" && code === "profit-attributable-to-owners"
				? EN_SEPARATE_PROFIT
				: EN_METRICS[code],
		statement: (statement: EquityStatement): string => EN_STATEMENTS[statement],
		statementShort: (statement: EquityStatement): string => EN_STATEMENT_SHORT[statement],
		reason: (reason: EquityUnavailableReason): string => EN_REASONS[reason],
		form: (form: EquityReportForm): string => EN_FORMS[form],
		standard: (standard: EquityAccountingStandard): string => EN_STANDARDS[standard],
		scope: (scope: EquityScope): string => EN_SCOPES[scope],
		/** The unit caption of amounts in millions of one currency. */
		millionsOf: (currency: string): string => `${currency} millions`,
		/** When the values of one table are in different currencies (each cell names its own). */
		millionsMixed: "Millions; each value names its currency",
		/** A chart axis's unit: the currency counted in 10^exponent ("USD billions"). */
		scaledUnitOf: (currency: string, exponent: number): string =>
			`${currency} ${EN_SCALES[exponent] ?? `× 10^${exponent}`}`,
		fiscalYear: (year: number): string => `FY${year}`,
		/** A column header's period end, for screen readers ("ended Mar 31, 2025"). */
		periodEnded: (date: string): string => `ended ${date}`,
		latestPeriod: (date: string): string => `Latest fiscal year ended ${date}`,
		metricColumn: "Metric",
		statementSwitch: "Statement",
		tableCaption: (statement: string, unit: string): string => `${statement}, ${unit}`,
		derivedMark: "derived",
		revisedMark: "revised",
		derivedNote: "Derived: operating cash flow minus capital expenditures, both from one filing.",
		revisedNote: "Revised: filings reported different values. Open a value to see each one.",
		/** A separate (parent-only) value in a row whose other values are consolidated. */
		separateMark: "separate",
		separateNote:
			"Separate: from the company's own (parent-only) statement, not the consolidated one.",
		underOneNote: "<1: under half a million, not zero.",
		/** A value cell's button: what it is and that it opens its details. */
		valueLabel: (metric: string, year: string, value: string, unit: string): string =>
			`${metric}, ${year}: ${value} ${unit}. Show details`,
		sources: "Sources:",
		filingLine: (form: string, filedOn: string): string => `${form} filed ${filedOn}`,
		filingCount: (count: number): string => (count === 1 ? "1 filing" : `${count} filings`),
		companyLine: (name: string, symbol: string): string => `${name} (${symbol})`,
		/** The noun in "Loading <thing>…". */
		statementThing: "the financial statement",
		historyThing: "the financial history",
		statementFailed: "Could not load the financial statement.",
		historyFailed: "Could not load the financial history.",
		notTracked:
			"This company is no longer tracked; its stored values are kept. Track it again on the Equities page.",
		notFound: "This company is not tracked. Remove this widget from its menu.",
		noDataYet: "No financial data yet. Values appear after the company's first sync.",
		openEquities: "Open Equities",

		/* ----- the history chart ----- */
		metricPicker: "Metric",
		fiscalYearAxis: "Fiscal year",
		chartTitle: (metric: string, company: string): string => `${metric} of ${company}`,
		notReportedYears: (years: string): string => `Not reported: ${years}`,
		/** Why a series in several currencies has no chart (one axis cannot measure two currencies). */
		mixedCurrencyChart:
			"Not charted: the values are in different currencies. The data table lists each value with its currency.",
		dataTableSummary: "Data table",
		dataTableCaption: (metric: string, unit: string): string => `${metric} by fiscal year, ${unit}`,
		periodEndColumn: "Period end",
		valueColumn: (unit: string): string => `Value (${unit})`,
		filingColumn: "Filing",

		/* ----- a value's details ----- */
		detailsHeading: (metric: string, year: string): string => `${metric}, ${year}`,
		exactValue: "Value in base units",
		periodEnd: "Period end",
		concept: "Source concept",
		scopeLabel: "Scope",
		filing: "Filing",
		derivedDetail: "Derived from other values of one filing; not reported directly.",
		openFiling: (form: string, filedOn: string): string => `Open ${form} filed ${filedOn}`,
		revisionsHeading: "Values each filing reported",
		revisionsIntro:
			"As reported, before the metric's sign convention is applied. The newest filing's value is the current one.",
		revisionsThing: "the revision history",
		revisionsFailed: "Could not load the revision history.",
		revisionFiled: "Filed",
		revisionValue: "As reported",
		currentValue: "Current",
		close: "Close",

		/* ----- the add dialog ----- */
		addStatementHeading: "Add a financial statement",
		addHistoryHeading: "Add a financial history chart",
		addIntro:
			"Choose one of the companies tracked on the Equities page. Its values come from its SEC or EDINET filings.",
		companyLabel: "Company",
		companiesThing: "the tracked companies",
		companiesFailed: "Could not load the tracked companies.",
		noCompanies: "No companies are tracked yet.",
		trackOnEquities: "Track one on the Equities page",
		yearsLabel: "Fiscal years",
		yearsOption: (years: number): string => `${years} years`,
		addWidget: "Add widget",
	},
	ja: {
		metric: (code) => JA_METRICS[code],
		metricInScope: (code, scope) =>
			scope === "separate" && code === "profit-attributable-to-owners"
				? JA_SEPARATE_PROFIT
				: JA_METRICS[code],
		statement: (statement) => JA_STATEMENTS[statement],
		statementShort: (statement) => JA_STATEMENT_SHORT[statement],
		reason: (reason) => JA_REASONS[reason],
		form: (form) => JA_FORMS[form],
		standard: (standard) => JA_STANDARDS[standard],
		scope: (scope) => JA_SCOPES[scope],
		millionsOf: (currency) => `百万${JA_CURRENCIES[currency] ?? currency}`,
		millionsMixed: "百万単位（通貨は値ごとに表示）",
		scaledUnitOf: (currency, exponent) =>
			`${JA_SCALES[exponent] ?? `10^${exponent} `}${JA_CURRENCIES[currency] ?? currency}`,
		fiscalYear: (year) => `FY${year}`,
		periodEnded: (date) => `${date}期末`,
		latestPeriod: (date) => `直近の決算期末: ${date}`,
		metricColumn: "項目",
		statementSwitch: "財務諸表",
		tableCaption: (statement, unit) => `${statement}（${unit}）`,
		derivedMark: "算出",
		revisedMark: "訂正",
		derivedNote:
			"算出: 同じ報告書の営業活動によるキャッシュ・フローから設備投資を差し引いた値です。",
		revisedNote: "訂正: 報告書によって値が異なります。値を開くとそれぞれを確認できます。",
		separateMark: "個別",
		separateNote: "個別: 連結ではなく、会社単体（個別）の財務諸表の値です。",
		underOneNote: "<1: 50 万未満の値で、0 ではありません。",
		valueLabel: (metric, year, value, unit) => `${metric}、${year}: ${value} ${unit}。詳細を表示`,
		sources: "出典:",
		filingLine: (form, filedOn) => `${form}（${filedOn} 提出）`,
		filingCount: (count) => `報告書 ${count} 件`,
		companyLine: (name, symbol) => `${name}（${symbol}）`,
		statementThing: "財務諸表",
		historyThing: "財務推移",
		statementFailed: "財務諸表を読み込めませんでした。",
		historyFailed: "財務推移を読み込めませんでした。",
		notTracked:
			"この企業は追跡されていません（保存済みの値は残っています）。株式データのページで再び追跡できます。",
		notFound: "この企業は追跡されていません。メニューからこのウィジェットを削除してください。",
		noDataYet: "まだ財務データがありません。企業の初回の同期が終わると表示されます。",
		openEquities: "株式データを開く",

		metricPicker: "指標",
		fiscalYearAxis: "会計年度",
		chartTitle: (metric, company) => `${company}の${metric}`,
		notReportedYears: (years) => `開示なし: ${years}`,
		mixedCurrencyChart:
			"通貨の異なる値が含まれるため、チャートは表示しません。データ表で値ごとの通貨を確認できます。",
		dataTableSummary: "データ表",
		dataTableCaption: (metric, unit) => `会計年度ごとの${metric}（${unit}）`,
		periodEndColumn: "期末日",
		valueColumn: (unit) => `値（${unit}）`,
		filingColumn: "報告書",

		detailsHeading: (metric, year) => `${metric}（${year}）`,
		exactValue: "値（基本単位）",
		periodEnd: "期末日",
		concept: "元の要素",
		scopeLabel: "範囲",
		filing: "報告書",
		derivedDetail: "同じ報告書の他の値から算出した値で、直接開示された値ではありません。",
		openFiling: (form, filedOn) => `${filedOn} 提出の${form}を開く`,
		revisionsHeading: "報告書ごとの報告値",
		revisionsIntro:
			"指標の符号規則を適用する前の報告どおりの値です。最新の報告書の値が現在の値です。",
		revisionsThing: "修正の履歴",
		revisionsFailed: "修正の履歴を読み込めませんでした。",
		revisionFiled: "提出日",
		revisionValue: "報告値",
		currentValue: "現在",
		close: "閉じる",

		addStatementHeading: "財務諸表を追加",
		addHistoryHeading: "財務推移チャートを追加",
		addIntro:
			"株式データのページで追跡している企業から選びます。値は SEC または EDINET の報告書から取得します。",
		companyLabel: "企業",
		companiesThing: "追跡中の企業",
		companiesFailed: "追跡中の企業を読み込めませんでした。",
		noCompanies: "追跡中の企業はまだありません。",
		trackOnEquities: "株式データのページで追跡する",
		yearsLabel: "表示する年数",
		yearsOption: (years) => `${years}年`,
		addWidget: "ウィジェットを追加",
	},
});
