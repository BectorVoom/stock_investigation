import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenCodeRuntime } from "../../src/providers/index.ts";
import {
	buildOpenCodeConfigContent,
	MAX_REJECTED_TOOL_CALLS,
	OPENCODE_CONFIG_CONTENT,
	OPENCODE_FREE_TIER_CONFIG_CONTENT,
	OPENCODE_FREE_TIER_GATED_PERMISSIONS,
} from "../../src/providers/openCode.ts";
import {
	BASE_ENV,
	collect,
	createFakeProcessRunner,
	fixtureLines,
	fixtureText,
	itemAt,
	makeContext,
	makeEnvironment,
	makeRequest,
	terminalEvents,
	textOf,
	usageEvents,
	valueAfter,
} from "./helpers.ts";

const MODEL = "opencode-go/example-model";
const FREE_MODEL = "opencode/muse-spark-1.3-contributor-free";
const line = (value: unknown): string => JSON.stringify(value);
const textPart = (text: string): string => line({ type: "text", part: { type: "text", text } });

interface WrittenFile {
	readonly path: string;
	readonly content: string;
}

function runtimeFor(
	lines: readonly string[],
	exit: { code: number; stderrTail?: string } = { code: 0 },
	env: Readonly<Record<string, string | undefined>> = BASE_ENV,
) {
	const fake = createFakeProcessRunner({ lines, exit });
	const written: WrittenFile[] = [];
	const runtime = createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner, env }), {
		writeConfigFile: async (path, content) => {
			written.push({ path, content });
		},
	});
	return { fake, written, runtime };
}

const ruleSchema = z.object({ action: z.string(), resource: z.string(), effect: z.string() });
const configSchema = z.object({
	permissions: z.array(ruleSchema),
	default_agent: z.string(),
	agents: z.record(z.string(), z.object({ mode: z.string(), permissions: z.array(ruleSchema) })),
});

describe("opencode runtime metadata", () => {
	it("is plan-limited and tool-isolated", () => {
		const runtime = createOpenCodeRuntime(makeEnvironment());
		expect(runtime.agentId).toBe("opencode");
		expect(runtime.costModel).toBe("plan-limited");
		expect(runtime.toolIsolation).toBe("enforced");
	});
});

