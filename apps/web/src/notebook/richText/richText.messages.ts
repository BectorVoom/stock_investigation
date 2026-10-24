import { defineMessages } from "@research/i18n";

/** The block types the "/" menu offers, in menu order. */
export type BlockOptionId =
	| "text"
	| "h1"
	| "h2"
	| "h3"
	| "bullet"
	| "numbered"
	| "todo"
	| "quote"
	| "code"
	| "divider";

interface BlockWords {
	readonly label: string;
	readonly hint: string;
}

const ENGLISH_BLOCKS: { readonly [B in BlockOptionId]: BlockWords } = {
	text: { label: "Text", hint: "Plain paragraph" },
	h1: { label: "Heading 1", hint: "Large section heading" },
	h2: { label: "Heading 2", hint: "Medium section heading" },
	h3: { label: "Heading 3", hint: "Small section heading" },
	bullet: { label: "Bulleted list", hint: "Dash list item" },
	numbered: { label: "Numbered list", hint: "Counted list item" },
	todo: { label: "To-do", hint: "Checkbox list item" },
	quote: { label: "Quote", hint: "Quoted paragraph" },
	code: { label: "Code", hint: "Fenced code block" },
	divider: { label: "Divider", hint: "Horizontal rule" },
};

const JAPANESE_BLOCKS: { readonly [B in BlockOptionId]: BlockWords } = {
	text: { label: "テキスト", hint: "通常の段落" },
	h1: { label: "見出し 1", hint: "大きな見出し" },
	h2: { label: "見出し 2", hint: "中くらいの見出し" },
	h3: { label: "見出し 3", hint: "小さな見出し" },
	bullet: { label: "箇条書き", hint: "記号付きの項目" },
	numbered: { label: "番号付きリスト", hint: "番号付きの項目" },
	todo: { label: "ToDo", hint: "チェックボックス付きの項目" },
	quote: { label: "引用", hint: "引用の段落" },
	code: { label: "コード", hint: "コードブロック" },
	divider: { label: "区切り線", hint: "水平線" },
};

/**
 * The rich-text editor's own words: toolbar, "/" block menu, link popover,
 * hints and accessible names. The note itself is the owner's content and is
 * never translated.
 */
export const richTextMessages = defineMessages({
	en: {
		loadingEditor: "Loading editor…",
		emptyHint: "Type # for headings, / for blocks, select text to format",
		characterCount: (count: number, max: number) => `${count} / ${max} characters`,
		/** A to-do checkbox's accessible name in the read view: its item's text. */
		todoItem: (text: string) => `To-do: ${text}`,
		/** A to-do checkbox's accessible name inside the editor. */
		toggleTodo: "Toggle to-do",
		blockLabel: (id: BlockOptionId): string => ENGLISH_BLOCKS[id].label,
		blockHint: (id: BlockOptionId): string => ENGLISH_BLOCKS[id].hint,
		invalidLink: "Use an http(s) or mailto link, without spaces.",
		formatting: "Formatting",
		bold: "Bold",
		italic: "Italic",
		strikethrough: "Strikethrough",
		code: "Code",
		link: "Link",
		insertBlock: "Insert block",
		noMatchingBlocks: "No matching blocks",
		editLink: "Edit link",
		linkUrl: "Link URL (http, https or mailto)",
		saveLink: "Save link",
		removeLink: "Remove link",
	},
	ja: {
		loadingEditor: "エディタを読み込み中…",
		emptyHint: "# で見出し、/ でブロック、テキストを選択して書式設定",
		characterCount: (count, max) => `${count} / ${max} 文字`,
		todoItem: (text) => `ToDo: ${text}`,
		toggleTodo: "ToDo の完了を切り替え",
		blockLabel: (id) => JAPANESE_BLOCKS[id].label,
		blockHint: (id) => JAPANESE_BLOCKS[id].hint,
		invalidLink: "http(s) または mailto のリンクを、空白を入れずに入力してください。",
		formatting: "書式",
		bold: "太字",
		italic: "斜体",
		strikethrough: "取り消し線",
		code: "コード",
		link: "リンク",
		insertBlock: "ブロックを挿入",
		noMatchingBlocks: "一致するブロックがありません",
		editLink: "リンクを編集",
		linkUrl: "リンクの URL（http、https または mailto）",
		saveLink: "リンクを保存",
		removeLink: "リンクを削除",
	},
});
