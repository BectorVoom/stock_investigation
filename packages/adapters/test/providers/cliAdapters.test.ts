/**
 * Behaviour every CLI adapter (OpenCode, Codex, Claude Code) must share. Each
 * case runs once per backend; provider-specific parsing is tested in the
 * per-adapter files.
 */
import type { AgentRuntime } from "@research/agent-core";
import type { AgentEvent } from "@research/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	createClaudeCodeRuntime,
	createCodexRuntime,
	createOpenCodeRuntime,
	type ProviderEnvironment,
} from "../../src/providers/index.ts";
import {
	BASE_ENV,
	collect,
	createFakeProcessRunner,
	fixtureLines,
	itemAt,
	makeContext,
	makeEnvironment,
	makeRequest,
	SECRET_ENV,
	terminalEvents,
	textOf,
	usageEvents,
} from "./helpers.ts";

interface CliBackend {
	readonly name: string;
	readonly command: string;
	readonly create: (environment: ProviderEnvironment) => AgentRuntime;
	readonly okFixture: string;
	readonly model: string;
	/** Provider-owned variables that ARE forwarded when present. */
	readonly forwardedEnv: Readonly<Record<string, string>>;
	/** A stream line that parses and carries a lot of text, for the size-limit test. */
	readonly bigTextLine: (text: string) => string;
	/** Lines that must precede text for the backend to accept it. */
	readonly preamble: readonly string[];
}

const noopWriteConfig = (): Promise<void> => Promise.resolve();

const BACKENDS: readonly CliBackend[] = [
	{
		name: "opencode",
		command: "opencode",
		create: (environment) =>
			createOpenCodeRuntime(environment, { writeConfigFile: noopWriteConfig }),
		okFixture: "opencode/ok.jsonl",
		model: "opencode-go/example-model",
		forwardedEnv: {
			XDG_CONFIG_HOME: "/home/owner/.config",
			XDG_DATA_HOME: "/home/owner/.local/share",
			XDG_STATE_HOME: "/home/owner/.local/state",
			XDG_CACHE_HOME: "/home/owner/.cache",
		},
		bigTextLine: (text) => JSON.stringify({ type: "text", part: { type: "text", text } }),
		preamble: [],
	},
	{
		name: "codex",
		command: "codex",
		create: createCodexRuntime,
		okFixture: "codex/ok.jsonl",
		model: "example-model",
		forwardedEnv: { CODEX_HOME: "/home/owner/.codex" },
		bigTextLine: (text) =>
			JSON.stringify({
				type: "item.completed",
				item: { id: "item_0", type: "agent_message", text },
			}),
		preamble: [],
	},
	{
		name: "claude-code",
		command: "claude",
		create: createClaudeCodeRuntime,
		okFixture: "claude-code/ok.stream.jsonl",
		model: "example-model",
		forwardedEnv: {
			CLAUDE_CONFIG_DIR: "/home/owner/.claude",
			CLAUDE_CODE_OAUTH_TOKEN: "subscription-token-from-setup-token",
		},
		bigTextLine: (text) =>
			JSON.stringify({
				type: "stream_event",
				event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
			}),
		preamble: [
			JSON.stringify({
				type: "system",
				subtype: "init",
				tools: [],
				mcp_servers: [],
				apiKeySource: "none",
			}),
		],
	},
];