describe("opencode invocation", () => {
	it("runs a private standalone server with JSON output and the deny-all agent", async () => {
		const { fake, runtime } = runtimeFor(fixtureLines("opencode/ok.jsonl"));

		await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		const spawn = itemAt(fake.spawns, 0);
		expect(spawn.command).toBe("opencode");
		expect(spawn.args).toEqual([
			"run",
			"--standalone",
			"--format",
			"json",
			"--agent",
			"research-text",
			"--model",
			// The run's effort is OpenCode's reasoning variant.
			`${MODEL}#medium`,
		]);
		// Never auto-approve, never attach to a shared or remote server.
		for (const forbidden of ["--auto", "--server", "--continue", "--session", "--file"]) {
			expect(spawn.args).not.toContain(forbidden);
		}
	});

	it("writes a deny-everything project config into the scratch directory before spawning", async () => {
		const { fake, written, runtime } = runtimeFor(fixtureLines("opencode/ok.jsonl"));

		await collect(
			runtime.run(makeRequest(), makeContext({ model: MODEL, scratchDirectory: "/scratch/job_3" })),
		);

		expect(written).toHaveLength(1);
		const file = itemAt(written, 0);
		expect(file.path).toBe("/scratch/job_3/opencode.jsonc");
		expect(itemAt(fake.spawns, 0).cwd).toBe("/scratch/job_3");

		const config = configSchema.parse(JSON.parse(file.content));
		const denyAll = { action: "*", resource: "*", effect: "deny" };
		// The last matching rule wins, so the deny-all rule must be the final one at both levels.
		expect(config.permissions.at(-1)).toEqual(denyAll);
		expect(config.permissions.some((rule) => rule.effect !== "deny")).toBe(false);
		const agent = config.agents[valueAfter(itemAt(fake.spawns, 0).args, "--agent") ?? ""];
		expect(agent?.mode).toBe("primary");
		expect(agent?.permissions.at(-1)).toEqual(denyAll);
		expect(agent?.permissions.some((rule) => rule.effect !== "deny")).toBe(false);
		expect(config.default_agent).toBe("research-text");
		// Keys that could add tools or code must not appear in the per-run config.
		expect(file.content).not.toMatch(/"(mcp|plugins|commands|skills|tools)"/);
	});

	it("does not spawn when the config cannot be written", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines("opencode/ok.jsonl") });
		const runtime = createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner }), {
			writeConfigFile: () => Promise.reject(new Error("EACCES")),
		});

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		expect(events).toEqual([
			{ type: "failed", code: "PROVIDER_CONFIG_WRITE_FAILED", retryable: false },
		]);
		expect(fake.spawns).toHaveLength(0);
	});

	it("refuses to let the CLI pick its default (possibly metered) provider when no model is given", async () => {
		const { fake, written, runtime } = runtimeFor(fixtureLines("opencode/ok.jsonl"));

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: null })));

		expect(events).toEqual([{ type: "failed", code: "PROVIDER_MODEL_REQUIRED", retryable: false }]);
		expect(fake.spawns).toHaveLength(0);
		expect(written).toHaveLength(0);
	});

	it("falls back to OPENCODE_MODEL from the runner environment, without forwarding it", async () => {
		const { fake, runtime } = runtimeFor(
			fixtureLines("opencode/ok.jsonl"),
			{ code: 0 },
			{
				...BASE_ENV,
				OPENCODE_MODEL: "opencode-go/from-env",
			},
		);

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: null })));

		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		expect(valueAfter(itemAt(fake.spawns, 0).args, "--model")).toBe("opencode-go/from-env#medium");
		expect(itemAt(fake.spawns, 0).env).not.toHaveProperty("OPENCODE_MODEL");
		expect((await runtime.probe()).capabilities.model).toBe("opencode-go/from-env");
	});
});

describe("opencode free-tier config selection", () => {
	it("uses the deny-all config for a plan model and the ask-and-reject config for a free-tier model", () => {
		expect(buildOpenCodeConfigContent(MODEL)).toBe(OPENCODE_CONFIG_CONTENT);
		expect(buildOpenCodeConfigContent(FREE_MODEL)).toBe(OPENCODE_FREE_TIER_CONFIG_CONTENT);
		expect(buildOpenCodeConfigContent(MODEL)).not.toBe(OPENCODE_FREE_TIER_CONFIG_CONTENT);
	});

	it("writes the deny-all config for a plan model run", async () => {
		const { written, runtime } = runtimeFor(fixtureLines("opencode/ok.jsonl"));

		await collect(
			runtime.run(makeRequest(), makeContext({ model: MODEL, scratchDirectory: "/scratch/plan" })),
		);

		expect(itemAt(written, 0).content).toBe(OPENCODE_CONFIG_CONTENT);
	});

	it("writes the ask-and-reject config for a free-tier model run", async () => {
		const { written, runtime } = runtimeFor(fixtureLines("opencode/ok.jsonl"));

		await collect(
			runtime.run(
				makeRequest(),
				makeContext({ model: FREE_MODEL, scratchDirectory: "/scratch/free" }),
			),
		);

		expect(itemAt(written, 0).path).toBe("/scratch/free/opencode.jsonc");
		expect(itemAt(written, 0).content).toBe(OPENCODE_FREE_TIER_CONFIG_CONTENT);
	});

	it("builds the free-tier config as deny-first then ask for exactly the ten verified permissions", () => {
		expect([...OPENCODE_FREE_TIER_GATED_PERMISSIONS]).toEqual([
			"edit",
			"glob",
			"grep",
			"question",
			"read",
			"shell",
			"skill",
			"subagent",
			"webfetch",
			"websearch",
		]);
		const config = configSchema.parse(JSON.parse(OPENCODE_FREE_TIER_CONFIG_CONTENT));
		const denyAll = { action: "*", resource: "*", effect: "deny" };
		const expected = [
			denyAll,
			...OPENCODE_FREE_TIER_GATED_PERMISSIONS.map((action) => ({
				action,
				resource: "*",
				effect: "ask",
			})),
		];
		expect(config.permissions).toEqual(expected);
		const agent = config.agents["research-text"];
		expect(agent?.permissions).toEqual(expected);
		expect(agent?.mode).toBe("primary");
		expect(config.default_agent).toBe("research-text");
	});

	it("never makes execute askable and keeps the free-tier agent honest about rejected tools", () => {
		for (const content of [OPENCODE_CONFIG_CONTENT, OPENCODE_FREE_TIER_CONFIG_CONTENT]) {
			const config = configSchema.parse(JSON.parse(content));
			const agentPermissions = config.agents["research-text"]?.permissions ?? [];
			const rules = [...config.permissions, ...agentPermissions];
			expect(rules.some((rule) => rule.action === "execute")).toBe(false);
			expect(rules.some((rule) => rule.effect !== "deny" && rule.effect !== "ask")).toBe(false);
		}
		// The first rule denies everything unknown, so execute (and any future
		// tool) matches only the deny rule and is never advertised as usable.
		expect(JSON.parse(OPENCODE_FREE_TIER_CONFIG_CONTENT).permissions[0]).toEqual({
			action: "*",
			resource: "*",
			effect: "deny",
		});
		const system: string = JSON.parse(OPENCODE_FREE_TIER_CONFIG_CONTENT).agents["research-text"]
			.system;
		expect(system).toContain("every tool call is rejected");
		expect(system).toContain("Do not call any tool");
		expect(system).toContain("text only");
	});
});

