import type { NotebookTurn } from "@research/contracts";
import { defineMessages } from "@research/i18n";

type ChangeKind = NotebookTurn["changes"][number]["kind"];

/**
 * A notebook-assistant turn in the thread (ADR-0032). Widget titles and the
 * before → after text are the notebook's content and stay as written.
 */
export const notebookTurnMessages = defineMessages({
	en: {
		change: (kind: ChangeKind, title: string): string =>
			`${
				{
					added: "Added",
					updated: "Updated",
					moved: "Moved",
					resized: "Resized",
					duplicated: "Duplicated",
				}[kind]
			} “${title}”`,
		showChanges: "Show changes",
		turn: (runId: string) => `Notebook changes for run ${runId}`,
		noChanges: "The assistant applied no changes.",
		changes: "Notebook changes",
		proposedRemovals: "Proposed removals",
		removeQuestion: (title: string) => `Remove “${title}”?`,
		keep: "Keep",
		undoing: "Undoing…",
	},
	ja: {
		change: (kind, title) =>
			`${
				{
					added: "追加",
					updated: "更新",
					moved: "移動",
					resized: "サイズ変更",
					duplicated: "複製",
				}[kind]
			}: 「${title}」`,
		showChanges: "変更を表示",
		turn: (runId) => `実行 ${runId} によるノートブックの変更`,
		noChanges: "アシスタントは変更を適用しませんでした。",
		changes: "ノートブックの変更",
		proposedRemovals: "削除の提案",
		removeQuestion: (title) => `「${title}」を削除しますか？`,
		keep: "残す",
		undoing: "取り消し中…",
	},
});
