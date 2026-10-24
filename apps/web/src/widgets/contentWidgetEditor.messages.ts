import { defineMessages } from "@research/i18n";

/**
 * The content-widget editor (text, metric, chart, table, research), the same
 * on Home and in the Notebook (ADR-0024). Series names and labels quoted in
 * a problem are the owner's text, shown as written.
 */
export const contentWidgetEditorMessages = defineMessages({
	en: {
		problems: "Problems",
		notSaved: "The widget was not saved. The notice above the widgets says why.",
		title: "Title",
		sizeOf: (title: string) => `Size of “${title}”`,
		textMarkdown: "Text (Markdown)",
		markdownHint:
			"Markdown: # / ## / ### headings, **bold**, *italic*, ~~strike~~, `code`, [label](https://…) links, - bullets, 1. numbered, - [ ] to-dos, > quotes, ``` code blocks, --- dividers.",
		valueLabel: "Value (empty means unavailable)",
		valueField: "Value",
		unit: "Unit",
		changeLabel: "Change (empty means unknown)",
		changeField: "Change",
		caption: "Caption",
		asOfLabel: "As-of date (YYYY-MM-DD, empty means unstated)",
		notANumber: (field: string) => `${field}: enter a number or leave it empty.`,
		chartType: "Chart type",
		line: "Line",
		bar: "Bar",
		seriesLabel: "Series (one block per series: the name, then “label, value” lines)",
		seriesNameMissing: (block: number) =>
			`Series ${block}: give the series a name on its first line.`,
		seriesLineNoComma: (name: string, line: number) =>
			`Series "${name}" line ${line}: use "label, value".`,
		seriesLineNotNumber: (name: string, line: number) =>
			`Series "${name}" line ${line}: use "label, value" with a number.`,
		seriesNoPoints: (name: string) => `Series "${name}": add at least one "label, value" line.`,
		seriesNone: 'Series: add one block per series: the name, then "label, value" lines.',
		columnsLabel: "Columns (comma-separated)",
		rowsLabel: "Rows (one line per row, comma-separated)",
		columnsNone: "Columns: list at least one column name, separated by commas.",
		rowCellCount: (row: number, needed: number, found: number) =>
			`Row ${row}: needs ${needed} cells, has ${found}.`,
		researchReadOnly: "Research content is read-only; only the title and size can be changed here.",
		saveWidget: "Save widget",
	},
	ja: {
		problems: "問題",
		notSaved:
			"ウィジェットを保存できませんでした。理由はウィジェットの上のお知らせに表示されています。",
		title: "タイトル",
		sizeOf: (title) => `「${title}」のサイズ`,
		textMarkdown: "テキスト（Markdown）",
		markdownHint:
			"Markdown: # / ## / ### 見出し、**太字**、*斜体*、~~取り消し線~~、`コード`、[ラベル](https://…) リンク、- 箇条書き、1. 番号付き、- [ ] ToDo、> 引用、``` コードブロック、--- 区切り線。",
		valueLabel: "値（空欄は取得できない値）",
		valueField: "値",
		unit: "単位",
		changeLabel: "変化（空欄は不明）",
		changeField: "変化",
		caption: "説明",
		asOfLabel: "時点の日付（YYYY-MM-DD、空欄は未記載）",
		notANumber: (field) => `${field}: 数値を入力するか、空欄にしてください。`,
		chartType: "チャートの種類",
		line: "折れ線",
		bar: "棒",
		seriesLabel: "系列（系列ごとに 1 ブロック: 1 行目に名前、続けて「ラベル, 値」の行）",
		seriesNameMissing: (block) => `系列 ${block}: 1 行目に系列の名前を入力してください。`,
		seriesLineNoComma: (name, line) =>
			`系列「${name}」の ${line} 行目: 「ラベル, 値」の形で入力してください。`,
		seriesLineNotNumber: (name, line) =>
			`系列「${name}」の ${line} 行目: 値を数値にした「ラベル, 値」の形で入力してください。`,
		seriesNoPoints: (name) => `系列「${name}」: 「ラベル, 値」の行を 1 行以上追加してください。`,
		seriesNone:
			"系列: 系列ごとに 1 ブロックを入力してください（1 行目に名前、続けて「ラベル, 値」の行）。",
		columnsLabel: "列（カンマ区切り）",
		rowsLabel: "行（1 行に 1 行分、カンマ区切り）",
		columnsNone: "列: 列の名前をカンマで区切って 1 つ以上入力してください。",
		rowCellCount: (row, needed, found) =>
			`${row} 行目: セルが ${needed} 個必要ですが、${found} 個です。`,
		researchReadOnly:
			"リサーチの内容は読み取り専用です。ここで変更できるのはタイトルとサイズだけです。",
		saveWidget: "ウィジェットを保存",
	},
});
