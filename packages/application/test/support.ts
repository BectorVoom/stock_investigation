import {
	type CollectedEvidence,
	createToolRegistry,
	defineTool,
	EMPTY_TOOL_OUTPUT,
	type ToolDefinition,
	type ToolRegistry,
} from "@research/agent-core";
import type {
	Evidence,
	Notebook,
	NotebookWidget,
	ResearchRequest,
	SubscribedSourceRef,
} from "@research/contracts";
import { type JobState, ok, type ResourceUsage, rankStockSearch } from "@research/domain";
import { z } from "zod";
import type {
	Clock,
	NotebookAssistTurnInput,
	PipelineReporter,
	ResearchRecordRepository,
	StockDirectoryMeta,
	StockDirectoryRepository,
	StoredStockDirectoryEntry,
} from "../src/index.ts";

/**
 * In-memory stock directory (ADR-0033). Search IS the domain reference
 * `rankStockSearch`, which the SQL repository is tested to equal, so a
 * service test over this fake sees exactly what the real store returns.
 */
export function inMemoryStockDirectory(
	rows: readonly StoredStockDirectoryEntry[],
	metas: readonly StockDirectoryMeta[] = [],
): StockDirectoryRepository {
	return {
		search: async (_ownerId, query) =>
			rankStockSearch(
				query.market === null ? rows : rows.filter((row) => row.market === query.market),
				query.text,
				query.limit,
			),
		getEntry: async (_ownerId, market, symbol) =>
			rows.find((row) => row.market === market && row.symbol === symbol) ?? null,
		listMeta: async () => [...metas].sort((a, b) => (a.market < b.market ? -1 : 1)),
	};
}

export const RUN_ID = "run_test";

export function fixedClock(startIso = "2026-10-11T00:00:00.000Z") {
	let nowMs = Date.parse(startIso);
	const clock: Clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
	return {
		clock,
		advance(ms: number) {
			nowMs += ms;
		},
	};
}

export const SOURCES: readonly SubscribedSourceRef[] = [
	{
		sourceId: "src_news",
		canonicalUrl: "https://news.example.org/feed.xml",
		publisher: "Example News",
		title: "Example News",
		licensePolicy: "short-excerpt-permitted",
	},
];

export function request(overrides: Partial<ResearchRequest> = {}): ResearchRequest {
	return {
		workspaceId: "ws_test",
		question: "Which storage products will see demand growth?",
		agentId: "scripted",
		model: null,
		effort: "medium",
		horizonYears: 4,
		markets: ["JP", "US"],
		budget: {
			maxAgentSteps: 6,
			maxToolCalls: 10,
			maxWallClockMs: 600_000,
			maxInputBytes: 400_000,
			maxSpendUsd: null,
		},
		webAccess: "off",
		...overrides,
	};
}

export const ARTICLE_TEXT =
	"Orders for grid storage reached 100 GWh in 2026, up from 70 GWh a year earlier. Example Storage Corp supplies battery systems to utilities. Analysts at a rival firm said demand could stall if subsidies lapse.";

export function evidenceItem(evidenceId: string, title: string, text: string): CollectedEvidence {
	const evidence: Evidence = {
		evidenceId,
		sourceUrl: `https://news.example.org/articles/${evidenceId}`,
		title,
		publisher: "Example News",
		publishedAt: "2026-10-01T00:00:00.000Z",
		retrievedAt: "2026-10-11T00:00:00.000Z",
		effectiveAt: null,
		excerpt: text.slice(0, 200),
		checksum: "b".repeat(64),
		sourceClass: "news",
	};
	return { evidence, retrievedText: text, retainQuotes: true };
}

export interface ToolSpy {
	readonly registry: ToolRegistry;
	/** toolId of every call that actually executed. */
	readonly executed: string[];
}

/**
 * A registry with one harmless news tool. `articleText` is what the tool
 * "retrieves" — tests put hostile instructions in it to model prompt injection.
 */
