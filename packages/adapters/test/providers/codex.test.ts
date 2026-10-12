import { describe, expect, it } from "vitest";
import { createCodexRuntime } from "../../src/providers/index.ts";
import {
	collect,
	createFakeProcessRunner,
	fixtureLines,
	itemAt,
	makeContext,
	makeEnvironment,
	makeRequest,
	terminalEvents,
	textOf,
	usageEvents,
	valueAfter,
} from "./helpers.ts";

const line = (value: unknown): string => JSON.stringify(value);
const agentMessage = (text: string): string =>
	line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
const TURN_COMPLETED = line({
	type: "turn.completed",
	usage: { input_tokens: 10, output_tokens: 2 },
});

function runtimeFor(
	lines: readonly string[],
	exit: { code: number; stderrTail?: string } = { code: 0 },
) {
	const fake = createFakeProcessRunner({ lines, exit });
	return { fake, runtime: createCodexRuntime(makeEnvironment({ processRunner: fake.runner })) };
}

/** Values of every repeated `flag value` pair, e.g. all `-c` overrides. */
function valuesOf(args: readonly string[], flag: string): string[] {
	return args.flatMap((arg, index) => (arg === flag ? [itemAt(args, index + 1)] : []));
}

describe("codex runtime metadata", () => {
	it("is plan-limited and honest that its tool isolation is unverified", () => {
		const runtime = createCodexRuntime(makeEnvironment());
		expect(runtime.agentId).toBe("codex");
		expect(runtime.costModel).toBe("plan-limited");
		expect(runtime.toolIsolation).toBe("unverified");
	});
});

describe("codex argv", () => {
	it("runs `exec --json` read-only, ephemeral, without ambient config, reading stdin", async () => {
		const { fake, runtime } = runtimeFor(fixtureLines("codex/ok.jsonl"));

		await collect(
			runtime.run(
				makeRequest(),
				makeContext({ scratchDirectory: "/scratch/job_7", effort: "low" }),
			),
		);

		const args = itemAt(fake.spawns, 0).args;
		expect(itemAt(fake.spawns, 0).command).toBe("codex");
		expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
		expect(valueAfter(args, "--sandbox")).toBe("read-only");
		expect(args).toContain("--skip-git-repo-check");
		expect(args).toContain("--ephemeral");
		expect(args).toContain("--ignore-user-config");
		expect(args).toContain("--ignore-rules");
		expect(valueAfter(args, "-C")).toBe("/scratch/job_7");
		expect(valuesOf(args, "-c")).toEqual([
			'approval_policy="never"',
			'web_search="disabled"',
			"mcp_servers={}",
			"notify=[]",
			"project_doc_max_bytes=0",
			'shell_environment_policy.inherit="none"',
			'model_reasoning_effort="low"',
		]);
		// "-" as the last argument makes the CLI read the prompt from stdin.
		expect(args.at(-1)).toBe("-");
		expect(args).not.toContain("-m");
		for (const forbidden of ["--search", "--add-dir", "--enable", "--oss", "--profile", "-p"]) {
			expect(args).not.toContain(forbidden);
		}
	});

	it("disables the shell, web, app, plugin, hook and sub-agent features", async () => {
		const { fake, runtime } = runtimeFor(fixtureLines("codex/ok.jsonl"));

		await collect(runtime.run(makeRequest(), makeContext()));

		const disabled = valuesOf(itemAt(fake.spawns, 0).args, "--disable");
		for (const feature of [
			"shell_tool",
			"unified_exec",
			"apps",
			"plugins",
			"hooks",
			"multi_agent",
			"browser_use",
			"computer_use",
			"image_generation",
			"view_image",
			"code_mode_host",
		]) {
			expect(disabled, feature).toContain(feature);
		}
		expect(new Set(disabled).size).toBe(disabled.length);
	});

	it("passes a requested model through -m, before the stdin marker", async () => {
		const { fake, runtime } = runtimeFor(fixtureLines("codex/ok.jsonl"));

		await collect(runtime.run(makeRequest(), makeContext({ model: "gpt-example" })));

		const args = itemAt(fake.spawns, 0).args;
		expect(valueAfter(args, "-m")).toBe("gpt-example");
		expect(args.at(-1)).toBe("-");
	});
});

