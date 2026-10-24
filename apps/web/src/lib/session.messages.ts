import { defineMessages } from "@research/i18n";

/** The notices an open workspace session leaves (`session.ts`). */
export const sessionMessages = defineMessages({
	en: {
		retryFailed: "The run could not be retried.",
		versionConflict:
			"The workspace changed since it was loaded (version conflict), so your change was not applied. The latest version has been reloaded — please repeat the action.",
		changeRejected: "The change was rejected and nothing was modified.",
		cancelFailed: "The run could not be cancelled.",
	},
	ja: {
		retryFailed: "実行を再試行できませんでした。",
		versionConflict:
			"読み込んだ後にワークスペースが変わったため（バージョンの競合）、変更は反映されませんでした。最新の版を再読み込みしました。もう一度操作してください。",
		changeRejected: "変更は拒否され、何も変更されていません。",
		cancelFailed: "実行をキャンセルできませんでした。",
	},
});
