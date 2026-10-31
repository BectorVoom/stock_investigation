import { describe, expect, it } from "vitest";
import {
	articleMention,
	mentionLikePattern,
	nameMentionTerm,
	type StockMentionTerm,
	stockMentionTerms,
	termOccurs,
} from "../../src/news/stockMentions.ts";

const name = (text: string): StockMentionTerm => ({ text, kind: "name" });
const symbol = (text: string): StockMentionTerm => ({ text, kind: "symbol" });

/** SQLite `LIKE … ESCAPE '\'` with ASCII case folding, for checking the prefilter. */
function sqliteLike(text: string, pattern: string): boolean {
	let source = "^";
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern.charAt(i);
		if (char === "\\") {
			i += 1;
			source += pattern.charAt(i).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		} else if (char === "%") source += "[\\s\\S]*";
		else if (char === "_") source += "[\\s\\S]";
		else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${source}$`, "i").test(text);
}

describe("stock mention terms (ADR-0049 §7)", () => {
	it("strips corporate forms and SEC state tags", () => {
		expect(nameMentionTerm("Apple Inc.")).toBe("Apple");
		expect(nameMentionTerm("COCA COLA CO")).toBe("COCA COLA");
		expect(nameMentionTerm("MICROSOFT CORP")).toBe("MICROSOFT");
		expect(nameMentionTerm("Toyota Motor Co., Ltd.")).toBe("Toyota Motor");
		// JPX's English names put no space after the comma.
		expect(nameMentionTerm("NINTENDO CO.,LTD.")).toBe("NINTENDO");
		expect(nameMentionTerm("HONDA MOTOR CO.,LTD.")).toBe("HONDA MOTOR");
		expect(nameMentionTerm("BERKSHIRE HATHAWAY INC /DE/")).toBe("BERKSHIRE HATHAWAY");
		expect(nameMentionTerm("任天堂株式会社")).toBe("任天堂");
		expect(nameMentionTerm("株式会社　ダイキン工業")).toBe("ダイキン工業");
		expect(nameMentionTerm("Ｘ")).toBeNull();
		// A name that is only a corporate form keeps it rather than becoming empty.
		expect(nameMentionTerm("Inc")).toBe("Inc");
	});

	it("keeps distinct names in order, then a US symbol; never a Japanese code", () => {
		expect(
			stockMentionTerms({
				market: "US",
				symbol: "AAPL",
				names: ["Apple Inc.", null, "APPLE INC", "アップル"],
			}),
		).toEqual([name("Apple"), name("アップル"), symbol("AAPL")]);
		expect(
			stockMentionTerms({ market: "JP", symbol: "7974", names: ["Nintendo Co., Ltd.", "任天堂"] }),
		).toEqual([name("Nintendo"), name("任天堂")]);
		expect(stockMentionTerms({ market: "JP", symbol: "7974", names: [] })).toEqual([]);
		const many = stockMentionTerms({ market: "US", symbol: "XY", names: ["Aa", "Bb", "Cc", "Dd"] });
		expect(many).toEqual([name("Aa"), name("Bb"), name("Cc"), symbol("XY")]);
		// A one-letter symbol is not a term ("Series A"), so all four slots go to names.
		const single = stockMentionTerms({ market: "US", symbol: "F", names: ["Ford Motor Co"] });
		expect(single).toEqual([name("Ford Motor")]);
	});
});

describe("article mention", () => {
	it("matches names case-insensitively at word boundaries", () => {
		expect(termOccurs("Apple unveils a new iPhone", name("apple"))).toBe(true);
		expect(termOccurs("Pineapple prices rise", name("Apple"))).toBe(false);
		expect(termOccurs("Applesauce", name("Apple"))).toBe(false);
		expect(termOccurs("(Apple)", name("Apple"))).toBe(true);
		expect(termOccurs("Coca-Cola earnings", name("COCA COLA"))).toBe(true);
		expect(termOccurs("Coca Cola earnings", name("Coca-Cola"))).toBe(true);
	});

	it("matches a symbol case-sensitively and Japanese names as substrings", () => {
		expect(termOccurs("KO shares fell", symbol("KO"))).toBe(true);
		expect(termOccurs("ko shares fell", symbol("KO"))).toBe(false);
		expect(termOccurs("KOREA", symbol("KO"))).toBe(false);
		expect(termOccurs("任天堂が新型機を発表", name("任天堂"))).toBe(true);
		expect(termOccurs("東京エレクトロンの決算", name("東京エレクトロン"))).toBe(true);
	});

	it("returns the first term in term order that any text mentions", () => {
		const terms = [name("Nintendo"), name("任天堂")];
		expect(articleMention(["任天堂の決算", "Nintendo results"], terms)).toEqual(name("Nintendo"));
		expect(articleMention([null, "任天堂の決算"], terms)).toEqual(name("任天堂"));
		expect(articleMention(["Sony results", null], terms)).toBeNull();
	});
});

describe("LIKE prefilter", () => {
	it("escapes wildcards and turns separators into one-character wildcards", () => {
		expect(mentionLikePattern(name("Coca-Cola"))).toBe("%Coca_Cola%");
		expect(mentionLikePattern(name("100%_Fund\\X"))).toBe("%100\\%\\_Fund\\\\X%");
	});

	it("never drops a true mention", () => {
		const cases: readonly [string, StockMentionTerm][] = [
			["COCA-COLA beats", name("Coca Cola")],
			["The 100%_Fund rises", name("100%_Fund")],
			["任天堂が発表", name("任天堂")],
			["Shares of AAPL", symbol("AAPL")],
		];
		for (const [text, term] of cases) {
			expect(termOccurs(text, term)).toBe(true);
			expect(sqliteLike(text, mentionLikePattern(term))).toBe(true);
		}
	});
});