describe("opencode stream interpretation", () => {
	it("completes the recorded run that has no step_finish event", async () => {
		const lines = fixtureLines("opencode/ok.jsonl");
		expect(lines.some((entry) => entry.includes("step_finish"))).toBe(false);
		const { runtime } = runtimeFor(lines);

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("reports OpenCode's own cost estimate as unknown, never as a known cost", async () => {
		expect(fixtureText("opencode/no-tools-attempt.jsonl")).toContain('"cost":0.00012405');
		const { runtime } = runtimeFor(fixtureLines("opencode/no-tools-attempt.jsonl"));

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		expect(textOf(events)).toBe("NO_TOOLS");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("ignores reasoning parts and unknown event types and separates text parts", async () => {
		const { runtime } = runtimeFor([
			line({ type: "step_start", part: { type: "step-start" } }),
			line({ type: "reasoning", part: { type: "reasoning", text: "hidden" } }),
			line({ type: "some_future_event", part: { type: "snapshot" } }),
			textPart("first"),
			textPart("second"),
		]);

		expect(textOf(await collect(runtime.run(makeRequest(), makeContext({ model: MODEL }))))).toBe(
			"first\nsecond",
		);
	});

	it("fails with PROVIDER_OUTPUT_EMPTY when the CLI exits cleanly without any text", async () => {
		const { runtime } = runtimeFor([line({ type: "step_start", part: { type: "step-start" } })]);

		expect(
			terminalEvents(await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })))),
		).toEqual([{ type: "failed", code: "PROVIDER_OUTPUT_EMPTY", retryable: true }]);
	});
});

