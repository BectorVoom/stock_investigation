import { defineMessages } from "@research/i18n";

/**
 * The message thread (ADR-0031): its landmarks, the empty-state greeting, the
 * actions under an answer and the result previews. The messages themselves
 * (the owner's questions, the agent's answers and claims) are research content
 * and stay as written.
 */
export const conversationMessages = defineMessages({
	en: {
		copied: "Copied",
		copyFailed: "Copy failed",
		copyAnswer: "Copy answer",
		evidence: "Evidence",
		inNotebook: "In notebook",
		addToNotebook: "Add to Notebook",
		suggestions: "Suggestions",
		runStatus: "Run status",
		conversation: "Conversation",
		loadingEarlier: "Loading earlier messages…",
		loadEarlier: "Load earlier messages",
		earlierFailed: "Could not load earlier messages.",
		earlierRuns: "Earlier runs",
		/** The thing being loaded, for "Loading …". */
		conversationLoading: "conversation",
		greeting: "What would you like to research?",
		greetingHint:
			"Ask about demand growth, suppliers or pricing power — answers arrive with their sources.",
		messages: "Messages",
		yourMessage: "Your message",
		assistantMessage: "Assistant message",
		notebookAssistant: "Notebook assistant",
		assistant: "Assistant",
		results: "Results",
	},
	ja: {
		copied: "コピーしました",
		copyFailed: "コピーできませんでした",
		copyAnswer: "回答をコピー",
		evidence: "根拠",
		inNotebook: "ノートブックに追加済み",
		addToNotebook: "ノートブックに追加",
		suggestions: "質問の例",
		runStatus: "実行の状態",
		conversation: "チャットの内容",
		loadingEarlier: "以前のメッセージを読み込み中…",
		loadEarlier: "以前のメッセージを読み込む",
		earlierFailed: "以前のメッセージを読み込めませんでした。",
		earlierRuns: "以前の実行",
		conversationLoading: "チャット",
		greeting: "何をリサーチしますか？",
		greetingHint:
			"需要の伸び、サプライヤー、価格決定力について質問できます。回答には出典が付きます。",
		messages: "メッセージ",
		yourMessage: "あなたのメッセージ",
		assistantMessage: "アシスタントのメッセージ",
		notebookAssistant: "ノートブックアシスタント",
		assistant: "アシスタント",
		results: "結果",
	},
});

/**
 * An answer's claims (ADR-0031). The words around its sources (chips, source
 * list) are the registry's `citationMessages`; claims and source titles stay
 * as written.
 */
export const citationsMessages = defineMessages({
	en: {
		claimUnavailable: (claimId: string) => `Claim unavailable (id ${claimId})`,
		noEvidenceLinked: "No evidence linked to this claim.",
		claimsInAnswer: "Claims in this answer",
		claims: "Claims",
	},
	ja: {
		claimUnavailable: (claimId) => `主張を取得できません（ID ${claimId}）`,
		noEvidenceLinked: "この主張に紐づく根拠はありません。",
		claimsInAnswer: "この回答の主張",
		claims: "主張",
	},
});
