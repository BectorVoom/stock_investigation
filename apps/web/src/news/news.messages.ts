import { defineMessages } from "@research/i18n";

export const newsMessages = defineMessages({
	en: {
		aiNews: "AI news",
		noReports: "No news reports yet. Run this task to generate a report.",
		noNewsTasks: "No news tasks yet. Create a task and choose News as its output.",
		aiNewsFailed: "Could not load AI news.",
		earlierNews: "Earlier news",
		manageSources: "Manage news sources",
		scanStalled: "The article cursor did not advance. Reload the article list to restart.",
	},
	ja: {
		aiNews: "AIニュース",
		noReports: "ニュースはまだありません。タスクを実行するとレポートが作成されます。",
		noNewsTasks:
			"ニュースタスクはまだありません。タスクを作成し、出力先にニュースを選んでください。",
		aiNewsFailed: "AIニュースを読み込めませんでした。",
		earlierNews: "過去のニュース",
		manageSources: "ニュースの情報源を管理",
		scanStalled: "記事のカーソルが進みませんでした。記事一覧を再読み込みしてください。",
	},
});