describe("opencode effort variant", () => {
	it.each([
		"low",
		"medium",
		"high",
	] as const)("sends effort %s as the model's reasoning variant", async (effort) => {
		const { fake, runtime } = runtimeFor(fixtureLines("opencode/ok.jsonl"));

		await collect(runtime.run(makeRequest(), makeContext({ model: MODEL, effort })));

		expect(valueAfter(itemAt(fake.spawns, 0).args, "--model")).toBe(`${MODEL}#${effort}`);
	});

	it("keeps a variant the owner wrote into the model id", async () => {
		const { fake, runtime } = runtimeFor(fixtureLines("opencode/ok.jsonl"));

		await collect(
			runtime.run(makeRequest(), makeContext({ model: `${MODEL}#high`, effort: "low" })),
		);

		expect(valueAfter(itemAt(fake.spawns, 0).args, "--model")).toBe(`${MODEL}#high`);
	});

	function variantRuntime(accepted: readonly string[]) {
		// Recorded live 2026-10-17: provider.no-route "Variant unavailable for <model>: <variant>".
		const fake = createFakeProcessRunner((spec) => {
			const argument = valueAfter(spec.args, "--model") ?? "";
			const variant = argument.includes("#") ? argument.slice(argument.indexOf("#") + 1) : null;
			return variant === null || accepted.includes(variant)
				? { lines: fixtureLines("opencode/ok.jsonl") }
				: { lines: fixtureLines("opencode/variant-unavailable.jsonl"), exit: { code: 1 } };
		});
		const runtime = createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner }), {
			writeConfigFile: () => Promise.resolve(),
		});
		return { fake, runtime };
	}

	it("falls back from a missing medium to low, and goes straight to low next time", async () => {
		// glm-5.3-flash-free and deepseek-v4.1-flash-free offer low, high and max, but no medium.
		const { fake, runtime } = variantRuntime(["low", "high", "max"]);

		const first = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));
		const second = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		for (const events of [first, second]) {
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
			expect(usageEvents(events)).toHaveLength(1);
		}
		expect(fake.spawns.map((spawn) => valueAfter(spawn.args, "--model"))).toEqual([
			`${MODEL}#medium`,
			`${MODEL}#low`,
			`${MODEL}#low`,
		]);
	});

	it("falls back from high to max", async () => {
		const { fake, runtime } = variantRuntime(["max"]);

		await collect(runtime.run(makeRequest(), makeContext({ model: MODEL, effort: "high" })));

		expect(fake.spawns.map((spawn) => valueAfter(spawn.args, "--model"))).toEqual([
			`${MODEL}#high`,
			`${MODEL}#max`,
		]);
	});

	it("runs without a variant only when the model offers none of the candidates, and remembers that", async () => {
		const { fake, runtime } = variantRuntime([]);

		const first = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));
		const second = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		for (const events of [first, second]) {
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
			expect(usageEvents(events)).toHaveLength(1);
		}
		expect(fake.spawns.map((spawn) => valueAfter(spawn.args, "--model"))).toEqual([
			`${MODEL}#medium`,
			`${MODEL}#low`,
			MODEL,
			MODEL,
		]);
	});

	it("reports a variant the owner wrote that the model does not offer", async () => {
		const { fake, runtime } = variantRuntime(["low"]);

		const events = await collect(
			runtime.run(makeRequest(), makeContext({ model: `${MODEL}#ultra` })),
		);

		expect(fake.spawns).toHaveLength(1);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_VARIANT_UNAVAILABLE", retryable: false },
		]);
	});
});

