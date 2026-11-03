import { describe, expect, it } from "vitest";
import {
	checkDescription,
	describeProblems,
	keepVerified,
	normalizeForQuote,
	numbersIn,
} from "../../scripts/poc/companyDescription/evidence.ts";
import { companyDescriptionPrompt } from "../../scripts/poc/companyDescription/prompt.ts";
import {
	escapeHtml,
	millions,
	operatingMargin,
} from "../../scripts/poc/companyDescription/render.ts";
import { groupDigits } from "../../scripts/poc/companyDescription/sources.ts";
import {
	type CompanyDescription,
	type CompanySource,
	companyDescriptionSchema,
	type Figure,
	type Segment,
	STYLE_RULES,
	type Statement,
} from "../../scripts/poc/companyDescription/template.ts";
import {
	choosePages,
	nameWords,
	pageKind,
} from "../../scripts/poc/companyDescription/webSources.ts";

const sources: CompanySource[] = [
	{
		id: "S1",
		title: { en: "Form 10-K, Item 1", ja: "Form 10-K 第1項" },
		publisher: "U.S. SEC EDGAR",
		asOf: "2025-09-27",
		url: "https://www.sec.gov/example.htm",
		note: null,
		text: "The Company designs, manufactures and markets smartphones,\npersonal computers, tablets — and wearables. Services accounted for 26% of total net sales. As of September 27, 2025, the Company had approximately 166,000 full-time equivalent employees.",
	},
];

function statement(en: string, quote: string, source = "S1"): Statement {
	return { en, ja: en, evidence: [{ source, quote }] };
}

function segment(name: string, quote: string, salesSharePercent: number | null): Segment {
	return {
		name: { en: name, ja: name },
		activity: null,
		salesSharePercent,
		marginPercent: null,
		evidence: [{ source: "S1", quote }],
	};
}

function description(overrides: Partial<CompanyDescription> = {}): CompanyDescription {
	return {
		feature: statement("Makes smartphones.", "designs, manufactures and markets smartphones"),
		businesses: [statement("Tablets.", "personal computers, tablets")],
		segments: [],
		overseasSales: null,
		profile: [],
		themes: [
			{
				label: { en: "Consumer electronics", ja: "民生用電子機器" },
				reason: statement("Devices.", "smartphones, personal computers"),
			},
		],
		...overrides,
	};
}

describe("company description evidence check (PoC)", () => {
	it("accepts quotes that differ only in whitespace, case, width and dash style", () => {
		expect(normalizeForQuote("Ｔablets – and\n  Wearables")).toBe("tablets - and wearables");
		const checked = checkDescription(
			description({ businesses: [statement("Tablets.", "TABLETS - and wearables")] }),
			sources,
		);
		expect(describeProblems(checked)).toEqual([]);
	});

	it("rejects a paraphrase, an unknown source and a digit without a quoted number", () => {
		const checked = checkDescription(
			description({
				businesses: [
					statement("It sells phones.", "sells mobile phones worldwide"),
					statement("Services grew.", "services revenue grew", "S9"),
					statement("Sold 2 billion devices.", "designs, manufactures and markets"),
				],
			}),
			sources,
		);
		expect(describeProblems(checked)).toEqual([
			'businesses[0]: the quote "sells mobile phones worldwide" is not in S1 word for word.',
			"businesses[1]: source S9 does not exist.",
			"businesses[2]: the text has a number but no quote with a number.",
		]);
	});

	it("accepts a stated segment share and rejects one the quote does not state", () => {
		const checked = checkDescription(
			description({
				segments: [
					segment("Services", "Services accounted for 26% of total net sales", 26),
					segment("iPhone", "markets smartphones", 51),
					segment("Mac", "personal computers", null),
				],
			}),
			sources,
		);
		expect(describeProblems(checked)).toEqual([
			"segments[1]: the number 51 is not in any of its quotes; use null when no source states it.",
		]);
	});

	it("checks profile facts and the overseas share like other fields", () => {
		const checked = checkDescription(
			description({
				overseasSales: {
					percent: 60,
					evidence: [{ source: "S1", quote: "accounted for 26% of total" }],
				},
				profile: [
					{
						field: "employees",
						value: { en: "About 166,000 (Sep 2025)", ja: "約16.6万人(2025年9月)" },
						evidence: [
							{ source: "S1", quote: "approximately 166,000 full-time equivalent employees" },
						],
					},
				],
			}),
			sources,
		);
		expect(describeProblems(checked)).toEqual([
			"overseasSales: the number 60 is not in any of its quotes; use null when no source states it.",
		]);
	});

	it("keeps only the verified fields", () => {
		const draft = description({
			feature: statement("Made up.", "a company that sells cars"),
			businesses: [
				statement("Tablets.", "personal computers, tablets"),
				statement("Cars.", "electric vehicles and cars"),
			],
		});
		const kept = keepVerified(draft, checkDescription(draft, sources));
		expect(kept.feature).toBeNull();
		expect(kept.businesses.map((item) => item.en)).toEqual(["Tablets."]);
		expect(kept.themes).toHaveLength(1);
	});

	it("refuses a 特色 longer than one handbook line", () => {
		const long = description({
			feature: { ...statement("x", "smartphones"), ja: "あ".repeat(71) },
		});
		expect(companyDescriptionSchema.safeParse(long).success).toBe(false);
		expect(companyDescriptionSchema.safeParse(description()).success).toBe(true);
	});
});

