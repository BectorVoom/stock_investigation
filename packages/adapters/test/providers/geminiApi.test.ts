/**
 * Gemini API adapter tests. RECORDED fixtures in fixtures/gemini-api
 * (live, 2026-11-14, see docs/external-apis/apis/gemini-api.md): ok.sse
 * (gemini-3.5-flash-lite, low effort), thinking-ok.sse (gemini-3.5-flash, low
 * effort), length.sse (stopped by max_completion_tokens 5), error-400.json.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	buildGeminiRequestBody,
	GEMINI_API_MODELS,
	GEMINI_CHAT_COMPLETIONS_URL,
	GEMINI_MAX_COMPLETION_TOKENS,
	resolveGeminiModel,
} from "../../src/providers/geminiApi.ts";
import { createGeminiApiRuntime } from "../../src/providers/index.ts";
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
	sseResponse,
	terminalEvents,
	textOf,
	usageEvents,
} from "./helpers.ts";

const API_KEY = "TEST-GEMINI-KEY-0123456789abcdef";
const CONFIGURED_ENV = { ...BASE_ENV, GEMINI_API_KEY: API_KEY };

function runtimeWith(
	fake: FakeFetch,
	env: Readonly<Record<string, string | undefined>> = CONFIGURED_ENV,
) {
	return createGeminiApiRuntime(makeEnvironment({ fetch: fake.fetch, env }));
}

const requestBodySchema = z.strictObject({
	model: z.string(),
	messages: z.array(z.strictObject({ role: z.literal("user"), content: z.string() })),
	stream: z.literal(true),
	max_completion_tokens: z.literal(16000),
	reasoning_effort: z.enum(["low", "medium", "high"]),
});

function bodyOf(fake: FakeFetch): z.infer<typeof requestBodySchema> {
	const body = itemAt(fake.calls, 0).init.body;
	if (typeof body !== "string") throw new Error("expected a string body");
	return requestBodySchema.parse(JSON.parse(body));
}

describe("gemini-api runtime metadata", () => {
	it("is a plan-limited, tool-isolated backend", () => {
		const runtime = createGeminiApiRuntime(makeEnvironment({ env: CONFIGURED_ENV }));
		expect(runtime.agentId).toBe("gemini-api");
		expect(runtime.displayName).toBe("Gemini API");
		expect(runtime.costModel).toBe("plan-limited");
		expect(runtime.toolIsolation).toBe("enforced");
	});
});

describe("gemini-api probe", () => {
	it("is NOT_CONFIGURED without GEMINI_API_KEY and never contacts the network", async () => {
		const probe = await createGeminiApiRuntime(
			makeEnvironment({ env: BASE_ENV, fetch: forbiddenFetch }),
		).probe();
		expect(probe.availability).toEqual({
			status: "unavailable",
			reasonCode: "NOT_CONFIGURED",
			detail: "The Gemini API needs GEMINI_API_KEY in the runner environment",
		});
	});

	it("is available with a key and offers the chat models, offline", async () => {
		const probe = await createGeminiApiRuntime(
			makeEnvironment({ env: CONFIGURED_ENV, fetch: forbiddenFetch }),
		).probe();
		expect(probe.availability).toEqual({ status: "available" });
		expect(probe.capabilities).toEqual({
			supported: ["stream", "cancel"],
			model: "gemini-3.5-flash",
			models: [
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-3.6-flash",
				"gemini-3.1-flash-lite",
			],
		});
	});

	it("reports GEMINI_MODEL as the default model when set", async () => {
		const probe = await createGeminiApiRuntime(
			makeEnvironment({ env: { ...CONFIGURED_ENV, GEMINI_MODEL: " gemini-3.5-flash-lite " } }),
		).probe();
		expect(probe.capabilities.model).toBe("gemini-3.5-flash-lite");
	});
});

describe("gemini-api request", () => {
	it("sends reasoning_effort and the 16,000-token cap", () => {
		expect(GEMINI_MAX_COMPLETION_TOKENS).toBe(16000);
		expect(GEMINI_API_MODELS).toEqual([
			"gemini-3.5-flash",
			"gemini-3.5-flash-lite",
			"gemini-3.6-flash",
			"gemini-3.1-flash-lite",
		]);
		expect(buildGeminiRequestBody("gemini-3.5-flash", "p", "high")).toBe(
			'{"model":"gemini-3.5-flash","messages":[{"role":"user","content":"p"}],"stream":true,"max_completion_tokens":16000,"reasoning_effort":"high"}',
		);
		expect(buildGeminiRequestBody("gemini-3.5-flash-lite", "p", "low")).toBe(
			'{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"p"}],"stream":true,"max_completion_tokens":16000,"reasoning_effort":"low"}',
		);
	});

	it("chooses Settings' model, then GEMINI_MODEL, then the default", () => {
		expect(resolveGeminiModel({ GEMINI_MODEL: "gemini-3.5-flash-lite" }, "gemini-3.6-flash")).toBe(
			"gemini-3.6-flash",
		);
		expect(resolveGeminiModel({ GEMINI_MODEL: "gemini-3.5-flash-lite" }, null)).toBe(
			"gemini-3.5-flash-lite",
		);
		expect(resolveGeminiModel({ GEMINI_MODEL: "  " }, null)).toBe("gemini-3.5-flash");
	});

	it("posts to the fixed endpoint with the key only in Authorization", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("gemini-api/ok.sse")));
		await collect(
			runtimeWith(fake, { ...CONFIGURED_ENV, ...SECRET_ENV, GEMINI_API_KEY: API_KEY }).run(
				makeRequest({ prompt: "Reply with the single word OK." }),
				makeContext({ model: "gemini-3.5-flash-lite", effort: "low", scratchDirectory: null }),
			),
		);
		expect(fake.calls).toHaveLength(1);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(GEMINI_CHAT_COMPLETIONS_URL);
		expect(call.init.method).toBe("POST");
		expect(call.init.redirect).toBe("error");
		expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
		const body = bodyOf(fake);
		expect(body).toEqual({
			model: "gemini-3.5-flash-lite",
			messages: [{ role: "user", content: "Reply with the single word OK." }],
			stream: true,
			max_completion_tokens: 16000,
			reasoning_effort: "low",
		});
		expect(JSON.stringify(call.init.body)).not.toContain("secret");
	});
});

describe("gemini-api recorded streams", () => {
	it("completes with the answer and an unknown cost (ok.sse)", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("gemini-api/ok.sse")));
		const events = await collect(
			runtimeWith(fake).run(
				makeRequest(),
				makeContext({ model: "gemini-3.5-flash-lite", scratchDirectory: null }),
			),
		);
		expect(textOf(events)).toBe("OK");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("forwards gemini-3.5-flash answer and ignores thought_signature (thinking-ok.sse)", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("gemini-api/thinking-ok.sse")));
		const events = await collect(
			runtimeWith(fake).run(makeRequest(), makeContext({ model: null, scratchDirectory: null })),
		);
		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("reports a turn stopped by the token cap as truncated, not completed", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("gemini-api/length.sse")));
		const events = await collect(
			runtimeWith(fake).run(
				makeRequest(),
				makeContext({ model: "gemini-3.5-flash-lite", scratchDirectory: null }),
			),
		);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_TRUNCATED", retryable: false },
		]);
	});

	it("maps a 400 to PROVIDER_REQUEST_REJECTED with the status unchanged, without retrying", async () => {
		const fake = recordingFetch(
			() =>
				new Response(fixtureText("gemini-api/error-400.json"), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const events = await collect(
			runtimeWith(fake).run(
				makeRequest(),
				makeContext({ model: "gemini-3.5-flash-lite", scratchDirectory: null }),
			),
		);
		expect(fake.calls).toHaveLength(1);
		expect(terminalEvents(events)).toEqual([
			expect.objectContaining({
				type: "failed",
				code: "PROVIDER_REQUEST_REJECTED",
				upstreamStatus: 400,
			}),
		]);
	});

	it("fails closed before any request without a key or with an invalid model id", async () => {
		for (const [env, model] of [
			[BASE_ENV, "gemini-3.5-flash-lite"],
			[CONFIGURED_ENV, "bad model"],
		] as const) {
			const events = await collect(
				createGeminiApiRuntime(makeEnvironment({ env, fetch: forbiddenFetch })).run(
					makeRequest(),
					makeContext({ model, scratchDirectory: null }),
				),
			);
			expect(itemAt(events, -1).type).toBe("failed");
		}
	});
});
