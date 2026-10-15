import {
	type AgentSettings,
	type AgentSettingsResponse,
	type AgentsResponse,
	agentSettingsResponseSchema,
	agentSettingsSchema,
	agentsResponseSchema,
	type Conversation,
	type ConversationSummary,
	conversationResponseSchema,
	conversationSummarySchema,
	type ResearchRun,
	researchRunSchema,
	type WorkspaceSummary,
	type WorkspaceView,
	workspaceSummarySchema,
	workspaceViewSchema,
} from "@research/contracts";

/** Fixtures are parsed with the contract schemas, so they are valid API payloads by construction. */

export const WORKSPACE_ID = "ws_1";
export const WORKSPACE_ID_2 = "ws_2";

export const WORKSPACE_SUMMARY: WorkspaceSummary = workspaceSummarySchema.parse({
	workspaceId: WORKSPACE_ID,
	title: "Grid storage research",
	version: 4,
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-05T00:00:00Z",
});

export const WORKSPACE_VIEW: WorkspaceView = workspaceViewSchema.parse({
	workspace: WORKSPACE_SUMMARY,
	state: {
		workspaceId: WORKSPACE_ID,
		version: 4,
		components: [
			{
				componentId: "run_1_news",
				componentType: "news-card",
				schemaVersion: 1,
				props: {
					headline: "Utilities accelerate storage tenders",
					sourceId: "ev_a",
					summary: "Three utilities announced tenders.",
				},
			},
			{
				componentId: "run_1_table",
				componentType: "data-table",
				schemaVersion: 1,
				props: { title: "Demand scenarios", datasetRef: "ds_demand", sourceIds: ["ev_a"] },
			},
			{
				componentId: "run_1_sources",
				componentType: "source-list",
				schemaVersion: 1,
				props: { title: "Key sources", sourceIds: ["ev_a"] },
			},
		],
		layout: { order: ["run_1_news", "run_1_table", "run_1_sources"], columns: 1 },
		focusedComponentId: null,
		selection: null,
		lastNavigation: null,
	},
	datasets: [
		{
			datasetId: "ds_demand",
			title: "Grid storage demand by year",
			createdAt: "2026-10-03T00:00:00Z",
			columns: [
				{ key: "year", label: "Year", kind: "text" },
				{ key: "base", label: "Base case", kind: "number", unit: "GWh" },
			],
			rows: [
				{ year: { v: "2026" }, base: { v: 120, sourceId: "ev_a", asOf: "2026-06-30" } },
				{ year: { v: "2027" }, base: { v: null, reason: "not yet published" } },
			],
		},
	],
	sources: [
		{
			evidenceId: "ev_a",
			sourceUrl: "https://example.com/reports/grid-storage",
			title: "Grid storage outlook 2026",
			publisher: "Example Energy Review",
			publishedAt: "2026-09-01T09:00:00Z",
			retrievedAt: "2026-10-01T08:30:00Z",
			effectiveAt: null,
			excerpt: null,
			checksum: "a".repeat(64),
			sourceClass: "news",
		},
	],
});

export const CONVERSATION: Conversation = conversationResponseSchema.parse({
	messages: [
		{
			messageId: "msg_1",
			seq: 0,
			role: "owner",
			text: "Where will storage demand grow?",
			runId: "run_1",
			claimIds: [],
			createdAt: "2026-10-04T00:00:00Z",
		},
		{
			messageId: "msg_2",
			seq: 1,
			role: "assistant",
			text: "Utility tenders are rising.\nSee the linked claims.",
			runId: "run_1",
			claimIds: ["claim_1", "claim_2"],
			createdAt: "2026-10-04T00:10:00Z",
		},
	],
	claims: [
		{
			claimId: "claim_1",
			text: "Utility tenders rose year over year.",
			claimType: "observation",
			status: "supported",
			links: [{ evidenceId: "ev_a", relation: "supports", quote: null }],
			issues: [],
		},
		{
			claimId: "claim_2",
			text: "Demand will triple by 2030.",
			claimType: "forecast",
			status: "unsupported",
			links: [],
			issues: [{ code: "NO_SUPPORTING_EVIDENCE" }],
		},
	],
	evidence: WORKSPACE_VIEW.sources,
	hasEarlier: false,
});

export const WORKSPACE_SUMMARY_2: WorkspaceSummary = workspaceSummarySchema.parse({
	workspaceId: WORKSPACE_ID_2,
	title: "Second research",
	version: 1,
	createdAt: "2026-10-06T00:00:00Z",
	updatedAt: "2026-10-06T00:00:00Z",
});

export const WORKSPACE_VIEW_2: WorkspaceView = workspaceViewSchema.parse({
	workspace: WORKSPACE_SUMMARY_2,
	state: {
		workspaceId: WORKSPACE_ID_2,
		version: 1,
		components: [],
		layout: { order: [], columns: 1 },
		focusedComponentId: null,
		selection: null,
		lastNavigation: null,
	},
	datasets: [],
	sources: [],
});

export const CONVERSATION_2: Conversation = conversationResponseSchema.parse({
	messages: [
		{
			messageId: "msg_2_1",
			seq: 0,
			role: "owner",
			text: "Second question?",
			runId: null,
			claimIds: [],
			createdAt: "2026-10-06T00:00:00Z",
		},
	],
	claims: [],
	evidence: [],
	hasEarlier: false,
});

