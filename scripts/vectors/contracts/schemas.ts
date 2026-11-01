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
	{
		widgetId: "w-13",
		type: "task-result",
		title: "Morning brief",
		size: "medium",
		taskId: "task_1",
	},
	{ widgetId: "w-14", type: "task-result", title: "Brief", size: "large", taskId: "task_a.b:c-9" },
	{
		widgetId: "w-15",
		type: "watchlist-prices",
		title: "Semiconductors",
		size: "medium",
		listId: "list_1",
	},
	{ widgetId: "w-16", type: "watchlist-prices", title: "Banks", size: "small", listId: "l.a:b-9" },
	{
		widgetId: "w-17",
		type: "financial-statement",
		title: "Apple Inc.",
		size: "large",
		companyId: "eqc_1",
		statement: "income-statement",
		years: 5,
	},
	{
		widgetId: "w-18",
		type: "financial-statement",
		title: "Nintendo",
		size: "medium",
		companyId: "c.a:b-9",
		statement: "cash-flow",
		years: 2,
	},
	{
		widgetId: "w-19",
		type: "financial-statement",
		title: "Daikin",
		size: "large",
		companyId: "eqc_2",
		statement: "balance-sheet",
		years: 10,
	},
	{
		widgetId: "w-20",
		type: "financial-history",
		title: "Revenue",
		size: "small",
		companyId: "eqc_1",
		metric: "revenue",
		years: 15,
	},
	{
		widgetId: "w-21",
		type: "financial-history",
		title: "Ordinary income",
		size: "medium",
		companyId: "eqc_2",
		metric: "ordinary-income",
		years: 2,
	},
];
/** A scheduled-tasks widget has no content fields: any one is rejected (ADR-0033). */
const scheduledTasksRejected = [
	'{"widgetId":"w-11","type":"scheduled-tasks","title":"Tasks","size":"medium","daysAhead":30}',
	'{"widgetId":"w-11","type":"scheduled-tasks","title":"Tasks","size":"medium","tasks":[]}',
	'{"widgetId":"w-11","type":"scheduled-tasks","title":"Tasks","size":"huge"}',
	'{"widgetId":"w-11","type":"scheduled-task","title":"Tasks","size":"medium"}',
];
/** A task-result widget names exactly one task by an id (ADR-0038 §1). */
const taskResultRejected = [
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium"}',
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":""}',
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":"-task"}',
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":"task 1"}',
	`{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":"${"t".repeat(97)}"}`,
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":7}',
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":null}',
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":"task_1","text":"answer"}',
	'{"widgetId":"w-13","type":"task-result","title":"Brief","size":"medium","taskId":"task_1","seriesIds":[]}',
];
/** A watchlist-prices widget names exactly one list by an id and no series (ADR-0040 §5). */
const watchlistPricesRejected = [
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium"}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":""}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":"_list"}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":"list 1"}',
	`{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":"${"l".repeat(97)}"}`,
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":3}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":null}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"huge","listId":"list_1"}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"  ","size":"medium","listId":"list_1"}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":"list_1","seriesIds":["twelve-data:AAPL"]}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","listId":"list_1","stockIds":["us:AAPL"]}',
	'{"widgetId":"w-15","type":"watchlist-prices","title":"Banks","size":"medium","taskId":"list_1"}',
	'{"widgetId":"w-15","type":"watchlist-price","title":"Banks","size":"medium","listId":"list_1"}',
];
/**
 * A financial-statement widget names one tracked company, one statement and
 * 2–10 fiscal years; a financial-history widget one company, one metric and
 * 2–15 years (ADR-0048 §8).
 */
const STATEMENT_HEAD =
	'{"widgetId":"w-17","type":"financial-statement","title":"Apple","size":"large"';
const HISTORY_HEAD =
	'{"widgetId":"w-20","type":"financial-history","title":"Revenue","size":"medium"';
