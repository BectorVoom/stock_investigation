import type { AgentSettings } from "@research/contracts";
import { defineMessages } from "@research/i18n";

type Effort = AgentSettings["effort"];

/**
 * The question form (ADR-0032): its controls, the reasons it cannot send yet
 * (`composerModel.ts` takes these as a parameter) and its notes after a send.
 * Backend names, model ids, market codes and amounts stay as they are.
 */
export const composerMessages = defineMessages({
	en: {
		questionTooShort: "Enter a research question (at least 3 characters).",
		questionTooLong: "The question must be at most 2000 characters.",
		agentsLoading: "Agent backends are still loading.",
		chooseBackend: "Choose a default agent backend in Settings → AI agent.",
		backendUnusable: (backend: string, status: string) =>
			`${backend} is ${status} and cannot be used — choose another backend in Settings → AI agent.`,
		openCodeNeedsModel:
			"OpenCode needs a model of the form provider/model — choose one in Settings → AI agent.",
		openRouterNeedsModel:
			"OpenRouter (free models) needs a model — choose one in Settings → AI agent.",
		chooseMarket: "Choose at least one market (JP or US).",
		settingsLoading: "Agent settings are still loading.",
		meteredNeedsSpend:
			"A metered backend needs a maximum spend greater than 0 USD — set it in Settings → AI agent.",
		maxSpendRange: (max: number) =>
			`Max spend must be greater than 0 and at most ${max} USD — fix it in Settings → AI agent.`,
		confirmConsent: "Confirm consent to metered spend on the form itself.",

		notebookNeedsBackend: "The notebook assistant needs an agent backend.",
		notebookOneAtATime: "One notebook request runs at a time. Wait for it to finish and try again.",
		questionQueued: "Question queued. It starts when a runner claims it.",
		/** `state` is the run state as the run card words it. */
		questionSubmitted: (state: string) => `Question submitted (run is ${state}).`,
		instructionEmpty: "Enter an instruction for the notebook assistant.",
		instructionTooLong: "The instruction must be at most 2000 characters.",
		instructionQueued: "Instruction queued. The notebook assistant starts when a runner claims it.",
		instructionSubmitted: (state: string) => `Instruction submitted (run is ${state}).`,

		backendDefault: "backend default",
		effort: (effort: Effort): string => effort,
		summaryLine: (backend: string, model: string, effort: string, webAccess: boolean) =>
			`${backend} · ${model} · ${effort} · web access ${webAccess ? "on" : "off"}`,
		consent: "I consent to metered spend for this question",
		consentUpTo: (amount: string) => `I consent to metered spend up to ${amount} for this question`,
		noMarkets: "no markets",
		optionsSummary: (years: number, markets: string) => `${years} years · ${markets}`,
		options: (summary: string) => `Options: ${summary}`,
		sending: "Sending…",
		sendInstruction: "Send instruction",
		sendQuestion: "Send question",
		notebookComposer: "Notebook composer",
		researchComposer: "Research composer",
		openAgentSettings: "Open Settings → AI agent",
		wholeNotebook: "About the whole notebook",
		selectedWidgets: "Selected widgets",
		removeFromSelection: (title: string) => `Remove ${title} from selection`,
		chooseMode: "Choose mode",
		composerMode: "Composer mode",
		research: "Research",
		notebook: "Notebook",
		leaveNotebookMode: "Leave Notebook mode",
		instruction: "Instruction",
		question: "Question",
		askNotebook: "Ask the notebook assistant…",
		askResearch: "Ask a research question…",
		agentSettings: "agent settings",
		agentSettingsFailed: "Could not load agent settings.",
		agentBackends: "agent backends",
		agentBackendsFailed: "Could not load agent backends.",
		changeInSettings: "Change in Settings → AI agent",
		carriedOver: "Using the backend of your last question —",
		reviewInSettings: "review in Settings → AI agent",
		horizon: "Horizon",
		years: (years: number) => `${years} years`,
		markets: "Markets",
		japan: "Japan (JP)",
		unitedStates: "United States (US)",
		beforeSubmit: "Before you can submit",
		questionNotSubmitted: "The question was not submitted.",
		instructionNotSent: "The instruction was not sent.",
	},
	ja: {
		questionTooShort: "リサーチの質問を入力してください（3 文字以上）。",
		questionTooLong: "質問は 2000 文字以内にしてください。",
		agentsLoading: "エージェントのバックエンドを読み込み中です。",
		chooseBackend: "設定 → AI エージェントで既定のバックエンドを選んでください。",
		backendUnusable: (backend, status) =>
			`${backend} は ${status} のため使用できません。設定 → AI エージェントで別のバックエンドを選んでください。`,
		openCodeNeedsModel:
			"OpenCode には provider/model 形式のモデルが必要です。設定 → AI エージェントで選んでください。",
		openRouterNeedsModel:
			"OpenRouter（無料モデル）にはモデルが必要です。設定 → AI エージェントで選んでください。",
		chooseMarket: "市場を 1 つ以上選んでください（JP または US）。",
		settingsLoading: "エージェント設定を読み込み中です。",
		meteredNeedsSpend:
			"従量課金のバックエンドには 0 USD より大きい上限額が必要です。設定 → AI エージェントで設定してください。",
		maxSpendRange: (max) =>
			`上限額は 0 より大きく ${max} USD 以下にしてください。設定 → AI エージェントで修正してください。`,
		confirmConsent: "このフォームで従量課金への同意にチェックしてください。",

		notebookNeedsBackend: "ノートブックアシスタントにはエージェントのバックエンドが必要です。",
		notebookOneAtATime:
			"ノートブックへの依頼は一度に 1 件ずつ実行されます。完了を待ってから再試行してください。",
		questionQueued: "質問をキューに追加しました。ランナーが受け取ると開始します。",
		questionSubmitted: (state) => `質問を送信しました（実行の状態: ${state}）。`,
		instructionEmpty: "ノートブックアシスタントへの指示を入力してください。",
		instructionTooLong: "指示は 2000 文字以内にしてください。",
		instructionQueued:
			"指示をキューに追加しました。ランナーが受け取るとノートブックアシスタントが開始します。",
		instructionSubmitted: (state) => `指示を送信しました（実行の状態: ${state}）。`,

		backendDefault: "バックエンドの既定",
		effort: (effort) => ({ low: "推論 低", medium: "推論 中", high: "推論 高" })[effort],
		summaryLine: (backend, model, effort, webAccess) =>
			`${backend} · ${model} · ${effort} · ウェブアクセス ${webAccess ? "オン" : "オフ"}`,
		consent: "この質問の従量課金に同意します",
		consentUpTo: (amount) => `この質問で ${amount} までの従量課金に同意します`,
		noMarkets: "市場なし",
		optionsSummary: (years, markets) => `${years} 年 · ${markets}`,
		options: (summary) => `オプション: ${summary}`,
		sending: "送信中…",
		sendInstruction: "指示を送信",
		sendQuestion: "質問を送信",
		notebookComposer: "ノートブックへの入力欄",
		researchComposer: "リサーチの入力欄",
		openAgentSettings: "設定 → AI エージェントを開く",
		wholeNotebook: "ノートブック全体が対象",
		selectedWidgets: "選択中のウィジェット",
		removeFromSelection: (title) => `「${title}」を選択から外す`,
		chooseMode: "モードを選択",
		composerMode: "入力モード",
		research: "リサーチ",
		notebook: "ノートブック",
		leaveNotebookMode: "ノートブックモードを終了",
		instruction: "指示",
		question: "質問",
		askNotebook: "ノートブックアシスタントに依頼…",
		askResearch: "リサーチの質問を入力…",
		agentSettings: "エージェント設定",
		agentSettingsFailed: "エージェント設定を読み込めませんでした。",
		agentBackends: "エージェントのバックエンド",
		agentBackendsFailed: "エージェントのバックエンドを読み込めませんでした。",
		changeInSettings: "設定 → AI エージェントで変更",
		carriedOver: "前回の質問のバックエンドを使用しています —",
		reviewInSettings: "設定 → AI エージェントで確認",
		horizon: "期間",
		years: (years) => `${years} 年`,
		markets: "市場",
		japan: "日本（JP）",
		unitedStates: "米国（US）",
		beforeSubmit: "送信する前に",
		questionNotSubmitted: "質問を送信できませんでした。",
		instructionNotSent: "指示を送信できませんでした。",
	},
});