describe("opencode tool-use guard", () => {
	it.each([
		[
			"a tool_use event",
			line({
				type: "tool_use",
				part: { type: "tool", tool: "bash", state: { status: "completed" } },
			}),
		],
		[
			"a tool part under another event name",
			line({ type: "part", part: { type: "tool", tool: "read" } }),
		],
		["a renamed tool event", line({ type: "tool_call", part: { type: "call" } })],
	])("fails closed and stops the process on %s", async (_label, toolLine) => {
		const fake = createFakeProcessRunner({
			lines: [textPart("before"), toolLine, textPart("after")],
			hang: true,
		});
		const runtime = createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner }), {
			writeConfigFile: () => Promise.resolve(),
		});

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		expect(textOf(events)).toBe("before");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	const rejectedRead = line({
		type: "tool_use",
		part: { type: "tool", tool: "read", state: { status: "error" } },
	});
	const rejectedShellWithProviderText = line({
		type: "tool_use",
		part: {
			type: "tool",
			tool: "shell",
			state: {
				status: "error",
				error:
					"This non-interactive run cannot ask the user for permission, so the request was rejected",
				input: { command: "echo hi" },
			},
		},
	});

	function freeTierRuntime(script: Parameters<typeof createFakeProcessRunner>[0]) {
		const fake = createFakeProcessRunner(script);
		const runtime = createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner }), {
			writeConfigFile: () => Promise.resolve(),
		});
		return { fake, runtime };
	}

	it.each([
		["a rejected read call", rejectedRead],
		["a rejected shell call with provider text", rejectedShellWithProviderText],
	])("lets a free-tier turn answer after %s, without surfacing provider text", async (_label, toolLine) => {
		// The live shape: the rejected call ends a step, and the next step carries the answer.
		const { runtime } = freeTierRuntime({
			lines: [
				line({ type: "step_start", part: { type: "step-start" } }),
				toolLine,
				line({ type: "step_finish", part: { type: "step-finish" } }),
				line({ type: "step_start", part: { type: "step-start" } }),
				textPart("the answer"),
			],
		});

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: FREE_MODEL })));

		expect(textOf(events)).toBe("the answer");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		// SEC-010: the provider's message text and tool inputs never leave the adapter.
		expect(JSON.stringify(events)).not.toContain("non-interactive");
		expect(JSON.stringify(events)).not.toContain("echo hi");
	});

	it("stops a free-tier turn that keeps calling tools past the bound", async () => {
		const { fake, runtime } = freeTierRuntime({
			lines: [
				...Array.from({ length: MAX_REJECTED_TOOL_CALLS + 1 }, () => rejectedRead),
				textPart("too late"),
			],
			hang: true,
		});

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: FREE_MODEL })));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_CALL_REJECTED", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("reports a free-tier turn that only called tools and never answered as PROVIDER_TOOL_CALL_REJECTED", async () => {
		const { runtime } = freeTierRuntime({ lines: [rejectedRead] });

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: FREE_MODEL })));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_CALL_REJECTED", retryable: false },
		]);
	});

	describe("native research-tool calls (ADR-0028)", () => {
		const RESEARCH_REQUEST = makeRequest({
			permittedToolIds: ["web.search", "web.fetch_page"],
			maxToolCalls: 20,
		});

		function nativeCall(
			tool: string,
			input: unknown,
			overrides: { executed?: boolean; id?: string } = {},
		): string {
			return line({
				type: "tool_use",
				part: {
					type: "tool",
					id: overrides.id ?? `call-${tool}`,
					tool,
					state: {
						status: "error",
						input,
						error: `No tool named "${tool}" is currently available.`,
						metadata: { providerCall: { executed: overrides.executed ?? false } },
					},
				},
			});
		}
		const stepFinish = line({
			type: "step_finish",
			part: { type: "step-finish", reason: "tool-calls" },
		});

		it("hands the recorded native web.search call to the orchestrator and ends the turn at that step", async () => {
			// Recorded live 2026-10-17 (opencode v2.0.32, nemotron-3.5-lightning-free): web.search,
			// then web.fetch_page in a second step, then a give-up text after 12 minutes.
			const { fake, runtime } = freeTierRuntime({
				lines: fixtureLines("opencode/free-tier-native-tool-call.jsonl"),
				hang: true,
			});

			const events = await collect(
				runtime.run(RESEARCH_REQUEST, makeContext({ model: FREE_MODEL })),
			);

			expect(events.filter((event) => event.type === "tool.request")).toEqual([
				{
					type: "tool.request",
					toolId: "web.search",
					args: { query: "increasing demand services global market 2026" },
					callId: "call-c01aa090-e149-4ade-b299-2245b366426c",
				},
			]);
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
			// The later steps were never waited for: the process was stopped after the first one.
			expect(textOf(events)).toBe("");
			expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
			// SEC-010: the provider's rejection text never leaves the adapter.
			expect(JSON.stringify(events)).not.toContain("No tool named");
		});

		it("reports every permitted call of one step before ending the turn", async () => {
			const { runtime } = freeTierRuntime({
				lines: [
					nativeCall("web.search", { query: "cloud demand japan" }, { id: "call-1" }),
					nativeCall("web.fetch_page", { url: "https://example.com/" }, { id: "call-2" }),
					stepFinish,
					textPart("never reached"),
				],
				hang: true,
			});

			const events = await collect(
				runtime.run(RESEARCH_REQUEST, makeContext({ model: FREE_MODEL })),
			);

			expect(
				events.filter((event) => event.type === "tool.request").map((event) => event.callId),
			).toEqual(["call-1", "call-2"]);
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		});

		it("skips a native call to a tool the run does not permit, and lets the model answer", async () => {
			const { runtime } = freeTierRuntime({
				lines: [
					nativeCall("sec.filings", { cik: "1" }),
					stepFinish,
					textPart('{"toolCalls":[],"done":true}'),
				],
			});

			const events = await collect(
				runtime.run(RESEARCH_REQUEST, makeContext({ model: FREE_MODEL })),
			);

			expect(events.some((event) => event.type === "tool.request")).toBe(false);
			expect(textOf(events)).toBe('{"toolCalls":[],"done":true}');
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		});

		it("never turns arguments that are not a JSON object into a request", async () => {
			const { runtime } = freeTierRuntime({
				lines: [nativeCall("web.search", "cloud demand"), stepFinish, textPart("answer")],
			});

			const events = await collect(
				runtime.run(RESEARCH_REQUEST, makeContext({ model: FREE_MODEL })),
			);

			expect(events.some((event) => event.type === "tool.request")).toBe(false);
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		});

		it("stops requesting at the run's remaining tool-call budget", async () => {
			const { runtime } = freeTierRuntime({
				lines: [
					nativeCall("web.search", { query: "a" }, { id: "call-1" }),
					nativeCall("web.search", { query: "b" }, { id: "call-2" }),
					stepFinish,
				],
				hang: true,
			});

			const events = await collect(
				runtime.run(
					makeRequest({ permittedToolIds: ["web.search"], maxToolCalls: 1 }),
					makeContext({ model: FREE_MODEL }),
				),
			);

			expect(events.filter((event) => event.type === "tool.request")).toHaveLength(1);
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		});

		it("fails closed on a permitted call that the CLI reports as executed", async () => {
			const { runtime } = freeTierRuntime({
				lines: [nativeCall("web.search", { query: "a" }, { executed: true }), stepFinish],
				hang: true,
			});

			const events = await collect(
				runtime.run(RESEARCH_REQUEST, makeContext({ model: FREE_MODEL })),
			);

			expect(events.some((event) => event.type === "tool.request")).toBe(false);
			expect(terminalEvents(events)).toEqual([
				{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
			]);
		});

		it("never accepts a native call from a plan-model run, where no tool is sent", async () => {
			const { runtime } = freeTierRuntime({
				lines: [nativeCall("web.search", { query: "a" }), stepFinish],
				hang: true,
			});

			const events = await collect(runtime.run(RESEARCH_REQUEST, makeContext({ model: MODEL })));

			expect(events.some((event) => event.type === "tool.request")).toBe(false);
			expect(terminalEvents(events)).toEqual([
				{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
			]);
		});
	});

	it("still fails closed on a free-tier tool event that was not rejected", async () => {
		const { fake, runtime } = freeTierRuntime({
			lines: [
				rejectedRead,
				line({
					type: "tool_use",
					part: { type: "tool", tool: "read", state: { status: "completed" } },
				}),
				textPart("after"),
			],
			hang: true,
		});

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: FREE_MODEL })));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("treats a rejected tool event in a plan-model run as an isolation violation (no tool is sent there)", async () => {
		const fake = createFakeProcessRunner({
			lines: [
				line({
					type: "tool_use",
					part: { type: "tool", tool: "read", state: { status: "error" } },
				}),
			],
			hang: true,
		});
		const runtime = createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner }), {
			writeConfigFile: () => Promise.resolve(),
		});

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
	});
});

