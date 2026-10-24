/**
 * Claude API adapter tests. The SSE fixtures in fixtures/claude-api are
 * DOC-DERIVED (written 2026-10-24 from Anthropic's Messages API streaming
 * reference), not captured from the live API.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	CLAUDE_API_MESSAGES_URL,
	CLAUDE_API_MODELS,
	type ClaudeModel,
	claudeCostUsd,
	claudeModel,
	failureForClaudeErrorType,
	failureForClaudeHttpStatus,
	failureForStopReason,
	interpretClaudeSseLine,
	MAX_OUTPUT_TOKENS,
} from "../../src/providers/claudeApi.ts";
import { createClaudeApiRuntime } from "../../src/providers/index.ts";
import {
	BASE_ENV,
	collect,
	type FakeFetch,
	fixtureText,
	forbiddenFetch,
	itemAt,
	makeContext,
	makeEnvironment,
	makeRequest,
	recordingFetch,
	SECRET_ENV,
	sseData,
	sseResponse,
	terminalEvents,
	textOf,
	usageEvents,
} from "./helpers.ts";

const API_KEY = "sk-ant-api03-TEST-KEY-0123456789abcdef";
const CONFIGURED_ENV = { ...BASE_ENV, ANTHROPIC_API_KEY: API_KEY };

function runtimeWith(
	fake: FakeFetch,
	env: Readonly<Record<string, string | undefined>> = CONFIGURED_ENV,
) {
	return createClaudeApiRuntime(makeEnvironment({ fetch: fake.fetch, env }));
}

function modelById(id: string): ClaudeModel {
	const model = claudeModel(id);
	if (model === null) throw new Error(`no such model ${id}`);
	return model;
}

const requestBodySchema = z.strictObject({
	model: z.string(),
	max_tokens: z.number().int().positive(),
	messages: z.array(z.strictObject({ role: z.literal("user"), content: z.string() })),
	stream: z.literal(true),
	output_config: z.strictObject({ effort: z.enum(["low", "medium", "high"]) }),
});

/** A complete stream answering `text`, with the given final usage and stop reason. */
function answer(
	text: string,
	options: { readonly stopReason?: string; readonly input?: number; readonly output?: number } = {},
): string {
	return [
		sseData({ type: "message_start", message: { usage: { input_tokens: options.input ?? 100 } } }),
		sseData({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		sseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		sseData({
			type: "message_delta",
			delta: { stop_reason: options.stopReason ?? "end_turn" },
			usage: { output_tokens: options.output ?? 10 },
		}),
		sseData({ type: "message_stop" }),
	].join("");
}

describe("claude-api runtime metadata", () => {
	it("is a metered, tool-isolated backend distinct from the Claude Code CLI", () => {
		const runtime = createClaudeApiRuntime(makeEnvironment({ env: CONFIGURED_ENV }));
		expect(runtime.agentId).toBe("claude-api");
		expect(runtime.displayName).toBe("Claude API");
		expect(runtime.costModel).toBe("metered");
		expect(runtime.toolIsolation).toBe("enforced");
	});
});

describe("claude-api probe", () => {
	it("is NOT_CONFIGURED without ANTHROPIC_API_KEY and never contacts the network", async () => {
		const probe = await createClaudeApiRuntime(
			makeEnvironment({ env: BASE_ENV, fetch: forbiddenFetch }),
		).probe();
		expect(probe.availability).toEqual({
			status: "unavailable",
			reasonCode: "NOT_CONFIGURED",
			detail: "The Claude API needs ANTHROPIC_API_KEY in the runner environment",
		});
	});

	it.each([
		["blank", "   "],
		["too short", "sk-ant"],
		["containing a space", "sk-ant api03 0123456789"],
	])("treats a %s key as missing", async (_label, key) => {
		const probe = await createClaudeApiRuntime(
			makeEnvironment({ env: { ...BASE_ENV, ANTHROPIC_API_KEY: key } }),
		).probe();
		expect(probe.availability.status).toBe("unavailable");
	});

	it("is available with a key and offers exactly the priced models, offline", async () => {
		const probe = await createClaudeApiRuntime(
			makeEnvironment({ env: CONFIGURED_ENV, fetch: forbiddenFetch }),
		).probe();
		expect(probe.availability).toEqual({ status: "available" });
		expect(probe.capabilities).toEqual({
			supported: ["stream", "cancel"],
			model: "claude-opus-5-5",
			models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
		});
	});
});

describe("claude-api request", () => {
	it("posts one streaming Messages request with the prompt, the effort, and no tools", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("claude-api/ok.sse")));

		await collect(
			runtimeWith(fake).run(
				makeRequest({ prompt: "the research prompt" }),
				makeContext({ scratchDirectory: null, effort: "high", model: "claude-sonnet-5-5" }),
			),
		);

		expect(fake.calls).toHaveLength(1);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe("https://api.anthropic.com/v1/messages");
		expect(call.init.method).toBe("POST");
		expect(call.init.redirect).toBe("error");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);
		const headers = new Headers(call.init.headers);
		expect(headers.get("x-api-key")).toBe(API_KEY);
		expect(headers.get("anthropic-version")).toBe("2026-10-21");
		expect(headers.get("authorization")).toBeNull();
		// strictObject: tools, fallbacks, thinking or sampling parameters would fail the parse.
		const body = requestBodySchema.parse(JSON.parse(String(call.init.body)));
		expect(body).toEqual({
			model: "claude-sonnet-5-5",
			max_tokens: MAX_OUTPUT_TOKENS,
			messages: [{ role: "user", content: "the research prompt" }],
			stream: true,
			output_config: { effort: "high" },
		});
	});

	it("uses Claude Opus 5.5 when Settings leaves the model empty", async () => {
		const fake = recordingFetch(() => sseResponse(answer("OK")));

		await collect(runtimeWith(fake).run(makeRequest(), makeContext({ model: null })));

		expect(requestBodySchema.parse(JSON.parse(String(itemAt(fake.calls, 0).init.body))).model).toBe(
			"claude-opus-5-5",
		);
	});

	it("never sends ANTHROPIC_BASE_URL's host the key: the origin is fixed", async () => {
		const fake = recordingFetch(() => sseResponse(answer("OK")));

		await collect(
			runtimeWith(fake, { ...CONFIGURED_ENV, ANTHROPIC_BASE_URL: "https://evil.example" }).run(
				makeRequest(),
				makeContext(),
			),
		);

		expect(fake.calls.map((call) => call.url)).toEqual([CLAUDE_API_MESSAGES_URL]);
	});

	it.each([
		["an unpriced model", { model: "claude-unknown-9" }, "PROVIDER_MODEL_INVALID"],
		["a date-suffixed id", { model: "claude-opus-5-5-20260401" }, "PROVIDER_MODEL_INVALID"],
	])("refuses %s before any network activity", async (_label, context, code) => {
		const events = await collect(
			createClaudeApiRuntime(makeEnvironment({ env: CONFIGURED_ENV, fetch: forbiddenFetch })).run(
				makeRequest(),
				makeContext(context),
			),
		);
		expect(events).toEqual([{ type: "failed", code, retryable: false }]);
	});

	it("fails NOT_CONFIGURED without a key, before any network activity", async () => {
		const events = await collect(
			createClaudeApiRuntime(makeEnvironment({ env: BASE_ENV, fetch: forbiddenFetch })).run(
				makeRequest(),
				makeContext(),
			),
		);
		expect(events).toEqual([{ type: "failed", code: "NOT_CONFIGURED", retryable: false }]);
	});
});

