import { defineMessages } from "@research/i18n";
import type { ScheduleChoice } from "./tasksModel.ts";

const EN_CHOICES: { readonly [C in ScheduleChoice]: string } = {
	once: "Once",
	daily: "Daily",
	weekdays: "Weekdays (Mon–Fri)",
	weekly: "Weekly",
	monthly: "Monthly",
};

const JA_CHOICES: { readonly [C in ScheduleChoice]: string } = {
	once: "1 回のみ",
	daily: "毎日",
	weekdays: "平日（月〜金）",
	weekly: "毎週",
	monthly: "毎月",
};

/**
 * Scheduled tasks (ADR-0033): the Tasks page, the editor dialog and the
 * Home / Notebook widget. Task titles and questions are the owner's text;
 * backend names, model ids, zones, codes and amounts stay as they are. The
 * sentences the pure model builds are in `tasksModel.messages.ts`.
 */
export const tasksMessages = defineMessages({
	en: {
		/* ----- the Tasks page ----- */
		listTitle: "Scheduled tasks",
		/** The noun in "Loading scheduled tasks…". */
		tasksThing: "scheduled tasks",
		loadFailed: "Could not load the scheduled tasks.",
		newTask: "New task",
		counts: (active: number, maxActive: number, total: number, maxTasks: number) =>
			`${active} of ${maxActive} active · ${total} of ${maxTasks} tasks`,
		empty:
			"No scheduled tasks yet. A task asks a research question by itself — once, every day, on weekdays, weekly or monthly — and its answers collect in its own chat.",
		agentNote:
			"Each run uses the backend, model and effort saved in Settings → AI agent when it runs, and counts against the same hourly allowance as your own questions.",
		taskList: "Your scheduled tasks",
		question: "Question",
		openChat: "Open chat",
		openChatNamed: (title: string) => `Open the chat of ${title}`,
		fixInSettings: "Open Settings → AI agent",

		edit: "Edit",
		editNamed: (title: string) => `Edit ${title}`,
		pause: "Pause",
		pauseNamed: (title: string) => `Pause ${title}`,
		resume: "Resume",
		resumeNamed: (title: string) => `Resume ${title}`,
		runNow: "Run now",
		runNowNamed: (title: string) => `Run ${title} now`,
		delete: "Delete",
		deleteNamed: (title: string) => `Delete ${title}`,

		deleteTitle: (title: string) => `Delete ${title}?`,
		deleteBody: "The task stops running. Its chat and the answers in it stay.",
		deleteConfirm: "Delete task",
		notDeleted: "The task was not deleted.",

		created: (title: string) => `Created ${title}. Its chat holds every answer.`,
		saved: (title: string) => `Saved ${title}.`,
		paused: (title: string) => `Paused ${title}.`,
		resumed: (title: string) => `Resumed ${title}.`,
		runQueued: (title: string) => `Queued a run of ${title}. Its answer arrives in its chat.`,
		runReplayed: (title: string) =>
			`${title} is still on its last run, so no second run was queued.`,
		deleted: (title: string) => `Deleted ${title}. Its chat stays.`,
		notPaused: "The task was not paused.",
		notResumed: "The task was not resumed.",
		notRun: "The run was not queued.",

		/* ----- the widget ----- */
		openTasks: "Open Tasks",
		widgetEmpty: "No scheduled tasks yet. A task runs a research question on a schedule.",
		more: (count: number) => `${count} more`,
		tasksSummary: (active: number, total: number) => `${active} active of ${total}`,

		/* ----- the editor dialog ----- */
		newTaskHeading: "New task",
		editTaskHeading: "Edit task",
		titleField: "Title",
		questionField: "Question",
		questionHint: "Asked as a research question each time the task runs.",
		horizon: "Horizon",
		years: (years: number) => `${years} years`,
		markets: "Markets",
		japan: "Japan (JP)",
		unitedStates: "United States (US)",
		repeat: "Repeat",
		choice: (choice: ScheduleChoice): string => EN_CHOICES[choice],
		date: "Date",
		time: "Time",
		days: "Days",
		dayOfMonth: "Day of month",
		dayOfMonthHint: "A month without this day runs on its last day.",
		timeZone: "Time zone",
		timeZoneHint: (browserZone: string) =>
			`Your browser's time zone is ${browserZone}. The task keeps its own zone when you travel.`,
		consent: (amount: string, backend: string, model: string) =>
			`Allow this task to spend up to ${amount} per run on ${backend} ${model}`,
		defaultModel: "(default model)",
		agentSettingsFailed: "Could not load the AI agent settings.",
		beforeSave: "Before you can save this task",
		createTask: "Create task",
		saveTask: "Save task",
		notSaved: "The task was not saved.",
	},
	ja: {
		listTitle: "スケジュールされたタスク",
		tasksThing: "スケジュールされたタスク",
		loadFailed: "スケジュールされたタスクを読み込めませんでした。",
		newTask: "新しいタスク",
		counts: (active, maxActive, total, maxTasks) =>
			`有効 ${active} / ${maxActive} 件 · 全体 ${total} / ${maxTasks} 件`,
		empty:
			"スケジュールされたタスクはまだありません。タスクはリサーチの質問を 1 回だけ、毎日、平日、毎週、または毎月、自動で実行し、回答はタスク専用のチャットにたまります。",
		agentNote:
			"各実行には、実行時点で設定 → AI エージェントに保存されているバックエンド、モデル、作業量が使われ、自分の質問と同じ 1 時間あたりの実行回数に数えられます。",
		taskList: "スケジュールされたタスクの一覧",
		question: "質問",
		openChat: "チャットを開く",
		openChatNamed: (title) => `${title} のチャットを開く`,
		fixInSettings: "設定 → AI エージェントを開く",

		edit: "編集",
		editNamed: (title) => `${title} を編集`,
		pause: "一時停止",
		pauseNamed: (title) => `${title} を一時停止`,
		resume: "再開",
		resumeNamed: (title) => `${title} を再開`,
		runNow: "今すぐ実行",
		runNowNamed: (title) => `${title} を今すぐ実行`,
		delete: "削除",
		deleteNamed: (title) => `${title} を削除`,

		deleteTitle: (title) => `${title} を削除しますか？`,
		deleteBody: "タスクは実行されなくなります。チャットとその中の回答は残ります。",
		deleteConfirm: "タスクを削除",
		notDeleted: "タスクを削除できませんでした。",

		created: (title) => `${title} を作成しました。回答はすべてタスクのチャットに届きます。`,
		saved: (title) => `${title} を保存しました。`,
		paused: (title) => `${title} を一時停止しました。`,
		resumed: (title) => `${title} を再開しました。`,
		runQueued: (title) => `${title} の実行を予約しました。回答はタスクのチャットに届きます。`,
		runReplayed: (title) =>
			`${title} は前回の実行がまだ終わっていないため、新たな実行は予約していません。`,
		deleted: (title) => `${title} を削除しました。チャットは残ります。`,
		notPaused: "タスクを一時停止できませんでした。",
		notResumed: "タスクを再開できませんでした。",
		notRun: "実行を予約できませんでした。",

		openTasks: "タスクを開く",
		widgetEmpty:
			"スケジュールされたタスクはまだありません。タスクはリサーチの質問を予定どおりに実行します。",
		more: (count) => `ほかに ${count} 件`,
		tasksSummary: (active, total) => `有効 ${active} 件 / 全 ${total} 件`,

		newTaskHeading: "新しいタスク",
		editTaskHeading: "タスクを編集",
		titleField: "タイトル",
		questionField: "質問",
		questionHint: "タスクが実行されるたびに、リサーチの質問として送られます。",
		horizon: "期間",
		years: (years) => `${years} 年`,
		markets: "市場",
		japan: "日本（JP）",
		unitedStates: "米国（US）",
		repeat: "繰り返し",
		choice: (choice) => JA_CHOICES[choice],
		date: "日付",
		time: "時刻",
		days: "曜日",
		dayOfMonth: "日にち",
		dayOfMonthHint: "その日がない月は、月の最終日に実行します。",
		timeZone: "タイムゾーン",
		timeZoneHint: (browserZone) =>
			`ブラウザのタイムゾーンは ${browserZone} です。移動してもタスクは自分のタイムゾーンを保ちます。`,
		consent: (amount, backend, model) =>
			`このタスクが ${backend} ${model} で 1 回の実行につき ${amount} まで支出することを許可します`,
		defaultModel: "（既定のモデル）",
		agentSettingsFailed: "AI エージェントの設定を読み込めませんでした。",
		beforeSave: "このタスクを保存する前に",
		createTask: "タスクを作成",
		saveTask: "タスクを保存",
		notSaved: "タスクを保存できませんでした。",
	},
});
