/**
 * The runner-reached zod schemas with their baselines (fixtures of the
 * contract and runner tests, plus values written here for shapes no
 * fixture covers) and hand-picked edge cases (refinement boundaries).
 * Each entry becomes `vectors/contracts/<name>.json`.
 */
import { z } from "zod";
import * as runner from "../../../apps/runner/test/support.ts";
import * as contracts from "../../../packages/contracts/src/index.ts";
import * as fx from "../../../packages/contracts/test/fixtures.ts";
import type { Json, MutationOptions } from "./mutations.ts";

export interface SchemaEntry {
	readonly name: string;
	readonly schema: z.ZodType;
	readonly baselines: readonly Json[];
	/** Extra JSON texts (refinement boundaries, values a baseline cannot reach). */
	readonly extra?: readonly string[];
	readonly options?: MutationOptions;
}

function json(value: unknown): Json {
	return JSON.parse(JSON.stringify(value)) as Json;
}

const unavailableAgent = {
	agentId: "opencode",
	displayName: "OpenCode",
	capabilities: {
		supported: ["stream", "cancel", "tool-calls"],
		model: "opencode/gpt-5",
		models: ["a", "b-free"],
	},
	costModel: "metered",
	toolIsolation: "unverified",
	availability: {
		status: "unavailable",
		reasonCode: "NOT_INSTALLED",
		detail: "opencode was not found on PATH",
	},
};

const agentRequest = {
	runId: "run_1",
	conversationId: "ws_1",
	prompt: "Answer briefly.",
	permittedToolIds: ["news.search", "web.fetch_page"],
	maxToolCalls: 20,
	deadline: fx.T1,
};

const agentEvents = [
	{ type: "text.delta", text: "Hello" },
	{
		type: "tool.request",
		toolId: "news.search",
		args: { query: "batteries", limit: 5 },
		callId: "call_1",
	},
	{ type: "tool.result", callId: "call_1", resultRef: "ev_1" },
	{ type: "ui.command", command: { operation: "component.focus", componentId: "c1" } },
	{ type: "usage", knownCostUsd: 0.25 },
	{ type: "usage", knownCostUsd: null },
	{ type: "completed" },
	{ type: "failed", code: "AGENT_TIMEOUT", retryable: true },
];

function nested(depth: number): string {
	return `${"[".repeat(depth)}1${"]".repeat(depth)}`;
}

const T0 = fx.T0;
const T1 = fx.T1;
const usage = json(fx.resourceUsage);
const SIGN_IN_URL =
	"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2F&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.app.created&access_type=offline&prompt=consent&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=q7Zk2mVh0xJt4Yb9Lw3Rn8Uc5Df1Gs6Pa0Oe2Ix7Hy4";

