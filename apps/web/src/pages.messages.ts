import { defineMessages } from "@research/i18n";
import { PAGES, type ViewName } from "./pages.ts";

/** English is `PAGES` itself (the text docs/PAGES.md is checked against); no copy. */
function englishPage(view: ViewName): (typeof PAGES)[number] {
	return PAGES.find((page) => page.view === view) ?? PAGES[0];
}

const JAPANESE: { readonly [V in ViewName]: { readonly title: string; readonly purpose: string } } =
	{
		equities: {
			title: "株式データ",
			purpose: "日本株・米国株の財務諸表と企業データを取り込み、出典とともに確認します。",
		},
		home: {
			title: "ホーム",
			purpose: "自分で並べたウィジェットで、株価・チャート・経済指標をひと目で確認します。",
		},
		watchlist: {
			title: "ウォッチリスト",
			purpose: "注目している銘柄を登録し、決算発表日を確認します。",
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