describe.each(BACKENDS)("$name CLI adapter", (backend) => {
	const context = (overrides: Parameters<typeof makeContext>[0] = {}) =>
		makeContext({ model: backend.model, ...overrides });

	it("completes the recorded happy path with exactly one terminal event and an unknown cost", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context()));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		expect(events.at(-1)).toEqual({ type: "completed" });
		// Plan-limited: the cost is unknown, which is never reported as 0 (AGT-008).
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
	});

	it("runs the CLI in the scratch directory and sends the prompt on stdin, never in argv", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));
		const prompt = "PROMPT-MARKER --dangerously-skip-permissions; rm -rf ~ $(id)";

		await collect(
			runtime.run(makeRequest({ prompt }), context({ scratchDirectory: "/scratch/job_9" })),
		);

		expect(fake.spawns).toHaveLength(1);
		const spawn = itemAt(fake.spawns, 0);
		expect(spawn.command).toBe(backend.command);
		expect(spawn.cwd).toBe("/scratch/job_9");
		expect(spawn.stdin).toBe(prompt);
		expect(spawn.args.join("\u0000")).not.toContain("PROMPT-MARKER");
		expect(spawn.args.some((arg) => arg.includes("rm -rf"))).toBe(false);
	});

	it("never passes an auto-approve or sandbox-bypass flag", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		await collect(runtime.run(makeRequest(), context()));

		const args = itemAt(fake.spawns, 0).args;
		expect(
			args.filter((arg) => /danger|bypass|approve-for-me|skip-permissions/i.test(arg)),
		).toEqual([]);
		expect(args).not.toContain("--auto");
		expect(args).not.toContain("--search");
	});

	it("gives the child an allowlisted environment with none of the runner's secrets", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(
			makeEnvironment({
				processRunner: fake.runner,
				env: { ...BASE_ENV, ...SECRET_ENV, ...backend.forwardedEnv, EMPTY_VALUE: "" },
			}),
		);

		await collect(runtime.run(makeRequest(), context()));

		const childEnv = itemAt(fake.spawns, 0).env;
		expect(childEnv).toEqual({ ...BASE_ENV, ...backend.forwardedEnv });
		for (const [key, value] of Object.entries(SECRET_ENV)) {
			expect(childEnv, `${key} must not be forwarded`).not.toHaveProperty(key);
			expect(Object.values(childEnv)).not.toContain(value);
		}
		expect(
			Object.keys(childEnv).filter((key) => /RUNNER|WORKER|CLOUDFLARE|OPENROUTER/.test(key)),
		).toEqual([]);
	});

	it("uses the same allowlisted environment for its probe commands", async () => {
		const fake = createFakeProcessRunner({ lines: ["0.0.1"] });
		const runtime = backend.create(
			makeEnvironment({ processRunner: fake.runner, env: { ...BASE_ENV, ...SECRET_ENV } }),
		);

		await runtime.probe();

		expect(fake.spawns.length).toBeGreaterThan(0);
		for (const spawn of fake.spawns) expect(spawn.env).toEqual(BASE_ENV);
	});

	it("fails with PROVIDER_EXIT_NONZERO when the CLI exits non-zero without an explanation", async () => {
		const fake = createFakeProcessRunner({
			lines: [],
			exit: { code: 2, stderrTail: "panic: boom" },
		});
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context()));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_EXIT_NONZERO", retryable: false },
		]);
		expect(textOf(events)).toBe("");
	});

	it("tolerates a few garbage lines around valid output", async () => {
		const fake = createFakeProcessRunner({
			lines: ["warning: not json", "{broken", ...fixtureLines(backend.okFixture), "trailing noise"],
		});
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context()));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("fails with PROVIDER_OUTPUT_INVALID once garbage exceeds the tolerated bound", async () => {
		const fake = createFakeProcessRunner({
			lines: Array.from({ length: 50 }, (_, index) => `garbage line ${index}`),
			hang: true,
		});
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context()));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false },
		]);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("fails with PROVIDER_OUTPUT_TOO_LARGE and stops the process when the text budget is exceeded", async () => {
		const megabyte = "x".repeat(1024 * 1024);
		const fake = createFakeProcessRunner({
			lines: [
				...backend.preamble,
				...Array.from({ length: 4 }, () => backend.bigTextLine(megabyte)),
			],
			hang: true,
		});
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context()));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_TOO_LARGE", retryable: false },
		]);
		expect(textOf(events).length).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("fails with DEADLINE_EXCEEDED without spawning when the deadline has already passed", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(
			runtime.run(makeRequest({ deadline: "2020-01-01T00:00:00.000Z" }), context()),
		);

		expect(events).toEqual([{ type: "failed", code: "DEADLINE_EXCEEDED", retryable: false }]);
		expect(fake.spawns).toHaveLength(0);
	});

	it("fails with DEADLINE_EXCEEDED and stops the process when the deadline passes mid-run", async () => {
		vi.useFakeTimers();
		try {
			const fake = createFakeProcessRunner({ lines: backend.preamble, hang: true });
			const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));
			const deadline = new Date(Date.now() + 5_000).toISOString();

			const pending = collect(runtime.run(makeRequest({ deadline }), context()));
			// Lets the adapter reach its spawn before the clock moves.
			await vi.advanceTimersByTimeAsync(0);
			expect(fake.spawns).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(5_001);
			const events = await pending;

			expect(terminalEvents(events)).toEqual([
				{ type: "failed", code: "DEADLINE_EXCEEDED", retryable: false },
			]);
			expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails with ABORTED without spawning when the signal is already aborted", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));
		const controller = new AbortController();
		controller.abort();

		const events = await collect(
			runtime.run(makeRequest(), context({ signal: controller.signal })),
		);

		expect(events).toEqual([{ type: "failed", code: "ABORTED", retryable: false }]);
		expect(fake.spawns).toHaveLength(0);
	});

	it("fails with ABORTED and aborts the process signal when cancelled mid-stream", async () => {
		const fake = createFakeProcessRunner({
			lines: [...backend.preamble, backend.bigTextLine("partial answer")],
			hang: true,
		});
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));
		const controller = new AbortController();

		const events = [];
		for await (const event of runtime.run(makeRequest(), context({ signal: controller.signal }))) {
			events.push(event);
			if (event.type === "text.delta") controller.abort();
		}

		expect(textOf(events)).toBe("partial answer");
		expect(terminalEvents(events)).toEqual([{ type: "failed", code: "ABORTED", retryable: false }]);
		expect(events.at(-1)).toEqual({ type: "failed", code: "ABORTED", retryable: false });
		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("reports ABORTED only after the runner confirmed the process tree is gone", async () => {
		vi.useFakeTimers();
		try {
			// The tree needs 1.5 s to die (e.g. a descendant that only yields to SIGKILL).
			const fake = createFakeProcessRunner({
				lines: backend.preamble,
				hang: true,
				exitAfterAbortMs: 1_500,
			});
			const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));
			const controller = new AbortController();
			const events: AgentEvent[] = [];
			const pending = (async () => {
				for await (const event of runtime.run(
					makeRequest(),
					context({ signal: controller.signal }),
				)) {
					events.push(event);
				}
			})();
			await vi.advanceTimersByTimeAsync(0);
			expect(fake.spawns).toHaveLength(1);

			controller.abort();
			await vi.advanceTimersByTimeAsync(1_499);
			// Nothing terminal yet: the caller must not discard the scratch directory at this point.
			expect(terminalEvents(events)).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(terminalEvents(events)).toEqual([
				{ type: "failed", code: "ABORTED", retryable: false },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still ends with ABORTED, after a bounded wait, when the runner never reports an exit", async () => {
		vi.useFakeTimers();
		try {
			const fake = createFakeProcessRunner({ lines: backend.preamble, ignoreAbort: true });
			const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));
			const controller = new AbortController();

			const pending = collect(runtime.run(makeRequest(), context({ signal: controller.signal })));
			await vi.advanceTimersByTimeAsync(0);
			expect(fake.spawns).toHaveLength(1);
			controller.abort();
			await vi.advanceTimersByTimeAsync(10_000);

			expect(terminalEvents(await pending)).toEqual([
				{ type: "failed", code: "ABORTED", retryable: false },
			]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the process when the consumer stops reading early", async () => {
		const fake = createFakeProcessRunner({
			lines: [...backend.preamble, backend.bigTextLine("first")],
			hang: true,
		});
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		for await (const event of runtime.run(makeRequest(), context())) {
			if (event.type === "text.delta") break;
		}

		expect(itemAt(fake.spawns, 0).signal.aborted).toBe(true);
	});

	it("fails with PROVIDER_NOT_INSTALLED when the binary is missing", async () => {
		const fake = createFakeProcessRunner({ spawnErrorCode: "ENOENT" });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context()));

		expect(events).toEqual([{ type: "failed", code: "PROVIDER_NOT_INSTALLED", retryable: false }]);
	});

	it("fails with PROVIDER_SPAWN_FAILED when the runner itself throws", async () => {
		const runtime = backend.create(
			makeEnvironment({
				processRunner: {
					run: () => {
						throw new Error("EACCES");
					},
				},
			}),
		);

		const events = await collect(runtime.run(makeRequest(), context()));

		expect(events).toEqual([{ type: "failed", code: "PROVIDER_SPAWN_FAILED", retryable: false }]);
	});

	it("refuses to run without a scratch directory", async () => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context({ scratchDirectory: null })));

		expect(events).toEqual([
			{ type: "failed", code: "SCRATCH_DIRECTORY_REQUIRED", retryable: false },
		]);
		expect(fake.spawns).toHaveLength(0);
	});

	it.each([
		"--dangerously-bypass-approvals-and-sandbox",
		"-c",
		"model with spaces",
		"a\nb",
		"",
	])("rejects the model id %j before spawning, so it cannot become a CLI option", async (model) => {
		const fake = createFakeProcessRunner({ lines: fixtureLines(backend.okFixture) });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const events = await collect(runtime.run(makeRequest(), context({ model })));

		expect(events).toEqual([{ type: "failed", code: "PROVIDER_MODEL_INVALID", retryable: false }]);
		expect(fake.spawns).toHaveLength(0);
	});

	it("reports NOT_INSTALLED from probe when the binary is missing", async () => {
		const fake = createFakeProcessRunner({ spawnErrorCode: "ENOENT" });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const probe = await runtime.probe();

		expect(probe.availability).toMatchObject({
			status: "unavailable",
			reasonCode: "NOT_INSTALLED",
		});
		expect(itemAt(fake.spawns, 0).args).toEqual(["--version"]);
	});

	it("reports PROBE_FAILED from probe when --version fails or prints no version", async () => {
		const failing = backend.create(
			makeEnvironment({ processRunner: createFakeProcessRunner({ exit: { code: 1 } }).runner }),
		);
		const silent = backend.create(
			makeEnvironment({
				processRunner: createFakeProcessRunner({ lines: ["no digits here"] }).runner,
			}),
		);

		expect((await failing.probe()).availability).toMatchObject({ reasonCode: "PROBE_FAILED" });
		expect((await silent.probe()).availability).toMatchObject({ reasonCode: "PROBE_FAILED" });
	});

	it("reports UNSUPPORTED_VERSION from probe for a CLI older than the verified one", async () => {
		const fake = createFakeProcessRunner({ lines: ["0.0.1"] });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		const probe = await runtime.probe();

		expect(probe.availability).toMatchObject({
			status: "unavailable",
			reasonCode: "UNSUPPORTED_VERSION",
		});
		// The auth status command is not run for a version that will be refused anyway.
		expect(fake.spawns).toHaveLength(1);
	});

	it("re-probes on every call instead of caching", async () => {
		const fake = createFakeProcessRunner({ lines: ["0.0.1"] });
		const runtime = backend.create(makeEnvironment({ processRunner: fake.runner }));

		await runtime.probe();
		await runtime.probe();

		expect(fake.spawns).toHaveLength(2);
	});
});
