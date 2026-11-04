import { defineMessages } from "@research/i18n";

/**
 * The Stocks page's theme search (ADR-0066, ADR-0070): its box, its pages
 * of results, the panel showing a chosen stock and the
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
		/** The caption's count when the results span pages. */
		resultRange: (from: number, to: number, total: number): string =>
			`${from}–${to} of ${total} stocks`,
		pagesLabel: "Result pages",
		firstPage: "First",
		previousPage: "Previous",
		nextPage: "Next",
		lastPage: "Last",
		pageOf: (page: number, count: number): string => `Page ${page} of ${count}`,
		/** The panel beside the results that shows a clicked stock. */
		panelLabel: "Chosen stock",
		openStockPage: "Open on its own page",
		closePanel: "Close the stock",
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
		resultRange: (from, to, total) => `${total} 銘柄中 ${from}–${to}`,
		pagesLabel: "検索結果のページ",
		firstPage: "最初",
		previousPage: "前へ",
		nextPage: "次へ",
		lastPage: "最後",
		pageOf: (page, count) => `${page} / ${count} ページ`,
		panelLabel: "選んだ銘柄",
		openStockPage: "銘柄のページで開く",
		closePanel: "銘柄を閉じる",
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
