import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	rankStockPassages,
	retrievalQueryTerms,
	retrievalTokens,
	STOCK_DATA_RETRIEVAL_LIMITS,
} from "../../src/watchlist/stockDataRetrieval.ts";

describe("retrievalTokens", () => {
	it("folds Latin words and drops stop words", () => {
		expect(retrievalTokens("What is Apple's REVENUE in FY2025?")).toEqual([
			"apple",
			"s",
			"revenue",
			"fy2025",
		]);
	});

	it("splits Japanese runs into bigrams and folds hiragana and full width", () => {
		expect(retrievalTokens("任天堂の売上高")).toEqual(
			["任天", "天堂", "堂の", "の売", "売上", "上高"].map((token) => token.replace("の", "ノ")),
		);
		expect(retrievalTokens("ＡＢＣ 半")).toEqual(["abc", "半"]);
	});

	it("separates on punctuation", () => {
		expect(retrievalTokens("net-income,cash/flow")).toEqual(["net", "income", "cash", "flow"]);
	});
});

describe("retrievalQueryTerms", () => {
	it("keeps distinct terms in first-seen order, capped", () => {
		expect(retrievalQueryTerms("revenue Revenue growth")).toEqual(["revenue", "growth"]);
		const many = Array.from({ length: 40 }, (_, index) => `w${index}`).join(" ");
		expect(retrievalQueryTerms(many)).toHaveLength(STOCK_DATA_RETRIEVAL_LIMITS.maxQueryTerms);
	});
});

describe("rankStockPassages", () => {
	const passages = [
		"Apple Inc. listing: NASDAQ, symbol AAPL.",
		"Income statement FY2025: revenue 416,161,000,000 USD; net income 112,010,000,000 USD.",
		"Balance sheet FY2025: total assets 359,241,000,000 USD.",
		"Next earnings announcement: 2027-01-29 after market close.",
		"任天堂の連結売上高は 2025年度に増加した。",
	];

	it("ranks the passage that answers the query first", () => {
		expect(rankStockPassages("revenue net income", passages, 3)[0]?.index).toBe(1);
		expect(rankStockPassages("next earnings date", passages, 3)[0]?.index).toBe(3);
		expect(rankStockPassages("売上高", passages, 3)[0]?.index).toBe(4);
	});

	it("returns nothing for a query without shared terms or an empty corpus", () => {
		expect(rankStockPassages("dividend yield", passages, 5)).toEqual([]);
		expect(rankStockPassages("the of", passages, 5)).toEqual([]);
		expect(rankStockPassages("revenue", [], 5)).toEqual([]);
	});

	it("clamps the limit", () => {
		const corpus = Array.from({ length: 30 }, (_, index) => `revenue row ${index}`);
		expect(rankStockPassages("revenue", corpus, 0)).toHaveLength(1);
		expect(rankStockPassages("revenue", corpus, 100)).toHaveLength(
			STOCK_DATA_RETRIEVAL_LIMITS.maxResults,
		);
		expect(rankStockPassages("revenue", corpus, Number.NaN)).toHaveLength(1);
	});

	it("breaks ties by input order", () => {
		const ranked = rankStockPassages("revenue", ["revenue a", "revenue b", "revenue c"], 3);
		expect(ranked.map((hit) => hit.index)).toEqual([0, 1, 2]);
	});

	it("is sound, sorted, bounded and duplicate-free for any input", () => {
		const word = fc.constantFrom("revenue", "income", "assets", "売上", "AAPL", "cash", "the", "x");
		const text = fc.array(word, { maxLength: 8 }).map((words) => words.join(" "));
		fc.assert(
			fc.property(
				text,
				fc.array(text, { maxLength: 15 }),
				fc.integer({ min: -2, max: 20 }),
				(query, corpus, limit) => {
					const ranked = rankStockPassages(query, corpus, limit);
					const terms = new Set(retrievalQueryTerms(query));
					expect(ranked.length).toBeLessThanOrEqual(
						Math.min(STOCK_DATA_RETRIEVAL_LIMITS.maxResults, Math.max(1, limit)),
					);
					expect(new Set(ranked.map((hit) => hit.index)).size).toBe(ranked.length);
					for (const [position, hit] of ranked.entries()) {
						const passage = corpus[hit.index];
						expect(passage).toBeDefined();
						// Sound: every hit shares a term with the query and scores above zero.
						expect(retrievalTokens(passage ?? "").some((token) => terms.has(token))).toBe(true);
						expect(hit.score).toBeGreaterThan(0);
						const next = ranked[position + 1];
						if (next !== undefined) {
							expect(
								hit.score > next.score || (hit.score === next.score && hit.index < next.index),
							).toBe(true);
						}
					}
					// Complete: when the matches fit the limit, every matching passage is ranked.
					const matching = corpus.filter((passage) =>
						retrievalTokens(passage).some((token) => terms.has(token)),
					).length;
					if (
						matching <= Math.max(1, limit) &&
						matching <= STOCK_DATA_RETRIEVAL_LIMITS.maxResults
					) {
						expect(ranked).toHaveLength(matching);
					}
				},
			),
		);
	});
});
