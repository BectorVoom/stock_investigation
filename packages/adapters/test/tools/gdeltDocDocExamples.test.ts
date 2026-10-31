/**
 * The documented GDELT DOC 2.0 answers (docs/external-apis/apis/gdelt-doc.md) are
 * served by a scripted fetcher and read by the real `news.search` tool: the
 * `artlist` JSON becomes evidence; a query with a keyword GDELT finds too
 * short (`ai`) is refused before any request, and the plain-text "keyword too
 * short" answer to any other query fails the call with its first line.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSearchTools } from "../../src/tools/searchTools.ts";
import { docExampleJson, docExampleText } from "../docExamples.ts";
import { createScriptedFetcher, createToolContext, fixedClock } from "./support.ts";

function gdeltUrl(query: string): string {
	return (
		"https://api.gdeltproject.org/api/v2/doc/doc" +
		`?query=${encodeURIComponent(`${query} sourcelang:english`)}` +
		"&mode=artlist&format=json&maxrecords=10&sort=hybridrel"
	);
}

function newsSearchTool(query: string, text: string, contentType: string) {
	const fetcher = createScriptedFetcher({ [gdeltUrl(query)]: { text, contentType } });
	const [tool] = createSearchTools({
		fetcher,
		hasher: {
			sha256Hex: async (value: string) => createHash("sha256").update(value).digest("hex"),
		},
		clock: fixedClock(),
		sleep: async () => {},
		tavilyApiKey: null,
	});
	if (tool === undefined) throw new Error("news.search was not created");
	return tool;
}

describe("GDELT DOC 2.0 document examples", () => {
	it("gdelt-doc-artlist: the live article list becomes evidence", async () => {
		const body = JSON.stringify(docExampleJson("gdelt-doc", "gdelt-doc-artlist"));
		const tool = newsSearchTool("gold price", body, "application/json; charset=utf-8");
		const result = await tool.execute({ query: "gold price" }, createToolContext());
		if (!result.ok) throw new Error(`news.search failed: ${result.error.code}`);
		const [first, second] = result.value.evidence;
		expect(result.value.evidence).toHaveLength(2);
		expect(first?.evidence.publisher).toBe("fortune.com");
		expect(first?.evidence.publishedAt).toBe("2026-10-16T14:30:00.000Z");
		expect(first?.evidence.sourceClass).toBe("news");
		expect(second?.evidence.publisher).toBe("economictimes.indiatimes.com");
	});

	it("gdelt-doc-keyword-too-short: the query `ai` is refused before any request", async () => {
		const text = docExampleText("gdelt-doc", "gdelt-doc-keyword-too-short");
		const fetcher = createScriptedFetcher({
			[gdeltUrl("ai")]: { text, contentType: "text/html; charset=utf-8" },
		});
		const [tool] = createSearchTools({
			fetcher,
			hasher: { sha256Hex: async () => "0".repeat(64) },
			clock: fixedClock(),
			sleep: async () => {},
			tavilyApiKey: null,
		});
		const result = await tool?.execute({ query: "ai" }, createToolContext());
		if (result === undefined || result.ok) throw new Error("expected news.search to fail");
		expect(result.error.code).toBe("QUERY_KEYWORD_TOO_SHORT");
		expect(fetcher.calls).toHaveLength(0);
	});

	it("gdelt-doc-keyword-too-short: the same answer to a query that passes our check fails with its first line", async () => {
		// Our check knows only GDELT's observed minimum; any other refusal still ends as SEARCH_FAILED.
		const text = docExampleText("gdelt-doc", "gdelt-doc-keyword-too-short");
		const tool = newsSearchTool('"ai" chips', text, "text/html; charset=utf-8");
		const result = await tool.execute({ query: '"ai" chips' }, createToolContext());
		if (result.ok) throw new Error("expected news.search to fail");
		expect(result.error.code).toBe("SEARCH_FAILED");
		expect(result.error.detail).toBe("Your search contained a keyword that was too short.");
		expect(result.error.upstreamStatus).toBeUndefined();
	});
});
