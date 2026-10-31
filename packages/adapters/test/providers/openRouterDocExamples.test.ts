/**
 * The examples in docs/external-apis/apis/openrouter.md, fed through the
 * TypeScript runner's own OpenRouter adapters (conventions.md §4): the chat
 * request must equal the documented one, the documented live streams must be
 * read as the document says, and the live catalogue must yield its free ids.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenRouterFreeRuntime, createOpenRouterRuntime } from "../../src/providers/index.ts";
import {
	failureForOpenRouterRejection,
	interpretSseLine,
	MAX_COMPLETION_TOKENS,
	OPENROUTER_CHAT_COMPLETIONS_URL,
} from "../../src/providers/openRouter.ts";
import {
	createFreeModelCatalog,
	OPENROUTER_MODELS_URL,
	parseFreeModelIds,
} from "../../src/providers/openRouterModels.ts";
import { docExampleJson, docExampleText } from "../docExamples.ts";
import {
	BASE_ENV,
	collect,
	itemAt,
	makeContext,
	makeEnvironment,
	makeRequest,
	recordingFetch,
	sseResponse,
	terminalEvents,
	textOf,
	usageEvents,
} from "./helpers.ts";

const API_KEY = "sk-or-v1-doc-example-0123456789abcdef";
const PROMPT = "Reply with the single word OK.";
const FREE_MODEL = "nvidia/nemotron-3.5-lightning:free";
const ENV = { ...BASE_ENV, OPENROUTER_API_KEY: API_KEY };

const errorBodySchema = z.looseObject({
	error: z.looseObject({ code: z.number().int(), message: z.string() }),
});

function lengthStream(): string {
	return `${docExampleText("openrouter", "openrouter-chat-stream-length")}\n`;
}

describe("openrouter.md examples", () => {
	it("documents the exact chat request body and headers the adapter sends", async () => {
		const lines = docExampleText("openrouter", "openrouter-chat-request").split("\n");
		const blank = lines.indexOf("");
		const fake = recordingFetch(() => sseResponse(lengthStream()));
		const runtime = createOpenRouterFreeRuntime(makeEnvironment({ fetch: fake.fetch, env: ENV }), {
			catalog: { list: async () => null },
		});
		await collect(
			runtime.run(
				makeRequest({ prompt: PROMPT }),
				makeContext({ model: FREE_MODEL, effort: "low" }),
			),
		);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
		// The documented request is the bounded diagnostic one (cap 16); otherwise byte-identical.
		const documented = lines.slice(blank + 1).join("\n");
		expect(documented).toContain('"max_completion_tokens":16,');
		expect(call.init.body).toBe(
			documented.replace(
				'"max_completion_tokens":16,',
				`"max_completion_tokens":${MAX_COMPLETION_TOKENS},`,
			),
		);
		const sent = new Headers(call.init.headers);
		for (const line of lines.slice(1, blank)) {
			const colon = line.indexOf(":");
			const name = line.slice(0, colon);
			if (name === "Host") continue;
			const value = line.slice(colon + 1).trim();
			expect(sent.get(name), name).toBe(name === "Authorization" ? `Bearer ${API_KEY}` : value);
		}
	});

	it("reads the live length-capped stream as truncated, with no text", async () => {
		for (const line of lengthStream().split("\n")) {
			expect(interpretSseLine(line).kind, line).not.toBe("malformed");
		}
		const free = createOpenRouterFreeRuntime(
			makeEnvironment({ fetch: recordingFetch(() => sseResponse(lengthStream())).fetch, env: ENV }),
			{ catalog: { list: async () => null } },
		);
		const freeEvents = await collect(free.run(makeRequest(), makeContext({ model: FREE_MODEL })));
		expect(textOf(freeEvents)).toBe("");
		expect(terminalEvents(freeEvents)).toEqual([
			{ type: "failed", code: "PROVIDER_OUTPUT_TRUNCATED", retryable: false },
		]);
		expect(usageEvents(freeEvents)).toEqual([{ type: "usage", knownCostUsd: null }]);

		// The metered backend reports the provider's cost as is: 0 here.
		const metered = createOpenRouterRuntime(
			makeEnvironment({ fetch: recordingFetch(() => sseResponse(lengthStream())).fetch, env: ENV }),
		);
		const meteredEvents = await collect(
			metered.run(makeRequest(), makeContext({ model: FREE_MODEL })),
		);
		expect(usageEvents(meteredEvents)).toEqual([{ type: "usage", knownCostUsd: 0 }]);
	});

	it("reads an upstream error chunk as a retryable rejection keeping its status", () => {
		const verdicts = docExampleText("openrouter", "openrouter-chat-stream-upstream-error")
			.split("\n")
			.map(interpretSseLine);
		expect(verdicts.filter((verdict) => verdict.kind !== "ignored")).toEqual([
			{
				kind: "failed",
				failure: { code: "PROVIDER_UNAVAILABLE", retryable: true, upstreamStatus: 503 },
			},
		]);
	});

	it("keeps only the free text model of the live catalogue, fetched without a key", async () => {
		const catalogue = docExampleJson("openrouter", "openrouter-models-list");
		expect(parseFreeModelIds(catalogue)).toEqual(["google/gemma-4-31b-it:free"]);

		const fake = recordingFetch(
			() =>
				new Response(JSON.stringify(catalogue), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const catalog = createFreeModelCatalog(makeEnvironment({ fetch: fake.fetch, env: ENV }));
		expect(await catalog.list()).toEqual(["google/gemma-4-31b-it:free"]);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(OPENROUTER_MODELS_URL);
		expect(new Headers(call.init.headers).get("authorization")).toBeNull();
	});

	it("maps the documented error answers (status and body) to our failure", () => {
		const cases = [
			[docExampleJson("openrouter", "openrouter-error-401"), "PROVIDER_AUTH"],
			// A spent key limit, not a bad key: metadata.limit_source decides.
			[docExampleJson("openrouter", "openrouter-error-403"), "PROVIDER_PAYMENT_REQUIRED"],
			[docExampleJson("openrouter", "openrouter-error-429"), "PROVIDER_RATE_LIMITED"],
		] as const;
		for (const [json, code] of cases) {
			const body = errorBodySchema.parse(json);
			// OpenRouter's error.code equals the HTTP status of a rejected request.
			expect(failureForOpenRouterRejection(body.error.code, JSON.stringify(json))).toEqual({
				code,
				retryable: code === "PROVIDER_RATE_LIMITED",
				upstreamStatus: body.error.code,
			});
		}
	});
});
