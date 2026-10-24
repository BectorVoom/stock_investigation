import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";

/**
 * The words the content widget bodies add around the owner's content
 * (metric, research, table, text). Values, units and dates stay as stored.
 */
export const notebookWidgetMessages = defineMessages({
	en: {
		/** The reason inside "unavailable (…)" (`commonMessages.unavailable`). */
		noValueRecorded: "no value recorded",
		up: "up",
		down: "down",
		unchanged: "unchanged",
		asOfNotStated: "as-of date not stated",
		/** "as of <date>", the date being a `<time>` element. */
		asOf: (date: JSX.Element): JSX.Element => <>as of {date}</>,
		researchGone: "This research result is no longer available.",
		tableCaption: (columns: number, rows: number) => `${columns} columns, ${rows} rows`,
		editNote: "Edit note",
	},
	ja: {
		noValueRecorded: "値が記録されていません",
		up: "上昇",
		down: "下落",
		unchanged: "変化なし",
		asOfNotStated: "時点の記載なし",
		asOf: (date) => <>{date} 時点</>,
		researchGone: "このリサーチ結果はもう利用できません。",
		tableCaption: (columns, rows) => `${columns} 列、${rows} 行`,
		editNote: "メモを編集",
	},
});
