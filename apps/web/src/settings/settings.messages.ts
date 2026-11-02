import { defineMessages } from "@research/i18n";

/** Settings: the category list, Export and import (`SettingsView.tsx`). */
export const settingsMessages = defineMessages({
	en: {
		/** The accessible name of the category list. */
		categoriesLabel: "Settings categories",
		exportTitle: "Export and import",
		exportIntro:
			"Exports are versioned and include citations. Imports are validated; an invalid file is rejected and changes nothing.",
		workspacesThing: "workspaces",
		workspaceToExport: "Workspace to export",
		exportHint: "JSON can be imported again; Markdown is for reading.",
		noWorkspaces: "No workspaces yet",
		chooseWorkspace: "Choose a workspace…",
		downloadJson: "Download JSON export",
		downloadMarkdown: "Download Markdown export",
		jsonExportFailed: "The JSON export failed.",
		markdownExportFailed: "The Markdown export failed.",
		importFile: "Import workspace file (JSON export)",
		importHint: "The file is added as a new workspace.",
		notImported: "The file was not imported.",
		fileTooLarge: (limit: number) => `The file is larger than the ${limit} byte import limit.`,
		fileNotJson: "The file is not valid JSON.",
		importedAs: (title: string) => `Imported as “${title}”.`,
		openImported: "Open imported workspace",
	},
	ja: {
		categoriesLabel: "設定の項目",
		exportTitle: "エクスポートとインポート",
		exportIntro:
			"エクスポートはバージョン付きで、出典を含みます。インポートは検証され、不正なファイルは拒否されて何も変更されません。",
		workspacesThing: "ワークスペース",
		workspaceToExport: "エクスポートするワークスペース",
		exportHint: "JSON は再インポートできます。Markdown は閲覧用です。",
		noWorkspaces: "ワークスペースはまだありません",
		chooseWorkspace: "ワークスペースを選択…",
		downloadJson: "JSON でエクスポート",
		downloadMarkdown: "Markdown でエクスポート",
		jsonExportFailed: "JSON のエクスポートに失敗しました。",
		markdownExportFailed: "Markdown のエクスポートに失敗しました。",
		importFile: "ワークスペースのファイルをインポート（JSON エクスポート）",
		importHint: "ファイルは新しいワークスペースとして追加されます。",
		notImported: "ファイルはインポートされませんでした。",
		fileTooLarge: (limit) => `ファイルがインポートの上限 ${limit} バイトを超えています。`,
		fileNotJson: "ファイルが有効な JSON ではありません。",
		importedAs: (title) => `「${title}」としてインポートしました。`,
		openImported: "インポートしたワークスペースを開く",
	},
});
