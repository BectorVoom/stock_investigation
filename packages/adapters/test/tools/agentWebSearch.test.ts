import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackSearchFetcher } from "../../src/node/agentSearch.ts";
import { agentSearchEndpoint } from "../../src/tools/agentSearchEndpoint.ts";
import { createSearchTools } from "../../src/tools/searchTools.ts";
import { createScriptedFetcher, createToolContext, fixedClock } from "./support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
async function serve(status: number, body: string) {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.headers.authorization ?? "");
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(body);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing address");
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { base: `http://127.0.0.1:${address.port}`, requests };
}
const answer = JSON.stringify({
	results: [
		{
			url: "https://example.com/training",
			title: "Training demand",
			content: "Employer expenditure rose",
			published_date: "2026-11-01",
		},
	],
});
function tool(base: string) {
	const endpoint = agentSearchEndpoint(base);
	if (endpoint === null) throw new Error("bad endpoint");
	const publicFetcher = createScriptedFetcher({});
	const fetcher = createLoopbackSearchFetcher(base);
	const tools = createSearchTools({
		fetcher: publicFetcher,
		hasher: { sha256Hex: async (text) => createHash("sha256").update(text).digest("hex") },
		clock: fixedClock(),
		sleep: async () => {},
		tavilyApiKey: "legacy-key-must-never-be-used",
		agentWebSearch: { endpoint, apiKey: "agent-search-test-key", fetcher },
	});
	const web = tools.find((t) => t.toolId === "web.search");
	if (web === undefined) throw new Error("missing web search");
	return { web, publicFetcher };
}
describe("Agent Web Search integration", () => {
	it("uses authenticated loopback search over the legacy provider and reuses cached evidence", async () => {
		const server = await serve(200, answer);
		const { web, publicFetcher } = tool(server.base);
		expect(web.version).toBe("3.0.0");
		expect(web.description).toContain("Agent Web Search");
		const context = createToolContext();
		const first = await web.execute({ query: "training demand" }, context);
		const second = await web.execute({ query: "training demand" }, context);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok) {
			expect(first.value.evidence[0]?.evidence.sourceUrl).toBe("https://example.com/training");
			expect(first.value.evidence[0]?.evidence.publishedAt).toBe("2026-11-01T00:00:00.000Z");
		}
		expect(server.requests).toEqual(["Bearer agent-search-test-key"]);
		expect(publicFetcher.calls).toEqual([]);
	});
	it("keeps service status and opens cooldown without retrying", async () => {
		const server = await serve(503, "unavailable".repeat(200_000));
		const { web } = tool(server.base);
		const failed = await web.execute({ query: "training demand" }, createToolContext());
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.upstreamStatus).toBe(503);
		const next = await web.execute({ query: "different question" }, createToolContext());
		expect(next.ok).toBe(false);
		if (!next.ok) expect(next.error.code).toBe("SEARCH_COOLDOWN");
		expect(server.requests).toHaveLength(1);
	});
	it("rejects endpoint changes and cancelled requests before any connection", async () => {
		const fetcher = createLoopbackSearchFetcher("http://127.0.0.1:1");
		const controller = new AbortController();
		controller.abort();
		const opts = {
			maxBytes: 100,
			timeoutMs: 10,
			accept: "application/json",
			signal: controller.signal,
			jsonBody: "{}",
			authorization: "Bearer agent-search-test-key",
		};
		expect((await fetcher.fetchText("http://127.0.0.1:1/search", opts)).ok).toBe(false);
		const result = await fetcher.fetchText("http://127.0.0.1:2/search", {
			...opts,
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("UNSAFE_URL");
	});
	it("refuses a successful response above the byte cap", async () => {
		const server = await serve(200, "x".repeat(100));
		const fetcher = createLoopbackSearchFetcher(server.base);
		const result = await fetcher.fetchText(`${server.base}/search`, {
			maxBytes: 10,
			timeoutMs: 1000,
			accept: "application/json",
			jsonBody: "{}",
			authorization: "Bearer agent-search-test-key",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("RESPONSE_TOO_LARGE");
	});
	it("only accepts literal loopback origins", () => {
		for (const value of [
			"http://localhost:8090",
			"http://10.0.0.1/",
			"https://example.com/",
			"http://user:pass@127.0.0.1:8090/",
			"http://127.0.0.1:8090/private",
		]) {
			expect(agentSearchEndpoint(value)).toBeNull();
		}
		expect(agentSearchEndpoint("http://[::1]:8090")).toBe("http://[::1]:8090/search");
	});
});
