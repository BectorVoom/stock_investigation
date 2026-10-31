import type { EquityProvider } from "@research/domain";
import { defineMessages } from "@research/i18n";
import { isWordedSyncFailure, type WordedSyncFailureCode } from "./syncFailureCodes.ts";

/** A tracked company's sync status (ADR-0048 §6), as the page and the widgets read it. */
type SyncStatus = "never" | "queued" | "running" | "succeeded" | "failed";
/** Where an EDINET company's scan stands. */
type SyncPhase = "discovery" | "backfill" | "forward" | "idle" | "not-found";

const EN_STATUS: { readonly [S in SyncStatus]: string } = {
	never: "Not synced yet",
	queued: "Queued",
	running: "Syncing",
	succeeded: "Synced",
	failed: "Sync failed",
};

const JA_STATUS: { readonly [S in SyncStatus]: string } = {
	never: "未同期",
	queued: "同期待ち",
	running: "同期中",
	succeeded: "同期済み",
	failed: "同期に失敗",
};

const EN_PHASE: { readonly [P in SyncPhase]: string } = {
	discovery: "looking for the latest annual report",
	backfill: "reading earlier years",
	forward: "checking for new reports",
	idle: "up to date",
	"not-found": "no annual report found on EDINET",
};

const JA_PHASE: { readonly [P in SyncPhase]: string } = {
	discovery: "最新の有価証券報告書を探索中",
	backfill: "過去の年度を取得中",
	forward: "新しい報告書を確認中",
	idle: "最新",
	"not-found": "EDINET に有価証券報告書が見つかりません",
};

/** A stored filing's extraction status (contracts `equityFilingListItemSchema.factsStatus`). */
type FilingFactsStatus = "pending" | "extracted" | "unavailable";

const EN_FACTS_STATUS: { readonly [S in FilingFactsStatus]: string } = {
	pending: "Pending: read again by the next sync",
	extracted: "Read",
	unavailable: "No machine-readable values",
};

const JA_FACTS_STATUS: { readonly [S in FilingFactsStatus]: string } = {
	pending: "保留: 次の同期で再取得",
	extracted: "取得済み",
	unavailable: "機械可読の値なし",
};

/** The runner variable each provider needs (ADR-0048 §9). */
const PROVIDER_VARIABLE: { readonly [P in EquityProvider]: string } = {
	sec: "SEC_USER_AGENT",
	edinet: "EDINET_API_KEY",
};

const EN_SOURCE_ID: { readonly [P in EquityProvider]: string } = {
	sec: "CIK",
	edinet: "EDINET code",
};

const JA_SOURCE_ID: { readonly [P in EquityProvider]: string } = {
	sec: "CIK",
	edinet: "EDINET コード",
};

/**
 * Failure codes of a `financial-sync` job (contracts `EQUITY_SYNC_FAILURE_CODES`)
 * in words, plus the codes the API records itself (contracts
 * `EQUITY_SYNC_API_FAILURE_CODES`): an identity conflict, the retry ceiling
 * and an internal refusal.
 */
const EN_FAILURES: { readonly [C in WordedSyncFailureCode]: string } = {
	FINANCIAL_COMPANY_NOT_FOUND: "The company was not found at the source.",
	FINANCIAL_RATE_LIMITED: "The source limited requests; the sync is tried again later.",
	FINANCIAL_ACCESS_DENIED: "The source refused access; check the runner's key or User-Agent.",
	FINANCIAL_SOURCE_FAILED: "The source could not be reached; the sync is tried again later.",
	FINANCIAL_PARSE_FAILED: "A document from the source did not have the expected shape.",
	FINANCIAL_IDENTITY_CONFLICT:
		"Another tracked company is the same issuer at the source (for example GOOGL and GOOG). Stop tracking one of them.",
	RETRY_CEILING_REACHED:
		"The sync stopped after too many attempts; it is tried again later, or press Sync now.",
	INTERNAL: "The sync could not be started or finished; it is tried again later.",
};

const JA_FAILURES: { readonly [C in WordedSyncFailureCode]: string } = {
	FINANCIAL_COMPANY_NOT_FOUND: "取得元で企業が見つかりませんでした。",
	FINANCIAL_RATE_LIMITED: "取得元がリクエストを制限しました。後で再試行します。",
	FINANCIAL_ACCESS_DENIED:
		"取得元がアクセスを拒否しました。ランナーのキーまたは User-Agent を確認してください。",
	FINANCIAL_SOURCE_FAILED: "取得元に接続できませんでした。後で再試行します。",
	FINANCIAL_PARSE_FAILED: "取得元の書類が想定した形式ではありませんでした。",
	FINANCIAL_IDENTITY_CONFLICT:
		"追跡中の別の企業が取得元で同じ発行体です（例: GOOGL と GOOG）。どちらかの追跡を停止してください。",
	RETRY_CEILING_REACHED:
		"再試行の上限に達したため同期を停止しました。後で再試行します。すぐに同期するには「今すぐ同期」を押してください。",
	INTERNAL: "同期を開始または完了できませんでした。後で再試行します。",
};

/**
 * A tracked company's sync status (ADR-0048 §6) and one company's
 * statements and filings, as the Stocks page's rows and its Financial
 * statements and Company tabs word them (ADR-0049 §2, §5, §6).
 */
