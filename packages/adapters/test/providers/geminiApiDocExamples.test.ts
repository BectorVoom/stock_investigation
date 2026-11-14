/**
 * The examples in docs/external-apis/apis/gemini-api.md, fed through the
 * TypeScript runner's own Gemini API adapter (conventions.md §4): the
 * request the adapter sends must equal the documented one, and the documented
 * live stream must parse into a completed turn of unknown cost.
 */
import { describe, expect, it } from "vitest";
import {
	buildGeminiRequestBody,
	createGeminiApiRuntime,
	GEMINI_CHAT_COMPLETIONS_URL,
} from "../../src/providers/geminiApi.ts";
import { interpretSseLine } from "../../src/providers/openRouter.ts";
import { docExampleText } from "../docExamples.ts";
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

const API_KEY = "DOC-EXAMPLE-GEMINI-0123456789abcdef";
const PROMPT = "Reply with the single word OK.";

function documentedRequest(): { headers: Map<string, string>; body: string } {
	const lines = docExampleText("gemini-api", "gemini-api-chat-request").split("\n");
	const blank = lines.indexOf("");
	const headers = new Map<string, string>();
	for (const line of lines.slice(1, blank)) {
		const colon = line.indexOf(":");
		headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
	}
	return { headers, body: lines.slice(blank + 1).join("\n") };
}

function stream(): string {
	return `${docExampleText("gemini-api", "gemini-api-chat-stream")}\n`;
}

describe("gemini-api.md examples", () => {
	it("documents the exact request body and headers the adapter sends", async () => {
		const documented = documentedRequest();
		expect(documented.body).toBe(buildGeminiRequestBody("gemini-3.5-flash-lite", PROMPT, "low"));

		const fake = recordingFetch(() => sseResponse(stream()));
		const runtime = createGeminiApiRuntime(
			makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, GEMINI_API_KEY: API_KEY } }),
		);
		await collect(
			runtime.run(
				makeRequest({ prompt: PROMPT }),
				makeContext({ model: "gemini-3.5-flash-lite", effort: "low", scratchDirectory: null }),
			),
		);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(GEMINI_CHAT_COMPLETIONS_URL);
		expect(call.init.body).toBe(documented.body);
		const sent = new Headers(call.init.headers);
		for (const [name, value] of documented.headers) {
			if (name === "host") continue;
			expect(sent.get(name), name).toBe(name === "authorization" ? `Bearer ${API_KEY}` : value);
		}
	});

	it("parses the live stream into the answer text and a completed turn of unknown cost", async () => {
		for (const line of stream().split("\n")) {
			expect(interpretSseLine(line).kind, line).not.toBe("malformed");
		}
		const fake = recordingFetch(() => sseResponse(stream()));
		const runtime = createGeminiApiRuntime(
			makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, GEMINI_API_KEY: API_KEY } }),
		);
		const events = await collect(
			runtime.run(
				makeRequest(),
				makeContext({ model: "gemini-3.5-flash-lite", scratchDirectory: null }),
			),
		);
		expect(textOf(events)).toBe("OK");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});
});
