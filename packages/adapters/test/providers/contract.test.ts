/**
 * Contract tests across all four adapters (AGT-001/002, FR-012/013): whatever
 * a provider does, the events that leave an adapter satisfy the shared schema
 * and the stream shape, and no adapter advertises a capability it lacks.
 */
import { type AgentRuntime, createAgentRegistry, parseAgentEvent } from "@research/agent-core";
import {
	type AgentEvent,
	agentDescriptorSchema,
	agentEventSchema,
	BASELINE_AGENT_IDS,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	createAgentRuntimes,
	createBaselineAgentRuntimes,
	createClaudeApiRuntime,
	createClaudeCodeRuntime,
	createCodexRuntime,
	createOpenCodeRuntime,
	createOpenRouterFreeRuntime,
	createOpenRouterRuntime,
	type ProviderEnvironment,
} from "../../src/providers/index.ts";
import {
	BASE_ENV,
	collect,
	createFakeProcessRunner,
	type FakeProcessScript,
	fixtureLines,
	fixtureText,
	makeContext,
	makeEnvironment,
	makeRequest,
} from "./helpers.ts";

const OPENROUTER_ENV = {
	...BASE_ENV,
	OPENROUTER_API_KEY: "sk-or-v1-TEST-KEY-0123456789abcdef",
	OPENROUTER_MODEL: "example/model",
};

const OPENROUTER_FREE_ENV = {
	...BASE_ENV,
	OPENROUTER_API_KEY: "sk-or-v1-TEST-KEY-0123456789abcdef",
	OPENROUTER_FREE_MODEL: "example/model:free",
};

const CLAUDE_API_ENV = {
	...BASE_ENV,
	ANTHROPIC_API_KEY: "sk-ant-api03-TEST-KEY-0123456789abcdef",
};

interface Scenario {
	readonly name: string;
	readonly runtime: AgentRuntime;
	readonly deadline?: string;
	readonly aborted?: boolean;
	readonly model?: string | null;
	/** Research tools the request permits (none unless a scenario needs them). */
	readonly permittedToolIds?: readonly string[];
}

function cliScenario(
	name: string,
	create: (environment: ProviderEnvironment) => AgentRuntime,
	script: FakeProcessScript,
	extra: Partial<Scenario> = {},
): Scenario {
	const runtime = create(
		makeEnvironment({ processRunner: createFakeProcessRunner(script).runner }),
	);
	return { name, runtime, ...extra };
}

function claudeApiScenario(
	name: string,
	respond: () => Response,
	extra: Partial<Scenario> = {},
): Scenario {
	const runtime = createClaudeApiRuntime(
		makeEnvironment({ env: CLAUDE_API_ENV, fetch: () => Promise.resolve(respond()) }),
	);
	return { name, runtime, ...extra };
}

function openRouterScenario(
	name: string,
	respond: () => Response,
	extra: Partial<Scenario> = {},
): Scenario {
	const runtime = createOpenRouterRuntime(
		makeEnvironment({ env: OPENROUTER_ENV, fetch: () => Promise.resolve(respond()) }),
	);
	return { name, runtime, ...extra };
}

function openRouterFreeScenario(
	name: string,
	respond: () => Response,
	extra: Partial<Scenario> = {},
): Scenario {
	const runtime = createOpenRouterFreeRuntime(
		makeEnvironment({
			env: OPENROUTER_FREE_ENV,
			fetch: () => Promise.resolve(respond()),
		}),
		{ catalog: { list: () => Promise.resolve(null) } },
	);
	return { name, runtime, model: "example/model:free", ...extra };
}

const createOpenCode = (environment: ProviderEnvironment): AgentRuntime =>
	createOpenCodeRuntime(environment, { writeConfigFile: () => Promise.resolve() });

const sse = (body: string): Response =>
	new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

const GARBAGE = Array.from({ length: 40 }, (_, index) => `\u0000garbage ${index} {{{`);

