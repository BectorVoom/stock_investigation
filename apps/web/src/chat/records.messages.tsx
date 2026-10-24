import type {
	DemandScenario,
	Evidence,
	FinancialObservation,
	PricingPowerRecord,
	Security,
} from "@research/contracts";
import { type ReportedPositionChange, reportedPositionChangePhrase } from "@research/domain";
import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";

type ClaimGroup = "supported" | "conflicting" | "unsupported";
type ScenarioCase = "bear" | "base" | "bull";
type Classification = PricingPowerRecord["assessment"]["classification"];

/**
 * The run's records drawer (ADR-0031): headings, field labels, empty states
 * and the wording of verification issues. Claims, quoted passages, issuer and
 * investor names, methodology text and source titles are research content and
 * stay as written; stored enum values are only worded here (English shows the
 * value itself, as before).
 */
export const recordsMessages = defineMessages({
	en: {
		/** A 13F quarter-to-quarter change; never implies a dated transaction (FR-008). */
		positionChange: (change: ReportedPositionChange): string =>
			reportedPositionChangePhrase(change),
		sectionTitle: (title: string, count: number) => `${title} (${count})`,
		/** Whether the ticker and exchange were checked against an official directory or only proposed. */
		listingVerification: (verification: Security["listingVerification"]): string =>
			({
				"source-verified": "listing verified against an official directory",
				unverified: "listing unverified — proposed by the model, format-checked only",
			})[verification],
		noPassageRetained: "no passage retained",
		securityUnavailable: (securityId: string) => `Security unavailable (id ${securityId})`,
		claimGroup: (group: ClaimGroup): string =>
			({
				supported: "Supported claims",
				conflicting: "Conflicting claims",
				unsupported: "Unsupported claims",
			})[group],
		noClaims: (group: ClaimGroup) => `No ${group} claims in this run.`,
		unknownEvidence: (evidenceId: string) => `cites evidence that is not stored (${evidenceId})`,
		quoteNotFound: (evidenceId: string) => `quoted passage not found in evidence ${evidenceId}`,
		quoteTooShort: (evidenceId: string) =>
			`quoted passage from evidence ${evidenceId} is too short to verify`,
		missingQuote: (evidenceId: string) => `no quoted passage given for evidence ${evidenceId}`,
		numberNotInEvidence: (numberText: string) =>
			`the number ${numberText} does not appear in the cited evidence`,
		noSupportingEvidence: "no supporting evidence",
		notIndependentlyVerified:
			"not independently verified — the quotes matched, but no independent check confirmed the claim",
		supportingEvidence: "Supporting evidence",
		contradictingEvidence: "Contradicting evidence",
		context: "Context",
		verificationIssues: "Verification issues",
		quantityKind: (kind: DemandScenario["quantityKind"]): string => kind,
		/** Ends with a space: the baseline value or its absence follows. */
		scenarioSummary: (kind: string, unit: string, baseYear: number, targetYear: number) =>
			`${kind} in ${unit}; base year ${baseYear}, target year ${targetYear}. Baseline: `,
		noSourcedBaseline: "no sourced baseline",
		scenarioCaption: (targetYear: number, unit: string) =>
			`Bear / base / bull targets for ${targetYear} (${unit})`,
		caseHeader: "Case",
		targetHeader: (unit: string) => `Target (${unit})`,
		derivedCagr: "Derived CAGR",
		assumptions: "Assumptions",
		scenarioCase: (name: ScenarioCase): string => name,
		notDerivable: "not derivable",
		perYear: (percent: string) => `${percent} per year`,
		noneStated: "none stated",
		drivers: "Drivers",
		barriers: "Barriers",
		falsifiers: "Falsifiers",
		methodology: "Methodology",
		baselinePassage: "Passage stating the baseline",
		baselineEvidence: "Baseline evidence",
		contraryEvidence: "Contrary evidence",
		currencyNotStated: "currency not stated",
		perShare: (value: string, currency: string) => `${value} ${currency} per share`,
		periodNotStated: "period not stated",
		period: (fiscalYear: number, fiscalPeriod: string, start: string, end: string) =>
			`FY${fiscalYear} ${fiscalPeriod} (${start} to ${end})`,
		financialCaption: "Each value is one dated observation with its formula, period and source",
		security: "Security",
		metric: "Metric",
		value: "Value",
		periodAndBasis: "Period and basis",
		marketDataAsOf: "Market data as of",
		formula: "Formula",
		source: "Source",
		reasonNotStated: "reason not stated",
		actualOrEstimate: (value: FinancialObservation["actualOrEstimate"]): string => value,
		accountingStandardNotStated: "accounting standard not stated",
		notPriceDerived: "not price-derived / not stated",
		notStated: "not stated",
		noSourceValue: "no source (value unavailable)",
		marginBuy: "Margin buy balance",
		marginSell: "Margin sell balance",
		shares: (count: string) => `${count} shares`,
		reportedShortInterest: "Reported short interest",
		averageDailyVolume: "Average daily volume",
		notReported: "not reported",
		positionDates: (asOf: JSX.Element, disseminated: JSX.Element, definition: string) => (
			<>
				As of {asOf}; disseminated {disseminated}. Definition: {definition}
			</>
		),
		dateNotStated: "date not stated",
		noSourceFigures: "no source (figures unavailable)",
		noObservations: "No observations of this kind in this run.",
		filingHeadline: (
			investor: JSX.Element,
			periodEnd: JSX.Element,
			form: string,
			filedAt: JSX.Element,
			link: JSX.Element,
		) => (
			<>
				{investor} — reported holdings as of quarter end {periodEnd} ({form} filed {filedAt}).{" "}
				{link}
			</>
		),
		viewFiling: "View filing",
		filerNote: (scheme: string, value: string) =>
			`Quarter-end holdings as reported by the filer (${scheme} ${value}); these are not dated transactions.`,
		noHoldings: "No holdings listed in this filing.",
		holdingsCaption: (investor: string, periodEnd: string) =>
			`Reported holdings of ${investor} as of ${periodEnd}`,
		issuer: "Issuer",
		reportedShares: "Reported shares",
		reportedValue: "Reported value (USD)",
		changeVersusPrior: "Change versus prior filing",
		notCompared: "not compared with a prior filing",
		demandScenarios: "Demand scenarios",
		noScenarios: "No demand scenarios in this run.",
		supplierLinks: "Supplier links",
		noSupplierLinks: "No supplier links in this run.",
		supplies: (products: string) => `Supplies: ${products}`,
		businessExposure: (exposure: string) => `Business exposure: ${exposure}`,
		issuerPassage: "Cited passage naming the issuer",
		supplierEvidence: "Evidence for the supplier relationship",
		financialObservations: "Financial observations",
		noFinancial: "No financial observations in this run.",
		investorFilings: "Investor filings — reported holdings",
		filingsNote:
			"Filings report holdings as of a quarter end. A change is a change in the reported position, not evidence of a trade on any particular date.",
		noFilings: "No investor filings in this run.",
		pricingPower: "Pricing power assessments",
		pricingNote:
			"Price realization is assessed separately from volume, mix, FX and input costs; margin improvement alone is not treated as proof.",
		noPricing: "No pricing power assessments in this run.",
		/** Follows the period; the classification follows after a space. */
		assessment: " — assessment:",
		classification: (value: Classification): string => value,
		/** Starts with a space: it follows the classification. */
		missingInputs: (inputs: string) => ` (missing inputs: ${inputs})`,
		evidence: "Evidence",
		allEvidence: "All evidence",
		noEvidence: "No evidence stored for this run.",
		sourceClass: (value: Evidence["sourceClass"]): string => value,
		drawerTitle: "Evidence & records",
		run: "Run",
		startedAt: (when: string) => ` · started ${when}`,
		closeRecords: "Close records",
		/** The thing being loaded, for "Loading …". */
		runRecords: "run records",
	},
	ja: {
		positionChange: (change) =>
			({
				"newly-reported-holding": "新たに報告された保有",
				"increase-in-reported-position": "報告された保有の増加",
				"decrease-in-reported-position": "報告された保有の減少",
				"no-longer-reported": "報告されなくなった保有",
				"unchanged-reported-position": "報告された保有に変化なし",
				"not-reported": "報告された保有なし",
			})[change],
		sectionTitle: (title, count) => `${title}（${count}）`,
		listingVerification: (verification) =>
			({
				"source-verified": "公式の銘柄一覧で上場を確認済み",
				unverified: "上場は未確認 — モデルの提案で、形式のみ確認",
			})[verification],
		noPassageRetained: "保存された引用箇所なし",
		securityUnavailable: (securityId) => `銘柄を取得できません（ID ${securityId}）`,
		claimGroup: (group) =>
			({
				supported: "裏付けのある主張",
				conflicting: "根拠が矛盾する主張",
				unsupported: "裏付けのない主張",
			})[group],
		noClaims: (group) =>
			({
				supported: "この実行に裏付けのある主張はありません。",
				conflicting: "この実行に根拠が矛盾する主張はありません。",
				unsupported: "この実行に裏付けのない主張はありません。",
			})[group],
		unknownEvidence: (evidenceId) => `保存されていない根拠を引用しています（${evidenceId}）`,
		quoteNotFound: (evidenceId) => `根拠 ${evidenceId} に引用箇所が見つかりません`,
		quoteTooShort: (evidenceId) => `根拠 ${evidenceId} からの引用箇所が短すぎて検証できません`,
		missingQuote: (evidenceId) => `根拠 ${evidenceId} の引用箇所がありません`,
		numberNotInEvidence: (numberText) => `数値 ${numberText} は引用された根拠に含まれていません`,
		noSupportingEvidence: "裏付けとなる根拠なし",
		notIndependentlyVerified:
			"独立した検証なし — 引用は一致しましたが、主張を確かめる独立したチェックはありません",
		supportingEvidence: "裏付けとなる根拠",
		contradictingEvidence: "反証となる根拠",
		context: "文脈",
		verificationIssues: "検証の問題",
		quantityKind: (kind) =>
			({ "unit-demand": "数量ベースの需要", revenue: "売上高", price: "価格" })[kind],
		scenarioSummary: (kind, unit, baseYear, targetYear) =>
			`${kind}（単位: ${unit}）、基準年 ${baseYear}、目標年 ${targetYear}。基準値: `,
		noSourcedBaseline: "出典のある基準値なし",
		scenarioCaption: (targetYear, unit) => `${targetYear} 年の弱気 / 基本 / 強気の目標（${unit}）`,
		caseHeader: "ケース",
		targetHeader: (unit) => `目標（${unit}）`,
		derivedCagr: "算出した CAGR",
		assumptions: "前提",
		scenarioCase: (name) => ({ bear: "弱気", base: "基本", bull: "強気" })[name],
		notDerivable: "算出できません",
		perYear: (percent) => `年 ${percent}`,
		noneStated: "記載なし",
		drivers: "推進要因",
		barriers: "障壁",
		falsifiers: "反証条件",
		methodology: "手法",
		baselinePassage: "基準値を示す箇所",
		baselineEvidence: "基準値の根拠",
		contraryEvidence: "反対の根拠",
		currencyNotStated: "通貨の記載なし",
		perShare: (value, currency) => `1 株あたり ${value} ${currency}`,
		periodNotStated: "期間の記載なし",
		period: (fiscalYear, fiscalPeriod, start, end) =>
			`FY${fiscalYear} ${fiscalPeriod}（${start}〜${end}）`,
		financialCaption: "各値は、計算式・期間・出典の付いた日付のある 1 件の観測値です",
		security: "銘柄",
		metric: "指標",
		value: "値",
		periodAndBasis: "期間と基準",
		marketDataAsOf: "市場データの時点",
		formula: "計算式",
		source: "出典",
		reasonNotStated: "理由の記載なし",
		actualOrEstimate: (value) => ({ actual: "実績", estimate: "予想" })[value],
		accountingStandardNotStated: "会計基準の記載なし",
		notPriceDerived: "株価由来ではない / 記載なし",
		notStated: "記載なし",
		noSourceValue: "出典なし（値を取得できません）",
		marginBuy: "信用買い残",
		marginSell: "信用売り残",
		shares: (count) => `${count} 株`,
		reportedShortInterest: "報告された空売り残高",
		averageDailyVolume: "1 日の平均出来高",
		notReported: "報告なし",
		positionDates: (asOf, disseminated, definition) => (
			<>
				{asOf} 時点、公表 {disseminated}。定義: {definition}
			</>
		),
		dateNotStated: "日付の記載なし",
		noSourceFigures: "出典なし（数値を取得できません）",
		noObservations: "この実行にこの種類の観測値はありません。",
		filingHeadline: (investor, periodEnd, form, filedAt, link) => (
			<>
				{investor} — 四半期末 {periodEnd} 時点の報告保有（{form}、提出日 {filedAt}）。{link}
			</>
		),
		viewFiling: "提出書類を見る",
		filerNote: (scheme, value) =>
			`提出者が報告した四半期末の保有です（${scheme} ${value}）。日付のある取引ではありません。`,
		noHoldings: "この提出書類に記載された保有はありません。",
		holdingsCaption: (investor, periodEnd) => `${investor} の ${periodEnd} 時点の報告保有`,
		issuer: "発行体",
		reportedShares: "報告株数",
		reportedValue: "報告評価額（USD）",
		changeVersusPrior: "前回の提出書類との比較",
		notCompared: "前回の提出書類と比較していません",
		demandScenarios: "需要シナリオ",
		noScenarios: "この実行に需要シナリオはありません。",
		supplierLinks: "サプライヤーとの関係",
		noSupplierLinks: "この実行にサプライヤーとの関係はありません。",
		supplies: (products) => `供給品目: ${products}`,
		businessExposure: (exposure) => `事業上のエクスポージャー: ${exposure}`,
		issuerPassage: "発行体の名前を挙げた引用箇所",
		supplierEvidence: "サプライヤー関係の根拠",
		financialObservations: "財務の観測値",
		noFinancial: "この実行に財務の観測値はありません。",
		investorFilings: "投資家の提出書類 — 報告保有",
		filingsNote:
			"提出書類は四半期末時点の保有を報告します。変化は報告されたポジションの変化であり、特定の日の取引の証拠ではありません。",
		noFilings: "この実行に投資家の提出書類はありません。",
		pricingPower: "価格決定力の評価",
		pricingNote:
			"価格の実現は数量、構成、為替、投入コストと切り分けて評価します。利益率の改善だけでは証拠とみなしません。",
		noPricing: "この実行に価格決定力の評価はありません。",
		assessment: " — 評価:",
		classification: (value) =>
			({
				"corroborated-price-realization": "価格の実現を確認",
				"price-realization-uncorroborated": "価格の実現は未確認",
				"price-increase-offset-by-volume-loss": "値上げを数量減が相殺",
				"price-increase-absorbed-by-costs": "値上げをコスト増が吸収",
				"no-price-realization": "価格の実現なし",
				"margin-improvement-without-price-evidence": "価格の根拠のない利益率改善",
				"insufficient-data": "データ不足",
			})[value],
		missingInputs: (inputs) => `（不足している入力: ${inputs}）`,
		evidence: "根拠",
		allEvidence: "すべての根拠",
		noEvidence: "この実行に保存された根拠はありません。",
		sourceClass: (value) =>
			({
				news: "ニュース",
				"regulatory-filing": "規制当局への提出書類",
				"official-statistics": "公的統計",
				"company-disclosure": "企業の開示",
				"market-data": "市場データ",
				other: "その他",
			})[value],
		drawerTitle: "根拠と記録",
		run: "実行",
		startedAt: (when) => ` · 開始 ${when}`,
		closeRecords: "記録を閉じる",
		runRecords: "実行の記録",
	},
});
