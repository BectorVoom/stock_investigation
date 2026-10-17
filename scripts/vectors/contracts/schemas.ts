/**
 * The runner-reached zod schemas with their baselines (fixtures of the
 * contract and runner tests, plus values written here for shapes no
 * fixture covers) and hand-picked edge cases (refinement boundaries).
 * Each entry becomes `vectors/contracts/<name>.json`.
 */
import type { z } from "zod";
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
	capabilities: { supported: ["stream", "cancel", "tool-calls"], model: "opencode/gpt-5", models: ["a", "b-free"] },
	costModel: "metered",
	toolIsolation: "unverified",
	availability: { status: "unavailable", reasonCode: "NOT_INSTALLED", detail: "opencode was not found on PATH" },
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
	{ type: "tool.request", toolId: "news.search", args: { query: "batteries", limit: 5 }, callId: "call_1" },
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
];
