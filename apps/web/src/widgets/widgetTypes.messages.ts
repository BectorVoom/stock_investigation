import { WIDGET_TYPE_META, type WidgetType } from "@research/contracts";
import { defineMessages } from "@research/i18n";

/** The widget type names and the owner's descriptions in Japanese (English: `WIDGET_TYPE_META`). */
const JAPANESE_TYPES: {
	readonly [T in WidgetType]: { readonly label: string; readonly description: string };
} = {
	text: { label: "テキスト", description: "編集できるリッチテキスト。メモ、説明、要約に。" },
	metric: { label: "数値", description: "単位、変化、時点を添えた見出しの数値 1 つ。" },
	chart: { label: "チャート", description: "自身の系列データを持つ折れ線または棒チャート。" },
	table: { label: "表", description: "名前付きの列の下に並ぶ構造化された行。" },
	research: {
		label: "リサーチ結果",
		description:
			"このチャットのリサーチ要素（レポート、ニュースカード、情報源リスト）。検証バッジ付きで読み取り専用で表示します。",
	},
	"market-metric": {
		label: "市場の数値",
		description: "1 つの系列の最新値、変化、1 年間の変化とスパークライン。",
	},
	"line-chart": {
		label: "折れ線チャート",
		description: "単位が共通の 1〜4 系列を期間で表示し、データ表を添えます。",
	},
	"stock-table": {
		label: "銘柄表",
		description: "系列ごとに 1 行。直近の終値、変化、時点。",
	},
	"indicator-table": {
		label: "指標表",
		description: "系列ごとに 1 行。最新値、単位、前回値、変化、1 年間の変化。",
	},
	"earnings-calendar": {
		label: "決算カレンダー",
		description:
			"ウォッチリストの今後の決算発表日をひと目で見られる月表示と、直近の一覧。カレンダーの同期とエクスポートは設定にあります。",
	},
	"scheduled-tasks": {
		label: "スケジュールされたタスク",
		description:
			"スケジュールされたリサーチのタスクをひと目で確認: 次回の実行、最新の結果、一時停止と今すぐ実行。タスクの管理はタスクページで行います。",
	},
	"task-result": {
		label: "タスクの結果",
		description:
			"スケジュールされたタスク 1 つの最新の回答: 実行日時、検証の状態、回答の本文。チャットを開く、今すぐ実行も。",
	},
};

/**
 * Widget type names as the add menu and the editors show them, shared by
 * Home and the Notebook (ADR-0024). English reads the one shared table in
 * `@research/contracts`, so the two cannot drift.
 */
export const widgetTypeMessages = defineMessages({
	en: {
		typeLabel: (type: WidgetType): string => WIDGET_TYPE_META[type].label,
		typeDescription: (type: WidgetType): string => WIDGET_TYPE_META[type].description,
		/** The heading of the content editor and the market dialog in edit mode. */
		editWidget: (type: WidgetType): string =>
			`Edit ${WIDGET_TYPE_META[type].label.toLowerCase()} widget`,
		/** The market dialog's heading in add mode. */
		addWidget: (type: WidgetType): string =>
			`Add ${WIDGET_TYPE_META[type].label.toLowerCase()} widget`,
	},
	ja: {
		typeLabel: (type) => JAPANESE_TYPES[type].label,
		typeDescription: (type) => JAPANESE_TYPES[type].description,
		editWidget: (type) => `${JAPANESE_TYPES[type].label}ウィジェットを編集`,
		addWidget: (type) => `${JAPANESE_TYPES[type].label}ウィジェットを追加`,
	},
});
