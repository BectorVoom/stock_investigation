import { describe, expect, it } from "vitest";
import {
	agentAvailabilitySchema,
	agentCapabilitiesSchema,
	agentDescriptorSchema,
	agentEventSchema,
	agentIdSchema,
	agentRequestSchema,
	BASELINE_AGENT_IDS,
	capabilitySchema,
	costModelSchema,
	isFreeTierModelId,
	isOpenRouterFreeModelId,
	OPENROUTER_FREE_AGENT_ID,
	OPENROUTER_FREE_ROUTER_MODEL_ID,
	toolIsolationSchema,
} from "../src/index.ts";
import { agentDescriptor } from "./fixtures.ts";
import { expectAccepted, expectRejected, without } from "./support.ts";

describe("agent identity and capabilities (FR-012 / FR-013)", () => {
	it("lists the four V1 backends, all of which are valid agent ids", () => {
		expect([...BASELINE_AGENT_IDS].sort()).toEqual([
			"claude-code",
			"codex",
			"opencode",
			"openrouter",
		]);
		for (const agentId of BASELINE_AGENT_IDS) expectAccepted(agentIdSchema, agentId);
	});

	it("accepts a new backend id without a contract change", () => {
		expectAccepted(agentIdSchema, "local-llm-2");
	});

	it.each([
		"",
		"a",
		"Codex",
		"open_code",
		"-codex",
		"9lives",
		"codex ",
		"x".repeat(33),
		"../etc",
	])("rejects the malformed agent id %j", (agentId) => {
		expectRejected(agentIdSchema, agentId);
	});

	it("accepts exactly the five documented capabilities", () => {
		expect([...capabilitySchema.options].sort()).toEqual(
			["cancel", "image-input", "stream", "structured-output", "tool-calls"].sort(),
		);
		expectRejected(capabilitySchema, "shell");
		expectRejected(capabilitySchema, "file-write");
	});

	it("accepts a capability set, including an empty one", () => {
		expectAccepted(agentCapabilitiesSchema, { supported: [] });
		expectAccepted(agentCapabilitiesSchema, {
			supported: ["stream", "cancel"],
			model: "some-model",
		});
	});

	it("accepts a runner-reported model list and omits it when the backend cannot list models", () => {
		expectAccepted(agentCapabilitiesSchema, {
			supported: [],
			models: ["opencode/model-a", "opencode/model-b"],
		});
		expectAccepted(agentCapabilitiesSchema, { supported: [] });
	});

	it("rejects an overlong model list or an empty model id", () => {
		expectRejected(agentCapabilitiesSchema, {
			supported: [],
			models: ["ok/model", ""],
		});
		expectRejected(agentCapabilitiesSchema, {
			supported: [],
			models: Array.from({ length: 301 }, (_, index) => `opencode/model-${index}`),
		});
	});

	it("rejects unknown capabilities and extra keys", () => {
		expectRejected(agentCapabilitiesSchema, { supported: ["stream", "telepathy"] }, [
			"supported",
			1,
		]);
		expectRejected(agentCapabilitiesSchema, { supported: [], sandbox: false });
		expectRejected(agentCapabilitiesSchema, {}, ["supported"]);
	});

	it("knows only metered and plan-limited cost models, never 'free'", () => {
		expectAccepted(costModelSchema, "metered");
		expectAccepted(costModelSchema, "plan-limited");
		expectRejected(costModelSchema, "free");
		expectRejected(costModelSchema, "unlimited");
	});

	it("knows only enforced and unverified tool isolation", () => {
		expectAccepted(toolIsolationSchema, "enforced");
		expectAccepted(toolIsolationSchema, "unverified");
		expectRejected(toolIsolationSchema, "trusted");
	});

	it("names the OpenRouter free-models backend and its router model", () => {
		expect(OPENROUTER_FREE_AGENT_ID).toBe("openrouter-free");
		expect(OPENROUTER_FREE_ROUTER_MODEL_ID).toBe("openrouter/free");
		expectAccepted(agentIdSchema, OPENROUTER_FREE_AGENT_ID);
	});

	it.each([
		"google/gemma-4-31b-it:free",
		"openrouter/free",
	])("accepts the free model id %j", (modelId) => {
		expect(isOpenRouterFreeModelId(modelId)).toBe(true);
	});

	it.each([
		"",
		":free",
		"google/gemma-4-31b-it",
		"x:free ",
		"X:FREE",
		"opencode/muse-spark-1.3-contributor-free",
	])("rejects the non-free model id %j", (modelId) => {
		expect(isOpenRouterFreeModelId(modelId)).toBe(false);
	});
});

