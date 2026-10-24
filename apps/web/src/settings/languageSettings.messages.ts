import { defineMessages } from "@research/i18n";

export const settingsLanguageMessages = defineMessages({
	en: {
		title: "Language",
		label: "Display language",
		browserDefault: (current: string) => `Browser default (${current})`,
		hint: "Applies to this browser at once. Research answers, source titles and quoted evidence stay in the language they were written in.",
	},
	ja: {
		title: "言語",
		label: "表示言語",
		browserDefault: (current) => `ブラウザの設定（${current}）`,
		hint: "このブラウザにすぐ反映されます。リサーチの回答、情報源のタイトル、引用された根拠は書かれた言語のまま表示されます。",
	},
});
