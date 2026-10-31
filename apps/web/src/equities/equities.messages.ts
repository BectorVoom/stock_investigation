import type { EquityMarket, EquityProvider } from "@research/domain";
import { defineMessages } from "@research/i18n";

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

const EN_MARKET: { readonly [M in EquityMarket]: string } = { US: "US", JP: "Japan" };
const JA_MARKET: { readonly [M in EquityMarket]: string } = { US: "米国", JP: "日本" };

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

/** Failure codes of a `financial-sync` job (contracts `EQUITY_SYNC_FAILURE_CODES`) in words. */
const EN_FAILURES: Readonly<Record<string, string>> = {
	FINANCIAL_COMPANY_NOT_FOUND: "The company was not found at the source.",
	FINANCIAL_RATE_LIMITED: "The source limited requests; the sync is tried again later.",
	FINANCIAL_ACCESS_DENIED: "The source refused access; check the runner's key or User-Agent.",
	FINANCIAL_SOURCE_FAILED: "The source could not be reached; the sync is tried again later.",
	FINANCIAL_PARSE_FAILED: "A document from the source did not have the expected shape.",
};

const JA_FAILURES: Readonly<Record<string, string>> = {
	FINANCIAL_COMPANY_NOT_FOUND: "取得元で企業が見つかりませんでした。",
	FINANCIAL_RATE_LIMITED: "取得元がリクエストを制限しました。後で再試行します。",
	FINANCIAL_ACCESS_DENIED:
		"取得元がアクセスを拒否しました。ランナーのキーまたは User-Agent を確認してください。",
	FINANCIAL_SOURCE_FAILED: "取得元に接続できませんでした。後で再試行します。",
	FINANCIAL_PARSE_FAILED: "取得元の書類が想定した形式ではありませんでした。",
};

/**
 * The Equities page (ADR-0048 §8): tracked companies with their sync
 * status, tracking through the stock directory search (ADR-0034), and one
 * company's statements, revisions and filings.
 */
