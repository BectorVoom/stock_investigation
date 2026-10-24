import { defineMessages } from "@research/i18n";

export const appMessages = defineMessages({
	en: {
		appName: "Research workspace",
		/** The browser tab title: the page, then the app. */
		tabTitle: (page: string) => `${page} · Research workspace`,
		developmentBadge: "Development",
		viewsNavigation: "Views",
		checkingSession: "Checking session…",
		signedInAs: "Signed in as",
		homeLoadFailed: "Home could not be loaded.",
	},
	ja: {
		appName: "リサーチワークスペース",
		tabTitle: (page) => `${page} · リサーチワークスペース`,
		developmentBadge: "開発環境",
		viewsNavigation: "ページ",
		checkingSession: "セッションを確認中…",
		signedInAs: "サインイン中:",
		homeLoadFailed: "ホームを読み込めませんでした。",
	},
});
