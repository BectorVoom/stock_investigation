import { defineMessages } from "@research/i18n";

/**
 * The sentences the pure agent-settings rules build (`agentSettingsModel.ts`),
 * passed into them as a parameter. Backend and model names are product names
 * and stay as they are; only the generic words around them are translated.
 */
export const agentSettingsModelMessages = defineMessages({
	en: {
		costPlanLimited: "plan-limited (cost unknown)",
		costMetered: "metered (billed per use)",
		costUnknown: "cost model unknown",
		isolationEnforced: "tool isolation enforced",
		isolationUnverified: "tool isolation unverified",
		statusAvailable: "available",
		statusUnavailable: (reasonCode: string) => `unavailable (${reasonCode})`,
		statusUnknown: "availability unknown",
		detailAvailable: (cost: string, isolation: string) => `Available — ${cost}; ${isolation}.`,
		detailUnavailable: (reasonCode: string, detail: string): string =>
			`Unavailable — ${reasonCode}${detail === "" ? "" : `: ${detail}`}`,
		detailUnknown: "Availability unknown — no runner has reported this backend yet.",
		modelOther: "Other — type a model id…",
		modelSavedSuffix: " (saved — not in the runner's list)",
		freeTierCaution:
			"OpenCode serves free-tier models only to sessions that list its tools, so this app runs them with every tool call rejected; an answer fails if the model tries a tool, and a plan model avoids that.",
		freePlanNote:
			"OpenRouter limits free models per minute and per day, and each agent step of a question uses one request. No spend is authorized for this backend.",
		chooseModel: "Choose a model…",
		backendDefault: "Backend default",
		/** A Claude Code alias: the newest model of the named family. */
		latestModel: (family: string) => `${family} (latest)`,
		modelIdPlaceholder: "model id",
		runnerNeverSeen:
			"Runner offline — no runner has ever reported in. Your question will be queued and will start when a runner connects.",
		runnerOffline: (lastSeen: string) =>
			`Runner offline (last seen ${lastSeen}). Your question will be queued and will start when the runner reconnects. Backend availability below is as last reported.`,
		costStatementPlanLimited:
			"Cost unknown — limited by your plan. This backend runs under your subscription's limits and does not report a price; no metered (paid) spend is authorized for this run.",
		costStatementMetered:
			"Metered backend — usage is billed to your provider account. Set an optional maximum spend to limit each run. Leave it blank for no spending cap.",
		costStatementUnknown:
			"Cost model unknown until a runner reports this backend. A maximum spend is optional; leave it blank for no spending cap.",
		meteredNeedsSpend: "A metered backend needs a maximum spend greater than 0 USD.",
		spendOutOfRange: (max: number) => `Max spend must be greater than 0 and at most ${max} USD.`,
		confirmConsent: "Confirm consent to metered spend before submitting.",
		agentsLoading: "Agent backends are still loading.",
		chooseDefaultBackend: "Choose a default agent backend.",
		backendUnusable: (name: string, status: string) => `${name} is ${status} and cannot be used.`,
		openCodeNeedsModel:
			"OpenCode needs a model of the form provider/model — without one it cannot run. Choose one from the list the runner reported, or type one.",
		openCodeModelShape: "The OpenCode model must have the form provider/model.",
		openRouterFreeNeedsModel:
			"OpenRouter (free models) needs a model — without one it cannot run. Choose one from the list the runner reported, or type one.",
		openRouterFreeModelShape:
			"The OpenRouter free model must end in :free (or be openrouter/free) — any other model is billed and is refused by this backend.",
		claudeApiModelNotListed:
			"The Claude API runs only the models the runner lists, because it prices each answer from them. Choose one from the list.",
		modelTooLong: (max: number) => `The model must be at most ${max} characters.`,
	},
	ja: {
		costPlanLimited: "プランの上限内（費用不明）",
		costMetered: "従量課金（利用ごとに請求）",
		costUnknown: "課金方式不明",
		isolationEnforced: "ツール分離あり",
		isolationUnverified: "ツール分離は未確認",
		statusAvailable: "利用可能",
		statusUnavailable: (reasonCode) => `利用不可（${reasonCode}）`,
		statusUnknown: "利用可否不明",
		detailAvailable: (cost, isolation) => `利用可能 — ${cost}、${isolation}。`,
		detailUnavailable: (reasonCode, detail) =>
			`利用不可 — ${reasonCode}${detail === "" ? "" : `: ${detail}`}`,
		detailUnknown: "利用可否不明 — このバックエンドを報告したランナーはまだありません。",
		modelOther: "その他 — モデル ID を入力…",
		modelSavedSuffix: "（保存済み — ランナーの一覧にありません）",
		freeTierCaution:
			"OpenCode は無料枠のモデルを、ツールを一覧に載せたセッションにしか提供しません。そのため、このアプリではすべてのツール呼び出しを拒否して実行します。モデルがツールを使おうとすると回答は失敗します。プランのモデルならこの問題はありません。",
		freePlanNote:
			"OpenRouter は無料モデルの利用回数を1分ごと・1日ごとに制限しており、質問のエージェントの各ステップが1リクエストを使います。このバックエンドでは支出を一切許可しません。",
		chooseModel: "モデルを選択…",
		backendDefault: "バックエンドの既定",
		latestModel: (family) => `${family}（最新）`,
		modelIdPlaceholder: "モデル ID",
		runnerNeverSeen:
			"ランナーはオフラインです。まだ一度も接続したランナーがありません。質問はキューに入り、ランナーが接続すると開始します。",
		runnerOffline: (lastSeen) =>
			`ランナーはオフラインです（最終接続 ${lastSeen}）。質問はキューに入り、ランナーが再接続すると開始します。下のバックエンドの利用可否は最後に報告された時点のものです。`,
		costStatementPlanLimited:
			"費用不明 — プランの上限内で動きます。このバックエンドはサブスクリプションの上限内で実行され、価格を報告しません。この実行では従量課金（有料）の支出は許可されません。",
		costStatementMetered:
			"従量課金のバックエンド — 利用料はプロバイダーのアカウントに請求されます。最大支出額は任意です。空欄の場合、支出額の上限はありません。",
		costStatementUnknown:
			"ランナーがこのバックエンドを報告するまで課金方式は不明です。最大支出額は任意です。空欄の場合、支出額の上限はありません。",
		meteredNeedsSpend: "従量課金のバックエンドには、0 USD より大きい最大支出額が必要です。",
		spendOutOfRange: (max) => `最大支出額は 0 より大きく、${max} USD 以下にしてください。`,
		confirmConsent: "送信する前に、従量課金の支出に同意してください。",
		agentsLoading: "エージェントのバックエンドを読み込み中です。",
		chooseDefaultBackend: "既定のエージェントのバックエンドを選んでください。",
		backendUnusable: (name, status) => `${name} は${status}のため使用できません。`,
		openCodeNeedsModel:
			"OpenCode には provider/model 形式のモデルが必要で、モデルなしでは実行できません。ランナーが報告した一覧から選ぶか、入力してください。",
		openCodeModelShape: "OpenCode のモデルは provider/model の形式にしてください。",
		openRouterFreeNeedsModel:
			"OpenRouter（無料モデル）にはモデルが必要で、モデルなしでは実行できません。ランナーが報告した一覧から選ぶか、入力してください。",
		openRouterFreeModelShape:
			"OpenRouter の無料モデルは :free で終わる（または openrouter/free である）必要があります。それ以外のモデルは課金されるため、このバックエンドでは拒否されます。",
		claudeApiModelNotListed:
			"Claude API はランナーが一覧にしたモデルだけを実行します。回答ごとの料金をその一覧から計算するためです。一覧から選んでください。",
		modelTooLong: (max) => `モデルは ${max} 文字以内にしてください。`,
	},
});