describe("claude-api streaming", () => {
	it("streams the text deltas, drops thinking, and reports the computed cost", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("claude-api/ok.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(events.filter((event) => event.type === "text.delta")).toEqual([
			{ type: "text.delta", text: "Hello" },
			{ type: "text.delta", text: ", wor" },
			{ type: "text.delta", text: "ld — 日本語" },
		]);
		// 1,200 input × 4 USD + 350 output × 20 USD per million tokens (Claude Opus 5.5).
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: 0.0118 }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("reassembles events split across arbitrary byte boundaries", async () => {
		const bytes = new TextEncoder().encode(fixtureText("claude-api/ok.sse"));
		const chunks = Array.from({ length: bytes.length }, (_, index) =>
			bytes.slice(index, index + 1),
		);
		const fake = recordingFetch(() => sseResponse(chunks));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("Hello, world — 日本語");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("fails PROVIDER_REFUSED on a refusal, after the partial text, and still reports the cost", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("claude-api/refusal.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("I can");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: 0.00384 }]);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_REFUSED", retryable: false },
		]);
		// No fallback model is tried (AGT-012).
		expect(fake.calls).toHaveLength(1);
	});

	it("reports a turn stopped at max_tokens as truncated, billed, and not retried", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("claude-api/max-tokens.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: 0.3236 }]);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_TRUNCATED", retryable: false },
		]);
	});

	it("fails closed on a tool block although no tools were offered", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("claude-api/tool-use.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
		]);
	});

	it("fails PROVIDER_OUTPUT_EMPTY for a complete answer with no text", async () => {
		const fake = recordingFetch(() => sseResponse(answer("")));

		expect(
			terminalEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext()))),
		).toEqual([{ type: "failed", code: "PROVIDER_OUTPUT_EMPTY", retryable: true }]);
	});

	it("fails PROVIDER_OUTPUT_INVALID when the stream closes before message_stop", async () => {
		const cut = answer("partial").split(sseData({ type: "message_stop" }))[0] ?? "";
		const fake = recordingFetch(() => sseResponse(cut));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("partial");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false },
		]);
	});

	it("fails PROVIDER_OUTPUT_INVALID after more than eight malformed lines", async () => {
		const garbage = Array.from({ length: 9 }, (_, index) => `data: {bad ${index}\n\n`).join("");
		const fake = recordingFetch(() => sseResponse(`${garbage}${answer("late")}`));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false },
		]);
	});
});

