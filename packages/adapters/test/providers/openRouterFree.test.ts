import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenRouterFreeRuntime } from "../../src/providers/index.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "../../src/providers/openRouter.ts";
import { OPENROUTER_MODELS_URL } from "../../src/providers/openRouterModels.ts";
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
	sseData,
	sseResponse,
	terminalEvents,
	textOf,
	usageEvents,
} from "./helpers.ts";

const API_KEY = "sk-or-v1-TEST-KEY-0123456789abcdef";
const FREE_MODEL = "google/gemma-4-31b-it:free";
const CONFIGURED_ENV = {
	...BASE_ENV,
	OPENROUTER_API_KEY: API_KEY,
	OPENROUTER_FREE_MODEL: FREE_MODEL,
};
function contentChunk(content: string, finishReason: string | null = null): string {
	return sseData({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] });
}

const DONE = "data: [DONE]\n\n";

const requestBodySchema = z.strictObject({
	model: z.string(),
	messages: z.array(z.strictObject({ role: z.string(), content: z.string() })),
	stream: z.literal(true),
	max_completion_tokens: z.number().int().positive(),
	usage: z.strictObject({ include: z.literal(true) }),
	reasoning: z.strictObject({ effort: z.string() }),
});

describe("openrouter-free runtime metadata", () => {
	it("is plan-limited and tool-isolated by construction", () => {
		const runtime = createOpenRouterFreeRuntime(makeEnvironment({ env: CONFIGURED_ENV }));
		expect(runtime.agentId).toBe("openrouter-free");
		expect(runtime.displayName).toBe("OpenRouter (free models)");
		expect(runtime.costModel).toBe("plan-limited");
		expect(runtime.toolIsolation).toBe("enforced");
	});
});

describe("openrouter-free probe", () => {
	it("reports NOT_CONFIGURED with zero fetch calls when the key is missing", async () => {
		const fake = recordingFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
		const runtime = createOpenRouterFreeRuntime(
			makeEnvironment({ fetch: fake.fetch, env: BASE_ENV }),
		);

		const probe = await runtime.probe();

		expect(probe.availability).toMatchObject({
			status: "unavailable",
			reasonCode: "NOT_CONFIGURED",
		});
		expect(JSON.stringify(probe)).toContain("OPENROUTER_API_KEY");
		expect(fake.calls).toHaveLength(0);
	});

	it("is available with the catalog models and the configured free model", async () => {
		const fake = recordingFetch((call) => {
			if (call.url === OPENROUTER_MODELS_URL) {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "b/model:free", pricing: { prompt: "0", completion: "0" } },
							{ id: "a/model:free", pricing: { prompt: "0", completion: "0" } },
						],
					}),
					{ status: 200 },
				);
			}
			return sseResponse(`${contentChunk("OK", "stop")}${DONE}`);
		});
		const runtime = createOpenRouterFreeRuntime(
			makeEnvironment({ fetch: fake.fetch, env: CONFIGURED_ENV }),
		);

		const probe = await runtime.probe();

		expect(probe.availability).toEqual({ status: "available" });
		expect(probe.capabilities.supported).toEqual(["stream", "cancel"]);
		expect(probe.capabilities.model).toBe(FREE_MODEL);
		expect(probe.capabilities.models).toEqual(["a/model:free", "b/model:free"]);
	});

	it("is available without models when the catalog fails", async () => {
		const runtime = createOpenRouterFreeRuntime(makeEnvironment({ env: CONFIGURED_ENV }), {
			catalog: { list: () => Promise.resolve(null) },
		});

		const probe = await runtime.probe();

		expect(probe.availability).toEqual({ status: "available" });
		expect(probe.capabilities).toEqual({ supported: ["stream", "cancel"], model: FREE_MODEL });
	});
});

