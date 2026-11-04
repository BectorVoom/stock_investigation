import type { OverviewProfileFact } from "@research/contracts";
import { defineMessages } from "@research/i18n";

type ProfileField = OverviewProfileFact["field"];

const EN_FIELDS: { readonly [F in ProfileField]: string } = {
	founded: "Founded",
	employees: "Employees",
	headquarters: "Headquarters",
};

const JA_FIELDS: { readonly [F in ProfileField]: string } = {
	founded: "設立",
	employees: "従業員",
	headquarters: "本社",
};

/**
 * The Company tab's company overview (事業概要, ADR-0064): its row labels,
 * laid out like a 会社四季報 entry, its key facts table and its source
 * lines. The entry's own text is stored in both languages and shown in the
 * UI's language.
 */
export const companyOverviewMessages = defineMessages({
	en: {
		feature: "Feature",
		businesses: "Businesses",
		segments: "Segments",
		overseas: "Overseas",
		themes: "Themes",
		keyFacts: "Key facts",
		references: "References",
		/** A row label in 四季報's brackets in Japanese; plain in English. */
		rowLabel: (label: string): string => label,
		market: "Market",
		sector: "Sector",
		fiscalYearEnd: "Fiscal year end",
		profileField: (field: ProfileField): string => EN_FIELDS[field],
		segmentNote: "Numbers are the share of sales in % (profit margin in parentheses).",
		/** "S2" after a field: which numbered source backs it. */
		sourceMark: (id: string): string => `Source ${id}`,
		sourceLine: "Source",
		/** Between a segment's name and what it does. */
		segmentActivitySeparator: ": ",
		/** Who wrote the overview and when; the date comes formatted. */
		writtenBy: (agent: string, model: string | null, date: string): string =>
			`Written by AI (${model === null ? agent : `${agent}, ${model}`}) on ${date} from the sources above only. It may contain mistakes.`,
	},
	ja: {
		feature: "特色",
		businesses: "事業内容",
		segments: "連結事業",
		overseas: "海外",
		themes: "テーマ",
		keyFacts: "基本情報",
		references: "出典",
		rowLabel: (label) => `【${label}】`,
		market: "市場",
		sector: "業種",
		fiscalYearEnd: "決算期",
		profileField: (field) => JA_FIELDS[field],
		segmentNote: "数値は売上構成比%(カッコ内は利益率%)。",
		sourceMark: (id) => `出典 ${id}`,
		sourceLine: "出所",
		segmentActivitySeparator: "：",
		writtenBy: (agent, model, date) =>
			`AI（${model === null ? agent : `${agent}、${model}`}）が ${date} に上記の出典だけから作成。誤りを含む場合があります。`,
	},
});