describe("claude-api failures and retries", () => {
	it("does not retry an error after the message started, and reports the cost as unknown", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("claude-api/midstream-error.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("Partial");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_UNAVAILABLE", retryable: true },
		]);
		expect(fake.calls).toHaveLength(1);
	});

	it("retries an overloaded error that arrives before the message starts", async () => {
		vi.useFakeTimers();
		try {
			const fake = recordingFetch(() =>
				fake.calls.length === 1
					? sseResponse(fixtureText("claude-api/overloaded-before-start.sse"))
					: sseResponse(answer("OK")),
			);

			const pending = collect(runtimeWith(fake).run(makeRequest(), makeContext()));
			await vi.advanceTimersByTimeAsync(2_000);
			const events = await pending;

			expect(fake.calls).toHaveLength(2);
			expect(textOf(events)).toBe("OK");
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries HTTP 529 after the provider's Retry-After", async () => {
		vi.useFakeTimers();
		try {
			const fake = recordingFetch(() =>
				fake.calls.length === 1
					? new Response("{}", { status: 529, headers: { "retry-after": "3" } })
					: sseResponse(answer("OK")),
			);

			const pending = collect(runtimeWith(fake).run(makeRequest(), makeContext()));
			await vi.advanceTimersByTimeAsync(2_999);
			expect(fake.calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(terminalEvents(await pending)).toEqual([{ type: "completed" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		[400, "PROVIDER_REQUEST_REJECTED"],
		[401, "PROVIDER_AUTH"],
		[403, "PROVIDER_AUTH"],
		[404, "PROVIDER_MODEL_UNAVAILABLE"],
		[413, "PROVIDER_REQUEST_REJECTED"],
	])("maps HTTP %i to %s without retrying and without usage", async (status, code) => {
		const fake = recordingFetch(() => new Response("{}", { status }));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(events).toEqual([{ type: "failed", code, retryable: false }]);
		expect(fake.calls).toHaveLength(1);
	});

	it("maps every documented error type", () => {
		expect(
			[
				"overloaded_error",
				"api_error",
				"rate_limit_error",
				"authentication_error",
				"permission_error",
				"billing_error",
				"timeout_error",
				"not_found_error",
				"invalid_request_error",
				"request_too_large",
				undefined,
			].map((type) => failureForClaudeErrorType(type).code),
		).toEqual([
			"PROVIDER_UNAVAILABLE",
			"PROVIDER_UNAVAILABLE",
			"PROVIDER_RATE_LIMITED",
			"PROVIDER_AUTH",
			"PROVIDER_AUTH",
			"PROVIDER_PAYMENT_REQUIRED",
			"PROVIDER_TIMEOUT",
			"PROVIDER_MODEL_UNAVAILABLE",
			"PROVIDER_REQUEST_REJECTED",
			"PROVIDER_REQUEST_REJECTED",
			"PROVIDER_REQUEST_REJECTED",
		]);
		expect(failureForClaudeHttpStatus(529).code).toBe("PROVIDER_UNAVAILABLE");
	});

	it("maps every stop reason", () => {
		expect(
			[
				"end_turn",
				"stop_sequence",
				"max_tokens",
				"model_context_window_exceeded",
				"refusal",
				"tool_use",
				"pause_turn",
				"something_new",
			].map((reason) => failureForStopReason(reason)?.code ?? null),
		).toEqual([
			null,
			null,
			"PROVIDER_OUTPUT_TRUNCATED",
			"PROVIDER_OUTPUT_TRUNCATED",
			"PROVIDER_REFUSED",
			"PROVIDER_TOOL_ISOLATION_VIOLATED",
			"PROVIDER_TOOL_ISOLATION_VIOLATED",
			"PROVIDER_OUTPUT_INVALID",
		]);
	});
});

describe("claude-api SSE lines", () => {
	it("skips event names, pings, unknown events and non-text deltas", () => {
		expect(interpretClaudeSseLine("event: message_start")).toEqual({ kind: "ignored" });
		expect(interpretClaudeSseLine('data: {"type":"ping"}')).toEqual({ kind: "ignored" });
		expect(interpretClaudeSseLine('data: {"type":"brand_new_event"}')).toEqual({
			kind: "ignored",
		});
		expect(
			interpretClaudeSseLine(
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}',
			),
		).toEqual({ kind: "ignored" });
	});

	it("treats invalid JSON and negative or fractional token counts as malformed", () => {
		expect(interpretClaudeSseLine("data: {")).toEqual({ kind: "malformed" });
		expect(interpretClaudeSseLine('data: {"no":"type"}')).toEqual({ kind: "malformed" });
		expect(
			interpretClaudeSseLine(
				'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":-1}}',
			),
		).toEqual({ kind: "malformed" });
		expect(
			interpretClaudeSseLine(
				'data: {"type":"message_start","message":{"usage":{"input_tokens":1.5}}}',
			),
		).toEqual({ kind: "malformed" });
	});
});

describe("claude-api cost", () => {
	it("lists only models with a price, most capable first", () => {
		expect(CLAUDE_API_MODELS.map((model) => model.id)).toEqual([
			"claude-fable-5-1",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"claude-haiku-5-5",
		]);
		for (const model of CLAUDE_API_MODELS) {
			expect(model.price.input).toBeGreaterThan(0);
			expect(model.price.output).toBeGreaterThan(model.price.input);
		}
	});

	it("is unknown until both the input and the output counts are known", () => {
		const opus = modelById("claude-opus-5-5");
		expect(claudeCostUsd(opus, { inputTokens: 10 })).toBeNull();
		expect(claudeCostUsd(opus, { outputTokens: 10 })).toBeNull();
		expect(claudeCostUsd(opus, { inputTokens: 0, outputTokens: 0 })).toBe(0);
	});

	it("prices cache writes at the 1-hour rate and cache reads at the model's read price", () => {
		const opus = modelById("claude-opus-5-5");
		// 1M cache write × 4 × 2 + 1M cache read × 0.20 = 8.20 USD.
		expect(
			claudeCostUsd(opus, {
				inputTokens: 0,
				cacheCreationInputTokens: 1_000_000,
				cacheReadInputTokens: 1_000_000,
				outputTokens: 0,
			}),
		).toBeCloseTo(8.2, 12);
	});

	it("charges Claude Haiku 5.5's long-prompt price above 100K prompt tokens", () => {
		const haiku = modelById("claude-haiku-5-5");
		expect(claudeCostUsd(haiku, { inputTokens: 100_000, outputTokens: 1_000_000 })).toBeCloseTo(
			0.51,
			12,
		);
		expect(claudeCostUsd(haiku, { inputTokens: 100_001, outputTokens: 1_000_000 })).toBeCloseTo(
			2.5500005,
			12,
		);
	});
});

describe("claude-api secret handling", () => {
	it("sends only its own key, only to Anthropic, and never places a secret in an event", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("claude-api/ok.sse")));
		const otherSecrets = Object.entries(SECRET_ENV)
			.filter(([name]) => name !== "ANTHROPIC_API_KEY")
			.map(([, value]) => value);

		const events = await collect(
			runtimeWith(fake, { ...SECRET_ENV, ...CONFIGURED_ENV }).run(makeRequest(), makeContext()),
		);

		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(API_KEY);
		for (const secret of otherSecrets) expect(serialized).not.toContain(secret);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(CLAUDE_API_MESSAGES_URL);
		const headers = JSON.stringify(call.init.headers);
		for (const secret of otherSecrets) expect(headers).not.toContain(secret);
	});
});
