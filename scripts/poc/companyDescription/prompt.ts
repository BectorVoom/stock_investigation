import { fenceUntrustedText } from "@research/agent-core";
import type { StockSources } from "./sources.ts";
import { STYLE_RULES, TEMPLATE_LIMITS } from "./template.ts";

export const COMPANY_DESCRIPTION_TURN_MARKER = "COMPANY DESCRIPTION TURN v4-poc";

/**
 * The prompt of one turn: the template (laid out like a 会社四季報 company
 * entry), the evidence rule and the numbered sources (each fenced as
 * untrusted data, AGT-007). `repairNote` lists why the previous reply was
 * rejected.
 */
export function companyDescriptionPrompt(input: {
	readonly stock: StockSources;
	readonly fenceToken: string;
	readonly repairNote: string | null;
}): string {
	const limits = TEMPLATE_LIMITS;
	const { stock } = input;
	return [
		COMPANY_DESCRIPTION_TURN_MARKER,
		"",
		`You fill in the company entry of an investor's stock page for ${stock.stock.market}:${stock.stock.symbol}, in the terse style of a Japanese company handbook (会社四季報).`,
		"Use ONLY the numbered sources below. Your own knowledge is not a source: if the sources do not say something, leave it out (null or an empty list).",
		'The first sources are the server\'s stored records (stock list, annual report or exchange data, figures). Sources noted "Company website", "Regulator or exchange" or "Web page" are public web pages found by a search, the company\'s own website first. Use them for the business activities, segments and themes the records do not cover; prefer the company\'s own and regulatory pages, and do not take a claim from a page that is not about this company.',
		"Do not write sentences about what the sources lack; the page says that itself.",
		"",
		"Fields (JSON):",
		`- feature (【特色】): one statement — what the company is and what it is known for (its main business, position, history). ja: one line, at most ${limits.maxFeatureJaChars} characters, terse handbook style ending in a noun or 「。」 (e.g. 「…を展開。…で世界首位級」).`,
		`- businesses (【事業内容】): up to ${limits.maxBusinesses} statements that explain the company's actual business activities, built from its business segment information: for each main business, what it makes or provides, for whom, and how it earns the money (for example: concentrate sold to bottling partners; finished drinks sold to retailers; fountain syrup sold to restaurants). When the segments are regions selling the same things, explain the main product and service lines instead and say they are sold in every region. A sector classification (TSE 33-sector, 17-sector) or a bare category word is NOT a business activity: when the sources describe no activity, return an empty list.`,
		`- segments (【連結事業】): every reportable or operating segment a source names, up to ${limits.maxSegments}. activity: one line on what that segment does — its products, customers or operations — as the sources describe it (e.g. 「濃縮原液をボトラーに販売。Costa店舗を含む」), or null when they say nothing specific about that segment. salesSharePercent and marginPercent: the segment's share of sales and its profit margin in percent ONLY when a source states that exact number for that segment; otherwise null. Never compute them.`,
		"- overseasSales (【海外】): the share of sales outside the home country, only when a source states it as a percentage; otherwise null.",
		'- profile (【会社概要】): up to 3 facts a source states — field "founded" (year founded or incorporated), "employees" (headcount and its date), "headquarters" (city). Leave out what no source states.',
		`- themes (【テーマ】): up to ${limits.maxThemes} investment themes, each with a one-statement reason. Specific, sub-industry level: name the product category, technology or niche the company is actually in — "Natural Foods" not "Food", "Analog Semiconductors" not "Semiconductors", "Sparkling Soft Drinks" not "Beverages", "Mobile Payments" not "Finance". Never a sector name or a broad word (Food, Beverages, Technology, Consumer, Services, Retail, Manufacturing, 食品, 飲料, 水産・農林業). The reason quotes the source passage that shows the company is in it. When the sources support no specific theme, return an empty list.`,
		"Do not state financial figures (sales, profits, margins).",
		"",
		"Every field has en (English) and ja (natural Japanese) text where shown, and evidence:",
		`1 to ${limits.maxEvidencePerField} items {"source": "S1", "quote": "..."}. The quote is copied WORD FOR WORD from that source`,
		`(${limits.minQuoteChars} to ${limits.maxQuoteChars} characters, in the source's language) and supports the field. A stated number must appear in its quote.`,
		"Neutral and factual: no investment advice, no opinions, no forecasts.",
		"",
		"Style, English (en):",
		...STYLE_RULES.en.map((rule) => `- ${rule}`),
		"Style, Japanese (ja):",
		...STYLE_RULES.ja.map((rule) => `- ${rule}`),
		"",
		"Answer with ONE JSON object and nothing else, exactly this shape:",
		'{"feature": {"en": "...", "ja": "...", "evidence": [{"source": "S2", "quote": "..."}]},',
		' "businesses": [<statement>],',
		' "segments": [{"name": {"en": "...", "ja": "..."}, "activity": {"en": "...", "ja": "..."} or null, "salesSharePercent": null, "marginPercent": null, "evidence": [...]}],',
		' "overseasSales": null or {"percent": 0, "evidence": [...]},',
		' "profile": [{"field": "employees", "value": {"en": "...", "ja": "..."}, "evidence": [...]}],',
		' "themes": [{"label": {"en": "...", "ja": "..."}, "reason": <statement>}]}',
		"",
		"Sources:",
		...stock.sources.map((source) =>
			fenceUntrustedText(
				`${source.id}: ${source.title.en} — ${source.publisher}${source.note === null ? "" : ` (${source.note.en})`}`,
				source.text,
				input.fenceToken,
			),
		),
		...(input.repairNote === null
			? []
			: [
					"",
					"Your previous answer was rejected:",
					input.repairNote,
					"Answer again with the whole JSON object. Fix or drop each rejected field; quote sources word for word.",
				]),
	].join("\n");
}