const origin = { kind: "owner", messageId: null, runId: null, componentId: null };
const chartPointSourced = { x: "2025", y: 12.5, sourceId: "ev_1", asOf: "2026-10-01" };
const widgetCores: Json[] = [
	{ widgetId: "w-1", type: "text", title: "Notes", size: "medium", text: "hello **world**" },
	{
		widgetId: "w-2",
		type: "metric",
		title: "M",
		size: "small",
		value: 3,
		unit: "x",
		change: null,
		caption: "",
		asOf: null,
	},
	{
		widgetId: "w-3",
		type: "chart",
		title: "Demand",
		size: "large",
		chartType: "line",
		unit: "GWh",
		series: [
			{
				name: "Base",
				points: [
					chartPointSourced,
					{ x: "2026", y: 14, basis: "assumption" },
					{ x: "2027", y: 15 },
				],
			},
		],
		xLabel: "Year",
		yLabel: "GWh",
		xKind: "date",
		sourceIds: ["ev_1"],
		sources: [json(fx.evidence)],
	},
	{
		widgetId: "w-4",
		type: "table",
		title: "T",
		size: "medium",
		columns: ["a", "b"],
		rows: [
			["x", 1],
			[null, "y"],
		],
	},
	{
		widgetId: "w-5",
		type: "research",
		title: "Report",
		size: "large",
		componentId: "run_1_report",
	},
	{ widgetId: "w-6", type: "market-metric", title: "VIX", size: "small", seriesId: "fred:VIXCLS" },
	{
		widgetId: "w-7",
		type: "line-chart",
		title: "Rates",
		size: "medium",
		seriesIds: ["fred:DGS10", "twelve-data:XAU/USD"],
		range: "1y",
	},
	{
		widgetId: "w-8",
		type: "stock-table",
		title: "Stocks",
		size: "medium",
		seriesIds: ["twelve-data:AAPL", "twelve-data:7203:XTKS"],
	},
	{
		widgetId: "w-9",
		type: "indicator-table",
		title: "Ind",
		size: "large",
		seriesIds: ["fred:CPIAUCSL"],
	},
	{ widgetId: "w-10", type: "earnings-calendar", title: "Earnings", size: "large", daysAhead: 90 },
	{ widgetId: "w-11", type: "scheduled-tasks", title: "Tasks", size: "medium" },
	{ widgetId: "w-12", type: "scheduled-tasks", title: "Next task", size: "small" },
];
/** A scheduled-tasks widget has no content fields: any one is rejected (ADR-0033). */
const scheduledTasksRejected = [
	'{"widgetId":"w-11","type":"scheduled-tasks","title":"Tasks","size":"medium","daysAhead":30}',
	'{"widgetId":"w-11","type":"scheduled-tasks","title":"Tasks","size":"medium","tasks":[]}',
	'{"widgetId":"w-11","type":"scheduled-tasks","title":"Tasks","size":"huge"}',
	'{"widgetId":"w-11","type":"scheduled-task","title":"Tasks","size":"medium"}',
];
const notebookWidgets: Json[] = widgetCores.map((core) => ({
	...(core as Record<string, Json>),
	createdAt: "2026-10-14T00:00:00.000Z",
	updatedAt: "2026-10-14T00:00:00.000Z",
	revision: 1,
	origin,
}));
const notebook: Json = { widgets: notebookWidgets };

