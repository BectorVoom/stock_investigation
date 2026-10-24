import type { ResearchRun } from "@research/contracts";
import { defineMessages } from "@research/i18n";

type RunState = ResearchRun["state"];

/**
 * A research run as the thread shows it (ADR-0032): the state badge, the
 * spoken state change, hints after a failure and the approval form. The
 * stored state values and failure codes are never translated; English shows
 * the state value itself, as before. Progress lines come from the runner and
 * stay as written.
 */
export const runMessages = defineMessages({
	en: {
		/** The concise spoken form of a run's state for the conversation status region. */
		announcement: (state: RunState, failureCode: string | null): string => {
			switch (state) {
				case "pending":
					return "Question queued. Waiting for a runner to claim it.";
				case "claimed":
					return "A runner claimed the question.";
				case "planning":
					return "Planning the research…";
				case "collecting":
					return "Collecting evidence…";
				case "analyzing":
					return "Analyzing the evidence…";
				case "verifying":
					return "Verifying the findings…";
				case "publishing":
					return "Publishing the answer…";
				case "completed":
					return "Completed: answer added.";
				case "failed":
					return `Failed: ${failureCode ?? "reason not stated"}.`;
				case "cancelled":
					return "Cancelled.";
				case "partial":
					return "Stopped early with partial results.";
				case "waiting_approval":
					return "Waiting for approval.";
			}
		},
		noToolWebOff:
			"The assistant found no tool that fits this question. If web access is off in Settings, turn it on so it can search the web.",
		noTool:
			"The assistant found no tool that fits this question. Try naming a company, ticker or topic.",
		toolsReturnedNothing:
			"The tools ran but found nothing on this question. Try naming a company, ticker or topic.",
		planNotJson:
			"The model's plan could not be read. Try again or choose another model in Settings.",
		providerUnavailable:
			"The model's provider is overloaded or could not be reached. Retry in a few minutes, or choose another model in Settings.",
		providerRateLimited:
			"The model's provider is limiting requests (free models have per-minute and daily limits). Retry later, or choose another model in Settings.",
		providerRefused:
			"The model declined to answer this question. Rephrase it, or choose another model in Settings.",
		approveRun: (runId: string) => `Approve run ${runId}`,
		approvalRequested: "Approval requested: ",
		reasonNotStated: "reason not stated",
		approveAndResume: "Approve and resume",
		notApproved: "The run was not approved.",
		run: (runId: string) => `Run ${runId}`,
		stop: "Stop",
		cancelRequested: "Cancellation requested — waiting for the runner to stop.",
		queued: "Queued — waiting for a runner to claim it.",
		runnerWorking: "A runner is working on this.",
		stoppedEarly: "Stopped early: ",
		failureCode: "Failure code: ",
		retryRun: "Retry run",
	},
	ja: {
		announcement: (state, failureCode) => {
			switch (state) {
				case "pending":
					return "質問をキューに追加しました。ランナーが受け取るのを待っています。";
				case "claimed":
					return "ランナーが質問を受け取りました。";
				case "planning":
					return "リサーチを計画中…";
				case "collecting":
					return "根拠を収集中…";
				case "analyzing":
					return "根拠を分析中…";
				case "verifying":
					return "調査結果を検証中…";
				case "publishing":
					return "回答を公開中…";
				case "completed":
					return "完了: 回答を追加しました。";
				case "failed":
					return `失敗: ${failureCode ?? "理由の記載なし"}。`;
				case "cancelled":
					return "キャンセルしました。";
				case "partial":
					return "一部の結果で途中停止しました。";
				case "waiting_approval":
					return "承認待ちです。";
			}
		},
		noToolWebOff:
			"アシスタントはこの質問に合うツールを見つけられませんでした。設定でウェブアクセスがオフの場合は、ウェブを検索できるようオンにしてください。",
		noTool:
			"アシスタントはこの質問に合うツールを見つけられませんでした。企業名、ティッカー、トピックを挙げてみてください。",
		toolsReturnedNothing:
			"ツールは実行されましたが、この質問について何も見つかりませんでした。企業名、ティッカー、トピックを挙げてみてください。",
		planNotJson:
			"モデルの計画を読み取れませんでした。再試行するか、設定で別のモデルを選んでください。",
		providerUnavailable:
			"モデルのプロバイダーが混雑しているか、接続できませんでした。数分後に再試行するか、設定で別のモデルを選んでください。",
		providerRateLimited:
			"モデルのプロバイダーがリクエストを制限しています（無料モデルには 1 分あたりと 1 日あたりの上限があります）。時間をおいて再試行するか、設定で別のモデルを選んでください。",
		providerRefused:
			"モデルがこの質問への回答を断りました。質問を言い換えるか、設定で別のモデルを選んでください。",
		approveRun: (runId) => `実行 ${runId} を承認`,
		approvalRequested: "承認が必要です: ",
		reasonNotStated: "理由の記載なし",
		approveAndResume: "承認して再開",
		notApproved: "実行を承認できませんでした。",
		run: (runId) => `実行 ${runId}`,
		stop: "停止",
		cancelRequested: "キャンセルを要求しました。ランナーの停止を待っています。",
		queued: "キュー待ち — ランナーが受け取るのを待っています。",
		runnerWorking: "ランナーが処理しています。",
		stoppedEarly: "途中で停止: ",
		failureCode: "失敗コード: ",
		retryRun: "実行を再試行",
	},
});
