import { z } from "zod";
import { jsonValueSchema, upstreamStatusSchema } from "./primitives.ts";

/**
 * Agent backend id. Deliberately an open string rather than a closed union so a
 * new backend can be registered without touching the contracts (FR-013); the
 * four V1 backends are listed in BASELINE_AGENT_IDS.
 */
export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "invalid agent id");
export type AgentId = z.infer<typeof agentIdSchema>;

/**
 * Single source of truth for "is this an OpenCode free-tier model id".
 * The provider marks free-tier ids with a `-free` suffix; the OpenCode
 * adapter and the web settings form both branch on this rule.
 */
export function isFreeTierModelId(modelId: string): boolean {
	return modelId.endsWith("-free");
}

export const BASELINE_AGENT_IDS = ["opencode", "codex", "claude-code", "openrouter"] as const;

/** Agent id of the OpenRouter free-models backend: plan-limited, free ids only. */
export const OPENROUTER_FREE_AGENT_ID = "openrouter-free" as const;

/**
 * Agent id of the Claude API backend: Anthropic's Messages API over HTTPS,
 * metered and billed to the owner's Anthropic account (ANTHROPIC_API_KEY).
 * Distinct from "claude-code", which runs the `claude` CLI on a subscription.
 */
export const CLAUDE_API_AGENT_ID = "claude-api" as const;

/** Router id that selects a free model on the owner's behalf. */
export const OPENROUTER_FREE_ROUTER_MODEL_ID = "openrouter/free" as const;

/**
 * True for the model ids the free backend may run: the free router itself,
 * or an id ending in `:free` with at least one character before it. No
 * trimming, case-sensitive: a billed id must never pass by accident.
 */
export function isOpenRouterFreeModelId(modelId: string): boolean {
	if (modelId === OPENROUTER_FREE_ROUTER_MODEL_ID) return true;
	return modelId.length > ":free".length && modelId.endsWith(":free");
}

export const capabilitySchema = z.enum([
	"stream",
	"cancel",
	"tool-calls",
	"structured-output",
	"image-input",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const agentCapabilitiesSchema = z.strictObject({
	supported: z.array(capabilitySchema).max(8).readonly(),
	model: z.string().max(100).optional(),
	/**
	 * Model ids this backend can be asked for, as reported by the runner's
	 * probe (e.g. `opencode models`). Absent when the backend cannot list
	 * them; the list may be incomplete, so typing a model stays possible.
	 */
	models: z.array(z.string().min(1).max(100)).max(300).optional(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/** How a backend is billed. "plan-limited" cost is unknown and must never be shown as $0. */
export const costModelSchema = z.enum(["metered", "plan-limited"]);
export type CostModel = z.infer<typeof costModelSchema>;

/**
 * Whether the backend can be prevented from using its own shell/file/network
 * tools. Anything but "enforced" is unsuitable for untrusted-source research.
 */
export const toolIsolationSchema = z.enum(["enforced", "unverified"]);
export type ToolIsolation = z.infer<typeof toolIsolationSchema>;

export const agentAvailabilitySchema = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("available") }),
	z.strictObject({
		status: z.literal("unavailable"),
		reasonCode: z.enum([
			"NOT_INSTALLED",
			"NOT_AUTHENTICATED",
			"NOT_CONFIGURED",
			"UNSUPPORTED_VERSION",
			"TOOL_ISOLATION_UNVERIFIED",
			"PROBE_FAILED",
		]),
		detail: z.string().max(300),
	}),
]);
export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;

export const agentDescriptorSchema = z.strictObject({
	agentId: agentIdSchema,
	displayName: z.string().min(1).max(60),
	capabilities: agentCapabilitiesSchema,
	costModel: costModelSchema,
	toolIsolation: toolIsolationSchema,
	availability: agentAvailabilitySchema,
});
export type AgentDescriptor = z.infer<typeof agentDescriptorSchema>;

export const agentRequestSchema = z.strictObject({
	runId: z.string().min(1).max(96),
	conversationId: z.string().min(1).max(96),
	prompt: z.string().min(1),
	permittedToolIds: z.array(z.string().max(80)).readonly(),
	maxToolCalls: z.number().int().nonnegative(),
	deadline: z.iso.datetime({ offset: true }),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;

/** Events an adapter may emit. Provider-native shapes never cross this boundary (AGT-002). */
export const agentEventSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("text.delta"), text: z.string() }),
	z.strictObject({
		type: z.literal("tool.request"),
		toolId: z.string().max(80),
		args: jsonValueSchema,
		callId: z.string().min(1).max(96),
	}),
	z.strictObject({
		type: z.literal("tool.result"),
		callId: z.string().min(1).max(96),
		resultRef: z.string().max(200),
	}),
	z.strictObject({ type: z.literal("ui.command"), command: jsonValueSchema }),
	z.strictObject({ type: z.literal("usage"), knownCostUsd: z.number().nonnegative().nullable() }),
	z.strictObject({ type: z.literal("completed") }),
	z.strictObject({
		type: z.literal("failed"),
		code: z.string().min(1).max(60),
		retryable: z.boolean(),
		/**
		 * The status the model provider's API answered with when it caused the
		 * failure, unchanged (docs/rule/error_handling.md §4a). Absent otherwise.
		 */
		upstreamStatus: upstreamStatusSchema.optional(),
	}),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