function conversationSummary(data: unknown): ConversationSummary {
	return conversationSummarySchema.parse(data);
}

export const CONVERSATION_SUMMARY_1: ConversationSummary = conversationSummary({
	workspaceId: WORKSPACE_ID,
	title: "Grid storage research",
	messageCount: 2,
	lastMessageAt: "2026-10-04T00:10:00Z",
	lastMessageRole: "assistant",
	lastMessagePreview: "Utility tenders are rising.",
	lastActivityAt: "2026-10-04T00:10:00Z",
});

export const CONVERSATION_SUMMARY_2: ConversationSummary = conversationSummary({
	workspaceId: WORKSPACE_ID_2,
	title: "Second research",
	messageCount: 1,
	lastMessageAt: "2026-10-06T00:00:00Z",
	lastMessageRole: "owner",
	lastMessagePreview: "Second question?",
	lastActivityAt: "2026-10-06T00:00:00Z",
});

/** Newest activity first, as the API returns it. */
export const CONVERSATION_SUMMARIES: readonly ConversationSummary[] = [
	CONVERSATION_SUMMARY_2,
	CONVERSATION_SUMMARY_1,
];

export const DEFAULT_BUDGET = {
	maxAgentSteps: 6,
	maxToolCalls: 20,
	maxWallClockMs: 600_000,
	maxInputBytes: 400_000,
	maxSpendUsd: null,
} as const;

/** What a completed run records about how its result was produced (AGT-010). */
export const RUN_PROVENANCE = {
	agentId: "claude-code",
	providerModel: "example-model-1",
	promptVersion: "research-v3",
	toolVersions: { "news.search": "1.2.0", "finance.metrics": "0.9.1" },
	dataCutoffAt: "2026-10-04T00:05:00Z",
} as const;

/** A completed, published run by default; override `provenance: null` for runs with no result yet. */
export function makeRun(overrides: Partial<ResearchRun> = {}): ResearchRun {
	return researchRunSchema.parse({
		runId: "run_1",
		kind: "research",
		workspaceId: WORKSPACE_ID,
		state: "completed",
		request: {
			workspaceId: WORKSPACE_ID,
			question: "Where will storage demand grow?",
			agentId: "claude-code",
			model: null,
			effort: "medium",
			horizonYears: 5,
			markets: ["JP", "US"],
			budget: DEFAULT_BUDGET,
			webAccess: "off",
		},
		usage: {
			agentSteps: 3,
			toolCalls: 7,
			inputBytes: 52_000,
			knownCostUsd: 0,
			hasUnmeteredUsage: true,
		},
		cost: { status: "unknown-plan-limited", totalCostUsd: null, meteredPortionUsd: 0 },
		attempt: 1,
		maxAttempts: 3,
		leaseExpiresAt: null,
		cancelRequested: false,
		failureCode: null,
		failureDetail: null,
		approvalRequest: null,
		retryOfRunId: null,
		verificationStatus: "verified",
		providerModel: null,
		provenance: RUN_PROVENANCE,
		createdAt: "2026-10-04T00:00:00Z",
		updatedAt: "2026-10-04T00:10:00Z",
		progress: [{ at: "2026-10-04T00:01:00Z", kind: "state", text: "planning" }],
		...overrides,
	});
}

const CAPABILITIES = { supported: ["tool-calls", "cancel"] };

export const AGENTS: AgentsResponse = agentsResponseSchema.parse({
	runnerOnline: true,
	runnerLastSeenAt: "2026-10-05T00:00:00Z",
	agents: [
		{
			agentId: "claude-code",
			displayName: "Claude Code",
			capabilities: CAPABILITIES,
			costModel: "plan-limited",
			toolIsolation: "enforced",
			availability: { status: "available" },
		},
		{
			agentId: "openrouter",
			displayName: "OpenRouter",
			capabilities: CAPABILITIES,
			costModel: "metered",
			toolIsolation: "enforced",
			availability: { status: "available" },
		},
		{
			agentId: "codex",
			displayName: "Codex",
			capabilities: CAPABILITIES,
			costModel: "plan-limited",
			toolIsolation: "unverified",
			availability: {
				status: "unavailable",
				reasonCode: "NOT_INSTALLED",
				detail: "codex binary not found on PATH",
			},
		},
	],
});

export const NO_RUNNER_AGENTS: AgentsResponse = agentsResponseSchema.parse({
	runnerOnline: false,
	runnerLastSeenAt: null,
	agents: [],
});

/** Saved agent choices (Settings → AI agent) pointing at a plan-limited backend. */
export const AGENT_SETTINGS: AgentSettings = agentSettingsSchema.parse({
	defaultAgentId: "claude-code",
	models: {},
	effort: "medium",
	budget: { ...DEFAULT_BUDGET },
	webAccess: "off",
});

export const AGENT_SETTINGS_RESPONSE: AgentSettingsResponse = agentSettingsResponseSchema.parse({
	settings: AGENT_SETTINGS,
	updatedAt: "2026-10-05T00:00:00Z",
	origin: "saved",
});
