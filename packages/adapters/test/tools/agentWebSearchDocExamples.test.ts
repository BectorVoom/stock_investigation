import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createSearchTools } from "../../src/tools/searchTools.ts";
import { docExampleJson } from "../docExamples.ts";
import { createScriptedFetcher, createToolContext, fixedClock } from "./support.ts";

it("parses the captured Agent Web Search response through the production evidence path", async () => {
	const body = docExampleJson("agent-web-search", "agent-web-search-search");
	const endpoint = "http://127.0.0.1:8090/search";
	const fetcher = createScriptedFetcher({
		[endpoint]: { text: JSON.stringify(body), contentType: "application/json" },
	});
	const tool = createSearchTools({
		fetcher: createScriptedFetcher({}),
		clock: fixedClock(),
		hasher: { sha256Hex: async (text) => createHash("sha256").update(text).digest("hex") },
		sleep: async () => {},
		tavilyApiKey: null,
		agentWebSearch: { endpoint, apiKey: "agent-search-example-key", fetcher },
	}).find((t) => t.toolId === "web.search");
	expect(tool).toBeDefined();
	const result = await tool?.execute(
		{ query: "corporate training market demand" },
		createToolContext(),
	);
	expect(result?.ok).toBe(true);
	if (result?.ok) expect(result.value.evidence).toHaveLength(1);
	const failure = docExampleJson("agent-web-search", "agent-web-search-unauthorized");
	expect(failure).toMatchObject({ detail: { code: "UNAUTHORIZED", status: 401 } });
});