export function newsTools(
	articleText = ARTICLE_TEXT,
	extra: readonly ToolDefinition[] = [],
): ToolSpy {
	const executed: string[] = [];
	const fetchFeed = defineTool({
		toolId: "news.fetch_feed",
		version: "1",
		description: "Fetch a subscribed feed.",
		argsSchema: z.strictObject({ sourceId: z.string() }),
		argsHint: '{"sourceId": string}',
		timeoutMs: 5_000,
		permission: "research-read",
		costCategory: "free",
		sideEffect: "external-read",
		networkAllowlist: { kind: "subscribed-sources" },
		async execute(_args, context) {
			executed.push("news.fetch_feed");
			const item = evidenceItem(context.nextId("ev"), "Grid storage orders rise", articleText);
			return ok({
				...EMPTY_TOOL_OUTPUT,
				modelText: `[${item.evidence.evidenceId}] ${item.evidence.title}\n${articleText}`,
				evidence: [item],
			});
		},
	});
	return { registry: createToolRegistry([fetchFeed, ...extra]), executed };
}

export interface RecordedProgress {
	readonly states: JobState[];
	readonly notes: string[];
	readonly tools: { toolId: string; outcome: string; detail: string }[];
	readonly usage: ResourceUsage[];
}

export function recordingReporter(): PipelineReporter & { readonly recorded: RecordedProgress } {
	const recorded: RecordedProgress = { states: [], notes: [], tools: [], usage: [] };
	return {
		recorded,
		async state(state) {
			recorded.states.push(state);
		},
		async note(text) {
			recorded.notes.push(text);
		},
		async tool(toolId, outcome, detail) {
			recorded.tools.push({ toolId, outcome, detail });
		},
		async usage(usage) {
			recorded.usage.push(usage);
		},
	};
}

/** The id the news tool assigns to its first evidence item in a run. */
export const EV1 = `${RUN_ID}_ev1`;

export const PLAN = JSON.stringify({
	toolCalls: [{ toolId: "news.fetch_feed", args: { sourceId: "src_news" } }],
	done: true,
});

/** A well-formed analysis whose every citation is real and verbatim. */
export function analysis(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		claims: [
			{
				text: "Grid storage orders reached 100 GWh in 2026.",
				claimType: "observation",
				evidence: [
					{
						evidenceId: EV1,
						relation: "supports",
						quote: "Orders for grid storage reached 100 GWh in 2026",
					},
				],
			},
		],
		scenarios: [
			{
				productOrService: "Grid-scale battery storage",
				quantityKind: "unit-demand",
				unit: "GWh per year",
				baseYear: 2026,
				targetYear: 2030,
				baselineValue: 100,
				baselineEvidenceId: EV1,
				baselineQuote: "Orders for grid storage reached 100 GWh in 2026",
				bear: { targetValue: 146.41, assumptions: ["Permitting delays persist"] },
				base: { targetValue: 207.36, assumptions: ["Order trend continues"] },
				bull: { targetValue: 285.61, assumptions: ["Subsidies are extended"] },
				drivers: ["Renewable build-out"],
				barriers: ["Interconnection queues"],
				falsifiers: ["Orders fall for two consecutive years"],
				methodology: "Order-book extrapolation from the cited baseline.",
				supportingEvidenceIds: [EV1],
				contraryEvidenceIds: [EV1],
			},
		],
		suppliers: [
			{
				issuerName: "Example Storage Corp",
				ticker: "EXMP",
				exchange: "NASDAQ",
				country: "US",
				productsOrServices: ["Battery systems"],
				businessExposure: "Supplies battery systems to utilities.",
				scenarioIndex: 0,
				evidence: [
					{
						evidenceId: EV1,
						quote: "Example Storage Corp supplies battery systems to utilities",
					},
				],
			},
		],
		pricingPower: [],
		uiOperations: [],
		...overrides,
	});
}

