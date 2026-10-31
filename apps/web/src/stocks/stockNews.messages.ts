import { defineMessages } from "@research/i18n";

/**
 * The Stocks page's News tab (ADR-0049 §7, ADR-0032). Article titles,
 * publishers, excerpts and the searched-for terms are data and stay as
 * they are; dates are formatted in the UI language by the tab.
 */
export const stockNewsMessages = defineMessages({
	en: {
		/** "Loading <thing>…". */
		newsThing: "articles that mention this stock",
		newsFailed: "The stored articles could not be loaded.",
		moreFailed: "More articles could not be loaded; the ones shown stay.",
		/** The article list's accessible name. */
		articlesLabel: (stock: string) => `Stored articles that mention ${stock}`,
		/** The searched-for terms in a list ("Apple, AAPL"). */
		termList: (terms: readonly string[]) => terms.join(", "),
		searchedFor: (terms: string) => `Searched for: ${terms}`,
		mentions: (term: string) => `Mentions: ${term}`,
		published: "Published",
		retrieved: "Retrieved",
		noPublishedDate: "(no publication date)",
		showMore: "Show more",
		/** Announced after Show more. */
		loaded: (added: number, total: number) =>
			added === 0
				? `No further mentions in the next stored articles; ${total} shown.`
				: `${added} more ${added === 1 ? "article" : "articles"} loaded; ${total} shown.`,
		moreLimit: (total: number) =>
			`The list shows at most ${total} articles; the older ones stay on Sources.`,
		/** The articles looked at so far held no mention, but older stored articles remain. */
		noneYet: (term: string) =>
			`No mention of ${term} among the stored articles looked at so far. Show more looks at older ones.`,
		none: (term: string) =>
			`No stored article mentions ${term}. Articles come from the feeds chosen on Sources.`,
		openSources: "Open Sources",
		noTerms:
			"There is no stored name to search the articles for: a Japanese stock is found by its name only, and none is stored for it yet.",
	},
	ja: {
		newsThing: "この銘柄に言及した記事",
		newsFailed: "保存された記事を読み込めませんでした。",
		moreFailed: "続きの記事を読み込めませんでした。表示中の記事はそのまま残ります。",
		articlesLabel: (stock) => `${stock} に言及した保存済みの記事`,
		termList: (terms) => terms.join("、"),
		searchedFor: (terms) => `検索した語：${terms}`,
		mentions: (term) => `言及：${term}`,
		published: "公開",
		retrieved: "取得",
		noPublishedDate: "（公開日の記載なし）",
		showMore: "さらに表示",
		loaded: (added, total) =>
			added === 0
				? `次の保存済みの記事には言及がありませんでした。${total} 件を表示中です。`
				: `さらに ${added} 件を読み込みました。${total} 件を表示中です。`,
		moreLimit: (total) =>
			`一覧に表示できるのは ${total} 件までです。それより古い記事は情報源ページで確認できます。`,
		noneYet: (term) =>
			`これまでに調べた保存済みの記事には ${term} への言及がありません。「さらに表示」でより古い記事を調べます。`,
		none: (term) =>
			`${term} に言及した保存済みの記事はありません。記事は情報源ページで選んだフィードから届きます。`,
		openSources: "情報源を開く",
		noTerms:
			"記事を検索するための保存済みの名称がありません。日本株は名称だけで検索しますが、この銘柄の名称はまだ保存されていません。",
	},
});
