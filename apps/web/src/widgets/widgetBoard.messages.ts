import type { WidgetSize } from "@research/contracts";
import { defineMessages } from "@research/i18n";

const ENGLISH_SIZES: { readonly [S in WidgetSize]: string } = {
	small: "Small",
	medium: "Medium",
	large: "Large",
};

const JAPANESE_SIZES: { readonly [S in WidgetSize]: string } = {
	small: "小",
	medium: "中",
	large: "大",
};

/**
 * The shared widget board's words (ADR-0024): the per-widget menu, the
 * header buttons and the selection toolbar, the same on Home and in the
 * Notebook (Cut, Copy, Duplicate, Remove and Undo are `commonMessages`). A
 * widget's title is the owner's and is quoted, never translated.
 */
export const widgetBoardMessages = defineMessages({
	en: {
		edit: "Edit…",
		size: (size: WidgetSize) => `Size: ${ENGLISH_SIZES[size]}`,
		pasteAfter: "Paste after",
		moveEarlier: "Move earlier",
		moveLater: "Move later",
		actionsButton: (title: string) => `${title} actions`,
		actionsMenu: (title: string) => `Actions for ${title}`,
		pasteWidgets: "Paste widgets",
		addWidget: "Add widget",
		selectedWidgets: "Selected widgets",
		selectedCount: (count: number) => `${count} selected`,
		duplicateSelected: "Duplicate selected widgets",
		cutSelected: "Cut selected widgets",
		copySelected: "Copy selected widgets",
		removeSelected: "Remove selected widgets",
		clearSelection: "Clear selection",
		dismiss: "Dismiss",
	},
	ja: {
		edit: "編集…",
		size: (size) => `サイズ: ${JAPANESE_SIZES[size]}`,
		pasteAfter: "後ろに貼り付け",
		moveEarlier: "前へ移動",
		moveLater: "後ろへ移動",
		actionsButton: (title) => `「${title}」の操作`,
		actionsMenu: (title) => `「${title}」の操作メニュー`,
		pasteWidgets: "ウィジェットを貼り付け",
		addWidget: "ウィジェットを追加",
		selectedWidgets: "選択したウィジェット",
		selectedCount: (count) => `${count} 件を選択中`,
		duplicateSelected: "選択したウィジェットを複製",
		cutSelected: "選択したウィジェットを切り取り",
		copySelected: "選択したウィジェットをコピー",
		removeSelected: "選択したウィジェットを削除",
		clearSelection: "選択を解除",
		dismiss: "閉じる",
	},
});
