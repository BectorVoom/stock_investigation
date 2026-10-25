import { defineMessages } from "@research/i18n";
import { runStateMessages } from "../i18n/runState.messages.ts";

/** The Home page (`HomeView.tsx`): notices, the status line, toolbar and states. */
export const homeMessages = defineMessages({
	en: {
		dataNotRefreshed: "Market data did not refresh.",
		followUpQueued:
			"A series was added while the refresh ran, so one follow-up refresh was queued.",
		earningsAlreadyQueuing: "An earnings-date refresh is already being queued.",
		earningsNotQueued: (reason: string) => `The earnings-date refresh was not queued: ${reason}`,
		earningsQueued: "Earnings-date refresh queued for the local runner.",
		googleNotQueued: (reason: string) => `The Google Calendar sync was not queued: ${reason}`,
		staleQueued: "Market data is stale, so one refresh was queued.",
		marketAlreadyQueuing: "A market-data refresh is already being queued.",
		marketNotQueued: (reason: string) => `The market-data refresh was not queued: ${reason}`,
		marketQueued: "Market-data refresh queued for the local runner.",
		saveInFlight: "The dashboard is being saved; please try your change again in a moment.",
		changeRejected: (reason: string) => `The change was rejected: ${reason}.`,
		dashboardInvalid: "the dashboard is invalid",
		changedElsewhere:
			"The dashboard changed elsewhere; it was reloaded. Please try your change again.",
		notSaved: (reason: string) => `The dashboard was not saved: ${reason}`,
		newSeriesQueued: "New series have no data yet, so one refresh was queued.",
		resetDone: "The dashboard was reset to the default arrangement.",
		notReset: (reason: string) => `The dashboard was not reset: ${reason}`,
		refreshing: (state: string, runId: string) =>
			`Refreshing market data… (${state}, run ${runId}). It is fetched by the local runner; if the runner is offline it stays queued until the runner reconnects.`,
		lastSucceeded: (when: string) => `Last successful refresh: ${when}.`,
		/** `failure`: the code, with the service's status after it when one caused it (`withUpstreamStatus`). */
		lastFailed: (failure: string, when: string) => `Last refresh failed (${failure}) at ${when}.`,
		noRefreshYet: "No market-data refresh has completed yet.",
		dataFailedToLoad: "Market data failed to load.",
		loadingDataLabel: "Loading market data",
		loadingData: "Loading market data…",
		widgetsLabel: "Home widgets",
		dataLoadFailed: "Could not load market data.",
		toolbarLabel: "Market widgets toolbar",
		refreshData: "Refresh market data",
		resetArrangement: "Reset to default arrangement",
		loadingHomeLabel: "Loading home",
		loadingWidgets: "Loading market widgets…",
		dashboardErrorLabel: "Dashboard error",
		dashboardLoadFailed: "Could not load the dashboard.",
		empty: "No widgets yet. Use the + button to add one.",
		changeExplainer:
			"Change compares the latest observation with the one before it; 1-year change compares with the observation nearest to one year earlier.",
	},
	ja: {
		dataNotRefreshed: "市場データを更新できませんでした。",
		followUpQueued: "更新中に系列が追加されたため、追加の更新を1回登録しました。",
		earningsAlreadyQueuing: "決算発表日の更新はすでに登録処理中です。",
		earningsNotQueued: (reason) => `決算発表日の更新を登録できませんでした：${reason}`,
		earningsQueued: "決算発表日の更新をローカルのランナーに登録しました。",
		googleNotQueued: (reason) => `Google Calendar の同期を登録できませんでした：${reason}`,
		staleQueued: "市場データが古いため、更新を1回登録しました。",
		marketAlreadyQueuing: "市場データの更新はすでに登録処理中です。",
		marketNotQueued: (reason) => `市場データの更新を登録できませんでした：${reason}`,
		marketQueued: "市場データの更新をローカルのランナーに登録しました。",
		saveInFlight: "ダッシュボードを保存中です。少し待ってから、もう一度変更してください。",
		changeRejected: (reason) => `変更は受け付けられませんでした：${reason}。`,
		dashboardInvalid: "ダッシュボードが無効です",
		changedElsewhere:
			"ダッシュボードが別の場所で変更されたため、再読み込みしました。もう一度変更してください。",
		notSaved: (reason) => `ダッシュボードを保存できませんでした：${reason}`,
		newSeriesQueued: "新しい系列にまだデータがないため、更新を1回登録しました。",
		resetDone: "ダッシュボードを既定の配置に戻しました。",
		notReset: (reason) => `ダッシュボードを既定の配置に戻せませんでした：${reason}`,
		refreshing: (state, runId) =>
			`市場データを更新中…（${runStateMessages.ja.name(state)}、実行 ${runId}）。ローカルのランナーが取得します。ランナーがオフラインの場合は、再接続するまで登録済みのまま待機します。`,
		lastSucceeded: (when) => `前回の更新成功：${when}。`,
		lastFailed: (failure, when) => `前回の更新は ${when} に失敗しました（${failure}）。`,
		noRefreshYet: "市場データの更新はまだ完了していません。",
		dataFailedToLoad: "市場データの読み込みに失敗しました。",
		loadingDataLabel: "市場データを読み込み中",
		loadingData: "市場データを読み込み中…",
		widgetsLabel: "ホームのウィジェット",
		dataLoadFailed: "市場データを読み込めませんでした。",
		toolbarLabel: "市場ウィジェットのツールバー",
		refreshData: "市場データを更新",
		resetArrangement: "既定の配置に戻す",
		loadingHomeLabel: "ホームを読み込み中",
		loadingWidgets: "市場ウィジェットを読み込み中…",
		dashboardErrorLabel: "ダッシュボードのエラー",
		dashboardLoadFailed: "ダッシュボードを読み込めませんでした。",
		empty: "ウィジェットはまだありません。+ ボタンで追加してください。",
		changeExplainer:
			"前回比は最新の観測値を一つ前の観測値と比べます。1年前比は約1年前に最も近い観測値と比べます。",
	},
});

/** Home's "Reset to default arrangement" confirmation (`ResetDialog.tsx`). */
export const resetDialogMessages = defineMessages({
	en: {
		title: "Reset to the default arrangement",
		body: "This replaces every widget with the default arrangement. Undo restores the widgets you had until you leave this page.",
		confirm: "Reset widgets",
	},
	ja: {
		title: "既定の配置に戻す",
		body: "すべてのウィジェットを既定の配置に置き換えます。このページを離れるまでは「取り消す」で元のウィジェットに戻せます。",
		confirm: "既定に戻す",
	},
});