describe("opencode failures", () => {
	it("maps the recorded no-route error (unknown model or no credential) to PROVIDER_MODEL_UNAVAILABLE", async () => {
		const { runtime } = runtimeFor(fixtureLines("opencode/model-unavailable.jsonl"), { code: 1 });

		expect(
			terminalEvents(await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })))),
		).toEqual([{ type: "failed", code: "PROVIDER_MODEL_UNAVAILABLE", retryable: false }]);
	});

	it("maps the recorded provider.auth refusal (credentials/plan rejected for this model) to PROVIDER_AUTH", async () => {
		const { runtime } = runtimeFor(fixtureLines("opencode/provider-auth.jsonl"), { code: 1 });

		expect(
			terminalEvents(await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })))),
		).toEqual([{ type: "failed", code: "PROVIDER_AUTH", retryable: false }]);
	});

	it("fails (never falls back to another agent) on the recorded agent-not-found error", async () => {
		const { runtime } = runtimeFor(fixtureLines("opencode/agent-not-found.jsonl"), { code: 1 });

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_ERROR", retryable: false },
		]);
	});

	it.each([
		["Unauthorized: invalid api key", "PROVIDER_AUTH", false],
		["Rate limit exceeded, retry later", "PROVIDER_RATE_LIMITED", true],
		["Insufficient credits", "PROVIDER_PAYMENT_REQUIRED", false],
		["upstream returned 503 service unavailable", "PROVIDER_UNAVAILABLE", true],
	])("maps the error message %j to %s", async (message, code, retryable) => {
		const { runtime } = runtimeFor(
			[line({ type: "error", error: { type: "provider.error", message } })],
			{
				code: 1,
			},
		);

		expect(
			terminalEvents(await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })))),
		).toEqual([{ type: "failed", code, retryable }]);
	});

	it("reports an error event as a failure even if text was produced and the exit code is 0", async () => {
		const { runtime } = runtimeFor([
			textPart("partial"),
			line({ type: "error", error: { type: "unknown", message: "stream interrupted" } }),
		]);

		expect(
			terminalEvents(await collect(runtime.run(makeRequest(), makeContext({ model: MODEL })))),
		).toEqual([{ type: "failed", code: "PROVIDER_ERROR", retryable: false }]);
	});
});

