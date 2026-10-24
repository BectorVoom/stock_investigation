import { NOTEBOOK_LIMITS, type NotebookCapacityProblem } from "@research/contracts";
import { defineMessages } from "@research/i18n";

/** The Notebook panel's own words (the widget actions are the shared board's). */
export const notebookPanelMessages = defineMessages({
	en: {
		notebook: "Notebook",
		askAi: "Ask AI",
		goToSource: "Go to source",
		dismiss: "Dismiss",
		askAboutSelected: "Ask AI about the selected widgets",
		/** The noun of "Loading notebook…". */
		loadingLabel: "notebook",
		loadFailed: "Could not load the notebook.",
		empty: "Save answers, charts and tables from Chat to build your notebook.",
	},
	ja: {
		notebook: "ノートブック",
		askAi: "AI に質問",
		goToSource: "元のメッセージへ移動",
		dismiss: "閉じる",
		askAboutSelected: "選択したウィジェットについて AI に質問",
		loadingLabel: "ノートブック",
		loadFailed: "ノートブックを読み込めませんでした。",
		empty: "チャットの回答、チャート、表を保存すると、ここにノートブックができます。",
	},
});

type CapacityCode = NotebookCapacityProblem["code"];

/** A failed API call: its stable code and the server's English message. */
interface Failure {
	readonly code: string;
	readonly message: string;
}

const JAPANESE_CAPACITY: { readonly [C in CapacityCode]: string } = {
	TOO_MANY_WIDGETS: `ノートブックに入れられるウィジェットは ${NOTEBOOK_LIMITS.maxWidgets} 個までです。追加する前に 1 つ削除してください。`,
	TOO_MANY_SERIES: `ノートブックの市場ウィジェットで使える系列は ${NOTEBOOK_LIMITS.maxMarketSeries} 個までです。追加する前に系列を 1 つ削除してください。`,
	NOTEBOOK_TOO_LARGE: `ノートブックのウィジェットの内容は ${Math.floor(NOTEBOOK_LIMITS.maxContentBytes / 1000)} KB までです。先にウィジェットを削除するか、大きな表、チャート、テキストを短くしてください。`,
};

/**
 * The notebook session's notices. English shows the server's message after
 * the sentence, as before; Japanese names the stable error code instead (the
 * notice's failure keeps the server's English message for diagnosis).
 */
export const notebookSessionMessages = defineMessages({
	en: {
		conflict: "The notebook changed elsewhere; showing the latest version.",
		notSaved: (failure: Failure) => `The notebook was not saved: ${failure.message}`,
		notRestored: (failure: Failure) => `The notebook was not restored: ${failure.message}`,
		/** A capacity refusal before saving; English is the contract's own sentence. */
		capacity: (problem: NotebookCapacityProblem): string => problem.message,
	},
	ja: {
		conflict: "ノートブックがほかの場所で変更されたため、最新の内容を表示しています。",
		notSaved: (failure) => `ノートブックを保存できませんでした（${failure.code}）。`,
		notRestored: (failure) => `ノートブックを元に戻せませんでした（${failure.code}）。`,
		capacity: (problem) => JAPANESE_CAPACITY[problem.code],
	},
});

/** What a widget saved from Chat is called when its answer gives nothing to use. */
export const notebookModelMessages = defineMessages({
	en: {
		answerTitle: "Answer",
		emptyAnswer: "(empty answer)",
	},
	ja: {
		answerTitle: "回答",
		emptyAnswer: "（空の回答）",
	},
});
