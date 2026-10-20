import { describe, expect, it } from "vitest";
import { createClaudeCodeRuntime } from "../../src/providers/index.ts";
import {
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

const INIT = { type: "system", subtype: "init", tools: [], mcp_servers: [], apiKeySource: "none" };
const line = (value: unknown): string => JSON.stringify(value);
const textDelta = (text: string): string =>
	line({
		type: "stream_event",
		event: { type: "content_block_delta", delta: { type: "text_delta", text } },
	});
const successResult = (extra: Record<string, unknown> = {}): string =>
	line({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "OK",
		total_cost_usd: 0.0125,
		...extra,
	});

function runtimeFor(
	lines: readonly string[],
	exit: { code: number; stderrTail?: string } = { code: 0 },
) {
	const fake = createFakeProcessRunner({ lines, exit });
	return {
		fake,
		runtime: createClaudeCodeRuntime(makeEnvironment({ processRunner: fake.runner })),
	};
}

describe("claude-code runtime metadata", () => {
	it("is plan-limited, tool-isolated and claims only streaming", async () => {
		const runtime = createClaudeCodeRuntime(makeEnvironment());
		expect(runtime.agentId).toBe("claude-code");
		expect(runtime.costModel).toBe("plan-limited");
		expect(runtime.toolIsolation).toBe("enforced");
	});
});

describe("claude-code argv", () => {
	it("uses print mode with streaming JSON and every isolation flag", async () => {
		const { fake, runtime } = runtimeFor(fixtureLines("claude-code/ok.stream.jsonl"));

		await collect(runtime.run(makeRequest(), makeContext({ effort: "high" })));

		const args = itemAt(fake.spawns, 0).args;
		expect(itemAt(fake.spawns, 0).command).toBe("claude");
		expect(itemAt(args, 0)).toBe("-p");
		expect(valueAfter(args, "--output-format")).toBe("stream-json");
		expect(args).toContain("--verbose");
		expect(args).toContain("--include-partial-messages");
		// All built-in tools off: the value after --tools is the empty string.
		expect(valueAfter(args, "--tools")).toBe("");
		expect(args).toContain("--strict-mcp-config");
		expect(args).not.toContain("--mcp-config");
		expect(valueAfter(args, "--setting-sources")).toBe("");
		expect(args).toContain("--disable-slash-commands");
		expect(args).toContain("--no-session-persistence");
		expect(args).toContain("--safe-mode");
		expect(valueAfter(args, "--permission-mode")).toBe("dontAsk");
		expect(valueAfter(args, "--permission-prompts")).toBe("none");
		expect(valueAfter(args, "--system-prompt")).toMatch(/no tools/i);
		expect(valueAfter(args, "--effort")).toBe("high");
		expect(args).not.toContain("--model");
		for (const forbidden of [
			"--allowedTools",
			"--allowed-tools",
			"--add-dir",
			"--settings",
			"--bare",
		]) {
			expect(args).not.toContain(forbidden);
		}
	});

	it("passes a requested model through --model", async () => {
		const { fake, runtime } = runtimeFor(fixtureLines("claude-code/ok.stream.jsonl"));

		await collect(runtime.run(makeRequest(), makeContext({ model: "sonnet" })));

		expect(valueAfter(itemAt(fake.spawns, 0).args, "--model")).toBe("sonnet");
	});
});

describe("claude-code stream interpretation", () => {
	it("emits the recorded text deltas incrementally, in order", async () => {
		const { runtime } = runtimeFor(fixtureLines("claude-code/no-tools-attempt.stream.jsonl"));

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(events.filter((event) => event.type === "text.delta")).toEqual([
			{ type: "text.delta", text: "N" },
			{ type: "text.delta", text: "O_T" },
			{ type: "text.delta", text: "OOLS" },
		]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("reports the subscription run's notional total_cost_usd as an unknown cost, not as money spent", async () => {
		const { runtime } = runtimeFor(fixtureLines("claude-code/ok.stream.jsonl"));

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		// The fixture's result line carries total_cost_usd 0.01264 with apiKeySource "none".
		expect(fixtureText("claude-code/ok.stream.jsonl")).toContain('"total_cost_usd":0.01264');
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
	});

	it("falls back to the result text when the CLI streamed no deltas", async () => {
		const { runtime } = runtimeFor([line(INIT), successResult({ result: "whole answer" })]);

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("whole answer");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("does not duplicate the text when both deltas and a result are present", async () => {
		const { runtime } = runtimeFor([line(INIT), textDelta("O"), textDelta("K"), successResult()]);

		expect(textOf(await collect(runtime.run(makeRequest(), makeContext())))).toBe("OK");
	});

	it("ignores thinking deltas and unknown event types", async () => {
		const { runtime } = runtimeFor([
			line(INIT),
			line({ type: "system", subtype: "status", status: "requesting" }),
			line({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "thinking_delta", thinking: "secret plan" },
				},
			}),
			line({ type: "some_future_event", payload: { nested: true } }),
			textDelta("OK"),
			successResult(),
		]);

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("fails with PROVIDER_OUTPUT_EMPTY when a successful turn produced no text", async () => {
		const { runtime } = runtimeFor([line(INIT), successResult({ result: "" })]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_EMPTY", retryable: true },
		]);
	});

	it("fails with PROVIDER_OUTPUT_INVALID when the stream ends without a result", async () => {
		const { runtime } = runtimeFor([line(INIT), textDelta("partial")]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false },
		]);
	});
});

describe("claude-code tool isolation guard", () => {
	it("fails closed when the init event lists any built-in tool", async () => {
		const fake = createFakeProcessRunner({
			lines: [line({ ...INIT, tools: ["Bash", "Read"] }), textDelta("should never be emitted")],
			hang: true,
		});
		const runtime = createClaudeCodeRuntime(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("fails closed when the init event lists an MCP server", async () => {
		const { runtime } = runtimeFor([
			line({ ...INIT, mcp_servers: [{ name: "gmail", status: "connected" }] }),
			textDelta("x"),
			successResult(),
		]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
	});

	it("fails closed when text arrives before any init event confirmed the tool list", async () => {
		const { runtime } = runtimeFor([textDelta("unverified"), successResult()]);

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_UNVERIFIED", retryable: false },
		]);
	});

	it("fails closed when the init event has no readable tool list", async () => {
		const { runtime } = runtimeFor([
			line({ type: "system", subtype: "init" }),
			textDelta("x"),
			successResult(),
		]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_UNVERIFIED", retryable: false },
		]);
	});

	it("fails closed when a result arrives without any init event", async () => {
		const { runtime } = runtimeFor([successResult()]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_UNVERIFIED", retryable: false },
		]);
	});

	it.each([
		[
			"a streamed tool_use block",
			line({
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } },
			}),
		],
		[
			"a server tool block",
			line({
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "server_tool_use", name: "web_search" },
				},
			}),
		],
		[
			"a tool_use block in an assistant message",
			line({
				type: "assistant",
				message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
			}),
		],
	])("fails closed and stops the process on %s", async (_label, toolLine) => {
		const fake = createFakeProcessRunner({
			lines: [line(INIT), textDelta("before"), toolLine],
			hang: true,
		});
		const runtime = createClaudeCodeRuntime(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});
});