describe("openrouter-free configuration", () => {
	it("refuses a non-free model with zero fetch calls", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok-no-cost.sse")));
		const runtime = createOpenRouterFreeRuntime(
			makeEnvironment({ fetch: fake.fetch, env: CONFIGURED_ENV }),
		);

		const events = await collect(
			runtime.run(makeRequest(), makeContext({ model: "google/gemma-4-31b-it" })),
		);

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_MODEL_INVALID", retryable: false },
		]);
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses a missing model with zero fetch calls", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok-no-cost.sse")));
		const runtime = createOpenRouterFreeRuntime(
			makeEnvironment({
				fetch: fake.fetch,
				env: { ...BASE_ENV, OPENROUTER_API_KEY: API_KEY },
			}),
		);

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: null })));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_MODEL_REQUIRED", retryable: false },
		]);
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses a missing key with zero fetch calls", async () => {
		const runtime = createOpenRouterFreeRuntime(
			makeEnvironment({ fetch: forbiddenFetch, env: BASE_ENV }),
		);

		expect(await collect(runtime.run(makeRequest(), makeContext({ model: FREE_MODEL })))).toEqual([
			{ type: "failed", code: "NOT_CONFIGURED", retryable: false },
		]);
		expect((await runtime.probe()).availability).toMatchObject({
			status: "unavailable",
			reasonCode: "NOT_CONFIGURED",
		});
	});

	it("never uses OPENROUTER_MODEL", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok-no-cost.sse")));
		const runtime = createOpenRouterFreeRuntime(
			makeEnvironment({
				fetch: fake.fetch,
				env: {
					...BASE_ENV,
					OPENROUTER_API_KEY: API_KEY,
					OPENROUTER_MODEL: "billed/model",
					OPENROUTER_FREE_MODEL: FREE_MODEL,
				},
			}),
		);

		await collect(runtime.run(makeRequest(), makeContext({ model: null })));

		const body = requestBodySchema.parse(JSON.parse(String(itemAt(fake.calls, 0).init.body)));
		expect(body.model).toBe(FREE_MODEL);

		const unset = recordingFetch(() => sseResponse(fixtureText("openrouter/ok-no-cost.sse")));
		const unsetRuntime = createOpenRouterFreeRuntime(
			makeEnvironment({
				fetch: unset.fetch,
				env: { ...BASE_ENV, OPENROUTER_API_KEY: API_KEY, OPENROUTER_MODEL: "billed/model" },
			}),
		);
		const events = await collect(unsetRuntime.run(makeRequest(), makeContext({ model: null })));
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_MODEL_REQUIRED", retryable: false },
		]);
		expect(unset.calls).toHaveLength(0);
	});
});

describe("openrouter-free turn", () => {
	function freeRuntimeWith(fake: FakeFetch) {
		return createOpenRouterFreeRuntime(makeEnvironment({ fetch: fake.fetch, env: CONFIGURED_ENV }));
	}

	it("streams text from the documented example with unknown cost and completes", async () => {
		// Reuses the documented ok.sse shape with the cost removed: a
		// plan-limited backend always reports unknown, never 0.
		const body = fixtureText("openrouter/ok.sse").replace('"cost":0.00042', '"cost":0');
		const fake = recordingFetch(() => sseResponse(body));

		const events = await collect(freeRuntimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("Hello, world — 日本語");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		const requestBody = requestBodySchema.parse(
			JSON.parse(String(itemAt(fake.calls, 0).init.body)),
		);
		expect(requestBody.model).toBe(FREE_MODEL);
		expect(requestBody).toEqual({
			model: FREE_MODEL,
			messages: [{ role: "user", content: "PROMPT-MARKER: reply with the single word OK." }],
			stream: true,
			max_completion_tokens: 8192,
			usage: { include: true },
			reasoning: { effort: "medium" },
		});
	});

	it("reports null when the provider explicitly says the cost is 0", async () => {
		const fake = recordingFetch(() =>
			sseResponse(
				`${contentChunk("OK")}${sseData({ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { cost: 0 } })}${DONE}`,
			),
		);

		const events = await collect(freeRuntimeWith(fake).run(makeRequest(), makeContext()));

		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
	});

	it("fails closed with the reported cost when the provider charges a free model", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok.sse")));

		const events = await collect(freeRuntimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("Hello, world — 日本語");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: 0.00042 }]);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_FREE_MODEL_CHARGED", retryable: false },
		]);
	});
});

describe("openrouter-free secret handling", () => {
	it("sends the key only in the chat Authorization header, never to the models URL", async () => {
		const fake = recordingFetch((call) => {
			if (call.url === OPENROUTER_MODELS_URL) {
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}
			expect(call.url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
			return sseResponse(fixtureText("openrouter/ok-no-cost.sse"));
		});
		const runtime = createOpenRouterFreeRuntime(
			makeEnvironment({ fetch: fake.fetch, env: CONFIGURED_ENV }),
		);

		await runtime.probe();
		await collect(runtime.run(makeRequest(), makeContext({ model: FREE_MODEL })));

		const modelsCall = fake.calls.find((call) => call.url === OPENROUTER_MODELS_URL);
		expect(modelsCall).toBeDefined();
		expect(new Headers(modelsCall?.init.headers).get("Authorization")).toBeNull();
		expect(modelsCall?.url).not.toContain(API_KEY);
		const chatCall = itemAt(
			fake.calls.filter((call) => call.url === OPENROUTER_CHAT_COMPLETIONS_URL),
			0,
		);
		expect(new Headers(chatCall.init.headers).get("Authorization")).toBe(`Bearer ${API_KEY}`);
		expect(chatCall.url).not.toContain(API_KEY);
		expect(String(chatCall.init.body)).not.toContain(API_KEY);
		for (const call of fake.calls) {
			if (call.url !== OPENROUTER_CHAT_COMPLETIONS_URL) continue;
			expect(JSON.stringify(call.init.body)).not.toContain("fallback");
		}
	});
});
