/**
 * Sarashina API adapter tests. RECORDED fixtures in fixtures/sarashina-api
 * (live, 2026-11-13, see docs/external-apis/apis/sarashina-api.md): ok.sse
 * (sarashina3-mini), thinking-ok.sse (sarashina3.2-mini-thinking, low effort),
 * length.sse (stopped by max_completion_tokens 5), error-401.json.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSarashinaApiRuntime } from "../../src/providers/index.ts";
import {
	buildSarashinaRequestBody,
	isSarashinaThinkingModel,
	resolveSarashinaModel,
	SARASHINA_API_MODELS,
	SARASHINA_CHAT_COMPLETIONS_URL,
	SARASHINA_MAX_COMPLETION_TOKENS,
} from "../../src/providers/sarashinaApi.ts";
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

const API_KEY = "TEST-SARASHINA-KEY-0123456789abcdef";
const CONFIGURED_ENV = { ...BASE_ENV, SARASHINA_API_KEY: API_KEY };

function runtimeWith(
	fake: FakeFetch,
	env: Readonly<Record<string, string | undefined>> = CONFIGURED_ENV,
) {
	return createSarashinaApiRuntime(makeEnvironment({ fetch: fake.fetch, env }));
}

const requestBodySchema = z.strictObject({
	model: z.string(),
	messages: z.array(z.strictObject({ role: z.literal("user"), content: z.string() })),
	stream: z.literal(true),
	max_completion_tokens: z.literal(8000),
	reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

function bodyOf(fake: FakeFetch): z.infer<typeof requestBodySchema> {
	const body = itemAt(fake.calls, 0).init.body;
	if (typeof body !== "string") throw new Error("expected a string body");
	return requestBodySchema.parse(JSON.parse(body));
}

describe("sarashina-api runtime metadata", () => {
	it("is a plan-limited, tool-isolated backend", () => {
		const runtime = createSarashinaApiRuntime(makeEnvironment({ env: CONFIGURED_ENV }));
		expect(runtime.agentId).toBe("sarashina-api");
		expect(runtime.displayName).toBe("Sarashina API");
		expect(runtime.costModel).toBe("plan-limited");
		expect(runtime.toolIsolation).toBe("enforced");
	});
});

describe("sarashina-api probe", () => {
	it("is NOT_CONFIGURED without SARASHINA_API_KEY and never contacts the network", async () => {
		const probe = await createSarashinaApiRuntime(
			makeEnvironment({ env: BASE_ENV, fetch: forbiddenFetch }),
		).probe();
		expect(probe.availability).toEqual({
			status: "unavailable",
			reasonCode: "NOT_CONFIGURED",
			detail: "The Sarashina API needs SARASHINA_API_KEY in the runner environment",
		});
	});

	it("is available with a key and offers the chat models, offline", async () => {
		const probe = await createSarashinaApiRuntime(
			makeEnvironment({ env: CONFIGURED_ENV, fetch: forbiddenFetch }),
		).probe();
		expect(probe.availability).toEqual({ status: "available" });
		expect(probe.capabilities).toEqual({
			supported: ["stream", "cancel"],
			model: "sarashina3.2-mini-thinking",
			models: ["sarashina3.2-mini-thinking", "sarashina3-mini", "sarashina3-nano"],
		});
	});

	it("reports SARASHINA_MODEL as the default model when set", async () => {
		const probe = await createSarashinaApiRuntime(
			makeEnvironment({ env: { ...CONFIGURED_ENV, SARASHINA_MODEL: " sarashina3-nano " } }),
		).probe();
		expect(probe.capabilities.model).toBe("sarashina3-nano");
	});
});

describe("sarashina-api request", () => {
	it("sends reasoning_effort only to a thinking model, and the API's 8,000-token cap", () => {
		expect(SARASHINA_MAX_COMPLETION_TOKENS).toBe(8000);
		expect(SARASHINA_API_MODELS.filter(isSarashinaThinkingModel)).toEqual([
			"sarashina3.2-mini-thinking",
		]);
		expect(buildSarashinaRequestBody("sarashina3.2-mini-thinking", "p", "high")).toBe(
			'{"model":"sarashina3.2-mini-thinking","messages":[{"role":"user","content":"p"}],"stream":true,"max_completion_tokens":8000,"reasoning_effort":"high"}',
		);
		expect(buildSarashinaRequestBody("sarashina3-mini", "p", "high")).toBe(
			'{"model":"sarashina3-mini","messages":[{"role":"user","content":"p"}],"stream":true,"max_completion_tokens":8000}',
		);
	});

	it("chooses Settings' model, then SARASHINA_MODEL, then the default", () => {
		expect(resolveSarashinaModel({ SARASHINA_MODEL: "sarashina3-nano" }, "sarashina3-mini")).toBe(
			"sarashina3-mini",
		);
		expect(resolveSarashinaModel({ SARASHINA_MODEL: "sarashina3-nano" }, null)).toBe(
			"sarashina3-nano",
		);
		expect(resolveSarashinaModel({ SARASHINA_MODEL: "  " }, null)).toBe(
			"sarashina3.2-mini-thinking",
		);
	});

	it("posts to the fixed endpoint with the key only in Authorization", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("sarashina-api/ok.sse")));
		await collect(
			runtimeWith(fake, { ...CONFIGURED_ENV, ...SECRET_ENV, SARASHINA_API_KEY: API_KEY }).run(
				makeRequest({ prompt: "Reply with exactly: OK" }),
				makeContext({ model: "sarashina3-mini", effort: "medium", scratchDirectory: null }),
			),
		);
		expect(fake.calls).toHaveLength(1);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(SARASHINA_CHAT_COMPLETIONS_URL);
		expect(call.init.method).toBe("POST");
		expect(call.init.redirect).toBe("error");
		expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
		const body = bodyOf(fake);
		expect(body).toEqual({
			model: "sarashina3-mini",
			messages: [{ role: "user", content: "Reply with exactly: OK" }],
			stream: true,
			max_completion_tokens: 8000,
		});
		expect(JSON.stringify(call.init.body)).not.toContain("secret");
	});

	it("passes the run's effort to a thinking model", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("sarashina-api/thinking-ok.sse")));
		await collect(
			runtimeWith(fake).run(
				makeRequest(),
				makeContext({ model: null, effort: "low", scratchDirectory: null }),
			),
		);
		expect(bodyOf(fake)).toMatchObject({
			model: "sarashina3.2-mini-thinking",
			reasoning_effort: "low",
		});
	});
});

describe("sarashina-api recorded streams", () => {
	it("completes with the answer and an unknown cost (ok.sse)", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("sarashina-api/ok.sse")));
		const events = await collect(
			runtimeWith(fake).run(
				makeRequest(),
				makeContext({ model: "sarashina3-mini", scratchDirectory: null }),
			),
		);
		expect(textOf(events)).toBe("OK");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("forwards a thinking model's answer and never its encrypted reasoning", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("sarashina-api/thinking-ok.sse")));
		const events = await collect(
			runtimeWith(fake).run(makeRequest(), makeContext({ model: null, scratchDirectory: null })),
		);
		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("reports a turn stopped by the token cap as truncated, not completed", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("sarashina-api/length.sse")));
		const events = await collect(
			runtimeWith(fake).run(
				makeRequest(),
				makeContext({ model: "sarashina3-mini", scratchDirectory: null }),
			),
		);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_TRUNCATED", retryable: false },
		]);
	});

	it("maps a 401 to PROVIDER_AUTH with the status unchanged, without retrying", async () => {
		const fake = recordingFetch(
			() =>
				new Response(fixtureText("sarashina-api/error-401.json"), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const events = await collect(
			runtimeWith(fake).run(
				makeRequest(),
				makeContext({ model: "sarashina3-mini", scratchDirectory: null }),
			),
		);
		expect(fake.calls).toHaveLength(1);
		expect(terminalEvents(events)).toEqual([
			expect.objectContaining({ type: "failed", code: "PROVIDER_AUTH", upstreamStatus: 401 }),
		]);
	});

	it("fails closed before any request without a key or with an invalid model id", async () => {
		for (const [env, model] of [
			[BASE_ENV, "sarashina3-mini"],
			[CONFIGURED_ENV, "bad model"],
		] as const) {
			const events = await collect(
				createSarashinaApiRuntime(makeEnvironment({ env, fetch: forbiddenFetch })).run(
					makeRequest(),
					makeContext({ model, scratchDirectory: null }),
				),
			);
			expect(itemAt(events, -1).type).toBe("failed");
		}
	});
});