describe("agentAvailabilitySchema", () => {
	it("accepts available", () => {
		expectAccepted(agentAvailabilitySchema, { status: "available" });
	});

	it.each([
		"NOT_INSTALLED",
		"NOT_AUTHENTICATED",
		"NOT_CONFIGURED",
		"UNSUPPORTED_VERSION",
		"TOOL_ISOLATION_UNVERIFIED",
		"PROBE_FAILED",
	])("accepts unavailable with reason %s", (reasonCode) => {
		expectAccepted(agentAvailabilitySchema, {
			status: "unavailable",
			reasonCode,
			detail: "see docs",
		});
	});

	it("requires an unavailable backend to say why", () => {
		expectRejected(agentAvailabilitySchema, { status: "unavailable" });
		expectRejected(agentAvailabilitySchema, {
			status: "unavailable",
			reasonCode: "BROKEN",
			detail: "",
		});
		expectRejected(agentAvailabilitySchema, { status: "unavailable", reasonCode: "NOT_INSTALLED" });
	});

	it("rejects unknown statuses and a reason on an available backend", () => {
		expectRejected(agentAvailabilitySchema, { status: "maybe" });
		expectRejected(agentAvailabilitySchema, { status: "available", reasonCode: "NOT_INSTALLED" });
		expectRejected(agentAvailabilitySchema, {});
	});
});

describe("agentDescriptorSchema", () => {
	it("accepts an available and an unavailable backend", () => {
		expectAccepted(agentDescriptorSchema, agentDescriptor);
		expectAccepted(agentDescriptorSchema, {
			...agentDescriptor,
			agentId: "codex",
			displayName: "Codex",
			toolIsolation: "unverified",
			availability: {
				status: "unavailable",
				reasonCode: "NOT_INSTALLED",
				detail: "codex not on PATH",
			},
		});
	});

	it("requires cost model and tool isolation to be declared", () => {
		expectRejected(agentDescriptorSchema, without(agentDescriptor, "costModel"), ["costModel"]);
		expectRejected(agentDescriptorSchema, without(agentDescriptor, "toolIsolation"), [
			"toolIsolation",
		]);
		expectRejected(agentDescriptorSchema, without(agentDescriptor, "availability"), [
			"availability",
		]);
	});

	it("rejects credentials or other extra fields on a descriptor", () => {
		expectRejected(agentDescriptorSchema, { ...agentDescriptor, apiKey: "sk-test" });
		expectRejected(agentDescriptorSchema, { ...agentDescriptor, displayName: "" }, ["displayName"]);
	});
});

describe("agentRequestSchema", () => {
	const request = {
		runId: "run_1",
		conversationId: "conv_1",
		prompt: "Summarize the evidence.",
		permittedToolIds: ["news.search"],
		maxToolCalls: 5,
		deadline: "2026-10-11T00:10:00Z",
	};

	it("accepts the common request contract", () => {
		expectAccepted(agentRequestSchema, request);
		expectAccepted(agentRequestSchema, { ...request, permittedToolIds: [], maxToolCalls: 0 });
	});

	it("requires an explicit tool allowlist, call ceiling and deadline", () => {
		expectRejected(agentRequestSchema, without(request, "permittedToolIds"), ["permittedToolIds"]);
		expectRejected(agentRequestSchema, without(request, "maxToolCalls"), ["maxToolCalls"]);
		expectRejected(agentRequestSchema, without(request, "deadline"), ["deadline"]);
	});

	it("rejects negative, fractional or unbounded tool-call ceilings", () => {
		for (const maxToolCalls of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, "5"]) {
			expectRejected(agentRequestSchema, { ...request, maxToolCalls }, ["maxToolCalls"]);
		}
	});

	it("rejects an empty prompt, a malformed deadline and extra keys", () => {
		expectRejected(agentRequestSchema, { ...request, prompt: "" }, ["prompt"]);
		expectRejected(agentRequestSchema, { ...request, deadline: "soon" }, ["deadline"]);
		expectRejected(agentRequestSchema, { ...request, allowShell: true });
	});
});