describe("claude-code metered-auth guard (AGT-012)", () => {
	const INIT_WITHOUT_KEY_SOURCE = { type: "system", subtype: "init", tools: [], mcp_servers: [] };

	it.each([
		["an environment API key", { ...INIT, apiKeySource: "ANTHROPIC_API_KEY" }],
		["a Console-managed key", { ...INIT, apiKeySource: "/login managed key" }],
		["an apiKeyHelper", { ...INIT, apiKeySource: "apiKeyHelper" }],
		["no statement about the key source at all", INIT_WITHOUT_KEY_SOURCE],
	])("fails closed at the init event for %s, before any output is accepted", async (_label, init) => {
		const fake = createFakeProcessRunner({
			lines: [line(init), textDelta("paid output that must not be delivered"), successResult()],
			hang: true,
		});
		const runtime = createClaudeCodeRuntime(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("");
		// The request may already have been sent, so the spend is unknown rather than absent.
		expect(events).toEqual([
			{ type: "usage", knownCostUsd: null },
			{ type: "failed", code: "PROVIDER_METERED_AUTH_NOT_ALLOWED", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("never turns the CLI's total_cost_usd into a known cost, even for a completed turn", async () => {
		const { runtime } = runtimeFor([
			line(INIT),
			textDelta("OK"),
			successResult({ total_cost_usd: 1.5 }),
		]);

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
	});

	it("reports a tool-isolation violation in preference to the auth kind when both are wrong", async () => {
		const { runtime } = runtimeFor([
			line({ ...INIT, tools: ["Bash"], apiKeySource: "ANTHROPIC_API_KEY" }),
			successResult(),
		]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
	});
});

describe("claude-code failures", () => {
	it("maps the recorded not-logged-in output to PROVIDER_AUTH without emitting the CLI's message as text", async () => {
		const { runtime } = runtimeFor(fixtureLines("claude-code/not-logged-in.stream.jsonl"), {
			code: 1,
		});

		const events = await collect(runtime.run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_AUTH", retryable: false },
		]);
	});

	it.each([
		["rate_limit", 429, "PROVIDER_RATE_LIMITED", true],
		["billing_error", 402, "PROVIDER_PAYMENT_REQUIRED", false],
		["server_error", 529, "PROVIDER_UNAVAILABLE", true],
		["authentication_failed", 401, "PROVIDER_AUTH", false],
	])("maps assistant error %s to %s", async (error, status, code, retryable) => {
		const { runtime } = runtimeFor(
			[
				line(INIT),
				line({
					type: "assistant",
					error,
					message: { content: [{ type: "text", text: "API error" }] },
				}),
				line({
					type: "result",
					subtype: "success",
					is_error: true,
					result: "API error",
					api_error_status: status,
				}),
			],
			{ code: 1 },
		);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code, retryable },
		]);
	});

	it("maps a rejected rate-limit event to PROVIDER_RATE_LIMITED", async () => {
		const { runtime } = runtimeFor(
			[
				line(INIT),
				line({
					type: "rate_limit_event",
					rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
				}),
				line({ type: "result", subtype: "success", is_error: true, result: "limit" }),
			],
			{ code: 1 },
		);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_RATE_LIMITED", retryable: true },
		]);
	});

	it("maps an unexplained error result to PROVIDER_ERROR", async () => {
		const { runtime } = runtimeFor([
			line(INIT),
			line({ type: "result", subtype: "error_during_execution", is_error: true }),
		]);

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_ERROR", retryable: false },
		]);
	});

	it("treats a non-zero exit as a failure even after a success result", async () => {
		const { runtime } = runtimeFor([line(INIT), textDelta("OK"), successResult()], { code: 1 });

		expect(terminalEvents(await collect(runtime.run(makeRequest(), makeContext())))).toEqual([
			{ type: "failed", code: "PROVIDER_EXIT_NONZERO", retryable: false },
		]);
	});
});