describe("company description rendering helpers (PoC)", () => {
	const figure = (metric: Figure["metric"], value: string): Figure => ({
		metric,
		fiscalYear: 2025,
		periodEnd: "2025-09-27",
		value,
		currency: "USD",
	});

	it("reads numbers as written", () => {
		expect(numbersIn("approximately 166,000 employees, 26% and 4.5")).toEqual([166000, 26, 4.5]);
	});

	it("shows figures in millions and computes the operating margin", () => {
		expect(millions("416161000000")).toBe("416,161");
		expect(millions("-21000000")).toBe("-21");
		expect(
			operatingMargin([
				figure("revenue", "416161000000"),
				figure("operating-income", "133050000000"),
			]),
		).toBe("32.0%");
		expect(operatingMargin([figure("revenue", "0"), figure("operating-income", "1")])).toBeNull();
		expect(operatingMargin([figure("revenue", "100")])).toBeNull();
	});

	it("groups digits and escapes HTML", () => {
		expect(groupDigits("416161000000")).toBe("416,161,000,000");
		expect(groupDigits("-1234.5")).toBe("-1,234.5");
		expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
		);
	});
});

describe("company description prompt (PoC)", () => {
	it("carries every style rule against AI-like writing, in both languages", () => {
		const prompt = companyDescriptionPrompt({
			stock: {
				stock: { market: "US", symbol: "AAPL" },
				name: { en: "Apple Inc.", ja: "Apple Inc." },
				sources,
				profile: { listing: "nasdaq", sector: null, fiscalYearEnd: "09-26" },
				cites: { listing: null, sector: null, figures: null },
				figures: [],
			},
			fenceToken: "fence123",
			repairNote: null,
		});
		for (const rule of [...STYLE_RULES.en, ...STYLE_RULES.ja]) {
			expect(prompt).toContain(rule);
		}
	});
});

describe("company overview web sources (PoC, ADR-0064)", () => {
	it("takes the distinctive words of a company name", () => {
		expect(nameWords("COCA COLA CO")).toEqual(["coca", "cola"]);
		expect(nameWords("AKIKAWA FOODS & FARMS CO.,LTD.")).toEqual(["akikawa", "foods", "farms"]);
		expect(nameWords("Apple Inc.")).toEqual(["apple"]);
	});

	it("ranks the company's own site, then regulators and exchanges, then other pages", () => {
		expect(pageKind("https://www.coca-colacompany.com/about-us", "COCA COLA CO")).toBe("official");
		expect(
			pageKind("https://www.akikawabokuen.com/company/", "AKIKAWA FOODS & FARMS CO.,LTD."),
		).toBe("official");
		expect(pageKind("https://www.sec.gov/cgi-bin/browse-edgar", "Apple Inc.")).toBe("regulator");
		expect(pageKind("https://www.jpx.co.jp/listing/", "X")).toBe("regulator");
		expect(pageKind("https://www.reuters.com/company/ko", "COCA COLA CO")).toBe("other");
	});

	it("never uses Wikipedia, social media, forums, 四季報's site or plain http", () => {
		for (const url of [
			"https://ja.wikipedia.org/wiki/秋川牧園",
			"https://x.com/apple",
			"https://www.reddit.com/r/stocks",
			"https://detail.chiebukuro.yahoo.co.jp/qa/1",
			"https://shikiho.toyokeizai.net/stocks/1380",
			"http://www.akikawabokuen.com/",
		]) {
			expect(pageKind(url, "AKIKAWA FOODS & FARMS")).toBeNull();
		}
	});

	it("chooses acceptable pages, official first, each once, up to the limit", () => {
		const chosen = choosePages(
			[
				{ url: "https://ja.wikipedia.org/wiki/x" },
				{ url: "https://kabutan.jp/stock/?code=1380" },
				{ url: "https://www.akikawabokuen.com/company/" },
				{ url: "https://www.akikawabokuen.com/company/" },
				{ url: "https://www.jpx.co.jp/x" },
				{ url: "https://example.com/a" },
			],
			"AKIKAWA FOODS & FARMS CO.,LTD.",
			3,
		);
		expect(chosen).toEqual([
			{ url: "https://www.akikawabokuen.com/company/", kind: "official" },
			{ url: "https://www.jpx.co.jp/x", kind: "regulator" },
			{ url: "https://kabutan.jp/stock/?code=1380", kind: "other" },
		]);
	});
});
