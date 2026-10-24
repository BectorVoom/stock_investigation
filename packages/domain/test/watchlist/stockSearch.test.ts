import { describe, expect, it } from "vitest";
import {
	foldStockSearchText,
	rankStockSearch,
	STOCK_SEARCH_LIMITS,
	type StockSearchRow,
	stockSearchKeys,
	stockSearchTerms,
	stockSearchTier,
} from "../../src/watchlist/stockSearch.ts";

const toyotaJp: StockSearchRow = {
	market: "JP",
	symbol: "7203",
	name: "TOYOTA MOTOR CORPORATION",
	localName: "トヨタ自動車",
};
const toyotaUs: StockSearchRow = {
	market: "US",
	symbol: "TM",
	name: "TOYOTA MOTOR CORP/",
	localName: null,
};
const hino: StockSearchRow = {
	market: "JP",
	symbol: "7205",
	name: "HINO MOTORS,LTD.",
	localName: "日野自動車",
};
const apple: StockSearchRow = { market: "US", symbol: "AAPL", name: "Apple Inc.", localName: null };
const applied: StockSearchRow = {
	market: "US",
	symbol: "AMAT",
	name: "APPLIED MATERIALS INC /DE",
	localName: null,
};
const ford: StockSearchRow = { market: "US", symbol: "F", name: "FORD MOTOR CO", localName: null };
const rows = [toyotaJp, toyotaUs, hino, apple, applied, ford];

describe("foldStockSearchText", () => {
	it("half-widths full-width input, lower-cases ASCII and collapses whitespace", () => {
		expect(foldStockSearchText("  ＡＡＰＬ　Inc. ")).toBe("aapl inc.");
		expect(foldStockSearchText("７２０３")).toBe("7203");
	});

	it("folds hiragana and half-width katakana onto full-width katakana", () => {
		expect(foldStockSearchText("とよた")).toBe("トヨタ");
		expect(foldStockSearchText("ﾄﾖﾀ")).toBe("トヨタ");
	});

	it("composes a voiced katakana that only exists after the hiragana shift, so folding is idempotent", () => {
		expect(foldStockSearchText("わ\u3099")).toBe("ヷ");
		for (const text of ["わ\u3099", "を\u3099ん", "ゐ\u3099 x", "トヨタ", "  ＡＢ　c "]) {
			const once = foldStockSearchText(text);
			expect(foldStockSearchText(once)).toBe(once);
		}
	});

	it("leaves kanji and non-ASCII letters as they are", () => {
		expect(foldStockSearchText("自動車")).toBe("自動車");
		expect(foldStockSearchText("É")).toBe("É");
	});
});

describe("stockSearchTerms", () => {
	it("splits the folded query and drops blanks", () => {
		expect(stockSearchTerms(" Toyota  Motor ")).toEqual(["toyota", "motor"]);
		expect(stockSearchTerms("   ")).toEqual([]);
	});

	it("keeps at most maxTerms terms and reads at most maxQueryChars characters", () => {
		expect(stockSearchTerms("a b c d e f")).toHaveLength(STOCK_SEARCH_LIMITS.maxTerms);
		const long = "x".repeat(STOCK_SEARCH_LIMITS.maxQueryChars + 10);
		expect(stockSearchTerms(long)[0]).toHaveLength(STOCK_SEARCH_LIMITS.maxQueryChars);
	});
});

describe("stockSearchTier", () => {
	it("ranks exact symbol, symbol prefix, name prefix, then any match", () => {
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["7203"])).toBe(0);
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["72"])).toBe(1);
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["toyota"])).toBe(2);
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["トヨタ"])).toBe(2);
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["motor"])).toBe(3);
	});

	it("needs every term, each inside one field", () => {
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["toyota", "自動車"])).toBe(2);
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["toyota", "hino"])).toBeNull();
		// "7203" then the name: "3t" spans the symbol and the name, so no match.
		expect(stockSearchTier(stockSearchKeys(toyotaJp), ["3t"])).toBeNull();
		expect(stockSearchTier(stockSearchKeys(toyotaJp), [])).toBeNull();
	});

	it("is not exact when more than one term is given", () => {
		expect(stockSearchTier(stockSearchKeys(toyotaUs), ["tm", "toyota"])).toBe(1);
	});
});

describe("rankStockSearch", () => {
	it("finds a Japanese stock by English name, Japanese name, hiragana or code", () => {
		expect(rankStockSearch(rows, "toyota")).toEqual([toyotaUs, toyotaJp]);
		expect(rankStockSearch(rows, "とよた")).toEqual([toyotaJp]);
		expect(rankStockSearch(rows, "７２０３")).toEqual([toyotaJp]);
	});

	it("puts the exact symbol first, then shorter symbols", () => {
		expect(rankStockSearch(rows, "f")).toEqual([ford]);
		expect(rankStockSearch(rows, "a")).toEqual([apple, applied, toyotaUs, toyotaJp]);
		expect(rankStockSearch(rows, "aapl")).toEqual([apple]);
		expect(rankStockSearch(rows, "720")).toEqual([toyotaJp, hino]);
	});

	it("orders same-tier rows by symbol length, symbol, then market", () => {
		expect(rankStockSearch(rows, "motor")).toEqual([ford, toyotaUs, toyotaJp, hino]);
		const twins: StockSearchRow[] = [
			{ market: "US", symbol: "ABC", name: "Same", localName: null },
			{ market: "JP", symbol: "ABC", name: "Same", localName: null },
		];
		expect(rankStockSearch(twins, "same").map((row) => row.market)).toEqual(["JP", "US"]);
	});

	it("returns nothing for a blank query and clamps the limit", () => {
		expect(rankStockSearch(rows, "  ")).toEqual([]);
		expect(rankStockSearch(rows, "o", 0)).toHaveLength(1);
		expect(rankStockSearch(rows, "o", 2)).toHaveLength(2);
		const many: StockSearchRow[] = Array.from({ length: 50 }, (_, index) => ({
			market: "US",
			symbol: `A${index}`,
			name: "Alpha",
			localName: null,
		}));
		expect(rankStockSearch(many, "alpha", 999)).toHaveLength(STOCK_SEARCH_LIMITS.maxResults);
	});
});
