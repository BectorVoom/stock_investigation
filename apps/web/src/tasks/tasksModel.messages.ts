import type { TaskSkipCode } from "@research/contracts";
import type { ScheduleWeekday } from "@research/domain";
import { defineMessages } from "@research/i18n";

const EN_WEEKDAYS: { readonly [D in ScheduleWeekday]: string } = {
	0: "Sun",
	1: "Mon",
	2: "Tue",
	3: "Wed",
	4: "Thu",
	5: "Fri",
	6: "Sat",
};

const JA_WEEKDAYS: { readonly [D in ScheduleWeekday]: string } = {
	0: "日",
	1: "月",
	2: "火",
	3: "水",
	4: "木",
	5: "金",
	6: "土",
};

/** Why an occurrence was skipped (ADR-0033 §3), in the owner's words. */
const EN_SKIP_REASONS: { readonly [C in TaskSkipCode]: string } = {
	RATE_LIMITED: "the hourly run allowance or the limit of unfinished runs was reached.",
	AGENT_NOT_CONFIGURED: "no AI backend is saved in Settings.",
	VALIDATION_FAILED: "the saved AI backend needs a model.",
	SPEND_CONSENT_REQUIRED:
		"the saved AI backend bills per use, and this task has no matching spend consent.",
	UNKNOWN_AGENT: "the saved AI backend is not one the runner offers.",
	NOT_FOUND: "the task's chat no longer exists.",
};

const JA_SKIP_REASONS: { readonly [C in TaskSkipCode]: string } = {
	RATE_LIMITED: "1 時間あたりの実行回数、または未完了の実行数の上限に達しました。",
	AGENT_NOT_CONFIGURED: "設定に AI バックエンドが保存されていません。",
	VALIDATION_FAILED: "保存されている AI バックエンドにはモデルの指定が必要です。",
	SPEND_CONSENT_REQUIRED:
		"保存されている AI バックエンドは従量課金で、このタスクには一致する支出の同意がありません。",
	UNKNOWN_AGENT: "保存されている AI バックエンドはランナーが提供していません。",
	NOT_FOUND: "タスクのチャットがもう存在しません。",
};

/** What fixes a skip: a sentence, and whether its fix lives in Settings → AI agent. */
const EN_SKIP_FIXES: { readonly [C in TaskSkipCode]: string } = {
	RATE_LIMITED: "It runs again at its next time.",
	AGENT_NOT_CONFIGURED: "Choose a backend in Settings → AI agent.",
	VALIDATION_FAILED: "Choose a model in Settings → AI agent.",
	SPEND_CONSENT_REQUIRED:
		"Edit the task to allow the spend, or choose a plan-limited backend in Settings → AI agent.",
	UNKNOWN_AGENT: "Choose an available backend in Settings → AI agent.",
	NOT_FOUND: "Delete the task, or create it again.",
};

const JA_SKIP_FIXES: { readonly [C in TaskSkipCode]: string } = {
	RATE_LIMITED: "次の予定時刻にまた実行されます。",
	AGENT_NOT_CONFIGURED: "設定 → AI エージェントでバックエンドを選んでください。",
	VALIDATION_FAILED: "設定 → AI エージェントでモデルを選んでください。",
	SPEND_CONSENT_REQUIRED:
		"タスクを編集して支出を許可するか、設定 → AI エージェントで定額制のバックエンドを選んでください。",
	UNKNOWN_AGENT: "設定 → AI エージェントで利用できるバックエンドを選んでください。",
	NOT_FOUND: "タスクを削除するか、作り直してください。",
};

/**
 * The sentences the pure tasks model builds (`tasksModel.ts`): schedules in
 * words, next-run and last-run lines, skip reasons with their fix, and the
 * editor's problems. Times stay `HH:MM`; dates `YYYY-MM-DD`.
 */
