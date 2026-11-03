import { defineMessages } from "@research/i18n";

/**
 * The Stocks page's theme search (ADR-0066): its box, its results and the
 * Company tab's theme links. Theme names and stock names are data.
 */
export const themeSearchMessages = defineMessages({
	en: {
		title: "Find stocks by theme",
		hint: "Search the themes shown on your stocks' Company tab. Only stocks with a business overview or an AI-written summary have themes.",
		inputLabel: "Theme words",
		submit: "Search",
		/** The results table's caption. */
		resultsCaption: (words: string): string => `Stocks with a theme containing “${words}”`,
		resultCount: (count: number): string => (count === 1 ? "1 stock" : `${count} stocks`),
		truncated: (shown: number): string =>
			`Showing the first ${shown}. Use more specific words to see the rest.`,
		none: (words: string): string =>
			`No stock has a theme containing “${words}”. Only stocks with a business overview or an AI-written summary have themes.`,
		nothingToMatch: "These words are longer than any theme, so no theme can contain them.",
		stockColumn: "Stock",
		symbolColumn: "Symbol",
		themesColumn: "Matching themes",
		searching: "theme search",
		failed: "The theme search failed",
		closeResults: "Close the results",
		/** A theme on the Company tab is a link to this search. */
		themeLink: (theme: string): string => `Find stocks with the theme ${theme}`,
	},
	ja: {
		title: "テーマで銘柄を探す",
		hint: "銘柄の企業情報タブに表示されるテーマを検索します。テーマがあるのは、事業概要または AI の要約がある銘柄だけです。",
		inputLabel: "テーマの語",
		submit: "検索",
		resultsCaption: (words) => `「${words}」を含むテーマの銘柄`,
		resultCount: (count) => `${count} 銘柄`,
		truncated: (shown) => `最初の ${shown} 銘柄を表示しています。語を絞ると残りも表示されます。`,
		none: (words) =>
			`「${words}」を含むテーマの銘柄はありません。テーマがあるのは、事業概要または AI の要約がある銘柄だけです。`,
		nothingToMatch: "どのテーマよりも長い語のため、一致するテーマはありません。",
		stockColumn: "銘柄",
		symbolColumn: "コード",
		themesColumn: "一致したテーマ",
		searching: "テーマ検索",
		failed: "テーマ検索に失敗しました",
		closeResults: "検索結果を閉じる",
		themeLink: (theme) => `テーマ「${theme}」の銘柄を探す`,
	},
});
