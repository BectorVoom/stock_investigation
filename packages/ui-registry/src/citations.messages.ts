import { defineMessages } from "@research/i18n";

/**
 * The registry's own words around cited sources: chips, source cards, the
 * sources disclosure and citation lines. Source titles, publishers and
 * excerpts are research content and are shown as written.
 */
export const citationMessages = defineMessages({
	en: {
		untitledSource: "Untitled source",
		/** Accessible name of a citation chip. */
		chipLabel: (number: number, name: string) => `Source ${number}: ${name}`,
		chipUnavailable: (number: number) => `Source ${number}: unavailable`,
		sourceUnavailable: (id: string) => `Source unavailable (id ${id})`,
		supports: "Supports",
		contradicts: "Contradicts",
		context: "Context",
		published: "published",
		retrieved: "retrieved",
		dataAsOf: "data as of",
		dateNotStated: "date not stated",
		/** Between the parts of a one-line citation: "Publisher; published …; retrieved …". */
		citationSeparator: "; ",
		noExcerpt: "No excerpt stored for this source.",
		openSource: "Open source",
		linkUnavailable: "(link unavailable)",
		sources: "Sources",
		sourceCount: (count: number) => `${count} ${count === 1 ? "source" : "sources"}`,
		noSourcesForComponent: "No sources cited for this component.",
		/** Accessible name of a cell's source link. */
		sourceLinkLabel: (title: string) => `Source: ${title}`,
		sourceLinkText: "source",
	},
	ja: {
		untitledSource: "無題の出典",
		chipLabel: (number, name) => `出典 ${number}：${name}`,
		chipUnavailable: (number) => `出典 ${number}：取得できません`,
		sourceUnavailable: (id) => `出典を取得できません（ID ${id}）`,
		supports: "裏付け",
		contradicts: "反証",
		context: "背景",
		published: "公開日",
		retrieved: "取得日",
		dataAsOf: "データ時点",
		dateNotStated: "日付の記載なし",
		citationSeparator: "、",
		noExcerpt: "この情報源の抜粋は保存されていません。",
		openSource: "情報源を開く",
		linkUnavailable: "（リンクを利用できません）",
		sources: "出典",
		sourceCount: (count) => `出典 ${count} 件`,
		noSourcesForComponent: "このコンポーネントには出典がありません。",
		sourceLinkLabel: (title) => `出典：${title}`,
		sourceLinkText: "出典",
	},
});