export const VERDICT_SUPPORTED = JSON.stringify({
	verdicts: [{ claimIndex: 0, verdict: "supported" }],
});

/* ---------- Notebook-assistant fixtures (ADR-0020) ---------- */

const NOTEBOOK_STAMP = "2026-10-11T00:00:00.000Z";

function notebookMeta() {
	return {
		createdAt: NOTEBOOK_STAMP,
		updatedAt: NOTEBOOK_STAMP,
		revision: 1,
		origin: { kind: "owner" as const, messageId: null, runId: null, componentId: null },
	};
}

export function textWidget(
	widgetId: string,
	text: string,
	options: { readonly title?: string; readonly size?: NotebookWidget["size"] } = {},
): NotebookWidget {
	return {
		widgetId,
		title: options.title ?? `Title ${widgetId}`,
		size: options.size ?? "medium",
		...notebookMeta(),
		type: "text",
		text,
	};
}

export function chartWidget(
	widgetId: string,
	options: { readonly title?: string; readonly size?: NotebookWidget["size"] } = {},
): NotebookWidget {
	return {
		widgetId,
		title: options.title ?? `Title ${widgetId}`,
		size: options.size ?? "medium",
		...notebookMeta(),
		type: "chart",
		chartType: "line",
		unit: "USD",
		series: [
			{
				name: "Revenue",
				points: [
					{ x: "2022", y: 10 },
					{ x: "2023", y: 12 },
				],
			},
		],
	};
}

export function tableWidget(widgetId: string): NotebookWidget {
	return {
		widgetId,
		title: `Title ${widgetId}`,
		size: "medium",
		...notebookMeta(),
		type: "table",
		columns: ["Year", "Revenue"],
		rows: [
			["2022", 10],
			["2023", 12],
		],
	};
}

export function notebookFixture(widgets: readonly NotebookWidget[] = []): Notebook {
	return {
		widgets:
			widgets.length > 0
				? [...widgets]
				: [textWidget("w-text", "Body of w-text."), chartWidget("w-chart")],
	};
}

export function assistInput(
	options: {
		readonly runId?: string;
		readonly workspaceId?: string;
		readonly instruction?: string;
		readonly selectedWidgetIds?: readonly string[];
		readonly notebook?: Notebook;
		readonly notebookVersion?: number;
		readonly conversationContext?: NotebookAssistTurnInput["conversationContext"];
		readonly agent?: NotebookAssistTurnInput["agent"];
		readonly signal?: AbortSignal;
		readonly allowUnverifiedToolIsolation?: boolean;
	} = {},
): NotebookAssistTurnInput {
	const controller = new AbortController();
	return {
		kind: "notebook-assist",
		runId: options.runId ?? "run_notebook",
		leaseGeneration: 3,
		leaseExpiresAt: "2026-10-11T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		workspaceId: options.workspaceId ?? "ws_test",
		agent: options.agent ?? { agentId: "scripted", model: null, effort: "medium" },
		instruction: options.instruction ?? "Make it larger.",
		selectedWidgetIds: [...(options.selectedWidgetIds ?? [])],
		notebook: options.notebook ?? notebookFixture(),
		notebookVersion: options.notebookVersion ?? 4,
		conversationContext: options.conversationContext ?? [],
		signal: options.signal ?? controller.signal,
		allowUnverifiedToolIsolation: options.allowUnverifiedToolIsolation ?? false,
	};
}

/** The owner's evidence store for ADR-0026's source check: only these records resolve. */
export function recordsWith(
	evidence: readonly Evidence[] = [],
): Pick<ResearchRecordRepository, "resolve"> {
	return {
		resolve: async (_ownerId, lookup) => ({
			datasets: [],
			evidence: evidence.filter((record) => lookup.evidenceIds.includes(record.evidenceId)),
			claims: [],
		}),
	};
}
