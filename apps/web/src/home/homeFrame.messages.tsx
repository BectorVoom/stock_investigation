import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";

/** The provenance lines under Home's market widgets (`HomeFrame.tsx`). */
export const homeFrameMessages = defineMessages({
	en: {
		/** "as of <date>", the date being a `<time>` element. */
		asOf: (date: JSX.Element): JSX.Element => <>as of {date}</>,
		asOfNotStated: "as-of date not stated",
		/** "retrieved <instant>", the instant being text or a "not stated" element. */
		retrieved: (when: JSX.Element): JSX.Element => <>retrieved {when}</>,
		notStated: "not stated",
		sourceNotStated: "source not stated",
		/** A line chart's provenance line starts with the series name. */
		seriesLabel: (title: string) => `${title}: `,
	},
	ja: {
		asOf: (date) => <>{date} 時点</>,
		asOfNotStated: "時点の記載なし",
		retrieved: (when) => <>取得日時 {when}</>,
		notStated: "記載なし",
		sourceNotStated: "出典の記載なし",
		seriesLabel: (title) => `${title}：`,
	},
});
