import { describe, expect, it } from "vitest";
import { webCryptoHasher } from "../../src/runtime/index.ts";
import { createAgentExtractTool } from "../../src/tools/agentExtract.ts";
import { createScriptedFetcher, createToolContext } from "./support.ts";

const endpoint = "http://127.0.0.1:8090/extract";
const url = "https://example.org/";

function setup(body: unknown) {
	const fetcher = createScriptedFetcher({ [endpoint]: { text: JSON.stringify(body) } });
	const tool = createAgentExtractTool(
		{ endpoint: "http://127.0.0.1:8090/search", apiKey: "fixture-key-not-secret", fetcher },
		webCryptoHasher,
	);
	return { fetcher, tool };
}

describe("Agent Web Search extraction", () => {
	it("posts to the service and gives verification the extracted source text", async () => {
		const text = "Publisher text made available for verification.";
		const { fetcher, tool } = setup({
			results: [{ url, title: "Source title", raw_content: text }],
			failed_results: [],
		});
		expect(await tool.execute({ url }, createToolContext())).toMatchObject({
			ok: true,
			value: {
				evidence: [
					{ evidence: { sourceUrl: url, excerpt: null }, retrievedText: text, retainQuotes: false },
				],
			},
		});
		expect(fetcher.urls()).toEqual([endpoint]);
		expect(JSON.parse(fetcher.calls[0]?.options.jsonBody ?? "null")).toEqual({
			urls: [url],
			format: "text",
			timeout: 25,
		});
	});

	it("preserves a robots denial and rejects private destinations before I/O", async () => {
		const { fetcher, tool } = setup({
			results: [],
			failed_results: [{ url, error: "Disallowed", code: "ROBOTS_DENIED", status: 403 }],
		});
		expect(await tool.execute({ url: "https://127.0.0.1/" }, createToolContext())).toMatchObject({
			ok: false,
			error: { code: "UNSAFE_URL" },
		});
		expect(fetcher.calls).toHaveLength(0);
		expect(await tool.execute({ url }, createToolContext())).toMatchObject({
			ok: false,
			error: { code: "ROBOTS_DISALLOWED" },
		});
	});
});
