import type { TaskResult } from "@research/contracts";
import { defineMessages } from "@research/i18n";

/** A run's recorded verification status. */
export type VerificationStatus = NonNullable<TaskResult["verificationStatus"]>;

/** A run's verification status (`ResearchRun["verificationStatus"]`) in the owner's words. */
const EN_VERIFICATION: { readonly [S in VerificationStatus]: string } = {
	verified: "Verified",
	"partially-verified": "Partially verified",
	unverified: "Unverified",
};

const JA_VERIFICATION: { readonly [S in VerificationStatus]: string } = {
	verified: "検証済み",
	"partially-verified": "一部検証済み",
	unverified: "未検証",
};

/**
 * The Task result widget (ADR-0038) and the dialog that adds one. Task
 * titles and answers are the owner's and the agent's text and stay as they
 * are; run states use the shared run-state words.
 */
export const taskResultMessages = defineMessages({
	en: {
		/* ----- the widget ----- */
		/** The noun in "Loading <thing>…". */
		resultThing: "the task's result",
		resultFailed: "Could not load this task's result.",
		verification: (status: VerificationStatus): string => EN_VERIFICATION[status],
		/** The status when the run recorded no verification. */
		verificationNotRecorded: "Verification not recorded",
		runningNow: (state: string) => `Running now (${state})`,
		noResultYet: "No result yet.",
		deleted: "This task was deleted. Remove this widget from its menu.",

		/* ----- the add dialog ----- */
		chooseHeading: "Choose a task",
		chooseIntro: "The widget shows the task's latest answer, when it ran and its verification.",
		chooseList: "Your scheduled tasks",
		noTasks: "You have no scheduled tasks yet. Create one on the Tasks page first.",
		openTasks: "Open Tasks",
	},
	ja: {
		resultThing: "タスクの結果",
		resultFailed: "このタスクの結果を読み込めませんでした。",
		verification: (status) => JA_VERIFICATION[status],
		verificationNotRecorded: "検証の記録なし",
		runningNow: (state) => `実行中（${state}）`,
		noResultYet: "まだ結果はありません。",
		deleted: "このタスクは削除されました。メニューからこのウィジェットを削除してください。",

		chooseHeading: "タスクを選択",
		chooseIntro: "ウィジェットにはタスクの最新の回答、実行日時、検証の状態が表示されます。",
		chooseList: "スケジュールされたタスクの一覧",
		noTasks: "スケジュールされたタスクはまだありません。先にタスクページで作成してください。",
		openTasks: "タスクを開く",
	},
});
