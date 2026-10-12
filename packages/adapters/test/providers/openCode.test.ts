import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenCodeRuntime } from "../../src/providers/index.ts";
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
			MODEL,
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
		expect(valueAfter(itemAt(fake.spawns, 0).args, "--model")).toBe("opencode-go/from-env");
		expect(itemAt(fake.spawns, 0).env).not.toHaveProperty("OPENCODE_MODEL");
		expect((await runtime.probe()).capabilities.model).toBe("opencode-go/from-env");
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
		version = "opencode v2.0.24",
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
});

describe("opencode model listing", () => {
	function modelsProbe(models: { lines: readonly string[]; code: number }) {
		const fake = createFakeProcessRunner((spec) => {
			if (spec.args[0] === "--version") return { lines: ["opencode v2.0.24"] };
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