export const equitiesMessages = defineMessages({
	en: {
		/* ----- a tracked company's sync ----- */
		sourceIdKind: (provider: EquityProvider): string => EN_SOURCE_ID[provider],
		status: (status: SyncStatus): string => EN_STATUS[status],
		phase: (phase: SyncPhase): string => EN_PHASE[phase],
		lastSynced: (when: string): string => `Last synced ${when}`,
		lastChecked: (when: string): string => `checked ${when}`,
		/** A code from a newer API than this page knows reads as a plain failure (its code is shown beside it). */
		failureCode: (code: string): string =>
			isWordedSyncFailure(code) ? EN_FAILURES[code] : "The sync failed.",
		notConfigured: (provider: EquityProvider): string =>
			`Not configured: set ${PROVIDER_VARIABLE[provider]} in apps/runner/.env, then restart the runner.`,
		upstreamStatus: (status: number): string => `The source answered HTTP ${status}.`,
		syncNow: "Sync now",
		syncNowNamed: (name: string): string => `Sync ${name} now`,
		syncQueued: (name: string): string =>
			`${name} will be synced when the local runner next claims work.`,
		syncFailed: "The sync was not requested.",
		/* ----- one company's statements and filings ----- */
		yearsLabel: "Fiscal years",
		yearsOption: (years: number): string => `${years} years`,
		filingsIntro:
			"Every annual report stored for this company, newest first, including amended originals and reports without machine-readable values.",
		filingsCaption: "Stored annual reports of this company",
		filingsThing: "the filings",
		filingsFailed: "Could not load the filings.",
		/** The selected company stopped being the owner's (removed elsewhere) before the list caught up. */
		companyGone:
			"This company's statements are no longer synced. Choose another stock in the table.",
		noFilings: "No filings are stored yet. They appear after the company's first sync.",
		factsColumn: "Values",
		factsStatus: (status: FilingFactsStatus): string => EN_FACTS_STATUS[status],
		factCount: (count: number): string => (count === 1 ? "1 value" : `${count} values`),
		amendsDocument: (documentId: string): string => `Amends ${documentId}`,
		form: "Form",
		filed: "Filed",
		periodEnd: "Period end",
		standard: "Accounting standard",
		amendment: "Amendment",
		isAmendment: "Amends an earlier filing",
		original: "Original",
		standardUnknown: "Not stated",
		link: "Link",
		openFiling: "Open",
		addStatementToHome: "Add this statement to Home",
		chartMetric: "Chart",
		addChartToHome: "Add chart to Home",
		addedToHome: (what: string): string => `Added ${what} to Home.`,
		alreadyOnHome: (what: string): string => `${what} is already on Home.`,
		notAddedToHome: "The widget was not added to Home.",
	},
	ja: {
		sourceIdKind: (provider) => JA_SOURCE_ID[provider],
		status: (status) => JA_STATUS[status],
		phase: (phase) => JA_PHASE[phase],
		lastSynced: (when) => `最終同期 ${when}`,
		lastChecked: (when) => `確認 ${when}`,
		failureCode: (code) => (isWordedSyncFailure(code) ? JA_FAILURES[code] : "同期に失敗しました。"),
		notConfigured: (provider) =>
			`未設定: apps/runner/.env に ${PROVIDER_VARIABLE[provider]} を設定し、ランナーを再起動してください。`,
		upstreamStatus: (status) => `取得元の応答は HTTP ${status} でした。`,
		syncNow: "今すぐ同期",
		syncNowNamed: (name) => `${name} を今すぐ同期`,
		syncQueued: (name) => `${name} は、ローカルランナーが次に作業を受け取ったときに同期されます。`,
		syncFailed: "同期を依頼できませんでした。",
		yearsLabel: "表示する年数",
		yearsOption: (years) => `${years}年`,
		filingsIntro:
			"この企業について保存しているすべての年次報告書です（新しい順）。訂正された当初の報告書や、機械可読の値がない報告書も含みます。",
		filingsCaption: "この企業の保存済みの年次報告書",
		filingsThing: "報告書",
		filingsFailed: "報告書を読み込めませんでした。",
		companyGone: "この企業の財務諸表はもう同期されていません。表で別の銘柄を選んでください。",
		noFilings: "保存済みの報告書はまだありません。企業の初回の同期が終わると表示されます。",
		factsColumn: "値",
		factsStatus: (status) => JA_FACTS_STATUS[status],
		factCount: (count) => `${count} 件の値`,
		amendsDocument: (documentId) => `${documentId} の訂正`,
		form: "様式",
		filed: "提出日",
		periodEnd: "期末日",
		standard: "会計基準",
		amendment: "訂正",
		isAmendment: "以前の報告書の訂正",
		original: "当初",
		standardUnknown: "記載なし",
		link: "リンク",
		openFiling: "開く",
		addStatementToHome: "この財務諸表をホームに追加",
		chartMetric: "チャート",
		addChartToHome: "チャートをホームに追加",
		addedToHome: (what) => `${what} をホームに追加しました。`,
		alreadyOnHome: (what) => `${what} はすでにホームにあります。`,
		notAddedToHome: "ウィジェットをホームに追加できませんでした。",
	},
});