const SCENARIOS: readonly Scenario[] = [
	cliScenario("opencode ok", createOpenCode, { lines: fixtureLines("opencode/ok.jsonl") }),
	cliScenario("opencode no-tools attempt", createOpenCode, {
		lines: fixtureLines("opencode/no-tools-attempt.jsonl"),
	}),
	cliScenario("opencode model unavailable", createOpenCode, {
		lines: fixtureLines("opencode/model-unavailable.jsonl"),
		exit: { code: 1 },
	}),
	cliScenario("opencode garbage", createOpenCode, { lines: GARBAGE }),
	cliScenario(
		"opencode free-tier native tool call",
		createOpenCode,
		{ lines: fixtureLines("opencode/free-tier-native-tool-call.jsonl"), hang: true },
		{
			model: "opencode/nemotron-3.5-lightning-free",
			permittedToolIds: ["web.search", "web.fetch_page"],
		},
	),
	cliScenario("opencode not installed", createOpenCode, { spawnErrorCode: "ENOENT" }),
	cliScenario(
		"opencode past deadline",
		createOpenCode,
		{},
		{ deadline: "2020-01-01T00:00:00.000Z" },
	),
	cliScenario("codex ok", createCodexRuntime, { lines: fixtureLines("codex/ok.jsonl") }),
	cliScenario("codex tool attempt", createCodexRuntime, {
		lines: fixtureLines("codex/tool-attempt.jsonl"),
	}),
	cliScenario("codex not logged in", createCodexRuntime, {
		lines: fixtureLines("codex/not-logged-in.jsonl"),
		exit: { code: 1 },
	}),
	cliScenario("codex garbage", createCodexRuntime, { lines: GARBAGE }),
	cliScenario("codex killed by a signal", createCodexRuntime, {
		exit: { code: null, signal: "SIGKILL" },
	}),
	cliScenario("codex aborted", createCodexRuntime, { hang: true }, { aborted: true }),
	cliScenario("claude ok", createClaudeCodeRuntime, {
		lines: fixtureLines("claude-code/ok.stream.jsonl"),
	}),
	cliScenario("claude no-tools attempt", createClaudeCodeRuntime, {
		lines: fixtureLines("claude-code/no-tools-attempt.stream.jsonl"),
	}),
	cliScenario("claude not logged in", createClaudeCodeRuntime, {
		lines: fixtureLines("claude-code/not-logged-in.stream.jsonl"),
		exit: { code: 1 },
	}),
	cliScenario("claude garbage", createClaudeCodeRuntime, { lines: GARBAGE }),
	cliScenario("claude metered API-key auth", createClaudeCodeRuntime, {
		lines: [
			JSON.stringify({
				type: "system",
				subtype: "init",
				tools: [],
				mcp_servers: [],
				apiKeySource: "ANTHROPIC_API_KEY",
			}),
		],
		hang: true,
	}),
	cliScenario("claude non-zero exit", createClaudeCodeRuntime, {
		exit: { code: 137, stderrTail: "killed" },
	}),
	cliScenario("claude not installed", createClaudeCodeRuntime, { spawnErrorCode: "ENOENT" }),
	openRouterScenario("openrouter ok", () => sse(fixtureText("openrouter/ok.sse"))),
	openRouterScenario("openrouter no cost", () => sse(fixtureText("openrouter/ok-no-cost.sse"))),
	openRouterScenario("openrouter mid-stream error", () =>
		sse(fixtureText("openrouter/midstream-error.sse")),
	),
	// A Retry-After beyond what a turn waits out: reported at once, with no backoff to wait for.
	openRouterScenario(
		"openrouter 429",
		() => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }),
	),
	openRouterScenario("openrouter garbage", () =>
		sse(GARBAGE.map((line) => `data: ${line}\n\n`).join("")),
	),
	openRouterScenario("openrouter past deadline", () => sse(""), {
		deadline: "2020-01-01T00:00:00.000Z",
	}),
	{
		name: "openrouter not configured",
		runtime: createOpenRouterRuntime(makeEnvironment({ env: BASE_ENV })),
	},
	openRouterFreeScenario("openrouter-free ok", () => sse(fixtureText("openrouter/ok-no-cost.sse"))),
	openRouterFreeScenario("openrouter-free garbage", () =>
		sse(GARBAGE.map((line) => `data: ${line}\n\n`).join("")),
	),
	{
		name: "openrouter-free not configured",
		runtime: createOpenRouterFreeRuntime(makeEnvironment({ env: BASE_ENV })),
	},
	claudeApiScenario("claude-api ok", () => sse(fixtureText("claude-api/ok.sse"))),
	claudeApiScenario("claude-api refusal", () => sse(fixtureText("claude-api/refusal.sse"))),
	claudeApiScenario("claude-api mid-stream error", () =>
		sse(fixtureText("claude-api/midstream-error.sse")),
	),
	claudeApiScenario("claude-api tool use", () => sse(fixtureText("claude-api/tool-use.sse"))),
	claudeApiScenario(
		"claude-api 529",
		() => new Response("{}", { status: 529, headers: { "Retry-After": "3600" } }),
	),
	claudeApiScenario("claude-api garbage", () =>
		sse(GARBAGE.map((line) => `data: ${line}\n\n`).join("")),
	),
	claudeApiScenario("claude-api unpriced model", () => sse(""), { model: "claude-unknown-9" }),
	{
		name: "claude-api not configured",
		runtime: createClaudeApiRuntime(makeEnvironment({ env: BASE_ENV })),
	},
];

