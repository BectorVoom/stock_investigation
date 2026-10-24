import { defineMessages } from "@research/i18n";

/** Japanese names of the job states the server reports (`ResearchRun["state"]`, plus "queued"). */
const JAPANESE_STATES: Readonly<Record<string, string>> = {
	queued: "登録済み",
	pending: "待機中",
	claimed: "受付済み",
	planning: "計画中",
	collecting: "収集中",
	analyzing: "分析中",
	verifying: "検証中",
	publishing: "公開中",
	completed: "完了",
	failed: "失敗",
	cancelled: "キャンセル済み",
	partial: "一部完了",
	waiting_approval: "承認待ち",
};

/**
 * A run's state as every page names it (run cards, Home, Watchlist and
 * Sources refresh lines). English shows the stored value itself, as before;
 * a state this table does not know is shown as stored.
 */
export const runStateMessages = defineMessages({
	en: {
		name: (state: string): string => state,
	},
	ja: {
		name: (state) => JAPANESE_STATES[state] ?? state,
	},
});