describe("agentEventSchema (AGT-002)", () => {
	it.each([
		{ type: "text.delta", text: "partial" },
		{ type: "text.delta", text: "" },
		{ type: "tool.request", toolId: "news.search", args: { query: "batteries" }, callId: "call_1" },
		{ type: "tool.request", toolId: "news.search", args: null, callId: "call_1" },
		{ type: "tool.result", callId: "call_1", resultRef: "run_1_res1" },
		{ type: "ui.command", command: { operation: "component.remove", componentId: "x" } },
		{ type: "usage", knownCostUsd: 0.0123 },
		{ type: "usage", knownCostUsd: 0 },
		{ type: "usage", knownCostUsd: null },
		{ type: "completed" },
		{ type: "failed", code: "PROVIDER_TIMEOUT", retryable: true },
	])("accepts %j", (event) => {
		expectAccepted(agentEventSchema, event);
	});

	it("rejects unknown event types", () => {
		for (const type of ["shell.exec", "file.write", "text", "done", ""]) {
			expectRejected(agentEventSchema, { type });
		}
		expectRejected(agentEventSchema, {});
		expectRejected(agentEventSchema, null);
		expectRejected(agentEventSchema, "completed");
	});

	it("rejects provider-native extra fields on every event type", () => {
		expectRejected(agentEventSchema, { type: "text.delta", text: "x", raw: { id: "provider" } });
		expectRejected(agentEventSchema, { type: "completed", stopReason: "end_turn" });
		expectRejected(agentEventSchema, {
			type: "failed",
			code: "X",
			retryable: false,
			stack: "trace",
		});
		expectRejected(agentEventSchema, { type: "usage", knownCostUsd: null, inputTokens: 5 });
	});

	it("requires an unknown cost to be an explicit null, never omitted or negative", () => {
		expectRejected(agentEventSchema, { type: "usage" }, ["knownCostUsd"]);
		expectRejected(agentEventSchema, { type: "usage", knownCostUsd: -0.01 }, ["knownCostUsd"]);
		expectRejected(agentEventSchema, { type: "usage", knownCostUsd: "0" }, ["knownCostUsd"]);
		expectRejected(agentEventSchema, { type: "usage", knownCostUsd: Number.NaN }, ["knownCostUsd"]);
	});

	it("requires a call id on tool requests and results", () => {
		expectRejected(agentEventSchema, { type: "tool.request", toolId: "t", args: {} }, ["callId"]);
		expectRejected(agentEventSchema, { type: "tool.request", toolId: "t", args: {}, callId: "" }, [
			"callId",
		]);
		expectRejected(agentEventSchema, { type: "tool.result", resultRef: "r" }, ["callId"]);
	});

	it("requires tool arguments to be JSON data", () => {
		expectRejected(agentEventSchema, { type: "tool.request", toolId: "t", callId: "c" }, ["args"]);
		expectRejected(agentEventSchema, {
			type: "tool.request",
			toolId: "t",
			callId: "c",
			args: { run: () => "code" },
		});
	});

	it("requires a failure to say whether it is retryable", () => {
		expectRejected(agentEventSchema, { type: "failed", code: "X" }, ["retryable"]);
		expectRejected(agentEventSchema, { type: "failed", code: "", retryable: true }, ["code"]);
		expectRejected(agentEventSchema, { type: "failed", code: "X", retryable: "yes" }, [
			"retryable",
		]);
	});
});

describe("isFreeTierModelId (shared OpenCode free-tier rule)", () => {
	it.each([
		["opencode/muse-spark-1.3-contributor-free", true],
		["provider/model-free", true],
		["provider/model", false],
		["provider/free-model", false],
		["", false],
		["-free", true],
	])("reports %j as free-tier: %s", (modelId, expected) => {
		expect(isFreeTierModelId(modelId)).toBe(expected);
	});
});