const HTTP_AGENT_IDS: ReadonlySet<string> = new Set([
	"openrouter",
	"openrouter-free",
	"claude-api",
]);

async function runScenario(scenario: Scenario): Promise<AgentEvent[]> {
	const controller = new AbortController();
	const request = makeRequest({
		...(scenario.deadline === undefined ? {} : { deadline: scenario.deadline }),
		permittedToolIds: [...(scenario.permittedToolIds ?? [])],
		maxToolCalls: 20,
	});
	const defaultModel =
		scenario.runtime.agentId === "opencode"
			? "opencode-go/example-model"
			: scenario.runtime.agentId === "openrouter-free"
				? "example/model:free"
				: null;
	const context = makeContext({
		signal: controller.signal,
		// CLI backends need a model for OpenCode; a pure HTTPS backend gets no scratch directory.
		model: scenario.model !== undefined ? scenario.model : defaultModel,
		scratchDirectory: HTTP_AGENT_IDS.has(scenario.runtime.agentId) ? null : "/scratch/job_1",
	});
	const pending = collect(scenario.runtime.run(request, context));
	if (scenario.aborted === true) controller.abort();
	return pending;
}

describe("agent event contract", () => {
	it.each(SCENARIOS)("$name: every emitted event satisfies agentEventSchema", async (scenario) => {
		const events = await runScenario(scenario);

		expect(events.length).toBeGreaterThan(0);
		for (const event of events) {
			expect(agentEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
			expect(parseAgentEvent(event).ok).toBe(true);
		}
	});

	it.each(
		SCENARIOS,
	)("$name: ends with exactly one terminal event, preceded by at most one usage event", async (scenario) => {
		const events = await runScenario(scenario);
		const types = events.map((event) => event.type);
		const terminalCount = types.filter((type) => type === "completed" || type === "failed").length;

		expect(terminalCount).toBe(1);
		expect(["completed", "failed"]).toContain(types.at(-1));
		expect(types.filter((type) => type === "usage").length).toBeLessThanOrEqual(1);
		// Text never follows the usage report, and nothing follows the terminal event.
		const usageIndex = types.indexOf("usage");
		if (usageIndex !== -1) expect(types.slice(usageIndex + 1)).toEqual([types.at(-1)]);
	});

	it.each(
		SCENARIOS,
	)("$name: emits only text, usage, terminal events and requests for permitted tools — the orchestrator runs every tool", async (scenario) => {
		const events = await runScenario(scenario);
		const allowed = new Set(["text.delta", "usage", "completed", "failed", "tool.request"]);
		const permitted = new Set(scenario.permittedToolIds ?? []);

		expect(events.map((event) => event.type).filter((type) => !allowed.has(type))).toEqual([]);
		// A tool request only ever names a tool the request permits (ADR-0028).
		expect(
			events.flatMap((event) =>
				event.type === "tool.request" && !permitted.has(event.toolId) ? [event.toolId] : [],
			),
		).toEqual([]);
	});

	it.each(
		SCENARIOS,
	)("$name: a successful turn always reports its (possibly unknown) cost", async (scenario) => {
		const events = await runScenario(scenario);

		if (events.at(-1)?.type === "completed") {
			expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
			// A completed turn delivers an answer: text, or tool requests (ADR-0028).
			expect(
				events.some(
					(event) =>
						(event.type === "text.delta" && event.text.length > 0) || event.type === "tool.request",
				),
			).toBe(true);
		}
	});
});

describe("baseline registry", () => {
	const runtimes = createBaselineAgentRuntimes(
		makeEnvironment({
			processRunner: createFakeProcessRunner({ spawnErrorCode: "ENOENT" }).runner,
		}),
	);

	it("provides the four V1 backends in BASELINE_AGENT_IDS order", () => {
		expect(runtimes.map((runtime) => runtime.agentId)).toEqual([...BASELINE_AGENT_IDS]);
	});

	it("registers without id collisions and describes every backend with a valid descriptor", async () => {
		const descriptors = await createAgentRegistry(runtimes).describeAll();

		expect(descriptors).toHaveLength(4);
		for (const descriptor of descriptors) {
			expect(agentDescriptorSchema.safeParse(descriptor).success, descriptor.agentId).toBe(true);
		}
	});

	it("surfaces unavailable backends honestly instead of pretending they work (FR-012)", async () => {
		const descriptors = await createAgentRegistry(runtimes).describeAll();

		expect(descriptors.map((descriptor) => [descriptor.agentId, descriptor.availability])).toEqual([
			["opencode", expect.objectContaining({ status: "unavailable", reasonCode: "NOT_INSTALLED" })],
			["codex", expect.objectContaining({ status: "unavailable", reasonCode: "NOT_INSTALLED" })],
			[
				"claude-code",
				expect.objectContaining({ status: "unavailable", reasonCode: "NOT_INSTALLED" }),
			],
			[
				"openrouter",
				expect.objectContaining({ status: "unavailable", reasonCode: "NOT_CONFIGURED" }),
			],
		]);
	});

	it("provides the baseline four, then openrouter-free and claude-api, through createAgentRuntimes", () => {
		const all = createAgentRuntimes(
			makeEnvironment({
				processRunner: createFakeProcessRunner({ spawnErrorCode: "ENOENT" }).runner,
			}),
		);
		expect(all.map((runtime) => runtime.agentId)).toEqual([
			...BASELINE_AGENT_IDS,
			"openrouter-free",
			"claude-api",
		]);
	});
});

describe("capability honesty", () => {
	const runtimes = createBaselineAgentRuntimes(
		makeEnvironment({
			env: OPENROUTER_ENV,
			processRunner: createFakeProcessRunner({ spawnErrorCode: "ENOENT" }).runner,
		}),
	);

	async function capabilitiesById(): Promise<Map<string, readonly string[]>> {
		const entries = await Promise.all(
			runtimes.map(async (runtime) => {
				const probe = await runtime.probe();
				return [runtime.agentId, probe.capabilities.supported] as const;
			}),
		);
		return new Map(entries);
	}

	it("no adapter claims tool-calls, structured-output or image-input", async () => {
		for (const [agentId, supported] of await capabilitiesById()) {
			expect(supported, agentId).not.toContain("tool-calls");
			expect(supported, agentId).not.toContain("structured-output");
			expect(supported, agentId).not.toContain("image-input");
		}
	});

	it("only openrouter claims cancel; killing a CLI process is not a provider cancel", async () => {
		const capabilities = await capabilitiesById();
		const claimingCancel = [...capabilities].filter(([, supported]) =>
			supported.includes("cancel"),
		);

		expect(claimingCancel.map(([agentId]) => agentId)).toEqual(["openrouter"]);
	});

	it("only backends that deliver incremental deltas claim stream", async () => {
		const capabilities = await capabilitiesById();
		const claimingStream = [...capabilities].filter(([, supported]) =>
			supported.includes("stream"),
		);

		// Codex and OpenCode print whole messages, so they do not claim it.
		expect(claimingStream.map(([agentId]) => agentId)).toEqual(["claude-code", "openrouter"]);
	});

	it("declares cost models and tool isolation exactly as verified", () => {
		expect(
			runtimes.map((runtime) => [runtime.agentId, runtime.costModel, runtime.toolIsolation]),
		).toEqual([
			["opencode", "plan-limited", "enforced"],
			["codex", "plan-limited", "unverified"],
			["claude-code", "plan-limited", "enforced"],
			["openrouter", "metered", "enforced"],
		]);
	});

	it("plan-limited backends never report a known cost for a subscription run", async () => {
		const subscriptionRuns: readonly Scenario[] = SCENARIOS.filter(
			(scenario) => scenario.runtime.costModel === "plan-limited",
		);
		for (const scenario of subscriptionRuns) {
			const events = await runScenario(scenario);
			for (const event of events) {
				if (event.type === "usage") expect(event.knownCostUsd, scenario.name).toBeNull();
			}
		}
	});
});
