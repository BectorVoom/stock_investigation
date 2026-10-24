import { defineMessages } from "@research/i18n";

/** "1 widget" / "2 widgets" in the clipboard announcements. */
function widgetCount(count: number): string {
	return `${count} widget${count === 1 ? "" : "s"}`;
}

/** The polite announcements after cut, copy, paste and remove, and the skipped-research notice. */
export const widgetClipboardMessages = defineMessages({
	en: {
		cutCount: (count: number) => `Cut ${widgetCount(count)}.`,
		copiedCount: (count: number) => `Copied ${widgetCount(count)}.`,
		pastedCount: (count: number) => `Pasted ${widgetCount(count)}.`,
		removedCount: (count: number) =>
			`Removed ${widgetCount(count)}. Undo restores ${count === 1 ? "it" : "them"}.`,
		skippedResearch: (skipped: number): string =>
			skipped === 1
				? "1 research result stays in its own chat and was not pasted."
				: `${skipped} research results stay in their own chat and were not pasted.`,
	},
	ja: {
		cutCount: (count) => `${count} 件のウィジェットを切り取りました。`,
		copiedCount: (count) => `${count} 件のウィジェットをコピーしました。`,
		pastedCount: (count) => `${count} 件のウィジェットを貼り付けました。`,
		removedCount: (count) =>
			`${count} 件のウィジェットを削除しました。「取り消す」で元に戻せます。`,
		skippedResearch: (skipped) =>
			`${skipped} 件のリサーチ結果は元のチャットにあるため、貼り付けませんでした。`,
	},
});
