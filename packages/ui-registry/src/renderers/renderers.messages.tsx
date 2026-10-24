import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";

/**
 * The fixed headings and labels the registry's components add around the
 * agent's content. Headlines, names, statements, notes and disclaimers are
 * research content and are shown as written.
 */
export const rendererMessages = defineMessages({
	en: {
		/** Accessible name of a rendered workspace component. */
		componentLabel: (componentId: string) => `Component ${componentId}`,
		newsSource: "Source: ",
		noSummary: "no summary stored for this article",
		countryJP: "Japan",
		countryUS: "United States",
		ticker: "Ticker",
		exchange: "Exchange",
		market: "Market",
		productsHeading: "Relevant products and services",
		noProducts: "No products or services recorded.",
		businessExposure: "Business exposure",
		metrics: "Metrics",
		unverifiedNote: "Unverified note — not checked against stored evidence",
		noStatementSources: "No sources cited for this statement.",
		/** The report's generation date, placed in the sentence. */
		generated: (date: JSX.Element): JSX.Element => <>Generated {date}</>,
		dataCutoff: (date: JSX.Element): JSX.Element => (
			<>Data cut-off: {date} — nothing retrieved after this date informed the report.</>
		),
		noStatements: "No statements in this section.",
		methodology: "Methodology: ",
	},
	ja: {
		componentLabel: (componentId) => `コンポーネント ${componentId}`,
		newsSource: "出典：",
		noSummary: "この記事の要約は保存されていません",
		countryJP: "日本",
		countryUS: "米国",
		ticker: "ティッカー",
		exchange: "取引所",
		market: "市場",
		productsHeading: "関連する製品・サービス",
		noProducts: "製品・サービスの記録はありません。",
		businessExposure: "事業との関わり",
		metrics: "指標",
		unverifiedNote: "未検証のメモ — 保存された根拠と照合していません",
		noStatementSources: "この記述には出典がありません。",
		generated: (date) => <>作成日 {date}</>,
		dataCutoff: (date) => (
			<>データの締め日：{date} — この日より後に取得した情報はレポートに使っていません。</>
		),
		noStatements: "このセクションには記述がありません。",
		methodology: "算出方法：",
	},
});