describe("claude-code probe", () => {
	function probeRuntime(
		authStatus: { lines: readonly string[]; code: number },
		version = "2.1.296 (Claude Code)",
	) {
		const fake = createFakeProcessRunner((spec) =>
			spec.args[0] === "--version"
				? { lines: [version] }
				: { lines: authStatus.lines, exit: { code: authStatus.code } },
		);
		return {
			fake,
			runtime: createClaudeCodeRuntime(makeEnvironment({ processRunner: fake.runner })),
		};
	}

	it("is available for the recorded logged-in status, using only local status commands", async () => {
		const { fake, runtime } = probeRuntime({
			lines: fixtureText("claude-code/auth-status.logged-in.json").split("\n"),
			code: 0,
		});

		const probe = await runtime.probe();

		// The CLI cannot list models, so the probe offers its aliases, newest model of each family.
		expect(probe).toEqual({
			capabilities: { supported: ["stream"], models: ["fable", "opus", "sonnet", "haiku"] },
			availability: { status: "available" },
		});
		expect(fake.spawns.map((spawn) => spawn.args)).toEqual([
			["--version"],
			["auth", "status", "--json"],
		]);
		// A probe never sends a prompt.
		expect(fake.spawns.every((spawn) => (spawn.stdin ?? "") === "")).toBe(true);
	});

	it("is NOT_AUTHENTICATED for the recorded logged-out status (exit code 1)", async () => {
		const { runtime } = probeRuntime({
			lines: fixtureText("claude-code/auth-status.logged-out.json").split("\n"),
			code: 1,
		});

		expect((await runtime.probe()).availability).toMatchObject({
			status: "unavailable",
			reasonCode: "NOT_AUTHENTICATED",
		});
	});

	it("is PROBE_FAILED when the status output is not the documented JSON", async () => {
		const { runtime } = probeRuntime({ lines: ["Usage: claude [options]"], code: 1 });

		expect((await runtime.probe()).availability).toMatchObject({ reasonCode: "PROBE_FAILED" });
	});

	it("refuses the recorded API-key status as NOT_CONFIGURED, before any turn can spend money", async () => {
		const { fake, runtime } = probeRuntime({
			lines: fixtureText("claude-code/auth-status.api-key.json").split("\n"),
			code: 0,
		});

		const { availability, capabilities } = await runtime.probe();

		expect(availability).toMatchObject({ status: "unavailable", reasonCode: "NOT_CONFIGURED" });
		// No models are offered for a backend that cannot run.
		expect(capabilities).toEqual({ supported: ["stream"] });
		expect(JSON.stringify(availability)).toMatch(/metered API key/);
		expect(JSON.stringify(availability)).toMatch(/plan-limited/);
		// Only the two local status commands ran; no prompt was sent.
		expect(fake.spawns.map((spawn) => spawn.args)).toEqual([
			["--version"],
			["auth", "status", "--json"],
		]);
	});

	it("accepts the recorded `claude setup-token` status, which is subscription auth", async () => {
		const { runtime } = probeRuntime({
			lines: fixtureText("claude-code/auth-status.oauth-token.json").split("\n"),
			code: 0,
		});

		expect((await runtime.probe()).availability).toEqual({ status: "available" });
	});

	it.each([
		[
			"an API key source on an otherwise subscription-looking status",
			{
				authMethod: "claude.ai",
				apiProvider: "firstParty",
				apiKeySource: "apiKeyHelper SECRET-MARKER",
			},
		],
		["a third-party provider", { authMethod: "claude.ai", apiProvider: "bedrock" }],
		[
			"an auth method this adapter does not know",
			{ authMethod: "console", apiProvider: "firstParty" },
		],
		["no auth method at all", { apiProvider: "firstParty" }],
		["no provider at all", { authMethod: "claude.ai" }],
	])("fails closed as NOT_CONFIGURED for %s, without echoing the status", async (_label, status) => {
		const { runtime } = probeRuntime({
			lines: [JSON.stringify({ loggedIn: true, ...status })],
			code: 0,
		});

		const availability = (await runtime.probe()).availability;

		expect(availability).toMatchObject({ status: "unavailable", reasonCode: "NOT_CONFIGURED" });
		expect(JSON.stringify(availability)).not.toContain("SECRET-MARKER");
	});

	it("accepts a newer CLI version, relying on the per-run init check", async () => {
		const { runtime } = probeRuntime(
			{ lines: fixtureText("claude-code/auth-status.logged-in.json").split("\n"), code: 0 },
			"3.0.1 (Claude Code)",
		);

		expect((await runtime.probe()).availability).toEqual({ status: "available" });
	});
});
