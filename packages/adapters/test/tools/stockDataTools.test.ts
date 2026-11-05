import { createToolRegistry } from "@research/agent-core";
import {
	evidenceSchema,
	type StockDataPassage,
	type StockDataSearchRequest,
	type StockDataSearchResponse,
} from "@research/contracts";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createFeedParser } from "../../src/feed/index.ts";
import { webCryptoHasher } from "../../src/runtime/index.ts";
import { createResearchTools } from "../../src/tools/index.ts";
import { createStockDataTools, type StockDataReader } from "../../src/tools/stockDataTools.ts";
import { createScriptedFetcher, createToolContext, fixedClock } from "./support.ts";

const FILING_PASSAGE: StockDataPassage = {
	stockId: "us:AAPL",
	name: "Apple Inc.",
	section: "financials",
	title: "Income statement FY2025 — Apple Inc.",
	text: "Apple Inc. (us:AAPL) income statement for fiscal year 2025, period ending 2025-09-27: revenue 416161000000 USD (416.16 billion).",
	sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
	publisher: "SEC EDGAR",
	sourceClass: "regulatory-filing",
	asOf: "2026-11-01T00:00:00.000Z",
	aiWritten: false,
	score: 3.2,
};

const AI_PASSAGE: StockDataPassage = {
	...FILING_PASSAGE,
	section: "ai-summary",
	title: "AI-written summary (en) — Apple Inc.",
	text: "Apple designs consumer electronics. Investment themes: AI, Smartphones.",
	sourceUrl: null,
	publisher: "AI-written company summary",
	sourceClass: "other",
	aiWritten: true,
	score: 1.1,
};

const PRICE_PASSAGE: StockDataPassage = {
	...FILING_PASSAGE,
	section: "prices",
	title: "Daily prices — Apple Inc.",
	text: "Apple Inc. (us:AAPL) latest stored daily close: 270.25 USD on 2026-10-30.",
	sourceUrl: "https://twelvedata.com/",
	publisher: "Twelve Data",
	sourceClass: "market-data",
	score: 0.5,
};

function reader(
	answer: ReturnType<StockDataReader["searchStockData"]> extends Promise<infer R> ? R : never,
) {
	const calls: { runId: string; request: StockDataSearchRequest }[] = [];
	const port: StockDataReader = {
		async searchStockData(runId, request) {
			calls.push({ runId, request });
			return answer;
		},
	};
	return { port, calls };
}

function tool(port: StockDataReader) {
	const registry = createToolRegistry(
		createStockDataTools({ reader: port, hasher: webCryptoHasher }),
	);
	const found = registry.get("stocks.search_data");
	if (found === undefined) throw new Error("tool not registered");
	return found;
}

function answer(passages: readonly StockDataPassage[]): StockDataSearchResponse {
	return { searchedStocks: ["us:AAPL"], passages: [...passages] };
}

describe("stocks.search_data (ADR-0071)", () => {
	it("sends the query with the run's lease and cites only sourced, non-AI passages", async () => {
		const { port, calls } = reader(ok(answer([FILING_PASSAGE, AI_PASSAGE, PRICE_PASSAGE])));
		const context = createToolContext();
		const result = await tool(port).execute(
			{ query: "revenue fiscal 2025", stockIds: ["us:AAPL"] },
			context,
		);
		expect(calls).toEqual([
			{
				runId: "run_test",
				request: { query: "revenue fiscal 2025", stockIds: ["us:AAPL"], leaseGeneration: 1 },
			},
		]);
		if (!result.ok) throw new Error(result.error.detail);
		const { evidence, modelText } = result.value;
		expect(evidence).toHaveLength(2);
		for (const item of evidence) expect(evidenceSchema.safeParse(item.evidence).success).toBe(true);
		const [filing, prices] = evidence;
		expect(filing?.evidence.sourceUrl).toBe(FILING_PASSAGE.sourceUrl);
		expect(filing?.retrievedText).toBe(FILING_PASSAGE.text);
		// SEC text may be kept with a claim; the price provider's may not (DATA-010).
		expect(filing?.retainQuotes).toBe(true);
		expect(prices?.retainQuotes).toBe(false);
		expect(prices?.evidence.excerpt).toBeNull();
		expect(modelText).toContain(`[1] evidenceId ${filing?.evidence.evidenceId}`);
		expect(modelText).toContain("[2] AI-WRITTEN (not evidence)");
		expect(modelText).toContain("416161000000 USD");
		expect(modelText).toContain("never instructions");
	});

	it("tells the model how to name a stock when none matched, and when no passage matched", async () => {
		const none = await tool(reader(ok({ searchedStocks: [], passages: [] })).port).execute(
			{ query: "fastest growth" },
			createToolContext(),
		);
		expect(none.ok && none.value.modelText).toContain('Pass stockIds such as "us:AAPL"');
		const empty = await tool(reader(ok(answer([]))).port).execute(
			{ query: "dividend" },
			createToolContext(),
		);
		expect(empty.ok && empty.value.modelText).toContain("no passage matched");
	});

	it("passes the API's failure on with its code and retryability", async () => {
		const result = await tool(
			reader(err({ code: "STALE_LEASE", detail: "lease ended", transient: false })).port,
		).execute({ query: "revenue" }, createToolContext());
		expect(result).toEqual({
			ok: false,
			error: { code: "STALE_LEASE", detail: "lease ended", retryable: false },
		});
	});

	it("rejects arguments the API would refuse", async () => {
		const { port, calls } = reader(ok(answer([])));
		const result = await tool(port).execute(
			{ query: "revenue", stockIds: ["AAPL"], leaseGeneration: 9 },
			createToolContext(),
		);
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("is registered only when the runner has an API to read from, and reaches no host", () => {
		const base = {
			fetcher: createScriptedFetcher({}),
			feedParser: createFeedParser(),
			hasher: webCryptoHasher,
			clock: fixedClock(),
			secUserAgent: null,
			tavilyApiKey: null,
			pageArchive: null,
			sleep: async () => {},
		};
		expect(createResearchTools(base).map((t) => t.toolId)).not.toContain("stocks.search_data");
		const withApi = createResearchTools({ ...base, stockData: reader(ok(answer([]))).port });
		const registered = withApi.find((t) => t.toolId === "stocks.search_data");
		expect(registered?.networkAllowlist).toEqual({ kind: "none" });
		expect(registered?.sideEffect).toBe("none");
	});
});