describe("opencode probe", () => {
	function probeRuntime(
		authList: { lines: readonly string[]; code: number },
		version = "opencode v2.0.27",
		models?: { lines: readonly string[]; code: number },
	) {
		const fake = createFakeProcessRunner((spec) => {
			if (spec.args[0] === "--version") return { lines: [version] };
			// The model catalog is a separate listing after the auth check.
			if (spec.args[0] === "models") {
				return models ?? { lines: [] };
			}
			return { lines: authList.lines, exit: { code: authList.code } };
		});
		return {
			fake,
			runtime: createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner })),
		};
	}

	it("is available for the recorded credential list, queried on a private server", async () => {
		const { fake, runtime } = probeRuntime({
			lines: fixtureText("opencode/auth-list.json").split("\n"),
			code: 0,
		});

		const probe = await runtime.probe();

		expect(probe).toEqual({
			capabilities: { supported: [], models: [] },
			availability: { status: "available" },
		});
		expect(fake.spawns.map((spawn) => spawn.args)).toEqual([
			["--version"],
			["auth", "list", "--standalone", "--format", "json"],
			["models"],
		]);
		// `auth export` prints secrets; the probe must never use it.
		expect(fake.spawns.some((spawn) => spawn.args.includes("export"))).toBe(false);
	});

	it("is NOT_AUTHENTICATED when no credential is stored (recorded empty list)", async () => {
		const { runtime } = probeRuntime({ lines: ["[]"], code: 0 });

		expect((await runtime.probe()).availability).toMatchObject({
			status: "unavailable",
			reasonCode: "NOT_AUTHENTICATED",
		});
	});

	it("does not count environment-variable connections, whose keys are not forwarded to runs", async () => {
		const { runtime } = probeRuntime({
			lines: [
				line([
					{ id: "google", name: "Google", connections: [{ type: "env", name: "GEMINI_API_KEY" }] },
				]),
			],
			code: 0,
		});

		expect((await runtime.probe()).availability).toMatchObject({ reasonCode: "NOT_AUTHENTICATED" });
	});

	it("is PROBE_FAILED when the list is not the expected JSON", async () => {
		const { runtime } = probeRuntime({ lines: ["ERROR", "  Unrecognized flag"], code: 1 });

		expect((await runtime.probe()).availability).toMatchObject({ reasonCode: "PROBE_FAILED" });
	});

	it.each([
		"opencode v2.1.0",
		"opencode v3.0.0",
	])("reports TOOL_ISOLATION_UNVERIFIED for %s, beyond the verified release line", async (version) => {
		const { fake, runtime } = probeRuntime({ lines: ["[]"], code: 0 }, version);

		expect((await runtime.probe()).availability).toMatchObject({
			status: "unavailable",
			reasonCode: "TOOL_ISOLATION_UNVERIFIED",
		});
		expect(fake.spawns).toHaveLength(1);
	});

	it("accepts a later patch release of the verified line", async () => {
		const { runtime } = probeRuntime(
			{ lines: fixtureText("opencode/auth-list.json").split("\n"), code: 0 },
			"opencode v2.0.31",
		);

		expect((await runtime.probe()).availability).toEqual({ status: "available" });
	});

	it("reports UNSUPPORTED_VERSION for a CLI older than the 2.0.27 floor", async () => {
		const { fake, runtime } = probeRuntime({ lines: ["[]"], code: 0 }, "opencode v2.0.24");

		expect((await runtime.probe()).availability).toMatchObject({
			status: "unavailable",
			reasonCode: "UNSUPPORTED_VERSION",
		});
		expect(fake.spawns).toHaveLength(1);
	});
});