export const tasksModelMessages = defineMessages({
	en: {
		weekday: (day: ScheduleWeekday): string => EN_WEEKDAYS[day],
		scheduleOnce: (date: string, time: string) => `Once on ${date} at ${time}`,
		scheduleDaily: (time: string) => `Every day at ${time}`,
		scheduleWeekdays: (time: string) => `Weekdays at ${time}`,
		scheduleWeekly: (days: readonly string[], time: string) =>
			`Every ${days.join(", ")} at ${time}`,
		scheduleMonthly: (day: number, time: string) => `Monthly on day ${day} at ${time}`,
		/** A schedule or time in another zone than the browser's names that zone. */
		inZone: (text: string, zone: string) => `${text} (${zone})`,

		statusActive: "Active",
		statusPaused: "Paused",
		statusCompleted: "Completed",
		nextRunIn: (relative: string) => `Next run in ${relative}`,
		nextRunAt: (when: string) => `Next run ${when}`,
		lessThanMinute: "less than a minute",
		minutes: (minutes: number) => `${minutes} min`,
		hoursMinutes: (hours: number, minutes: number) =>
			minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`,
		dueNow: "Due now: it starts when the local runner next asks for work.",
		pausedLine: "Paused: it does not run until you resume it.",
		completedLine: "Completed: this one-time task has run.",

		notRunYet: "Not run yet",
		lastRun: (state: string) => `Last run: ${state}`,
		lastRunFailed: (state: string, code: string) => `Last run: ${state} (${code})`,

		skipped: (when: string) => `The run due ${when} was skipped:`,
		skipReason: (code: TaskSkipCode): string => EN_SKIP_REASONS[code],
		skipFix: (code: TaskSkipCode): string => EN_SKIP_FIXES[code],

		titleMissing: "Enter a title.",
		titleTooLong: (max: number) => `Shorten the title to ${max} characters or fewer.`,
		questionTooShort: (min: number) => `Write a question of at least ${min} characters.`,
		questionTooLong: (max: number) => `Shorten the question to ${max} characters or fewer.`,
		chooseMarket: "Choose at least one market.",
		chooseDay: "Choose at least one day of the week.",
		timeInvalid: "Enter a time as HH:MM (24 hours).",
		dateInvalid: "Enter a date.",
		dayOfMonthInvalid: "Enter a day of the month from 1 to 31.",
		zoneUnknown: "Enter a time zone such as Asia/Tokyo or America/New_York.",
		inPast: "Choose a date and time in the future.",
		agentsLoading: "Loading the AI agent settings…",
		confirmConsent: "Allow the spend below, or choose a plan-limited backend in Settings.",
		meteredNeedsSpend: (backend: string) =>
			`${backend} bills per use: set a maximum spend in Settings → AI agent first.`,

		tasksFull: (maxActive: number, maxTasks: number) =>
			`You have reached the limit of ${maxActive} active or ${maxTasks} tasks in all. Pause or delete a task first.`,
		scheduleInPast: "Its time has passed. Choose a date and time in the future.",
		taskCompleted: "This one-time task has already run. Edit its date and time to run it again.",
		versionConflict: "The task changed elsewhere. The list now shows the latest version.",
	},
	ja: {
		weekday: (day) => JA_WEEKDAYS[day],
		scheduleOnce: (date, time) => `1 回のみ ${date} ${time}`,
		scheduleDaily: (time) => `毎日 ${time}`,
		scheduleWeekdays: (time) => `平日 ${time}`,
		scheduleWeekly: (days, time) => `毎週 ${days.join("・")} ${time}`,
		scheduleMonthly: (day, time) => `毎月 ${day} 日 ${time}`,
		inZone: (text, zone) => `${text}（${zone}）`,

		statusActive: "有効",
		statusPaused: "一時停止中",
		statusCompleted: "完了",
		nextRunIn: (relative) => `次回の実行は ${relative}後`,
		nextRunAt: (when) => `次回の実行 ${when}`,
		lessThanMinute: "1 分以内",
		minutes: (minutes) => `${minutes} 分`,
		hoursMinutes: (hours, minutes) =>
			minutes === 0 ? `${hours} 時間` : `${hours} 時間 ${minutes} 分`,
		dueNow: "予定時刻です。ローカルのランナーが次に作業を取りに来たときに始まります。",
		pausedLine: "一時停止中です。再開するまで実行されません。",
		completedLine: "完了しました。この 1 回限りのタスクは実行済みです。",

		notRunYet: "まだ実行されていません",
		lastRun: (state) => `前回の実行: ${state}`,
		lastRunFailed: (state, code) => `前回の実行: ${state}（${code}）`,

		skipped: (when) => `${when} の実行はスキップされました:`,
		skipReason: (code) => JA_SKIP_REASONS[code],
		skipFix: (code) => JA_SKIP_FIXES[code],

		titleMissing: "タイトルを入力してください。",
		titleTooLong: (max) => `タイトルを ${max} 文字以内にしてください。`,
		questionTooShort: (min) => `質問を ${min} 文字以上で書いてください。`,
		questionTooLong: (max) => `質問を ${max} 文字以内にしてください。`,
		chooseMarket: "市場を 1 つ以上選んでください。",
		chooseDay: "曜日を 1 つ以上選んでください。",
		timeInvalid: "時刻を HH:MM（24 時間制）で入力してください。",
		dateInvalid: "日付を入力してください。",
		dayOfMonthInvalid: "日にちを 1〜31 で入力してください。",
		zoneUnknown: "Asia/Tokyo や America/New_York のようなタイムゾーンを入力してください。",
		inPast: "これから先の日付と時刻を選んでください。",
		agentsLoading: "AI エージェントの設定を読み込み中…",
		confirmConsent: "下の支出を許可するか、設定で定額制のバックエンドを選んでください。",
		meteredNeedsSpend: (backend) =>
			`${backend} は従量課金です。先に設定 → AI エージェントで上限金額を設定してください。`,

		tasksFull: (maxActive, maxTasks) =>
			`有効なタスク ${maxActive} 件、またはタスク全体 ${maxTasks} 件の上限に達しています。先にタスクを一時停止するか削除してください。`,
		scheduleInPast: "予定時刻が過ぎています。これから先の日付と時刻を選んでください。",
		taskCompleted:
			"この 1 回限りのタスクは実行済みです。もう一度実行するには日付と時刻を編集してください。",
		versionConflict: "タスクが別の場所で変更されました。一覧は最新の内容を表示しています。",
	},
});