export const equitiesMessages = defineMessages({
	en: {
		/* ----- tracked companies ----- */
		trackedHeading: "Tracked companies",
		trackedCount: (count: number, max: number): string => `${count} of ${max} companies`,
		companiesThing: "the tracked companies",
		companiesFailed: "Could not load the tracked companies.",
		noCompanies: "No companies are tracked yet. Track one below.",
		tableCaption: "Tracked companies and their sync status",
		company: "Company",
		symbol: "Symbol",
		market: "Market",
		marketName: (market: EquityMarket): string => EN_MARKET[market],
		sourceId: "Source ID",
		sourceIdKind: (provider: EquityProvider): string => EN_SOURCE_ID[provider],
		notResolved: "Not resolved yet",
		fiscalYearEnd: "Fiscal year end",
		latestFiscalYear: "Latest fiscal year",
		filings: "Filings",
		sync: "Sync",
		actions: "Actions",
		nameUnknown: "Name not known yet",
		unknown: "Not known yet",
		status: (status: SyncStatus): string => EN_STATUS[status],
		phase: (phase: SyncPhase): string => EN_PHASE[phase],
		lastSynced: (when: string): string => `Last synced ${when}`,
		lastChecked: (when: string): string => `checked ${when}`,
		failureCode: (code: string): string => EN_FAILURES[code] ?? "The sync failed.",
		notConfigured: (provider: EquityProvider): string =>
			`Not configured: set ${PROVIDER_VARIABLE[provider]} in apps/runner/.env, then restart the runner.`,
		upstreamStatus: (status: number): string => `The source answered HTTP ${status}.`,
		show: "Show statements",
		showNamed: (name: string): string => `Show the statements of ${name}`,
		syncNow: "Sync now",
		syncNowNamed: (name: string): string => `Sync ${name} now`,
		syncQueued: (name: string): string =>
			`${name} will be synced when the local runner next claims work.`,
		syncFailed: "The sync was not requested.",
		remove: "Remove",
		removeNamed: (name: string): string => `Stop tracking ${name}`,
		removeHeading: (name: string): string => `Stop tracking ${name}?`,
		removeBody:
			"It is no longer synced and leaves this list. Its stored filings and values are kept: tracking it again shows them at once.",
		removeConfirm: "Stop tracking",
		removeFailed: "The company was not removed.",
		removed: (name: string): string => `Stopped tracking ${name}. Its stored data is kept.`,

		/* ----- track a company ----- */
		trackHeading: "Track a company",
		trackHint:
			"Search the US and Japanese listed stocks. Tracking starts its first sync from SEC EDGAR (US) or EDINET (Japan); values appear once it ends.",
		idDisclosure: "Enter a stock id instead",
		idLabel: "Stock id",
		idPlaceholder: "us:AAPL",
		idHint: "us:AAPL for a US ticker, jp:7974 for a Japanese code.",
		idInvalid: "Enter us: followed by a US ticker, or jp: followed by a four-character code.",
		trackButton: "Track company",
		toTrack: (stock: string): string => `To track: ${stock}`,
		tracked: (name: string): string =>
			`Tracking ${name}. Its first sync runs when the local runner next claims work.`,
		trackFailed: "The company was not tracked.",
		atLimit: (max: number): string =>
			`You track ${max} companies, the most there can be. Remove one to track another.`,

		/* ----- one company ----- */
		detailHeading: (name: string): string => `Statements of ${name}`,
		chooseCompany: "Choose a company in the table to see its statements.",
		yearsLabel: "Fiscal years",
		yearsOption: (years: number): string => `${years} years`,
		filingsHeading: "Filings behind these values",
		filingsCaption: "Filings the statement above cites",
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
		trackedHeading: "追跡中の企業",
		trackedCount: (count, max) => `${max} 社中 ${count} 社`,
		companiesThing: "追跡中の企業",
		companiesFailed: "追跡中の企業を読み込めませんでした。",
		noCompanies: "追跡中の企業はまだありません。下で追加してください。",
		tableCaption: "追跡中の企業と同期の状態",
		company: "企業",
		symbol: "銘柄コード",
		market: "市場",
		marketName: (market) => JA_MARKET[market],
		sourceId: "取得元 ID",
		sourceIdKind: (provider) => JA_SOURCE_ID[provider],
		notResolved: "未特定",
		fiscalYearEnd: "決算日",
		latestFiscalYear: "直近の会計年度",
		filings: "報告書",
		sync: "同期",
		actions: "操作",
		nameUnknown: "企業名は未取得",
		unknown: "未取得",
		status: (status) => JA_STATUS[status],
		phase: (phase) => JA_PHASE[phase],
		lastSynced: (when) => `最終同期 ${when}`,
		lastChecked: (when) => `確認 ${when}`,
		failureCode: (code) => JA_FAILURES[code] ?? "同期に失敗しました。",
		notConfigured: (provider) =>
			`未設定: apps/runner/.env に ${PROVIDER_VARIABLE[provider]} を設定し、ランナーを再起動してください。`,
		upstreamStatus: (status) => `取得元の応答は HTTP ${status} でした。`,
		show: "財務諸表を表示",
		showNamed: (name) => `${name} の財務諸表を表示`,
		syncNow: "今すぐ同期",
		syncNowNamed: (name) => `${name} を今すぐ同期`,
		syncQueued: (name) => `${name} は、ローカルランナーが次に作業を受け取ったときに同期されます。`,
		syncFailed: "同期を依頼できませんでした。",
		remove: "削除",
		removeNamed: (name) => `${name} の追跡を停止`,
		removeHeading: (name) => `${name} の追跡を停止しますか?`,
		removeBody:
			"同期されなくなり、この一覧から外れます。保存済みの報告書と値は残り、再び追跡するとすぐに表示されます。",
		removeConfirm: "追跡を停止",
		removeFailed: "企業を削除できませんでした。",
		removed: (name) => `${name} の追跡を停止しました。保存済みのデータは残っています。`,

		trackHeading: "企業を追跡",
		trackHint:
			"米国と日本の上場銘柄を検索します。追跡すると SEC EDGAR（米国）または EDINET（日本）から初回の同期を始め、終わると値が表示されます。",
		idDisclosure: "銘柄 ID を直接入力する",
		idLabel: "銘柄 ID",
		idPlaceholder: "jp:7974",
		idHint: "米国のティッカーは us:AAPL、日本の銘柄コードは jp:7974 の形式です。",
		idInvalid: "us: に米国のティッカー、または jp: に 4 文字の銘柄コードを続けて入力してください。",
		trackButton: "この企業を追跡",
		toTrack: (stock) => `追跡する企業: ${stock}`,
		tracked: (name) =>
			`${name} の追跡を始めました。初回の同期は、ローカルランナーが次に作業を受け取ったときに実行されます。`,
		trackFailed: "企業を追跡できませんでした。",
		atLimit: (max) =>
			`追跡できる上限の ${max} 社に達しています。追加するには 1 社を削除してください。`,

		detailHeading: (name) => `${name} の財務諸表`,
		chooseCompany: "表で企業を選ぶと財務諸表を表示します。",
		yearsLabel: "表示する年数",
		yearsOption: (years) => `${years}年`,
		filingsHeading: "値の出典となった報告書",
		filingsCaption: "上の財務諸表が引用している報告書",
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
