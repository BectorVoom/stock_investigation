/**
 * The documented Tavily `POST /search` answer (docs/external-apis/apis/tavily-search.md)
 * is served by a scripted fetcher and read by the real `web.search` tool, so the
 * document's example cannot drift from what the TypeScript runner accepts.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSearchTools } from "../../src/tools/searchTools.ts";
import { docExampleJson } from "../docExamples.ts";
import { createScriptedFetcher, createToolContext, fixedClock } from "./support.ts";

function webSearchTool(body: unknown) {
	const fetcher = createScriptedFetcher({
		"https://api.tavily.com/search": {
			text: JSON.stringify(body),
			contentType: "application/json",
		},
	});
	const tools = createSearchTools({
		fetcher,
		hasher: { sha256Hex: async (text: string) => createHash("sha256").update(text).digest("hex") },
		clock: fixedClock(),
		sleep: async () => {},
		tavilyApiKey: "tvly-doc-example-key",
	});
	const tool = tools.find((candidate) => candidate.toolId === "web.search");
	if (tool === undefined) throw new Error("web.search was not created");
	return { fetcher, tool };
}

describe("Tavily Search document examples", () => {
	it("tavily-search-results: the live answer becomes dated evidence", async () => {
		const { fetcher, tool } = webSearchTool(
			docExampleJson("tavily-search", "tavily-search-results"),
		);
		const result = await tool.execute(
			{ query: "Apple quarterly revenue 2026" },
			createToolContext(),
		);
		if (!result.ok) throw new Error(`web.search failed: ${result.error.code}`);
		const [first] = result.value.evidence;
		expect(result.value.evidence).toHaveLength(1);
		expect(first?.evidence.sourceUrl).toBe("https://en.wikipedia.org/wiki/Apple_Inc.");
		expect(first?.evidence.publisher).toBe("en.wikipedia.org");
		expect(first?.evidence.publishedAt).toBe("2026-10-14T07:00:00.000Z");
		expect(first?.evidence.excerpt).toBe(null);
		expect(fetcher.calls[0]?.options.jsonBody).toBe(
			'{"query":"Apple quarterly revenue 2026","search_depth":"basic","max_results":10,"include_published_date":true}',
		);
	});
});
