import { defineMessages } from "@research/i18n";
import { PAGES, type ViewName } from "./pages.ts";

/** English is `PAGES` itself (the text docs/PAGES.md is checked against); no copy. */
function englishPage(view: ViewName): (typeof PAGES)[number] {
	return PAGES.find((page) => page.view === view) ?? PAGES[0];
}

const JAPANESE: { readonly [V in ViewName]: { readonly title: string; readonly purpose: string } } =
	{
		home: {
			title: "ホーム",
			purpose: "自分で並べたウィジェットで、株価・チャート・経済指標をひと目で確認します。",
		},
		registered: {
			title: "登録済みの銘柄",
			purpose: "登録した銘柄をリストにまとめ、決算発表日と財務諸表の同期を管理します。",
		},
		stocks: {
			title: "株式データ",
			purpose: "1 銘柄の株価チャート・財務諸表・企業情報・ニュースを保存済みのデータで確認します。",
		},
		tasks: {
			title: "タスク",
			purpose: "リサーチの質問を予定どおりに自動で実行し、次の実行日時と前回の結果を確認します。",
		},
		chat: {
			title: "チャット",
			purpose: "リサーチの質問をして、出典と実行の進み具合とともに回答を読みます。",
		},
		sources: {
			title: "情報源",
			purpose: "リサーチが読んでよいニュースの情報源を選びます。",
		},
		settings: {
			title: "設定",
			purpose:
				"ワークスペースの動作を設定します: AI エージェント、カレンダー、ランナー、データのエクスポート。",
		},
	};

export const pageMessages = defineMessages({
	en: {
		title: (view: ViewName): string => englishPage(view).title,
		purpose: (view: ViewName): string => englishPage(view).purpose,
	},
	ja: {
		title: (view) => JAPANESE[view].title,
		purpose: (view) => JAPANESE[view].purpose,
	},
});
