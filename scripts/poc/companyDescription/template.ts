import {
	COMPANY_OVERVIEW_LIMITS,
	type CompanyOverviewDraft,
	type CompanyOverviewEntry,
	companyOverviewDraftSchema,
	type OverviewEvidence,
	type OverviewFigure,
	type OverviewFigureMetric,
	type OverviewProfileFact,
	type OverviewReference,
	type OverviewSegment,
	type OverviewSourceId,
	type OverviewStatement,
	type OverviewTheme,
} from "@research/contracts";

/**
 * PoC: the 企業の説明 (About the company) template for the Stocks page's
 * Company tab (企業情報), laid out like the company entry of 会社四季報
 * (Japan Company Handbook) as SBI証券 shows it on its 企業概要 tab, with
 * evidence and references.
 *
 * Only the layout follows 会社四季報: its text is Toyo Keizai's licensed
 * content and is never copied, and its editorial forecast paragraphs have
 * no counterpart (ADR-0060: no forecasts). Every field is filled from the
 * server's own stored records, and every model-written field carries
 * evidence — the id of a numbered source plus a word-for-word quote that
 * code checks before anything is shown. The model never writes a
 * reference: titles, dates and links come from the stored records.
 *
 * The template, in display order (四季報's label → who fills it):
 *   【特色】 Feature        — model: one short statement, what the company is known for
 *   【事業内容】 Businesses  — model: the summary of the business, 2–4 sentences of one paragraph
 *   【連結事業】 Segments    — model: the reportable segments; a sales share or margin only where a source states it
 *   【海外】 Overseas        — model: the overseas share and each country's or region's share, as stated or from a table's amounts
 *   【会社概要】 Profile     — code: market, sector, fiscal year end; model: founded, employees, headquarters (each with evidence)
 *   【業績】 Results         — code: the latest fiscal year's stored figures and the operating margin computed from them
 *   【テーマ】 Themes        — model: 1–6 labels, each with a one-statement reason
 *   出所 / 出典 References    — code: in small text under each section and as the numbered list
 */

/**
 * How the text must read: like a company handbook written by a person, not
 * like an AI assistant. Model text tends toward stock phrases ("a wide
 * range of", 「多岐にわたる」), praise the source never states, and the same
 * subject at the start of every sentence; a reader learns nothing from
 * them and they mark the page as machine-written. Each rule names the
 * pattern so the model can find it in its own draft. Part of the prompt.
 */
export const STYLE_RULES = {
	en: [
		"Write like a company handbook editor, not an AI assistant: short, plain, concrete.",
		"Name things: products, brands, segments, regions, years, counts from the sources. Prefer a name over a category word.",
		'No filler or praise words unless a source says them: "leading", "innovative", "comprehensive", "diverse", "robust", "cutting-edge", "seamless", "renowned", "key player", "a wide range of", "various", "plays a vital role", "is committed to", "strives to".',
		'Do not start sentences with "The company" or the company\'s name; the page is already about it.',
		'No rhetorical shapes: no "not only … but also", no lists of three for rhythm, no em dashes (—), no colons that introduce a summary, no closing sentence that sums up.',
		"No hedging (may, could, potentially) and no evaluation (strong, well-positioned, impressive).",
	],
	ja: [
		"会社四季報の記者のように書く。AIアシスタントの文体にしない。短く、具体的に。",
		"文末は体言止めか「〜を展開。」「〜が主力。」のような簡潔な形。「〜しています」「〜となっています」「〜を行っています」を続けない。",
		"「同社は」「当社は」や社名で文を始めない。",
		"出典にない限り、次の語を使わない:「幅広い」「多岐にわたる」「さまざまな」「多様な」「革新的な」「先進的な」「包括的な」「〜に注力」「〜を通じて」「〜に取り組む」「〜をリード」「重要な役割を果たす」「強み」「高品質な」。",
		"製品名・ブランド名・部門名・地域名・数値など、出典にある固有の語を使う。英語の固有名詞（社名・ブランド名・製品名）はカタカナ化しにくければ原綴りのまま書く。部門名・地域名・業種名などの普通の語は日本語に訳す（Construction→建設、Latin America→中南米、Wealth Management→資産運用）。",
		"「——」(ダッシュ)、「〜だけでなく〜も」、締めくくりのまとめ文を使わない。",
	],
} as const;

/**
 * The template's schema lives in `@research/contracts` (companyOverview.ts,
 * ADR-0064), where the stored overview and the Stocks API use it; the PoC
 * names below are aliases of it.
 */
export const TEMPLATE_LIMITS = COMPANY_OVERVIEW_LIMITS;
export const companyDescriptionSchema = companyOverviewDraftSchema;
export type CompanyDescription = CompanyOverviewDraft;
export type VerifiedDescription = CompanyOverviewEntry;
/**
 * A reply as the checks read it: the draft, whose 【特色】 may be null when
 * the salvage dropped an invalid one (an entry may lack it; ADR-0064 §5c).
 */
export type DescriptionToCheck = Omit<CompanyDescription, "feature"> & {
	readonly feature: CompanyDescription["feature"] | null;
};
export type SourceId = OverviewSourceId;
export type Evidence = OverviewEvidence;
export type Statement = OverviewStatement;
export type Segment = OverviewSegment;
export type ProfileFact = OverviewProfileFact;
export type Theme = OverviewTheme;
export type Figure = OverviewFigure;
export type FigureMetric = OverviewFigureMetric;

/** The 会社概要 rows code fills from stored records (null when not stored). */
export interface StoredProfile {
	readonly listing: string | null;
	/** A Japanese stock's TSE 33-sector (J-Quants). */
	readonly sector: string | null;
	/** "MM-DD" as stored. */
	readonly fiscalYearEnd: string | null;
}

/**
 * A numbered source the server built from its own records: the reference
 * shown under 出典 plus the text the model may quote. Only the reference
 * part is stored; the model sees only the id and the text.
 */
export interface CompanySource extends OverviewReference {
	readonly text: string;
}
