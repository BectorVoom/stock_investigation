/**
 * The examples in docs/external-apis/apis/sarashina-api.md, fed through the
 * TypeScript runner's own Sarashina API adapter (conventions.md §4): the
 * request the adapter sends must equal the documented one, and the documented
 * live stream must parse into a completed turn of unknown cost.
 */
import { describe, expect, it } from "vitest";
import { interpretSseLine } from "../../src/providers/openRouter.ts";
import {
	buildSarashinaRequestBody,
	createSarashinaApiRuntime,
	SARASHINA_CHAT_COMPLETIONS_URL,
} from "../../src/providers/sarashinaApi.ts";
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

const API_KEY = "DOC-EXAMPLE-SARASHINA-0123456789abcdef";
const PROMPT = "Reply with the single word OK.";

function documentedRequest(): { headers: Map<string, string>; body: string } {
	const lines = docExampleText("sarashina-api", "sarashina-api-chat-request").split("\n");
	const blank = lines.indexOf("");
	const headers = new Map<string, string>();
	for (const line of lines.slice(1, blank)) {
		const colon = line.indexOf(":");
		headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
	}
	return { headers, body: lines.slice(blank + 1).join("\n") };
}

function stream(): string {
	return `${docExampleText("sarashina-api", "sarashina-api-chat-stream")}\n`;
}

describe("sarashina-api.md examples", () => {
	it("documents the exact request body and headers the adapter sends", async () => {
		const documented = documentedRequest();
		expect(documented.body).toBe(buildSarashinaRequestBody("sarashina3-mini", PROMPT, "low"));

		const fake = recordingFetch(() => sseResponse(stream()));
		const runtime = createSarashinaApiRuntime(
			makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, SARASHINA_API_KEY: API_KEY } }),
		);
		await collect(
			runtime.run(
				makeRequest({ prompt: PROMPT }),
				makeContext({ model: "sarashina3-mini", effort: "low", scratchDirectory: null }),
			),
		);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(SARASHINA_CHAT_COMPLETIONS_URL);
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
		const runtime = createSarashinaApiRuntime(
			makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, SARASHINA_API_KEY: API_KEY } }),
		);
		const events = await collect(
			runtime.run(makeRequest(), makeContext({ model: "sarashina3-mini", scratchDirectory: null })),
		);
		expect(textOf(events)).toBe("OK");
		expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
	});
});
