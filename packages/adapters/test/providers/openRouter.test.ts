/**
 * OpenRouter adapter tests. The SSE fixtures are DOC-DERIVED (written from
 * openrouter.ai/docs on 2026-10-11), not captured from the live API.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenRouterRuntime } from "../../src/providers/index.ts";
import {
	BASE_ENV,
	collect,
	fixtureText,
	forbiddenFetch,
	itemAt,
	makeContext,
	makeEnvironment,
	makeRequest,
	terminalEvents,
	textOf,
	usageEvents,
} from "./helpers.ts";

const API_KEY = "sk-or-v1-TEST-KEY-0123456789abcdef";
const CONFIGURED_ENV = {
	...BASE_ENV,
	OPENROUTER_API_KEY: API_KEY,
	OPENROUTER_MODEL: "example/model",
};
const encoder = new TextEncoder();

interface FetchCall {
	readonly url: string;
	readonly init: RequestInit;
}

interface FakeFetch {
	readonly fetch: typeof fetch;
	readonly calls: FetchCall[];
}

function recordingFetch(respond: (call: FetchCall) => Response | Promise<Response>): FakeFetch {
	const calls: FetchCall[] = [];
	const fake: typeof fetch = async (input, init) => {
		const call = { url: typeof input === "string" ? input : input.toString(), init: init ?? {} };
		calls.push(call);
		return respond(call);
	};
	return { fetch: fake, calls };
}

function streamOf(
	chunks: readonly Uint8Array[],
	options: { keepOpen?: boolean } = {},
): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index];
			if (chunk !== undefined) {
				index += 1;
				controller.enqueue(chunk);
			} else if (options.keepOpen !== true) {
				controller.close();
			} else {
				// Stays open: the adapter must stop waiting by itself (abort, deadline, idle).
				return new Promise<void>(() => undefined);
			}
			return undefined;
		},
	});
}

function sseResponse(
	body: string | readonly Uint8Array[],
	options: { keepOpen?: boolean } = {},
): Response {
	const chunks = typeof body === "string" ? [encoder.encode(body)] : body;
	return new Response(streamOf(chunks, options), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function data(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

function contentChunk(content: string, finishReason: string | null = null): string {
	return data({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] });
}

const DONE = "data: [DONE]\n\n";

function runtimeWith(
	fake: FakeFetch,
	env: Readonly<Record<string, string | undefined>> = CONFIGURED_ENV,
) {
	return createOpenRouterRuntime(makeEnvironment({ fetch: fake.fetch, env }));
}

const requestBodySchema = z.strictObject({
	model: z.string(),
	messages: z.array(z.strictObject({ role: z.string(), content: z.string() })),
	stream: z.literal(true),
	max_completion_tokens: z.number().int().positive(),
	usage: z.strictObject({ include: z.literal(true) }),
	reasoning: z.strictObject({ effort: z.string() }),
});

describe("openrouter runtime metadata", () => {
	it("is metered and tool-isolated by construction", () => {
		const runtime = createOpenRouterRuntime(makeEnvironment({ env: CONFIGURED_ENV }));
		expect(runtime.agentId).toBe("openrouter");
		expect(runtime.costModel).toBe("metered");
		expect(runtime.toolIsolation).toBe("enforced");
	});
});

describe("openrouter request", () => {
	it("posts one streaming chat completion with the prompt, no tools and no fallback models", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok.sse")));
		const runtime = runtimeWith(fake);
		const controller = new AbortController();

		await collect(
			runtime.run(
				makeRequest({ prompt: "the research prompt" }),
				makeContext({ scratchDirectory: null, effort: "high", signal: controller.signal }),
			),
		);

		expect(fake.calls).toHaveLength(1);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(call.init.method).toBe("POST");
		expect(call.init.redirect).toBe("error");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);
		expect(new Headers(call.init.headers).get("Authorization")).toBe(`Bearer ${API_KEY}`);
		// strictObject: any extra key such as `tools`, `models`, `route` or `plugins` fails the parse.
		const body = requestBodySchema.parse(
			JSON.parse(typeof call.init.body === "string" ? call.init.body : ""),
		);
		expect(body).toEqual({
			model: "example/model",
			messages: [{ role: "user", content: "the research prompt" }],
			stream: true,
			// Bounds what a single turn can cost on this metered backend.
			max_completion_tokens: 8192,
			usage: { include: true },
			reasoning: { effort: "high" },
		});
	});

	it.each([
		["the model from OPENROUTER_MODEL", null],
		["a model from the run context", "other/model"],
	])("never asks for a model fallback or sends tools, with %s (AGT-012)", async (_label, model) => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok.sse")));

		await collect(runtimeWith(fake).run(makeRequest(), makeContext({ model })));

		const rawBody = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(String(itemAt(fake.calls, 0).init.body)));
		for (const forbidden of ["models", "route", "provider", "tools", "tool_choice", "plugins"]) {
			expect(rawBody, forbidden).not.toHaveProperty(forbidden);
		}
		expect(JSON.stringify(rawBody)).not.toContain("fallback");
		expect(typeof rawBody.model).toBe("string");
		// Exactly one output cap is sent: the current field, not the deprecated alias as well.
		expect(rawBody.max_completion_tokens).toBe(8192);
		expect(rawBody).not.toHaveProperty("max_tokens");
	});

	it("prefers the model from the run context over OPENROUTER_MODEL", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok.sse")));

		await collect(runtimeWith(fake).run(makeRequest(), makeContext({ model: "other/model:free" })));

		const body = requestBodySchema.parse(JSON.parse(String(itemAt(fake.calls, 0).init.body)));
		expect(body.model).toBe("other/model:free");
	});
});

describe("openrouter SSE parsing", () => {
	const EXPECTED_TEXT = "Hello, world — 日本語";

	it("streams the documented example: deltas concatenate, cost is reported, one terminal event", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(events.filter((event) => event.type === "text.delta")).toEqual([
			{ type: "text.delta", text: "Hello" },
			{ type: "text.delta", text: ", wor" },
			{ type: "text.delta", text: "ld — 日本語" },
		]);
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: 0.00042 }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		expect(events.at(-1)).toEqual({ type: "completed" });
	});

	it("gives the same result wherever the byte stream is cut, including inside a data: line or a character", async () => {
		const bytes = encoder.encode(fixtureText("openrouter/ok.sse"));
		for (let cut = 1; cut < bytes.length; cut += 1) {
			const fake = recordingFetch(() => sseResponse([bytes.slice(0, cut), bytes.slice(cut)]));
			const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));
			expect(textOf(events), `cut at byte ${cut}`).toBe(EXPECTED_TEXT);
			expect(usageEvents(events), `cut at byte ${cut}`).toEqual([
				{ type: "usage", knownCostUsd: 0.00042 },
			]);
			expect(terminalEvents(events), `cut at byte ${cut}`).toEqual([{ type: "completed" }]);
		}
	});

	it("gives the same result when the body arrives one byte at a time", async () => {
		const bytes = encoder.encode(fixtureText("openrouter/ok.sse"));
		const fake = recordingFetch(() =>
			sseResponse(Array.from(bytes, (_, index) => bytes.slice(index, index + 1))),
		);

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe(EXPECTED_TEXT);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("accepts CRLF line endings and data lines without a space after the colon", async () => {
		const body = `data:${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\r\n\r\ndata:[DONE]\r\n\r\n`;
		const fake = recordingFetch(() => sseResponse(body));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("stops at [DONE] and ignores anything after it", async () => {
		const fake = recordingFetch(() =>
			sseResponse(`${contentChunk("OK", "stop")}${DONE}${contentChunk("ignored")}`),
		);

		expect(textOf(await collect(runtimeWith(fake).run(makeRequest(), makeContext())))).toBe("OK");
	});

	it("ignores keep-alive comments, event/id fields and unknown JSON fields", async () => {
		const body = `: OPENROUTER PROCESSING\n\nevent: message\nid: 7\nretry: 100\n${data({
			id: "gen-1",
			provider: "example",
			future_field: { nested: [1, 2] },
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "OK", reasoning: "hidden" },
					finish_reason: null,
				},
			],
		})}${contentChunk("", "stop")}${DONE}`;
		const fake = recordingFetch(() => sseResponse(body));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("tolerates a few malformed data lines but fails once they exceed the bound", async () => {
		const few = recordingFetch(() =>
			sseResponse(`data: {not json\n\ndata: 42\n\n${contentChunk("OK", "stop")}${DONE}`),
		);
		const many = recordingFetch(() =>
			sseResponse(`${"data: {not json\n\n".repeat(20)}${contentChunk("OK", "stop")}${DONE}`),
		);

		expect(
			terminalEvents(await collect(runtimeWith(few).run(makeRequest(), makeContext()))),
		).toEqual([{ type: "completed" }]);
		expect(
			terminalEvents(await collect(runtimeWith(many).run(makeRequest(), makeContext()))),
		).toEqual([{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false }]);
	});

	it("fails with PROVIDER_OUTPUT_INVALID when the stream ends without [DONE] or a finish_reason", async () => {
		const fake = recordingFetch(() => sseResponse(contentChunk("truncated ans")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("truncated ans");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false },
		]);
	});

	it("fails with PROVIDER_OUTPUT_EMPTY when the completion has no text", async () => {
		const fake = recordingFetch(() => sseResponse(`${contentChunk("", "stop")}${DONE}`));

		expect(
			terminalEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext()))),
		).toEqual([{ type: "failed", code: "PROVIDER_OUTPUT_EMPTY", retryable: true }]);
	});

	it("fails with PROVIDER_OUTPUT_TRUNCATED when the provider stops at the output-token cap", async () => {
		const fake = recordingFetch(() =>
			sseResponse(
				`${contentChunk("cut off mid-sen")}${data({
					choices: [{ delta: { content: "" }, finish_reason: "length" }],
					usage: { cost: 0.02 },
				})}${DONE}`,
			),
		);

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("cut off mid-sen");
		// The capped turn was still billed, and retrying would hit the same cap.
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: 0.02 }]);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_TRUNCATED", retryable: false },
		]);
	});

	it("reports a cap consumed entirely by reasoning as truncated, not as a retryable empty answer", async () => {
		const fake = recordingFetch(() => sseResponse(`${contentChunk("", "length")}${DONE}`));

		expect(
			terminalEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext()))),
		).toEqual([{ type: "failed", code: "PROVIDER_OUTPUT_TRUNCATED", retryable: false }]);
	});

	it("fails with PROVIDER_OUTPUT_INVALID for a 200 response that is not an event stream", async () => {
		const fake = recordingFetch(
			() =>
				new Response(JSON.stringify({ error: { code: 502, message: "Provider disconnected" } }), {
					status: 200,
				}),
		);

		expect(
			terminalEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext()))),
		).toEqual([{ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false }]);
	});
});

describe("openrouter cost", () => {
	it("reports an unknown cost (null, not 0) when the response carries no cost", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok-no-cost.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});

	it("reports an unknown cost when the response has no usage object at all", async () => {
		const fake = recordingFetch(() => sseResponse(`${contentChunk("OK", "stop")}${DONE}`));

		expect(usageEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext())))).toEqual(
			[{ type: "usage", knownCostUsd: null }],
		);
	});

	it("reports a cost of 0 only when the provider explicitly says 0 (a free model)", async () => {
		const fake = recordingFetch(() =>
			sseResponse(
				`${contentChunk("OK")}${data({ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { cost: 0 } })}${DONE}`,
			),
		);

		expect(usageEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext())))).toEqual(
			[{ type: "usage", knownCostUsd: 0 }],
		);
	});

	it.each([-1, null])("treats the invalid cost %j as unknown", async (cost) => {
		const fake = recordingFetch(() =>
			sseResponse(
				`${contentChunk("OK")}${data({ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { cost } })}${DONE}`,
			),
		);

		expect(usageEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext())))).toEqual(
			[{ type: "usage", knownCostUsd: null }],
		);
	});
});

describe("openrouter failures", () => {
	it("maps the documented mid-stream error chunk to PROVIDER_UNAVAILABLE after the partial text", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/midstream-error.sse")));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("Partial");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_UNAVAILABLE", retryable: true },
		]);
	});

	it.each([
		[429, "PROVIDER_RATE_LIMITED", true],
		[402, "PROVIDER_PAYMENT_REQUIRED", false],
		[401, "PROVIDER_AUTH", false],
		["server_error", "PROVIDER_UNAVAILABLE", true],
	])("maps a mid-stream error with code %j to %s", async (code, expectedCode, retryable) => {
		const fake = recordingFetch(() =>
			sseResponse(
				data({
					error: { code, message: "x" },
					choices: [{ delta: { content: "" }, finish_reason: "error" }],
				}),
			),
		);

		expect(
			terminalEvents(await collect(runtimeWith(fake).run(makeRequest(), makeContext()))),
		).toEqual([{ type: "failed", code: expectedCode, retryable }]);
	});

	it.each([
		[401, "PROVIDER_AUTH", false],
		[403, "PROVIDER_AUTH", false],
		[402, "PROVIDER_PAYMENT_REQUIRED", false],
		[429, "PROVIDER_RATE_LIMITED", true],
		[500, "PROVIDER_UNAVAILABLE", true],
		[502, "PROVIDER_UNAVAILABLE", true],
		[503, "PROVIDER_UNAVAILABLE", true],
		[408, "PROVIDER_TIMEOUT", true],
		[400, "PROVIDER_REQUEST_REJECTED", false],
		[404, "PROVIDER_REQUEST_REJECTED", false],
	])("maps HTTP %i to %s and does not retry", async (status, code, retryable) => {
		const fake = recordingFetch(
			() => new Response(JSON.stringify({ error: { code: status, message: "nope" } }), { status }),
		);

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		// Nothing was generated, so there is no usage to report, and exactly one request was made.
		expect(events).toEqual([{ type: "failed", code, retryable }]);
		expect(fake.calls).toHaveLength(1);
	});

	it("maps a network failure to PROVIDER_UNAVAILABLE", async () => {
		const fake = recordingFetch(() => Promise.reject(new TypeError("fetch failed")));

		expect(await collect(runtimeWith(fake).run(makeRequest(), makeContext()))).toEqual([
			{ type: "failed", code: "PROVIDER_UNAVAILABLE", retryable: true },
		]);
	});

	it("maps a connection dropped mid-stream to PROVIDER_UNAVAILABLE", async () => {
		let pulls = 0;
		const dropping = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) controller.enqueue(encoder.encode(contentChunk("Par")));
				else controller.error(new TypeError("terminated"));
			},
		});
		const fake = recordingFetch(() => new Response(dropping, { status: 200 }));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(textOf(events)).toBe("Par");
		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_UNAVAILABLE", retryable: true },
		]);
	});

	it("fails with PROVIDER_OUTPUT_TOO_LARGE once the text budget is exceeded", async () => {
		const megabyte = "x".repeat(1024 * 1024);
		const chunks = Array.from({ length: 4 }, () => encoder.encode(contentChunk(megabyte)));
		const fake = recordingFetch(() => sseResponse(chunks, { keepOpen: true }));

		const events = await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		expect(terminalEvents(events)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_TOO_LARGE", retryable: false },
		]);
		expect(textOf(events).length).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(itemAt(fake.calls, 0).init.signal?.aborted).toBe(true);
	});
});

describe("openrouter configuration", () => {
	it.each([
		["no API key", { ...BASE_ENV, OPENROUTER_MODEL: "example/model" }],
		["an empty API key", { ...CONFIGURED_ENV, OPENROUTER_API_KEY: "   " }],
		[
			"an API key containing a line break",
			{ ...CONFIGURED_ENV, OPENROUTER_API_KEY: "sk-or-v1-abc\r\nX-Evil: 1" },
		],
		["no model", { ...BASE_ENV, OPENROUTER_API_KEY: API_KEY }],
	])("fails closed with NOT_CONFIGURED and makes no network call with %s", async (_label, env) => {
		const runtime = createOpenRouterRuntime(makeEnvironment({ fetch: forbiddenFetch, env }));

		expect(await collect(runtime.run(makeRequest(), makeContext()))).toEqual([
			{ type: "failed", code: "NOT_CONFIGURED", retryable: false },
		]);
		expect((await runtime.probe()).availability).toMatchObject({
			status: "unavailable",
			reasonCode: "NOT_CONFIGURED",
		});
	});

	it("is available when key and model are set, without any network call from probe", async () => {
		const runtime = createOpenRouterRuntime(
			makeEnvironment({ fetch: forbiddenFetch, env: CONFIGURED_ENV }),
		);

		expect(await runtime.probe()).toEqual({
			capabilities: { supported: ["stream", "cancel"], model: "example/model" },
			availability: { status: "available" },
		});
	});

	it("runs with a model from the run context even if OPENROUTER_MODEL is unset", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok.sse")));
		const runtime = runtimeWith(fake, { ...BASE_ENV, OPENROUTER_API_KEY: API_KEY });

		const events = await collect(runtime.run(makeRequest(), makeContext({ model: "ctx/model" })));

		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});
});

describe("openrouter deadline and cancellation", () => {
	it("fails with DEADLINE_EXCEEDED without a network call when the deadline has passed", async () => {
		const runtime = createOpenRouterRuntime(
			makeEnvironment({ fetch: forbiddenFetch, env: CONFIGURED_ENV }),
		);

		expect(
			await collect(
				runtime.run(makeRequest({ deadline: "2020-01-01T00:00:00.000Z" }), makeContext()),
			),
		).toEqual([{ type: "failed", code: "DEADLINE_EXCEEDED", retryable: false }]);
	});

	it("fails with ABORTED without a network call when already cancelled", async () => {
		const runtime = createOpenRouterRuntime(
			makeEnvironment({ fetch: forbiddenFetch, env: CONFIGURED_ENV }),
		);
		const controller = new AbortController();
		controller.abort();

		expect(
			await collect(runtime.run(makeRequest(), makeContext({ signal: controller.signal }))),
		).toEqual([{ type: "failed", code: "ABORTED", retryable: false }]);
	});

	it("aborts the HTTP request and fails with ABORTED when cancelled mid-stream", async () => {
		const fake = recordingFetch(() =>
			sseResponse([encoder.encode(contentChunk("partial"))], { keepOpen: true }),
		);
		const controller = new AbortController();

		const events = [];
		for await (const event of runtimeWith(fake).run(
			makeRequest(),
			makeContext({ signal: controller.signal }),
		)) {
			events.push(event);
			if (event.type === "text.delta") controller.abort();
		}

		expect(textOf(events)).toBe("partial");
		// Partial output may already have been billed, so the cost is unknown rather than absent.
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "failed", code: "ABORTED", retryable: false }]);
		expect(itemAt(fake.calls, 0).init.signal?.aborted).toBe(true);
	});

	it("fails with ABORTED when cancelled while waiting for the response headers", async () => {
		const fake = recordingFetch(() => new Promise<Response>(() => undefined));
		const controller = new AbortController();

		const pending = collect(
			runtimeWith(fake).run(makeRequest(), makeContext({ signal: controller.signal })),
		);
		await Promise.resolve();
		controller.abort();

		expect(terminalEvents(await pending)).toEqual([
			{ type: "failed", code: "ABORTED", retryable: false },
		]);
		expect(itemAt(fake.calls, 0).init.signal?.aborted).toBe(true);
	});

	it("fails with DEADLINE_EXCEEDED when the deadline passes mid-stream", async () => {
		vi.useFakeTimers();
		try {
			const fake = recordingFetch(() =>
				sseResponse([encoder.encode(contentChunk("partial"))], { keepOpen: true }),
			);
			const deadline = new Date(Date.now() + 5_000).toISOString();

			const pending = collect(runtimeWith(fake).run(makeRequest({ deadline }), makeContext()));
			await vi.advanceTimersByTimeAsync(5_001);

			expect(terminalEvents(await pending)).toEqual([
				{ type: "failed", code: "DEADLINE_EXCEEDED", retryable: false },
			]);
			expect(itemAt(fake.calls, 0).init.signal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails with PROVIDER_TIMEOUT when the stream goes silent for too long", async () => {
		vi.useFakeTimers();
		try {
			const fake = recordingFetch(() =>
				sseResponse([encoder.encode(contentChunk("partial"))], { keepOpen: true }),
			);

			const pending = collect(runtimeWith(fake).run(makeRequest(), makeContext()));
			await vi.advanceTimersByTimeAsync(120_001);

			expect(terminalEvents(await pending)).toEqual([
				{ type: "failed", code: "PROVIDER_TIMEOUT", retryable: true },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts the HTTP request when the consumer stops reading early", async () => {
		const fake = recordingFetch(() =>
			sseResponse([encoder.encode(contentChunk("first"))], { keepOpen: true }),
		);

		for await (const event of runtimeWith(fake).run(makeRequest(), makeContext())) {
			if (event.type === "text.delta") break;
		}

		expect(itemAt(fake.calls, 0).init.signal?.aborted).toBe(true);
	});
});

describe("openrouter secret handling", () => {
	const leakyResponses: readonly [string, () => Response | Promise<Response>][] = [
		["a successful stream", () => sseResponse(fixtureText("openrouter/ok.sse"))],
		[
			"an error body echoing the key",
			() => new Response(`{"error":{"message":"bad key ${API_KEY}"}}`, { status: 401 }),
		],
		[
			"a thrown error containing the key",
			() => Promise.reject(new Error(`connect failed for Bearer ${API_KEY}`)),
		],
		[
			"a mid-stream error echoing the key",
			() => sseResponse(data({ error: { code: 500, message: API_KEY }, choices: [] })),
		],
		["a stream that echoes the key as garbage", () => sseResponse(`data: ${API_KEY}\n\n`)],
	];

	it.each(
		leakyResponses,
	)("never puts the API key into an event for %s", async (_label, respond) => {
		const fake = recordingFetch(respond);
		const runtime = runtimeWith(fake);

		const events = await collect(runtime.run(makeRequest(), makeContext()));
		const probe = await runtime.probe();

		expect(JSON.stringify(events)).not.toContain(API_KEY);
		expect(JSON.stringify(events)).not.toContain("sk-or-");
		expect(JSON.stringify(probe)).not.toContain(API_KEY);
		expect(terminalEvents(events)).toHaveLength(1);
	});

	it("sends the key only in the Authorization header, never in the URL or the body", async () => {
		const fake = recordingFetch(() => sseResponse(fixtureText("openrouter/ok.sse")));

		await collect(runtimeWith(fake).run(makeRequest(), makeContext()));

		const call = itemAt(fake.calls, 0);
		expect(call.url).not.toContain(API_KEY);
		expect(String(call.init.body)).not.toContain(API_KEY);
	});
});