const financialRejected = [
	`${STATEMENT_HEAD},"statement":"income-statement","years":5}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","years":5}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","statement":"income-statement"}`,
	`${STATEMENT_HEAD},"companyId":"","statement":"income-statement","years":5}`,
	`${STATEMENT_HEAD},"companyId":"eqc 1","statement":"income-statement","years":5}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","statement":"equity","years":5}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","statement":"income-statement","years":1}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","statement":"income-statement","years":11}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","statement":"income-statement","years":5.5}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","statement":"income-statement","years":"5"}`,
	`${STATEMENT_HEAD},"companyId":"eqc_1","statement":"income-statement","years":5,"metric":"revenue"}`,
	'{"widgetId":"w-17","type":"financial-statement","title":"Apple","size":"huge","companyId":"eqc_1","statement":"income-statement","years":5}',
	`${HISTORY_HEAD},"companyId":"eqc_1","years":5}`,
	`${HISTORY_HEAD},"metric":"revenue","years":5}`,
	`${HISTORY_HEAD},"companyId":"eqc_1","metric":"net-income","years":5}`,
	`${HISTORY_HEAD},"companyId":"eqc_1","metric":"revenue","years":1}`,
	`${HISTORY_HEAD},"companyId":"eqc_1","metric":"revenue","years":16}`,
	`${HISTORY_HEAD},"companyId":"eqc_1","metric":"revenue","years":null}`,
	`${HISTORY_HEAD},"companyId":"eqc_1","metric":"revenue","years":5,"statement":"cash-flow"}`,
	`${HISTORY_HEAD},"companyId":"eqc_1","metric":"revenue","years":5,"seriesIds":[]}`,
];
const widgetRejected = [
	...scheduledTasksRejected,
	...taskResultRejected,
	...watchlistPricesRejected,
	...financialRejected,
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
/** ADR-0044: the stored observation a window refresh must reproduce. */
const historyAnchor = { observedOn: "2026-08-27", value: 15.25 };
/* ---------- stock-prices-sync claims and stock-prices-synced completions (ADR-0058 §2) ---------- */
const stockPricesUsClaim = {
	kind: "stock-prices-sync",
	...lease,
	market: "US",
	days: ["2026-10-30", "2026-10-29", "2026-10-28"],
	histories: [{ symbol: "BRK-B", from: "2024-11-01", to: "2026-10-30" }],
	adjustmentsSince: "2026-10-27",
	windowStart: "2024-11-01",
};
const stockPricesJpClaim = {
	kind: "stock-prices-sync",
	...lease,
	market: "JP",
	days: [],
	histories: [
		{ symbol: "1380", from: "2024-08-05", to: "2026-08-07" },
		{ symbol: "130A", from: "2024-08-05", to: "2026-08-07" },
	],
	adjustmentsSince: null,
	windowStart: "2024-08-05",
};
/** Claims the API must never send: each breaks one rule of `stockPricesClaimShape`. */
const STOCK_PRICES_CLAIM_EDGES: string[] = [
	JSON.stringify({ ...stockPricesJpClaim, histories: [] }),
	JSON.stringify({ ...stockPricesUsClaim, market: "EU" }),
	JSON.stringify({ ...stockPricesUsClaim, days: ["2026-02-30"] }),
	JSON.stringify({ ...stockPricesUsClaim, days: Array.from({ length: 11 }, () => "2026-10-30") }),
	JSON.stringify({ ...stockPricesUsClaim, histories: [{ symbol: "brk-b", from: "x", to: "y" }] }),
	JSON.stringify({
		...stockPricesUsClaim,
		histories: Array.from({ length: 11 }, () => stockPricesUsClaim.histories[0]),
	}),
	JSON.stringify({ ...stockPricesUsClaim, adjustmentsSince: undefined }),
	JSON.stringify({ ...stockPricesUsClaim, windowStart: null }),
	JSON.stringify({ ...stockPricesUsClaim, extra: 1 }),
];
const usDayBar = ["BRK-B", 412.5, [410, 415.25, 409.5, 3_120_455]];
const jpDayBar = ["130A", 1_204, [1_190, 1_210, 1_188, null]];
const usDayResults: Json[] = [
	{
		date: "2026-10-30",
		outcome: "stored",
		bars: [usDayBar, ["AAPL", 270.5, [268, 271, 267.5, 0]]],
	},
	{ date: "2026-10-29", outcome: "not-yet-available", bars: [], upstreamStatus: 403 },
	{ date: "2026-10-28", outcome: "no-trading", bars: [] },
	{ date: "2024-10-01", outcome: "too-old", bars: [], upstreamStatus: 403 },
];
const usHistoryResults: Json[] = [
	{
		symbol: "BRK-B",
		reason: "requested",
		outcome: "stored",
		from: "2024-11-01",
		to: "2026-10-30",
		bars: [["2026-10-30", 412.5, [410, 415.25, 409.5, 3_120_455]]],
	},
	{
		symbol: "NVDA",
		reason: "split",
		outcome: "not-found",
		from: "2024-11-01",
		to: "2026-10-30",
		bars: [],
	},
];
const stockPricesUsCompletion = {
	outcome: "stock-prices-synced",
	leaseGeneration: 1,
	usage,
	market: "US",
	provider: "massive",
	fetchedAt: T1,
	days: usDayResults,
	histories: usHistoryResults,
};
const stockPricesJpCompletion = {
	outcome: "stock-prices-synced",
	leaseGeneration: 1,
	usage,
	market: "JP",
	provider: "jquants",
	fetchedAt: T1,
	days: [{ date: "2026-08-07", outcome: "stored", bars: [jpDayBar] }],
	histories: [],
};
const stockPricesWith = (fields: object) =>
	JSON.stringify({ ...stockPricesUsCompletion, ...fields });
/** Completions the API must refuse: each breaks one rule of `stockPricesCompletionShape`. */
const STOCK_PRICES_COMPLETION_EDGES: string[] = [
	stockPricesWith({ provider: "jquants" }),
	JSON.stringify({ ...stockPricesJpCompletion, provider: "massive" }),
	stockPricesWith({
		days: [
			{ date: "2026-10-30", outcome: "no-trading", bars: [] },
			{ date: "2026-10-30", outcome: "too-old", bars: [] },
		],
	}),
	stockPricesWith({ days: [{ date: "2026-10-30", outcome: "stored", bars: [] }] }),
	stockPricesWith({ days: [{ date: "2026-10-30", outcome: "no-trading", bars: [usDayBar] }] }),
	stockPricesWith({
		days: [{ date: "2026-10-30", outcome: "stored", bars: [["BRK-B", 420, [410, 415, 409, 1]]] }],
	}),
	stockPricesWith({
		days: [{ date: "2026-10-30", outcome: "stored", bars: [["brk.b", 412, [410, 415, 409, 1]]] }],
	}),
	stockPricesWith({
		days: [{ date: "2026-10-30", outcome: "stored", bars: [["BRK-B", 412, [410, 415, 409]]] }],
	}),
	stockPricesWith({
		days: [{ date: "2026-10-30", outcome: "stored", bars: [["BRK-B", 412, [410, 415, 409, -1]]] }],
	}),
	stockPricesWith({
		days: [{ date: "2026-10-30", outcome: "too-old", bars: [], upstreamStatus: 99 }],
	}),
	stockPricesWith({
		days: [{ date: "2026-10-30", outcome: "too-old", bars: [], upstreamStatus: null }],
	}),
	stockPricesWith({ days: [{ date: "2026-10-30", outcome: "gone", bars: [] }] }),
	stockPricesWith({
		histories: [
			{
				symbol: "AAPL",
				reason: "requested",
				outcome: "not-found",
				from: "2024-11-01",
				to: "2026-10-30",
				bars: [["2026-10-30", 270, [268, 271, 267, 1]]],
			},
		],
	}),
	stockPricesWith({
		histories: [
			{
				symbol: "AAPL",
				reason: "requested",
				outcome: "stored",
				from: "2026-10-30",
				to: "2024-11-01",
				bars: [],
			},
		],
	}),
	stockPricesWith({
		histories: [
			{
				symbol: "AAPL",
				reason: "manual",
				outcome: "stored",
				from: "2024-11-01",
				to: "2026-10-30",
				bars: [],
			},
		],
	}),
	stockPricesWith({ fetchedAt: "2026-10-30" }),
	stockPricesWith({ market: "EU" }),
];
/* ---------- edinet-index claims and edinet-indexed completions (ADR-0058 §4) ---------- */
const edinetIndexClaim = {
	kind: "edinet-index",
	...lease,
	days: ["2025-06-30", "2025-06-27", "2025-06-26"],
};
const edinetIndexReport = {
	docId: "S100TR7I",
	secCode: "79740",
	edinetCode: "E02367",
	filerName: "任天堂株式会社",
	docTypeCode: "120",
	periodStart: "2024-04-01",
	periodEnd: "2025-03-31",
	submittedAt: "2025-06-27T15:00:00+09:00",
	parentDocId: null,
};
const edinetIndexAmendment = {
	...edinetIndexReport,
	docId: "S100TR8J",
	docTypeCode: "130",
	periodStart: null,
	periodEnd: null,
	submittedAt: "2025-06-27T16:30:00+09:00",
	parentDocId: "S100TR7I",
};
/** Claims the API must never send: each breaks one rule of `edinetIndexClaimShape`. */
const EDINET_INDEX_CLAIM_EDGES: string[] = [
	JSON.stringify({ ...edinetIndexClaim, days: [] }),
	JSON.stringify({ ...edinetIndexClaim, days: ["2025-06-31"] }),
	JSON.stringify({ ...edinetIndexClaim, days: Array.from({ length: 41 }, () => "2025-06-27") }),
	JSON.stringify({ ...edinetIndexClaim, days: undefined }),
	JSON.stringify({ ...edinetIndexClaim, extra: 1 }),
];
const edinetIndexCompletion = {
	outcome: "edinet-indexed",
	leaseGeneration: 1,
	usage,
	fetchedAt: T1,
	days: [
		{ date: "2025-06-27", documents: [edinetIndexReport, edinetIndexAmendment] },
		{ date: "2025-06-26", documents: [] },
	],
};
const edinetIndexWith = (fields: object) => JSON.stringify({ ...edinetIndexCompletion, ...fields });
const edinetIndexDocumentWith = (fields: object) =>
	edinetIndexWith({
		days: [{ date: "2025-06-27", documents: [{ ...edinetIndexReport, ...fields }] }],
	});
/** Completions the API must refuse: each breaks one rule of `edinetIndexCompletionShape`. */
const EDINET_INDEX_COMPLETION_EDGES: string[] = [
	edinetIndexWith({
		days: [
			{ date: "2025-06-27", documents: [] },
			{ date: "2025-06-27", documents: [] },
		],
	}),
	edinetIndexWith({
		days: [{ date: "2025-06-27", documents: [edinetIndexReport, edinetIndexReport] }],
	}),
	edinetIndexDocumentWith({ periodEnd: null }),
	edinetIndexDocumentWith({ docTypeCode: "140" }),
	edinetIndexDocumentWith({ secCode: "7974" }),
	edinetIndexDocumentWith({ secCode: "79741" }),
	edinetIndexDocumentWith({ edinetCode: "E2367" }),
	edinetIndexDocumentWith({ docId: "s100tr7i" }),
	edinetIndexDocumentWith({ filerName: "" }),
	edinetIndexDocumentWith({ filerName: "x".repeat(201) }),
	edinetIndexDocumentWith({ submittedAt: "2025-06-27 15:00" }),
	edinetIndexDocumentWith({ periodEnd: "2025-02-30" }),
	edinetIndexDocumentWith({ parentDocId: "bad" }),
	edinetIndexDocumentWith({ extra: 1 }),
	edinetIndexWith({ days: [{ date: "2025-06-31", documents: [] }] }),
	edinetIndexWith({
		days: Array.from({ length: 41 }, (_, day) => ({
			date: `2025-0${1 + Math.floor(day / 28)}-${String((day % 28) + 1).padStart(2, "0")}`,
			documents: [],
		})),
	}),
	edinetIndexWith({ fetchedAt: "2025-06-27" }),
	edinetIndexWith({ days: undefined }),
];
/* ---------- financial-sync claims and financial-synced completions (ADR-0048) ---------- */
const pendingFiling = {
	sourceDocumentId: "S100TR7I",
	form: "securities-report",
	filedOn: "2025-06-27",
	submittedAt: "2025-06-27T15:00:00+09:00",
	periodStart: "2024-04-01",
	periodEnd: "2025-03-31",
	amendsSourceDocumentId: null,
	sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100TR7I",
};
const financialSecClaim = {
	kind: "financial-sync",
	...lease,
	companyId: "eqc_1",
	market: "US",
	symbol: "AAPL",
	concepts: ["us-gaap:Assets", "us-gaap:Revenues"],
	source: {
		provider: "sec",
		cik: null,
		knownAccessions: ["0000320193-24-000123"],
		pendingFilings: [],
		filedSince: "2020-10-31",
		fullCheck: true,
		describedDocumentId: null,
	},
};
const financialEdinetClaim = {
	kind: "financial-sync",
	...lease,
	companyId: "eqc_2",
	market: "JP",
	symbol: "7974",
	concepts: ["jppfs_cor:NetSales"],
	source: {
		provider: "edinet",
		secCode: "79740",
		edinetCode: "E02367",
		knownFilings: [
			{ docId: "S100TR7I", periodStart: "2024-04-01", periodEnd: "2025-03-31" },
			{ docId: "S100SY24", periodStart: null, periodEnd: "2024-03-31" },
		],
		pendingFilings: [pendingFiling],
		indexedFilings: [
			{ ...pendingFiling, sourceDocumentId: "S100TR8J", submittedAt: "2025-06-30T09:00:00+09:00" },
		],
		describeFiling: pendingFiling,
	},
};
const withSource = (
	claim: typeof financialSecClaim | typeof financialEdinetClaim,
	source: object,
) => JSON.stringify({ ...claim, source: { ...claim.source, ...source } });
/** Claims the API must never send: each breaks one rule of `equitySyncClaimShape`. */
const FINANCIAL_CLAIM_EDGES: string[] = [
	JSON.stringify({ ...financialSecClaim, market: "JP" }),
	JSON.stringify({ ...financialEdinetClaim, market: "US" }),
	JSON.stringify({ ...financialSecClaim, concepts: [] }),
	JSON.stringify({ ...financialSecClaim, concepts: ["Revenues"] }),
	JSON.stringify({ ...financialSecClaim, concepts: ["us-gaap:Revenues extra"] }),
	JSON.stringify({ ...financialSecClaim, symbol: "" }),
	withSource(financialSecClaim, { cik: "320193" }),
	withSource(financialSecClaim, { knownAccessions: ["0000320193-24-123"] }),
	withSource(financialSecClaim, { filedSince: "2020-02-30" }),
	withSource(financialSecClaim, { fullCheck: "yes" }),
	withSource(financialSecClaim, { extra: 1 }),
	// ADR-0053: the described 10-K is an accession or null, and the field is required.
	withSource(financialSecClaim, { describedDocumentId: "0000320193-24-123" }),
	withSource(financialSecClaim, { describedDocumentId: "S100TR7I" }),
	JSON.stringify({
		...financialSecClaim,
		source: { ...financialSecClaim.source, describedDocumentId: undefined },
	}),
	withSource(financialEdinetClaim, { secCode: "7974" }),
	withSource(financialEdinetClaim, { edinetCode: "E2367" }),
	withSource(financialEdinetClaim, {
		knownFilings: [{ docId: "s100tr7i", periodStart: null, periodEnd: "2025-03-31" }],
	}),
	withSource(financialEdinetClaim, { knownFilings: [{ docId: "S100TR7I", periodStart: null }] }),
	withSource(financialEdinetClaim, {
		knownFilings: [{ docId: "S100TR7I", periodStart: null, periodEnd: "2025-02-30" }],
	}),
	withSource(financialEdinetClaim, {
		knownFilings: [{ docId: "S100TR7I", periodStart: null, periodEnd: "2025-03-31", extra: 1 }],
	}),
	withSource(financialEdinetClaim, {
		knownFilings: Array.from({ length: 401 }, () => ({
			docId: "S100TR7I",
			periodStart: null,
			periodEnd: "2025-03-31",
		})),
	}),
	// The field it replaced: a strict object refuses it.
	withSource(financialEdinetClaim, { knownDocIds: [] }),
	// ADR-0058 §4: the per-company day scan is gone; a strict object refuses it.
	withSource(financialEdinetClaim, { scanDays: ["2025-06-27"] }),
	withSource(financialEdinetClaim, { indexedFilings: [{ ...pendingFiling, periodEnd: null }] }),
	withSource(financialEdinetClaim, {
		indexedFilings: Array.from({ length: 21 }, () => pendingFiling),
	}),
	JSON.stringify({
		...financialEdinetClaim,
		source: { ...financialEdinetClaim.source, indexedFilings: undefined },
	}),
	withSource(financialEdinetClaim, { pendingFilings: [{ ...pendingFiling, extra: 1 }] }),
	// ADR-0053: the report to describe is a whole pending-filing record, or null.
	withSource(financialEdinetClaim, { describeFiling: { ...pendingFiling, filedOn: "2025-06-31" } }),
	withSource(financialEdinetClaim, { describeFiling: { docId: "S100TR7I" } }),
	JSON.stringify({
		...financialEdinetClaim,
		source: { ...financialEdinetClaim.source, describeFiling: undefined },
	}),
	withSource(financialEdinetClaim, {
		pendingFilings: [{ ...pendingFiling, sourceUrl: "http://x.test/" }],
	}),
];
const secFact = {
	concept: "us-gaap:Revenues",
	unit: "USD",
	valueDecimal: "391035000000",
	periodType: "duration",
	periodStart: "2023-10-01",
	periodEnd: "2024-09-28",
	scope: "consolidated",
};
const secInstant = {
	concept: "us-gaap:Assets",
	unit: "USD",
	valueDecimal: "364980000000.5",
	periodType: "instant",
	periodStart: null,
	periodEnd: "2024-09-28",
	scope: "consolidated",
};
const secFiling = {
	sourceDocumentId: "0000320193-24-000123",
	form: "10-K",
	filedOn: "2024-11-01",
	submittedAt: "2024-11-01T06:01:36.000Z",
	periodStart: null,
	periodEnd: "2024-09-28",
	amendsSourceDocumentId: null,
	sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
	accountingStandard: "US-GAAP",
	factsStatus: "extracted",
	facts: [secFact, secInstant],
};
/** ADR-0053: the business section of the 10-K above, read into paragraphs. */
const secDescription = {
	source: {
		sourceDocumentId: "0000320193-24-000123",
		form: "10-K",
		filedOn: "2024-11-01",
		periodEnd: "2024-09-28",
		sourceUrl:
			"https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
	},
	status: "extracted",
	paragraphs: [
		{ kind: "heading", text: "Company Background" },
		{
			kind: "text",
			text: "The Company designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories.",
		},
		{ kind: "text", text: "• iPhone" },
	],
	truncated: true,
};
const edinetNotFound = {
	source: {
		sourceDocumentId: "S100TR7I",
		form: "securities-report",
		filedOn: "2025-06-27",
		periodEnd: "2025-03-31",
		sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100TR7I",
	},
	status: "not-found",
	paragraphs: [],
	truncated: false,
};
const edinetDescription = {
	...edinetNotFound,
	status: "extracted",
	paragraphs: [
		{ kind: "heading", text: "事業の内容" },
		{
			kind: "text",
			text: "当社グループは、家庭用ゲーム機の開発、製造及び販売を主な事業としております。",
		},
	],
};
const descriptionWith = (fields: object) => ({ ...secDescription, ...fields });
/** Business descriptions zod refuses: each breaks one rule of `equityBusinessDescriptionSchema`. */
const BUSINESS_DESCRIPTION_EDGES: string[] = [
	JSON.stringify(descriptionWith({ paragraphs: [{ kind: "heading", text: "Overview" }] })),
	JSON.stringify(descriptionWith({ paragraphs: [] })),
	JSON.stringify({ ...edinetNotFound, truncated: true }),
	JSON.stringify({ ...edinetNotFound, paragraphs: edinetDescription.paragraphs }),
	JSON.stringify(
		descriptionWith({
			paragraphs: [
				{ kind: "text", text: "a".repeat(15_000) },
				{ kind: "text", text: "b".repeat(5_001) },
			],
		}),
	),
	// Both refinements fail: zod reports each.
	JSON.stringify({
		...edinetNotFound,
		paragraphs: [
			{ kind: "text", text: "😀".repeat(5_000) },
			{ kind: "text", text: "b".repeat(10_001) },
		],
	}),
	JSON.stringify(
		descriptionWith({
			paragraphs: [
				{ kind: "text", text: "a".repeat(10_000) },
				{ kind: "text", text: "b".repeat(10_000) },
			],
		}),
	),
	JSON.stringify(
		descriptionWith({
			paragraphs: Array.from({ length: 401 }, () => ({ kind: "text", text: "Line." })),
		}),
	),
	JSON.stringify(
		descriptionWith({
			paragraphs: Array.from({ length: 400 }, () => ({ kind: "text", text: "Line." })),
		}),
	),
	JSON.stringify(descriptionWith({ paragraphs: [{ kind: "list", text: "Line." }] })),
	JSON.stringify(descriptionWith({ paragraphs: [{ kind: "text", text: "" }] })),
	JSON.stringify(descriptionWith({ source: { ...secDescription.source, form: "10-K/A" } })),
	JSON.stringify(
		descriptionWith({ source: { ...secDescription.source, sourceUrl: "http://x.test/" } }),
	),
	JSON.stringify(descriptionWith({ status: "pending" })),
];
const financialSecCompletion = {
	outcome: "financial-synced",
	leaseGeneration: 1,
	usage,
	companyId: "eqc_1",
	provider: "sec",
	fetchedAt: T1,
	identity: { sourceCompanyId: "0000320193", name: "Apple Inc.", fiscalYearEnd: "09-28" },
	filings: [
		secFiling,
		{
			...secFiling,
			sourceDocumentId: "0000320193-25-000008",
			form: "10-K/A",
			filedOn: "2025-01-31",
			submittedAt: null,
			accountingStandard: null,
			factsStatus: "not-available",
			facts: [],
		},
	],
	more: false,
	description: secDescription,
};
const financialEdinetCompletion = {
	outcome: "financial-synced",
	leaseGeneration: 1,
	usage,
	companyId: "eqc_2",
	provider: "edinet",
	fetchedAt: T1,
	identity: null,
	filings: [
		{
			...pendingFiling,
			form: "amended-securities-report",
			amendsSourceDocumentId: "S100TR00",
			accountingStandard: null,
			factsStatus: "deferred",
			facts: [],
		},
	],
	more: true,
	description: null,
};
const secCompletionWith = (fields: object) =>
	JSON.stringify({ ...financialSecCompletion, ...fields });
const secFilingWith = (fields: object) =>
	secCompletionWith({ filings: [{ ...secFiling, ...fields }] });
/** Completions the API refuses: each breaks one rule of `equitySyncCompletionShape`. */
const FINANCIAL_COMPLETION_EDGES: string[] = [
	// ADR-0058 §4: no date is reported scanned any more; a strict object refuses it.
	secCompletionWith({ scannedDays: [] }),
	secCompletionWith({ identity: { sourceCompanyId: "E02367", name: null, fiscalYearEnd: null } }),
	JSON.stringify({
		...financialEdinetCompletion,
		identity: { sourceCompanyId: "0000320193", name: null, fiscalYearEnd: null },
	}),
	secCompletionWith({
		identity: { sourceCompanyId: "0000320193", name: " ", fiscalYearEnd: "02-30x" },
	}),
	secCompletionWith({ filings: [secFiling, secFiling] }),
	secFilingWith({ sourceDocumentId: "S100TR7I" }),
	secFilingWith({ form: "securities-report" }),
	secFilingWith({ factsStatus: "not-available" }),
	secFilingWith({ facts: [{ ...secInstant, periodStart: "2024-09-28" }] }),
	secFilingWith({ facts: [{ ...secFact, periodStart: null }] }),
	secFilingWith({ facts: [{ ...secFact, periodStart: "2024-10-01" }] }),
	secFilingWith({ facts: [{ ...secFact, valueDecimal: "1.0" }] }),
	secFilingWith({ facts: [{ ...secFact, valueDecimal: "1e3" }] }),
	secFilingWith({ facts: [{ ...secFact, concept: "Revenues" }] }),
	secFilingWith({ facts: [{ ...secFact, scope: "parent" }] }),
	secFilingWith({ sourceUrl: "http://www.sec.gov/x" }),
	secFilingWith({ filedOn: "2024-11-31" }),
	secCompletionWith({ provider: "edinet" }),
	secCompletionWith({ more: "no" }),
	// ADR-0053: the description's filing must be the provider's original annual report.
	secCompletionWith({ description: edinetDescription }),
	secCompletionWith({
		description: descriptionWith({
			source: { ...secDescription.source, sourceDocumentId: "S100TR7I" },
		}),
	}),
	secCompletionWith({
		description: descriptionWith({
			source: { ...secDescription.source, form: "securities-report" },
		}),
	}),
	JSON.stringify({ ...financialEdinetCompletion, description: secDescription }),
	JSON.stringify({
		...financialEdinetCompletion,
		description: { ...edinetDescription, source: { ...edinetDescription.source, form: "10-K" } },
	}),
	secCompletionWith({ description: descriptionWith({ paragraphs: [] }) }),
	secCompletionWith({ description: undefined }),
	secCompletionWith({
		filings: [{ ...secFiling, facts: Array.from({ length: 3001 }, () => secFact) }],
	}),
	secCompletionWith({
		filings: [
			{ ...secFiling, facts: Array.from({ length: 1500 }, () => secFact) },
			{
				...secFiling,
				sourceDocumentId: "0000320193-23-000106",
				facts: Array.from({ length: 1501 }, () => secFact),
			},
		],
	}),
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
			{
				seriesId: "fred:VIXCLS",
				latestObservedOn: "2026-10-10",
				anchor: historyAnchor,
				fullCheck: false,
			},
			{ seriesId: "twelve-data:AAPL", latestObservedOn: null, anchor: null, fullCheck: false },
			{
				seriesId: "fred:CPIAUCSL",
				latestObservedOn: "2026-09-01",
				anchor: { observedOn: "2024-01-01", value: -0.5 },
				fullCheck: true,
			},
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
	financialSecClaim,
	financialEdinetClaim,
	{
		...financialSecClaim,
		source: { ...financialSecClaim.source, describedDocumentId: "0000320193-24-000123" },
	},
	{ ...financialEdinetClaim, source: { ...financialEdinetClaim.source, describeFiling: null } },
	stockPricesUsClaim,
	stockPricesJpClaim,
	{ ...stockPricesUsClaim, histories: [], adjustmentsSince: null },
	edinetIndexClaim,
	{ ...edinetIndexClaim, days: ["2025-06-27"] },
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
				history: { mode: "window", replaceFrom: "2026-10-09" },
			},
			{
				seriesId: "twelve-data:AAPL",
				fetchedAt: T1,
				meta: null,
				observations: [],
				errorCode: "SOURCE_NOT_CONFIGURED",
			},
			{
				seriesId: "fred:CPIAUCSL",
				fetchedAt: T1,
				meta: marketMeta,
				observations: [["2026-09-01", 320.5]],
				errorCode: null,
				history: { mode: "full", replaceFrom: null },
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
	financialSecCompletion,
	financialEdinetCompletion,
	{ ...financialEdinetCompletion, description: edinetDescription },
	{ ...financialEdinetCompletion, description: edinetNotFound },
	{ ...financialSecCompletion, description: null },
	stockPricesUsCompletion,
	stockPricesJpCompletion,
	{ ...stockPricesJpCompletion, days: [], histories: [] },
	edinetIndexCompletion,
	{ ...edinetIndexCompletion, days: [] },
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

/* ---------- Market history (ADR-0044) ---------- */

function marketClaim(series: Json[]): string {
	return JSON.stringify({ kind: "market-refresh", ...lease, series });
}
const claimSeries = {
	seriesId: "fred:VIXCLS",
	latestObservedOn: "2026-10-10",
	anchor: historyAnchor,
	fullCheck: false,
};
/** The claim's anchor and full-check flag at their edges. */
const MARKET_CLAIM_EDGES: string[] = [
	marketClaim([{ ...claimSeries, anchor: null, fullCheck: true }]),
	marketClaim([{ ...claimSeries, anchor: null, fullCheck: false }]),
	marketClaim([claimSeries, { ...claimSeries, anchor: null, fullCheck: true, extra: 1 }]),
	marketClaim([{ ...claimSeries, anchor: { ...historyAnchor, extra: 1 } }]),
	marketClaim([{ ...claimSeries, anchor: { observedOn: "2026-02-30", value: 1 } }]),
	marketClaim([{ ...claimSeries, anchor: { observedOn: "2026-08-27" } }]),
	marketClaim([{ ...claimSeries, anchor: { observedOn: "2026-08-27", value: "1" } }]),
	marketClaim([{ ...claimSeries, fullCheck: "true" }]),
	marketClaim([{ seriesId: "fred:VIXCLS", latestObservedOn: null }]),
	// The anchor key itself missing (not null).
	marketClaim([
		{
			seriesId: claimSeries.seriesId,
			latestObservedOn: claimSeries.latestObservedOn,
			fullCheck: true,
		},
	]),
	// JSON.stringify cannot write a non-finite number; this text parses to Infinity.
	marketClaim([claimSeries]).replace('"value":15.25', '"value":1e400'),
];

function marketCompletion(series: Json[]): string {
	return JSON.stringify({ outcome: "market-refreshed", leaseGeneration: 1, usage, series });
}
const refreshed = {
	seriesId: "fred:VIXCLS",
	fetchedAt: T1,
	meta: {
		title: "CBOE Volatility Index: VIX",
		unit: "Index",
		frequency: "daily",
		publisher: "Federal Reserve Bank of St. Louis",
		sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
	},
	observations: [
		["2026-10-09", 17.5],
		["2026-10-10", 18],
	],
	errorCode: null,
};
const failedRefresh = {
	seriesId: "twelve-data:AAPL",
	fetchedAt: T1,
	meta: null,
	observations: [],
	errorCode: "RATE_LIMITED",
	upstreamStatus: 429,
};
/** The completion's history write: where it may appear and what it may replace. */
const MARKET_COMPLETION_EDGES: string[] = [
	marketCompletion([{ ...refreshed, history: { mode: "window", replaceFrom: "2026-10-10" } }]),
	marketCompletion([{ ...refreshed, history: { mode: "full", replaceFrom: "2026-10-09" } }]),
	marketCompletion([{ ...refreshed, history: { mode: "full", replaceFrom: null } }]),
	marketCompletion([{ ...refreshed, history: { mode: "window", replaceFrom: "2026-10-08" } }]),
	marketCompletion([{ ...refreshed, history: { mode: "full", replaceFrom: "2026-10-11" } }]),
	marketCompletion([{ ...refreshed, history: { mode: "window", replaceFrom: null } }]),
	marketCompletion([{ ...refreshed, history: { mode: "window" } }]),
	marketCompletion([{ ...refreshed, history: { mode: "partial", replaceFrom: null } }]),
	marketCompletion([{ ...refreshed, history: { mode: "full", replaceFrom: null, extra: 1 } }]),
	marketCompletion([{ ...refreshed, history: null }]),
	marketCompletion([{ ...refreshed, history: { mode: "full", replaceFrom: "2026-02-30" } }]),
	marketCompletion([
		{ ...refreshed, observations: [], history: { mode: "full", replaceFrom: null } },
	]),
	marketCompletion([{ ...failedRefresh, history: { mode: "full", replaceFrom: null } }]),
	// Both refinements fail: the error carries observations and a history.
	marketCompletion([
		{
			...failedRefresh,
			observations: [["2026-10-09", 1]],
			history: { mode: "window", replaceFrom: "2026-10-09" },
		},
	]),
	marketCompletion([
		refreshed,
		failedRefresh,
		{
			...refreshed,
			seriesId: "fred:DGS10",
			history: { mode: "window", replaceFrom: "2026-10-09" },
		},
	]),
	// Each series at most once: two writes for one series would not merge entry by entry.
	marketCompletion([
		{ ...refreshed, history: { mode: "full", replaceFrom: null } },
		{ ...refreshed, seriesId: "fred:DGS10", history: { mode: "full", replaceFrom: null } },
	]),
	marketCompletion([
		{ ...refreshed, history: { mode: "full", replaceFrom: null } },
		{ ...refreshed, history: { mode: "full", replaceFrom: null } },
	]),
	marketCompletion([refreshed, { ...failedRefresh, seriesId: "fred:VIXCLS" }]),
];

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
		extra: [
			...GOOGLE_JOB_EDGES,
			...MARKET_CLAIM_EDGES,
			...FINANCIAL_CLAIM_EDGES,
			...STOCK_PRICES_CLAIM_EDGES,
			...EDINET_INDEX_CLAIM_EDGES,
		],
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
		extra: [
			...DIRECTORY_COMPLETION_EDGES,
			...MARKET_COMPLETION_EDGES,
			...FINANCIAL_COMPLETION_EDGES,
			...STOCK_PRICES_COMPLETION_EDGES,
			...EDINET_INDEX_COMPLETION_EDGES,
		],
	},
	{
		name: "completeJobResponse",
		schema: contracts.completeJobResponseSchema,
		baselines: [{ state: "completed", replayed: false, newArticleCount: 3 }],
	},
	{ name: "marketSeriesMeta", schema: contracts.marketSeriesMetaSchema, baselines: [marketMeta] },
	{
		name: "marketHistoryAnchor",
		schema: contracts.marketHistoryAnchorSchema,
		baselines: [historyAnchor, { observedOn: "2024-02-29", value: -0.5 }],
		extra: [
			'{"observedOn":"2026-08-27","value":1e400}',
			'{"observedOn":"2026-08-27","value":-1e400}',
		],
	},
	{
		name: "marketHistoryWrite",
		schema: contracts.marketHistoryWriteSchema,
		baselines: [
			{ mode: "window", replaceFrom: "2026-10-09" },
			{ mode: "full", replaceFrom: "2026-10-09" },
			{ mode: "full", replaceFrom: null },
		],
		extra: ['{"mode":"window","replaceFrom":null}', '{"replaceFrom":null}', '{"mode":"full"}'],
	},
	{
		name: "marketBar",
		schema: contracts.marketBarSchema,
		baselines: [
			[410.5, 415.25, 409, 21458123],
			[149.1, 149.9, 148.7, null],
		],
		extra: [
			"[1,2,3]",
			"[1,2,3,4,5]",
			"[1,2,3,-1]",
			"[1,2,3,-0]",
			"[1,2,3,0]",
			"[1e400,2,3,4]",
			"[1,2,3,1e400]",
			'["1",2,3,4]',
			"[null,null,null,null]",
			"null",
			"{}",
		],
	},
	{
		name: "marketObservation",
		schema: contracts.marketObservationSchema,
		baselines: [
			["2026-10-09", 17.5],
			["2026-10-09", 412, [410.5, 415.25, 409, 21458123]],
			["2026-10-09", 149.5, [149.1, 149.9, 148.7, null]],
		],
		extra: [
			'["2026-10-09"]',
			'["2026-10-09",1,2]',
			'{"0":"2026-10-09","1":1}',
			'["2026-10-09",1e400]',
			// ADR-0056: the optional bar and its consistency refinement.
			'["2026-10-09",1,null]',
			'["2026-10-09",1,[1,1,1,null]]',
			'["2026-10-09",1,[1,1,1,0]]',
			'["2026-10-09",5,[4,6,3,10]]',
			'["2026-10-09",7,[4,6,3,10]]',
			'["2026-10-09",2,[4,6,3,10]]',
			'["2026-10-09",5,[7,6,3,10]]',
			'["2026-10-09",5,[2,6,3,10]]',
			'["2026-10-09",5,[4,3,6,10]]',
			'["2026-10-09",7,[4,6,3,-1]]',
			'["2026-10-09",5,[4,6,3,-1]]',
			'["2026-10-09",5,[4,6,3]]',
			'["2026-10-09",5,[4,6,3,10,1]]',
			'["2026-10-09",7,[4,6,3,10,1]]',
			'["2026-10-09",5,[4,6,3,10],1]',
			'["2026-10-09",7,[4,6,3,10],1]',
			'["2026-10-09",5,[4,6,3,10],1,2]',
			'["2026-10-09",5,[4,6,1e400,10]]',
			'["2026-10-09",5,[4,6,3,1e400]]',
			'["2026-10-09",1e400,[4,6,3,10]]',
			'["2026-02-30",7,[4,6,3,10]]',
			'["2026-02-30",5,[4,6,3,10]]',
			"[5,7,[4,6,3,10]]",
			'["2026-10-09","5",[4,6,3,10]]',
			'["2026-10-09",5,{"0":4,"1":6,"2":3,"3":10}]',
			'["2026-10-09",5,[4,6,3,"10"]]',
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
		extra: widgetRejected,
	},
	{
		name: "notebookWidget",
		schema: contracts.notebookWidgetSchema,
		baselines: notebookWidgets,
		extra: widgetRejected.map((text) =>
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
	{
		name: "edinetIndexDocument",
		schema: contracts.edinetIndexDocumentSchema,
		baselines: [edinetIndexReport, edinetIndexAmendment],
	},
	{
		name: "edinetIndexDayResult",
		schema: contracts.edinetIndexDayResultSchema,
		baselines: edinetIndexCompletion.days,
	},
	{
		name: "stockDayBar",
		schema: contracts.stockDayBarSchema,
		baselines: [usDayBar, jpDayBar],
		extra: ['["BRK-B",420,[410,415,409,1]]', '["",1,[1,1,1,null]]', '["A",1,[1,1,1,null],1]'],
	},
	{
		name: "stockHistoryBar",
		schema: contracts.stockHistoryBarSchema,
		baselines: [["2026-10-30", 412.5, [410, 415.25, 409.5, 3_120_455]]],
		extra: ['["2026-02-30",1,[1,1,1,null]]', '["2026-10-30",1,[2,3,1,null]]'],
	},
	{
		name: "stockHistoryRequest",
		schema: contracts.stockHistoryRequestSchema,
		baselines: stockPricesUsClaim.histories,
	},
	{
		name: "stockPriceDayResult",
		schema: contracts.stockPriceDayResultSchema,
		baselines: usDayResults,
	},
	{
		name: "stockHistoryResult",
		schema: contracts.stockHistoryResultSchema,
		baselines: usHistoryResults,
	},
	{
		name: "equityBusinessDescription",
		schema: contracts.equityBusinessDescriptionSchema,
		baselines: [secDescription, edinetDescription, edinetNotFound],
		extra: BUSINESS_DESCRIPTION_EDGES,
	},
];