describe("opencode model listing", () => {
	function modelsProbe(models: { lines: readonly string[]; code: number }) {
		const fake = createFakeProcessRunner((spec) => {
			if (spec.args[0] === "--version") return { lines: ["opencode v2.0.27"] };
			if (spec.args[0] === "models") return { lines: models.lines, exit: { code: models.code } };
			return {
				lines: fixtureText("opencode/auth-list.json").split("\n"),
				exit: { code: 0 },
			};
		});
		return {
			fake,
			runtime: createOpenCodeRuntime(makeEnvironment({ processRunner: fake.runner })),
		};
	}

	it("reports the recorded listing sorted and de-duplicated, dropping garbage lines", async () => {
		const { fake, runtime } = modelsProbe({
			lines: fixtureText("opencode/models.txt").split("\n"),
			code: 0,
		});

		const probe = await runtime.probe();

		expect(probe.availability).toEqual({ status: "available" });
		// Sorted, de-duplicated; the blank line, the prose and the flag-like line are dropped.
		expect(probe.capabilities.models).toEqual([
			"google/gemini-2.5-flash",
			"opencode-go/muse-spark-1.3-contributor",
			"opencode/gpt-5.5",
		]);
		expect(fake.spawns.map((spawn) => spawn.args)).toContainEqual(["models"]);
	});

	it("omits the list when the models command fails, without changing availability", async () => {
		const { runtime } = modelsProbe({ lines: ["usage: unexpected flag"], code: 1 });

		const probe = await runtime.probe();

		expect(probe.availability).toEqual({ status: "available" });
		expect(probe.capabilities.models).toBeUndefined();
	});

	it("caps a long listing at 300 ids", async () => {
		const lines = Array.from({ length: 350 }, (_, index) => `opencode/model-${index}`);
		const { runtime } = modelsProbe({ lines, code: 0 });

		const probe = await runtime.probe();

		expect(probe.capabilities.models).toHaveLength(300);
	});

	it("parses nothing when the command prints no valid ids", async () => {
		const { runtime } = modelsProbe({ lines: ["", "not a model id!!", "--help"], code: 0 });

		const probe = await runtime.probe();

		expect(probe.availability).toEqual({ status: "available" });
		expect(probe.capabilities.models).toEqual([]);
	});
});
