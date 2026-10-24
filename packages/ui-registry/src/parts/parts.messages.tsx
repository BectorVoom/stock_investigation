import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";

/** States every component shares: fallbacks, unavailable values and empty data. */
export const stateMessages = defineMessages({
	en: {
		unknownComponentType: "unknown component type",
		unsupportedSchemaVersion: "unsupported schema version",
		invalidProps: "invalid props",
		rendererFailed: "the renderer failed",
		cannotRender: (reason: string, componentType: string, schemaVersion: number | undefined) =>
			`Cannot render: ${reason} (component type "${componentType}"${schemaVersion === undefined ? "" : `, schema version ${schemaVersion}`}).`,
		dataUnavailable: (datasetRef: string) =>
			`Data unavailable — dataset "${datasetRef}" is not available in this workspace.`,
		/** A single missing value with the reason it is missing (never blank, never 0). */
		unavailable: (reason: string) => `N/A — ${reason}`,
	},
	ja: {
		unknownComponentType: "不明なコンポーネント種別",
		unsupportedSchemaVersion: "未対応のスキーマバージョン",
		invalidProps: "無効な props",
		rendererFailed: "描画処理の失敗",
		cannotRender: (reason, componentType, schemaVersion) =>
			`表示できません：${reason}（コンポーネント種別「${componentType}」${schemaVersion === undefined ? "" : `、スキーマバージョン ${schemaVersion}`}）。`,
		dataUnavailable: (datasetRef) =>
			`データを取得できません — データセット「${datasetRef}」はこのワークスペースにありません。`,
		unavailable: (reason) => `取得できません（${reason}）`,
	},
});

/** Claim type and verification status badges: words for the stored enum values. */
export const badgeMessages = defineMessages({
	en: {
		observation: "Observation",
		inference: "Inference",
		hypothesis: "Hypothesis",
		forecast: "Forecast",
		supported: "Supported",
		unsupported: "Unsupported",
		conflicting: "Conflicting evidence",
	},
	ja: {
		observation: "観察",
		inference: "推論",
		hypothesis: "仮説",
		forecast: "予測",
		supported: "裏付けあり",
		unsupported: "裏付けなし",
		conflicting: "根拠が矛盾",
	},
});

/** The dataset table's own words; column labels, units and values are the dataset's. */
export const datasetTableMessages = defineMessages({
	en: {
		select: "Select",
		selected: "Selected",
		selectRow: (row: number) => `Select row ${row}`,
		/** A sourced value's as-of date, placed in the sentence. */
		asOf: (date: JSX.Element): JSX.Element => <>as of {date}</>,
		asOfMissing: "as-of date not stated",
		noRows: "No rows — this dataset is empty.",
		basisAssumption: "assumption",
		basisDerived: "derived",
		basisUnstated: "unsourced — basis not stated",
	},
	ja: {
		select: "選択",
		selected: "選択中",
		selectRow: (row) => `${row} 行目を選択`,
		asOf: (date) => <>{date} 時点</>,
		asOfMissing: "時点の記載なし",
		noRows: "行がありません — このデータセットは空です。",
		basisAssumption: "仮定",
		basisDerived: "算出値",
		basisUnstated: "出典なし — 根拠の記載なし",
	},
});
