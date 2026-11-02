import { defineMessages } from "@research/i18n";

/** A stored filing's extraction status (contracts `equityFilingListItemSchema.factsStatus`). */
type FilingFactsStatus = "pending" | "extracted" | "unavailable";

const EN_FACTS_STATUS: { readonly [S in FilingFactsStatus]: string } = {
	pending: "Pending: the server reads it again",
	extracted: "Read",
	unavailable: "No machine-readable values",
};

const JA_FACTS_STATUS: { readonly [S in FilingFactsStatus]: string } = {
	pending: "保留: サーバーが再取得します",
	extracted: "取得済み",
	unavailable: "機械可読の値なし",
};

/**
 * One company's statements and filings, as the Stocks
 * page's Financial statements and Company tabs word them (ADR-0049 §5, §6).
 * The sync status is not shown (ADR-0055 §4).
 */
export const equitiesMessages = defineMessages({
	en: {
		/* ----- one company's statements and filings ----- */
		yearsLabel: "Fiscal years",
		yearsOption: (years: number): string => `${years} years`,
		filingsIntro:
			"Every annual filing stored for this company — annual reports, or for a Japanese company its full-year earnings summaries — newest first, including corrected originals and filings without machine-readable values.",
		filingsCaption: "Stored annual filings of this company",
		filingsThing: "the filings",
		filingsFailed: "Could not load the filings.",
		/** The selected company stopped being the owner's (removed elsewhere) before the list caught up. */
		companyGone: "This company's statements are no longer stored.",
		noFilings: "No filings are stored yet. They appear here once the server has fetched them.",
		factsColumn: "Values",
		factsStatus: (status: FilingFactsStatus): string => EN_FACTS_STATUS[status],
		factCount: (count: number): string => (count === 1 ? "1 value" : `${count} values`),
		amendsDocument: (documentId: string): string => `Amends ${documentId}`,
		form: "Form",
		filed: "Filed",
		periodEnd: "Period end",
		standard: "Accounting standard",
		amendment: "Amendment",
		isAmendment: "Amends an earlier filing",
		original: "Original",
		standardUnknown: "Not stated",
		link: "Link",
		openFiling: "Open",
	},
	ja: {
		yearsLabel: "表示する年数",
		yearsOption: (years) => `${years}年`,
		filingsIntro:
			"この企業について保存しているすべての年次の報告書（日本企業は通期の決算短信）です（新しい順）。訂正された当初の報告書や、機械可読の値がない報告書も含みます。",
		filingsCaption: "この企業の保存済みの年次の報告書",
		filingsThing: "報告書",
		filingsFailed: "報告書を読み込めませんでした。",
		companyGone: "この企業の財務諸表はもう保存されていません。",
		noFilings: "保存済みの報告書はまだありません。サーバーが取得すると、ここに表示されます。",
		factsColumn: "値",
		factsStatus: (status) => JA_FACTS_STATUS[status],
		factCount: (count) => `${count} 件の値`,
		amendsDocument: (documentId) => `${documentId} の訂正`,
		form: "様式",
		filed: "提出日",
		periodEnd: "期末日",
		standard: "会計基準",
		amendment: "訂正",
		isAmendment: "以前の報告書の訂正",
		original: "当初",
		standardUnknown: "記載なし",
		link: "リンク",
		openFiling: "開く",
	},
});
