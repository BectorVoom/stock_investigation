import { defineMessages } from "@research/i18n";

/**
 * What a new starter widget says before the owner edits it (`starterWidget`).
 * UI text in the language of the moment it is made; once saved it is the
 * owner's content and never rewritten.
 */
export const widgetModelMessages = defineMessages({
	en: {
		newNote: "New note",
		newMetric: "New metric",
		newChart: "New chart",
		firstSeries: "Series 1",
		newTable: "New table",
		labelColumn: "Label",
		valueColumn: "Value",
		exampleRow: "Example",
	},
	ja: {
		newNote: "新しいメモ",
		newMetric: "新しい数値",
		newChart: "新しいチャート",
		firstSeries: "系列 1",
		newTable: "新しい表",
		labelColumn: "ラベル",
		valueColumn: "値",
		exampleRow: "例",
	},
});