describe("codex stream interpretation", () => {
	it("treats `item.completed` warnings of type error as non-fatal (recorded run)", async () => {
		const lines = fixtureLines("codex/ok.jsonl");
		expect(lines.filter((entry) => entry.includes('"type":"error"')).length).toBeGreaterThan(0);
		const { runtime } = runtimeFor(lines);

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
	});

	it("emits each agent message of the recorded two-message turn, separated, in order", async () => {
		const { runtime } = runtimeFor(fixtureLines("codex/tool-attempt.jsonl"));

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		const text = textOf(events);
		expect(events.filter((event) => event.type === "text.delta")).toHaveLength(2);
		expect(
			text.startsWith("I’ll check the available tools and try both requested operations.\nTOOLS: "),
		).toBe(true);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("separates messages that do not end in a newline", async () => {
		const { runtime } = runtimeFor([agentMessage("first"), agentMessage("second"), TURN_COMPLETED]);

		expect(textOf(await collect(runtime.run(makeRequest(), makeContext())))).toBe("first\nsecond");
	});

	it("ignores reasoning items, plan updates, transient error notices and unknown event types", async () => {
		const { runtime } = runtimeFor([
			line({ type: "thread.started", thread_id: "t" }),
			line({ type: "turn.started" }),
			line({ type: "error", message: "Reconnecting... 1/5" }),
			line({ type: "item.started", item: { id: "item_0", type: "reasoning" } }),
			line({
				type: "item.completed",
				item: { id: "item_0", type: "reasoning", text: "hidden reasoning" },
			}),
			line({ type: "item.updated", item: { id: "item_9", type: "todo_list", items: [] } }),
			line({ type: "some.future.event", data: 1 }),
			agentMessage("OK"),
			TURN_COMPLETED,
		]);

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("fails with PROVIDER_OUTPUT_INVALID when the stream ends without turn.completed", async () => {
		const { runtime } = runtimeFor([agentMessage("partial")]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false },
		]);
	});

	it("fails with PROVIDER_OUTPUT_EMPTY when the turn completed without any message", async () => {
		const { runtime } = runtimeFor([TURN_COMPLETED]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_EMPTY", retryable: true },
		]);
	});
});

describe("codex tool-use guard", () => {
	it.each([
		["command_execution", "item.started"],
		["file_change", "item.completed"],
		["mcp_tool_call", "item.started"],
		["web_search", "item.started"],
		["collab_tool_call", "item.started"],
		["some_future_tool", "item.completed"],
	])("fails closed and stops the process on a %s item", async (itemType, eventType) => {
		const fake = createFakeProcessRunner({
			lines: [
				agentMessage("before"),
				line({
					type: eventType,
					item: { id: "item_2", type: itemType, command: "cat ~/.ssh/id_rsa" },
				}),
				agentMessage("after"),
			],
			hang: true,
		});
		const runtime = createCodexRuntime(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("before");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});
});

describe("codex failures", () => {
	it("maps the recorded not-logged-in run (401, turn.failed, exit 1) to PROVIDER_AUTH", async () => {
		const { runtime } = runtimeFor(fixtureLines("codex/not-logged-in.jsonl"), { code: 1 });

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_AUTH", retryable: false },
		]);
	});

	it("maps a usage-limit turn failure to PROVIDER_RATE_LIMITED", async () => {
		const { runtime } = runtimeFor(
			[
				line({
					type: "turn.failed",
					error: { message: "You've hit your usage limit. Try again later." },
				}),
			],
			{ code: 1 },
		);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_RATE_LIMITED", retryable: true },
		]);
	});

	it("maps an unexplained turn failure with exit 0 to PROVIDER_ERROR", async () => {
		const { runtime } = runtimeFor([
			line({ type: "turn.failed", error: { message: "stream disconnected" } }),
		]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_ERROR", retryable: false },
		]);
	});

	it("fails with PROVIDER_EXIT_NONZERO for an unknown feature flag error", async () => {
		const { runtime } = runtimeFor([], {
			code: 1,
			stderrTail: "Error: Unknown feature flag: shell_tool",
		});

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_EXIT_NONZERO", retryable: false },
		]);
	});
});

describe("codex probe", () => {
	function probeRuntime(
		status: { stderrTail: string; code: number },
		version = "codex-cli 0.160.0",
	) {
		const fake = createFakeProcessRunner((spec) =>
			spec.args[0] === "--version" ? { lines: [version] } : { lines: [], exit: status },
		);
		return { fake, runtime: createCodexRuntime(makeEnvironment({ processRunner: fake.runner })) };
	}

	it("is available for a ChatGPT login, which the CLI reports on stderr", async () => {
		const { fake, runtime } = probeRuntime({ stderrTail: "Logged in using ChatGPT\n", code: 0 });

		const probe = await runtime.probe();

		expect(probe).toEqual({
			capabilities: { supported: [] },
			availability: { status: "available" },
		});
		expect(fake.spawns.map((spawn) => spawn.args)).toEqual([["--version"], ["login", "status"]]);
	});

	it("is NOT_AUTHENTICATED when the CLI reports no login (exit code 1)", async () => {
		const { runtime } = probeRuntime({ stderrTail: "Not logged in\n", code: 1 });

		expect((await runtime.probe()).availability).toMatchObject({
			status: "unavailable",
			reasonCode: "NOT_AUTHENTICATED",
		});
	});

	it("refuses a metered API-key login and never echoes the status line", async () => {
		const { runtime } = probeRuntime({
			stderrTail: "Logged in using an API key - sk-proj-abc***xyz\n",
			code: 0,
		});

		const availability = (await runtime.probe()).availability;

		expect(availability).toMatchObject({ status: "unavailable", reasonCode: "NOT_CONFIGURED" });
		expect(JSON.stringify(availability)).not.toContain("sk-proj");
	});

	it("is PROBE_FAILED when the status output is not understood", async () => {
		const { runtime } = probeRuntime({ stderrTail: "", code: 0 });

		expect((await runtime.probe()).availability).toMatchObject({ reasonCode: "PROBE_FAILED" });
	});
});
