import { defineMessages } from "@research/i18n";

/** The shared UI parts' own words (`ui.tsx`); the labels callers pass stay theirs. */
export const uiMessages = defineMessages({
	en: {
		validationErrors: "Validation errors",
		/** `RemoteView`'s failure title for the named part of the page. */
		couldNotLoad: (thing: string) => `Could not load ${thing}.`,
		chatNotDeleted: "The chat was not deleted.",
		deleting: "Deleting…",
	},
	ja: {
		validationErrors: "検証エラー",
		couldNotLoad: (thing) => `${thing}を読み込めませんでした。`,
		chatNotDeleted: "チャットは削除されませんでした。",
		deleting: "削除中…",
	},
});

/** The maximum-spend field shared by Settings and the approval form (`SpendField.tsx`). */
export const spendFieldMessages = defineMessages({
	en: {
		label: "Max spend (USD)",
		hint: (max: number) => `Leave empty for no spending cap; at most ${max} when set`,
		consent: "I consent to metered spend up to the maximum above for this run",
	},
	ja: {
		label: "最大支出額（USD）",
		hint: (max) => `空欄の場合、支出額の上限はありません。設定できる上限は ${max} です`,
		consent: "この実行で、上記の最大額までの従量課金の支出に同意します",
	},
});