const lease = {
	runId: "run_1",
	leaseGeneration: 1,
	leaseExpiresAt: T1,
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [json(fx.subscribedSource)],
};
const eventBody = {
	id: "a".repeat(32),
	summary: "AAPL Apple Inc earnings (Q4 2026)",
	description: "Scheduled earnings announcement for AAPL (Q4 2026).",
	startDate: "2026-10-29",
	endDate: "2026-10-30",
	privateProperties: { researchWorkspace: "earnings", stockId: "us:AAPL", periodKey: "2026-q4" },
	sourceTitle: "Finnhub",
	sourceUrl: "https://finnhub.io/",
};
const earningsEvent = {
	periodKey: "2026-q4",
	announcementDate: "2026-10-29",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
};
const conversation = [
	{ role: "owner", text: "Which products will see demand growth?" },
	{ role: "assistant", text: "Grid storage, mainly." },
];
const claimedJobs: Json[] = [
	json(fx.claimedResearchJob),
	json(runner.RESEARCH_JOB),
	json(runner.INGEST_JOB),
	{
		kind: "research",
		...lease,
		request: json(fx.researchRequest),
		priorUsage: usage,
		workspaceComponents: [{ componentId: "c", componentType: "data-table", title: null }],
		conversationContext: conversation,
	},
	{
		kind: "notebook-assist",
		...lease,
		workspaceId: "ws_1",
		agent: { agentId: "opencode", model: "opencode/big-pickle", effort: "high" },
		instruction: "Make the chart a bar chart.",
		selectedWidgetIds: ["w-3"],
		notebook,
		notebookVersion: 4,
		conversationContext: conversation,
	},
	{
		kind: "market-refresh",
		...lease,
		series: [
			{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-10" },
			{ seriesId: "twelve-data:AAPL", latestObservedOn: null },
		],
	},
	{
		kind: "earnings-refresh",
		...lease,
		fromDate: "2026-10-13",
		toDate: "2027-04-16",
		stocks: [
			{ stockId: "us:AAPL", name: "Apple Inc" },
			{ stockId: "jp:7203", name: null },
		],
	},
	{ kind: "google-calendar", ...lease, action: "connect" },
	{ kind: "google-calendar", ...lease, action: "disconnect" },
	{
		kind: "google-calendar",
		...lease,
		action: "sync",
		calendarId: "cal_1@group.calendar.google.com",
		desiredDigest: "b".repeat(64),
		events: [eventBody],
	},
	{
		kind: "google-calendar",
		...lease,
		action: "sync",
		calendarId: null,
		desiredDigest: "b".repeat(64),
		events: [],
	},
	{ kind: "stock-directory-refresh", ...lease, market: "US" },
	{ kind: "stock-directory-refresh", ...lease, market: "JP" },
];
const marketMeta = {
	title: "CBOE Volatility Index: VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
};
const base = { leaseGeneration: 1, usage };
const completions: Json[] = [
	{
		outcome: "completed",
		...base,
		bundle: json(fx.researchBundle),
		articles: [json(fx.ingestedArticle)],
		sourceReports: [json(fx.sourceReport)],
	},
	{
		outcome: "partial",
		...base,
		failureCode: "TOOL_CALL_BUDGET_EXHAUSTED",
		bundle: json(fx.emptyBundle),
		articles: [],
		sourceReports: [],
	},
	{
		outcome: "ingested",
		...base,
		articles: [json(fx.ingestedArticle)],
		sourceReports: [
			json(fx.sourceReport),
			{ sourceId: "src_2", fetchedAt: T1, errorCode: "NOT_A_FEED" },
		],
	},
	{
		outcome: "market-refreshed",
		...base,
		series: [
			{
				seriesId: "fred:VIXCLS",
				fetchedAt: T1,
				meta: marketMeta,
				observations: [
					["2026-10-09", 17.5],
					["2026-10-10", 18],
				],
				errorCode: null,
			},
			{
				seriesId: "twelve-data:AAPL",
				fetchedAt: T1,
				meta: null,
				observations: [],
				errorCode: "SOURCE_NOT_CONFIGURED",
			},
		],
	},
	{
		outcome: "failed",
		...base,
		failureCode: "ALL_TOOL_CALLS_FAILED",
		failureDetail: "TIMEOUT",
		retryable: true,
	},
	{
		outcome: "failed",
		...base,
		failureCode: "AGENT_THREW_TypeError",
		failureDetail: null,
		retryable: false,
	},
	{ outcome: "failed", ...base, failureCode: "BUNDLE_INVALID", retryable: false },
	{ outcome: "cancelled", ...base },
	{
		outcome: "notebook-assisted",
		...base,
		baseVersion: 4,
		reply: "Done.",
		commands: [{ kind: "update", widgetId: "w-3", config: { chartType: "bar" } }],
		proposedRemovals: ["w-1"],
	},
	{
		outcome: "waiting_approval",
		...base,
		approvalRequest: {
			reasonCode: "SPEND_CONSENT_REQUIRED",
			detail: "Metered spend of 0.5000 USD needs consent.",
		},
	},
	{
		outcome: "earnings-refreshed",
		...base,
		stocks: [
			{
				stockId: "us:AAPL",
				fetchedAt: T1,
				name: "Apple Inc",
				events: [earningsEvent],
				errorCode: null,
			},
			{ stockId: "jp:7203", fetchedAt: T1, name: null, events: [], errorCode: "NO_SCHEDULED_DATE" },
		],
	},
	{ outcome: "google-calendar-connected", ...base, calendarId: "cal_1@group.calendar.google.com" },
	{
		outcome: "google-calendar-synced",
		...base,
		calendarId: "cal_1",
		desiredDigest: "c".repeat(64),
		inserted: 1,
		updated: 0,
		deleted: 2,
		unchanged: 3,
	},
	{ outcome: "google-calendar-disconnected", ...base, revoked: true },
];
const runnerEvents: Json[] = [
	{ seq: 0, at: T0, event: { type: "state", state: "planning" } },
	{ seq: 1, at: T0, event: { type: "note", text: "Searching news." } },
	{
		seq: 2,
		at: T0,
		event: { type: "tool", toolId: "news.search", outcome: "executed", detail: "3 results" },
	},
	{ seq: 3, at: T0, event: { type: "usage", usage } },
	{ seq: 4, at: T0, event: { type: "provider-session", sessionRef: "ses_1" } },
	{ seq: 5, at: T0, event: { type: "google-auth-url", url: SIGN_IN_URL } },
];
const uiOperations: Json[] = [
	...(json(fx.researchBundle.uiOperations) as Json[]),
	{ operation: "component.update", componentId: "c1", props: { title: "x" } },
	{ operation: "component.remove", componentId: "c1" },
	{ operation: "component.focus", componentId: "c1" },
	{ operation: "component.select", componentId: "c1", itemKey: "row-1" },
	{ operation: "component.select", componentId: "c1", itemKey: null },
	{ operation: "layout.update", order: ["c1", "c2"], columns: 2 },
	{ operation: "dataset.bind", componentId: "c1", datasetRef: "ds_1" },
	{ operation: "dataset.refresh", datasetRef: "ds_1", replacementDatasetRef: "ds_2" },
	{ operation: "navigation.open", target: { kind: "view", view: "sources" } },
	{ operation: "navigation.open", target: { kind: "evidence", evidenceId: "ev_1" } },
];
const credential = {
	credential: {
		credentialId: "cred_1",
		label: "Laptop runner",
		createdAt: T0,
		expiresAt: "2026-11-10T00:00:00Z",
		revokedAt: null,
		lastUsedAt: T1,
	},
	token: "t".repeat(48),
};

/** A cell-count boundary: `rows` datasets of `cells` cells each. */
function bundleWithCells(datasets: number, rowsPerDataset: number, columns: number): string {
	const columnDefs = Array.from({ length: columns }, (_, index) => ({
		key: `c${index}`,
		label: `C${index}`,
		kind: "text",
	}));
	const row = Object.fromEntries(columnDefs.map((column) => [column.key, { v: "x" }]));
	const dataset = (index: number) => ({
		datasetId: `ds_${index}`,
		title: "Cells",
		columns: columnDefs,
		rows: Array.from({ length: rowsPerDataset }, () => row),
		createdAt: T0,
	});
	return JSON.stringify({
		...(json(fx.emptyBundle) as Record<string, Json>),
		datasets: Array.from({ length: datasets }, (_, index) => dataset(index)),
	});
}

function contextOfBytes(perMessage: string, count: number): string {
	return JSON.stringify(Array.from({ length: count }, () => ({ role: "owner", text: perMessage })));
}

const googleConnect = { kind: "google-calendar", ...lease, action: "connect" };
const googleSync = {
	kind: "google-calendar",
	...lease,
	action: "sync",
	calendarId: "cal",
	desiredDigest: "b".repeat(64),
	events: [],
};
const GOOGLE_JOB_EDGES: string[] = [
	{ ...googleConnect, calendarId: null },
	{ ...googleConnect, calendarId: "cal", desiredDigest: "b".repeat(64), events: [] },
	{ ...googleConnect, action: "disconnect", events: [] },
	{ ...googleSync, calendarId: undefined },
	{ ...googleSync, desiredDigest: undefined, events: undefined },
	{ ...googleSync, calendarId: "", desiredDigest: "B".repeat(64) },
	{ ...googleSync, events: Array.from({ length: 400 }, () => eventBody) },
	{ ...googleSync, events: Array.from({ length: 401 }, () => eventBody) },
].map((value) => JSON.stringify(value));

function withUrl(url: string): string {
	return JSON.stringify({ seq: 0, at: T0, event: { type: "google-auth-url", url } });
}
const SIGN_IN_EDGES: string[] = [
	`${SIGN_IN_URL}&state=again`,
	`${SIGN_IN_URL}&extra=1`,
	`${SIGN_IN_URL}#frag`,
	`${SIGN_IN_URL}#`,
	SIGN_IN_URL.replace("https://", "https://user:pw@"),
	SIGN_IN_URL.replace("%3A49152", "%3A0"),
	SIGN_IN_URL.replace("%3A49152", "%3A99999"),
	SIGN_IN_URL.replace("%3A49152", "%3A100000"),
	SIGN_IN_URL.replace("access_type=offline&", ""),
	SIGN_IN_URL.replace("prompt=consent&", "prompt=none&"),
	SIGN_IN_URL.replace("client_id=x", `client_id=${"x".repeat(200)}`),
	SIGN_IN_URL.replace("client_id=x", `client_id=${"x".repeat(201)}`),
	SIGN_IN_URL.replace("client_id=x", "client_id="),
	SIGN_IN_URL.replace("client_id=x", "client_id=%E2%82%AC"),
	SIGN_IN_URL.replace("response_type=code", "response_type=co%64e"),
	SIGN_IN_URL.replace("response_type=code", "response_type=code+"),
	SIGN_IN_URL.replace("&state=", "&st%61te="),
	SIGN_IN_URL.replace("code_challenge_method=S256", "code_challenge_method=plain"),
	SIGN_IN_URL.replace(/code_challenge=[^&]+/, `code_challenge=${"a".repeat(42)}`),
	SIGN_IN_URL.replace(/state=[^&]+/, `state=${"a".repeat(15)}`),
	SIGN_IN_URL.replace(/state=[^&]+/, `state=${"a".repeat(128)}`),
	SIGN_IN_URL.replace(/state=[^&]+/, `state=${"a".repeat(129)}`),
	SIGN_IN_URL.replace("scope=https", "scope=http"),
	`${SIGN_IN_URL}&`,
	`${SIGN_IN_URL}&&`,
	SIGN_IN_URL.replace("?", "?&"),
].map(withUrl);

function withSourceUrl(url: string): string {
	return JSON.stringify({ ...(json(fx.evidence) as Record<string, Json>), sourceUrl: url });
}
const URL_EDGES: string[] = [
	"https://例え.jp/",
	"https://xn--r8jz45g.jp/",
	"https://[::1]/",
	"https://[::1",
	"https://127.0.0.1:443/",
	"https:example.com",
	"https:/example.com",
	"https://exa mple.com/",
	"https://example.com/a b",
	"HTTPS://EXAMPLE.COM/",
	"https://example.com:65535/",
	"https://example.com:65536/",
	"https://%41.com/",
	"https://a%2Fb.com/",
	"https://example.com\\path",
	" https://example.com/ ",
	"\thttps://exa\nmple.com/",
	"https://",
	"https://.",
	"https://a..b/",
	"https://xn--/",
	"https://ex%00ample.com/",
	"https://example.com#\u0000",
	"https://user@example.com/",
	"http://example.com/",
	"ftp://example.com/",
	"https://😀.com/",
	"https://0x7f.1/",
	"https://999.999.999.999/",
	"https://1.2.3/",
].map(withSourceUrl);

const COMPOSITE: MutationOptions = { maxDepth: 3, maxCases: 1500 };

/* ---------- Stock directory (ADR-0034) ---------- */

const usDirectoryEntry = { symbol: "AAPL", name: "Apple Inc.", listing: "nasdaq" };
const jpDirectoryEntry = {
	symbol: "130A",
	name: "Veritas In Silico Inc.",
	localName: "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
	listing: "tse-growth",
};

/** `count` minimal rows of a market (`A0`…, `1000`…): a completion needs at least the floor. */
function directoryRows(market: "US" | "JP", count: number): Json[] {
	return Array.from(
		{ length: count },
		(_, index): Json =>
			market === "US"
				? { symbol: `A${index}`, name: "N", listing: "nyse" }
				: { symbol: String(1000 + index), name: "N", localName: "L", listing: "tse-prime" },
	);
}

function directoryCompletion(market: "US" | "JP", entries: Json[], asOf: Json = null): string {
	return JSON.stringify({
		outcome: "stock-directory-refreshed",
		leaseGeneration: 1,
		usage,
		market,
		asOf,
		fetchedAt: T1,
		entries,
	});
}

const FLOOR = contracts.STOCK_DIRECTORY_LIMITS.minEntriesPerMarket;

/**
 * Whole `stock-directory-refreshed` completions: too large for the mutation
 * search (a thousand rows each), so the edges are written out: the floor,
 * each refinement message, and a refinement skipped behind an entry issue.
 */
const DIRECTORY_COMPLETION_EDGES: string[] = [
	directoryCompletion("US", directoryRows("US", FLOOR)),
	directoryCompletion("JP", directoryRows("JP", FLOOR), "2026-09-30"),
	directoryCompletion("US", directoryRows("US", FLOOR - 1)),
	directoryCompletion("JP", directoryRows("JP", FLOOR), "2026-02-30"),
	directoryCompletion("US", [
		...directoryRows("US", FLOOR),
		{ symbol: "A0", name: "N", listing: "nyse" },
	]),
	directoryCompletion("JP", directoryRows("US", FLOOR)),
	directoryCompletion("US", directoryRows("JP", FLOOR)),
	directoryCompletion("US", [
		...directoryRows("US", FLOOR - 1),
		{ symbol: "LOCAL", name: "N", localName: "L", listing: "nasdaq" },
	]),
	directoryCompletion("JP", [
		...directoryRows("JP", FLOOR - 1),
		{ symbol: "7203", name: "N", localName: "L", listing: "nyse" },
	]),
	directoryCompletion("US", [
		...directoryRows("US", FLOOR),
		{ symbol: "A1", name: " ".repeat(3), listing: "nyse" },
	]),
	directoryCompletion("US", [
		...directoryRows("US", FLOOR),
		{ symbol: "A1", name: "N".repeat(201), listing: "nyse" },
	]),
	directoryCompletion("US", [
		...directoryRows("US", FLOOR - 1),
		{ symbol: "", name: "N", listing: "nyse" },
	]),
	directoryCompletion("US", [
		...directoryRows("US", FLOOR - 1),
		{ symbol: "ABCDEFGHIJKLMNOPQ", name: "N", listing: "nyse" },
	]),
	directoryCompletion("US", [
		...directoryRows("US", FLOOR - 1),
		{ symbol: "  AAPL ", name: "  Trimmed  ", listing: "nasdaq" },
	]),
];

export const SCHEMAS: readonly SchemaEntry[] = [
	{
		name: "agentDescriptor",
		schema: contracts.agentDescriptorSchema,
		baselines: [json(fx.agentDescriptor), json(unavailableAgent)],
	},
	{ name: "agentRequest", schema: contracts.agentRequestSchema, baselines: [json(agentRequest)] },
	{
		name: "agentEvent",
		schema: contracts.agentEventSchema,
		baselines: agentEvents.map(json),
		extra: [
			`{"type":"tool.request","toolId":"t","args":${nested(12)},"callId":"c"}`,
			`{"type":"tool.request","toolId":"t","args":${nested(13)},"callId":"c"}`,
			`{"type":"tool.request","toolId":"t","args":[${"0,".repeat(19_999)}0],"callId":"c"}`,
			`{"type":"tool.request","toolId":"t","args":[${"0,".repeat(19_998)}0],"callId":"c"}`,
			`{"type":"tool.request","toolId":"t","callId":"c"}`,
			`{"type":"tool.request","toolId":"t","args":1e400,"callId":"c"}`,
			`{"type":"usage","knownCostUsd":-0}`,
		],
	},
	{ name: "resourceUsage", schema: contracts.resourceUsageSchema, baselines: [usage] },
	{
		name: "researchBudget",
		schema: contracts.researchBudgetSchema,
		baselines: [json(fx.researchBudget), json(contracts.runBudget(12.5))],
	},
	{
		name: "researchRequest",
		schema: contracts.researchRequestSchema,
		baselines: [json(fx.researchRequest)],
		extra: [
			JSON.stringify({
				...(json(fx.researchRequest) as Record<string, Json>),
				webAccess: undefined,
			}),
		],
	},
	{
		name: "bundleProvenance",
		schema: contracts.bundleProvenanceSchema,
		baselines: [json(fx.researchBundle.provenance)],
		extra: [
			'{"agentId":"codex","providerModel":null,"promptVersion":"v","toolVersions":{"b":"1","10":"2","a":"3","2":"4","__proto__":"x"},"dataCutoffAt":"2026-10-11T00:00:00Z"}',
		],
	},
	{
		name: "ingestedArticle",
		schema: contracts.ingestedArticleSchema,
		baselines: [json(fx.ingestedArticle)],
	},
	{
		name: "evidence",
		schema: contracts.evidenceSchema,
		baselines: [json(fx.evidence)],
		extra: URL_EDGES,
	},
	{
		name: "claim",
		schema: contracts.claimSchema,
		baselines: [
			json(fx.claim),
			{
				...(json(fx.claim) as Record<string, Json>),
				issues: [
					{ code: "UNKNOWN_EVIDENCE", evidenceId: "x" },
					{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "42%" },
					{ code: "NO_SUPPORTING_EVIDENCE" },
					{ code: "NOT_INDEPENDENTLY_VERIFIED" },
					{ code: "QUOTE_NOT_FOUND", evidenceId: "e" },
					{ code: "QUOTE_TOO_SHORT", evidenceId: "e" },
					{ code: "MISSING_QUOTE", evidenceId: "e" },
				],
			},
		],
	},
	{
		name: "demandScenario",
		schema: contracts.demandScenarioSchema,
		baselines: [json(fx.demandScenario)],
	},
	{
		name: "security",
		schema: contracts.securitySchema,
		baselines: [json(fx.jpSecurity), json(fx.usSecurity)],
	},
	{
		name: "supplierLink",
		schema: contracts.supplierLinkSchema,
		baselines: [json(fx.supplierLink)],
	},
	{
		name: "reportingPeriod",
		schema: contracts.reportingPeriodSchema,
		baselines: [json(fx.reportingPeriod)],
	},
	{
		name: "financialObservation",
		schema: contracts.financialObservationSchema,
		baselines: [json(fx.availableObservation), json(fx.unavailableObservation)],
	},
	{
		name: "positionFigures",
		schema: contracts.positionFiguresSchema,
		baselines: [json(fx.jpPosition.figures), json(fx.usPosition.figures)],
	},
	{
		name: "positionObservation",
		schema: contracts.positionObservationSchema,
		baselines: [json(fx.jpPosition), json(fx.usPosition)],
	},
	{
		name: "investorFiling",
		schema: contracts.investorFilingSchema,
		baselines: [json(fx.investorFiling)],
	},
	{
		name: "pricingPowerRecord",
		schema: contracts.pricingPowerRecordSchema,
		baselines: [json(fx.pricingPowerRecord)],
	},
	{
		name: "datasetCell",
		schema: contracts.datasetCellSchema,
		baselines: [
			{ v: 1.5, sourceId: "ev_1", asOf: "2026-10-01" },
			{ v: 2, basis: "derived" },
			{ v: "text" },
			{ v: null, reason: "No sourced baseline." },
			{ v: 3, sourceId: "ev_1", asOf: T0, basis: "assumption" },
		],
	},
	{
		name: "datasetColumn",
		schema: contracts.datasetColumnSchema,
		baselines: [
			{ key: "value", label: "Value", kind: "number", unit: "USD" },
			{ key: "name", label: "Name", kind: "text" },
		],
	},
	{ name: "dataset", schema: contracts.datasetSchema, baselines: [json(fx.dataset)] },
	{ name: "uiOperation", schema: contracts.uiOperationSchema, baselines: uiOperations },
	{
		name: "researchBundle",
		schema: contracts.researchBundleSchema,
		baselines: [json(fx.researchBundle), json(fx.emptyBundle)],
		// The records have their own vectors; here the bundle-level rules.
		options: { maxDepth: 2, maxCases: 350 },
		extra: [
			bundleWithCells(1, 250, 12),
			bundleWithCells(1, 251, 12),
			bundleWithCells(3, 100, 10),
			bundleWithCells(3, 101, 10),
			bundleWithCells(9, 1, 1),
			bundleWithCells(9, 300, 10),
		],
	},
	{
		name: "sourceFetchReport",
		schema: contracts.sourceFetchReportSchema,
		baselines: [json(fx.sourceReport)],
	},
	{
		name: "subscribedSourceRef",
		schema: contracts.subscribedSourceRefSchema,
		baselines: [json(fx.subscribedSource)],
	},
	{
		name: "claimJobRequest",
		schema: contracts.claimJobRequestSchema,
		baselines: [
			{ runnerVersion: "0.1.0", agents: [json(fx.agentDescriptor), json(unavailableAgent)] },
		],
	},
	{
		name: "workspaceComponentSummary",
		schema: contracts.workspaceComponentSummarySchema,
		baselines: [{ componentId: "table_1", componentType: "data-table", title: "Demand" }],
	},
	{
		name: "conversationContextMessage",
		schema: contracts.conversationContextMessageSchema,
		baselines: conversation,
	},
	{
		name: "conversationContext",
		schema: contracts.conversationContextSchema,
		baselines: [conversation, []],
		extra: [
			contextOfBytes("a".repeat(400), 6),
			contextOfBytes(`${"a".repeat(399)}é`, 6),
			contextOfBytes("😀".repeat(100), 6),
			contextOfBytes(`${"😀".repeat(100)}a`, 6),
			contextOfBytes("あ".repeat(160), 5),
			contextOfBytes("あ".repeat(161), 5),
			contextOfBytes("a".repeat(601), 7),
		],
	},
	{
		name: "claimedJob",
		schema: contracts.claimedJobSchema,
		baselines: claimedJobs,
		options: COMPOSITE,
		extra: GOOGLE_JOB_EDGES,
	},
	{
		name: "claimJobResponse",
		schema: contracts.claimJobResponseSchema,
		baselines: [
			{ job: null, pollAfterMs: 15_000 },
			...claimedJobs.map((job) => ({ job, pollAfterMs: 2_000 })),
		],
		options: { maxDepth: 2, maxCases: 1500 },
	},
	{
		name: "heartbeatRequest",
		schema: contracts.heartbeatRequestSchema,
		baselines: [{ leaseGeneration: 3 }],
	},
	{
		name: "heartbeatResponse",
		schema: contracts.heartbeatResponseSchema,
		baselines: [{ leaseExpiresAt: T1, cancelRequested: false }],
	},
	{
		name: "releaseJobRequest",
		schema: contracts.releaseJobRequestSchema,
		baselines: [{ leaseGeneration: 3, usage }],
	},
	{
		name: "releaseJobResponse",
		schema: contracts.releaseJobResponseSchema,
		baselines: [{ state: "pending" }, { state: "cancelled" }],
	},
	{
		name: "eventsResponse",
		schema: z.object({ cancelRequested: z.boolean() }),
		baselines: [{ cancelRequested: true }, { cancelRequested: false, extra: 1, more: { a: 1 } }],
	},
	{
		name: "runnerEvent",
		schema: contracts.runnerEventSchema,
		baselines: runnerEvents,
		extra: SIGN_IN_EDGES,
	},
	{
		name: "runnerEventsRequest",
		schema: contracts.runnerEventsRequestSchema,
		baselines: [{ leaseGeneration: 2, events: runnerEvents }],
		options: { maxDepth: 3 },
	},
	{
		name: "completeJobRequest",
		schema: contracts.completeJobRequestSchema,
		baselines: completions,
		options: { maxDepth: 3, maxCases: 900 },
		extra: DIRECTORY_COMPLETION_EDGES,
	},
	{
		name: "completeJobResponse",
		schema: contracts.completeJobResponseSchema,
		baselines: [{ state: "completed", replayed: false, newArticleCount: 3 }],
	},
	{ name: "marketSeriesMeta", schema: contracts.marketSeriesMetaSchema, baselines: [marketMeta] },
	{
		name: "marketObservation",
		schema: contracts.marketObservationSchema,
		baselines: [["2026-10-09", 17.5]],
		extra: [
			'["2026-10-09"]',
			'["2026-10-09",1,2]',
			'{"0":"2026-10-09","1":1}',
			'["2026-10-09",1e400]',
		],
	},
	{ name: "earningsEvent", schema: contracts.earningsEventSchema, baselines: [earningsEvent] },
	{
		name: "googleEventBody",
		schema: contracts.googleEventBodySchema,
		baselines: [
			eventBody,
			{
				...eventBody,
				privateProperties: {
					researchWorkspace: "earnings",
					stockId: "jp:130A",
					periodKey: "fy2026",
				},
			},
		],
	},
	{
		name: "widgetCore",
		schema: contracts.widgetCoreSchema,
		baselines: widgetCores,
		extra: scheduledTasksRejected,
	},
	{
		name: "notebookWidget",
		schema: contracts.notebookWidgetSchema,
		baselines: notebookWidgets,
		extra: scheduledTasksRejected.map((text) =>
			text.replace(
				"{",
				`{"createdAt":"2026-10-14T00:00:00.000Z","updatedAt":"2026-10-14T00:00:00.000Z","revision":1,"origin":${JSON.stringify(origin)},`,
			),
		),
	},
	{
		name: "notebook",
		schema: contracts.notebookSchema,
		baselines: [notebook, { widgets: [] }],
		options: { maxDepth: 3, maxCases: 350 },
	},
	{
		name: "issuedRunnerCredential",
		schema: contracts.issuedRunnerCredentialSchema,
		baselines: [credential],
	},
	{
		name: "apiErrorBody",
		schema: contracts.apiErrorBodySchema,
		baselines: [
			{ error: { code: "STALE_LEASE", message: "The lease is stale." } },
			{ error: { code: "UI_COMMAND_REJECTED", message: "x", detail: "UNKNOWN_COMPONENT" } },
		],
	},
	{
		name: "stockDirectoryEntry",
		schema: contracts.stockDirectoryEntrySchema,
		baselines: [usDirectoryEntry, jpDirectoryEntry],
	},
];
