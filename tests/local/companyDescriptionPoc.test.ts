import type { ToolDefinition } from "@research/agent-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	cleanFetchedText,
	pagesFromResults,
	samePageKey,
} from "../../scripts/poc/companyDescription/claudePageFinder.ts";
import {
	checkDescription,
	claimTerms,
	describeProblems,
	keepVerified,
	normalizeForQuote,
	numbersIn,
	quotedNumbersIn,
	westernYearsIn,
} from "../../scripts/poc/companyDescription/evidence.ts";
import { companyDescriptionPrompt } from "../../scripts/poc/companyDescription/prompt.ts";
import {
	escapeHtml,
	millions,
	operatingMargin,
} from "../../scripts/poc/companyDescription/render.ts";
import { salvageReply } from "../../scripts/poc/companyDescription/reply.ts";
import {
	isOutOfCredit,
	KEPT_STORED,
	MAX_SEARCH_FAILURES_IN_A_ROW,
	mayReplace,
	NO_BUSINESS_SOURCE,
	NO_SUMMARY,
	recentlyUnreadable,
	SEARCH_PAUSE_MS,
	storeRefusal,
	WebBudget,
} from "../../scripts/poc/companyDescription/runPolicy.ts";
import { groupDigits, issuerOf } from "../../scripts/poc/companyDescription/sources.ts";
import { styleProblems } from "../../scripts/poc/companyDescription/style.ts";
import {
	type CompanyDescription,
	type CompanySource,
	companyDescriptionSchema,
	type Figure,
	type Segment,
	STYLE_RULES,
	type Statement,
	TEMPLATE_LIMITS,
} from "../../scripts/poc/companyDescription/template.ts";
import {
	choosePages,
	cooldownSeconds,
	isJobSiteHost,
	nameWords,
	pageKind,
	registeredLabel,
	withTrailingSlash,
	withWebSources,
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
					totalAmount: null,
					homeAmount: null,
					regions: [],
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

	it("computes each country's share from the quoted table of sales by region", () => {
		// The table form J-Quants-less Japanese sources mostly give (所在地別 売上高, 百万円).
		const table: CompanySource = {
			id: "S4",
			title: { en: "Annual report", ja: "有価証券報告書" },
			publisher: "example.co.jp",
			asOf: null,
			url: "https://www.example.co.jp/ir",
			note: null,
			text: "所在地別売上高 | 日本 | 42,000 | 米国 | 33,000 | 中国 | 15,000 | 欧州 | 10,000 | 計 | 100,000 |",
		};
		const quote = "日本 | 42,000 | 米国 | 33,000 | 中国 | 15,000 | 欧州 | 10,000 | 計 | 100,000";
		const region = (en: string, ja: string, amount: number) => ({
			name: { en, ja },
			percent: null,
			amount,
		});
		const draft = description({
			overseasSales: {
				percent: null,
				totalAmount: 100_000,
				homeAmount: 42_000,
				regions: [
					region("Europe", "欧州", 10_000),
					region("United States", "米国", 33_000),
					region("China", "中国", 15_000),
				],
				evidence: [{ source: "S4", quote }],
			},
		});
		const checked = checkDescription(draft, [...sources, table]);
		expect(describeProblems(checked)).toEqual([]);
		expect(keepVerified(draft, checked).overseasSales).toEqual({
			percent: 58,
			regions: [
				{ name: { en: "United States", ja: "米国" }, percent: 33 },
				{ name: { en: "China", ja: "中国" }, percent: 15 },
				{ name: { en: "Europe", ja: "欧州" }, percent: 10 },
			],
			evidence: [{ source: "S4", quote }],
		});
		// An amount the table does not state fails the field.
		const invented = description({
			overseasSales: {
				...(draft.overseasSales ?? {
					percent: null,
					totalAmount: null,
					homeAmount: null,
					evidence: [],
				}),
				regions: [region("India", "インド", 7_000)],
			},
		});
		expect(describeProblems(checkDescription(invented, [...sources, table]))).toContain(
			"overseasSales: the number 7000 is not in any of its quotes; use null when no source states it.",
		);
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
				hasBusinessText: true,
				sources,
				profile: { listing: "nasdaq", sector: null, fiscalYearEnd: "09-26" },
				cites: { listing: null, sector: null, figures: null },
				figures: [],
			},
			fenceToken: "fence123",
			repairNote: null,
			today: "2026-11-04",
		});
		for (const rule of [...STYLE_RULES.en, ...STYLE_RULES.ja]) {
			expect(prompt).toContain(rule);
		}
		// The limits the reply is checked against, so a long theme label does not cost a turn.
		expect(prompt).toContain(`a theme label at most ${TEMPLATE_LIMITS.maxThemeChars}`);
		expect(prompt).toContain("only a count dated 2023 or later");
	});
});

describe("company description reply salvage (PoC)", () => {
	const statement = {
		en: "Makes soft drink concentrate.",
		ja: "清涼飲料の原液を製造。",
		evidence: [{ source: "S2", quote: "soft drink concentrate" }],
	};

	it("drops only the invalid list items of a reply", () => {
		const salvaged = salvageReply({
			feature: statement,
			businesses: [statement, { en: "", ja: "", evidence: [] }],
			segments: [],
			overseasSales: {
				percent: 140,
				totalAmount: null,
				homeAmount: null,
				regions: [],
				evidence: statement.evidence,
			},
			profile: [],
			themes: [
				{ label: { en: "Sparkling Soft Drinks", ja: "炭酸飲料" }, reason: statement },
				{
					label: { en: "x".repeat(TEMPLATE_LIMITS.maxThemeChars + 1), ja: "長い" },
					reason: statement,
				},
			],
		});
		expect(salvaged?.businesses).toHaveLength(1);
		expect(salvaged?.overseasSales).toBeNull();
		expect(salvaged?.themes.map((theme) => theme.label.en)).toEqual(["Sparkling Soft Drinks"]);
	});

	it("drops an invalid or missing 特色 and keeps the rest of the reply", () => {
		// Haiku leaves 特色 null when no quote supports one (US:AETR, US:ANRO, 2026-11-04).
		for (const feature of [
			null,
			{ en: "", ja: "", evidence: [] },
			{ en: "x", ja: "x", evidence: [] },
		]) {
			const salvaged = salvageReply({ feature, businesses: [statement], themes: [] });
			expect(salvaged?.feature).toBeNull();
			expect(salvaged?.businesses).toEqual([statement]);
			if (salvaged === null) continue;
			const paths = checkDescription(salvaged, []).map((field) => field.path);
			expect(paths).toEqual(["businesses[0]"]);
			expect(keepVerified(salvaged, []).feature).toBeNull();
		}
	});

	it("gives up when the reply is not an object", () => {
		expect(salvageReply(null)).toBeNull();
		expect(salvageReply([statement])).toBeNull();
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
		// Only starts with the name: maybe the company's, maybe a subsidiary's (松竹芸能 for 松竹).
		expect(
			pageKind("https://www.akikawabokuen.com/company/", "AKIKAWA FOODS & FARMS CO.,LTD."),
		).toBe("other");
		expect(pageKind("https://www.shochikugeino.co.jp/company", "SHOCHIKU CO.,LTD.")).toBe("other");
		expect(pageKind("https://www.sec.gov/cgi-bin/browse-edgar", "Apple Inc.")).toBe("regulator");
		expect(pageKind("https://www.jpx.co.jp/listing/", "X")).toBe("regulator");
		expect(pageKind("https://www.reuters.com/company/ko", "COCA COLA CO")).toBe("other");
		expect(pageKind("https://ir.toyota.co.jp/", "TOYOTA MOTOR CORPORATION")).toBe("official");
		expect(pageKind("https://www.toyota-global.com/", "TOYOTA MOTOR CORPORATION")).toBe("official");
	});

	it("reads a site named after the Japanese name as the company's own", () => {
		// スバル興業 (Subaru Enterprise) is subaru-kougyou.jp; every page was refused (2026-11-04).
		const url = "https://subaru-kougyou.jp/company/";
		expect(pageKind(url, "Subaru Enterprise Co.,Ltd.", "スバル興業")).toBe("official");
		expect(pageKind(url, "Subaru Enterprise Co.,Ltd.")).toBeNull();
		// Not SUBARU's: its Japanese name has no 興業.
		expect(pageKind(url, "SUBARU CORPORATION", "SUBARU")).toBeNull();
		expect(
			pageKind("https://www.toyota-shoji.co.jp/", "TOYOTA MOTOR CORPORATION", "トヨタ自動車"),
		).toBeNull();
	});

	it("never reads a family company's site as the company's own", () => {
		// トヨタ車体 and トヨタ自動車東日本 came back for トヨタ自動車 (2026-11-03).
		for (const url of [
			"https://www.toyota-body.co.jp/corporate/profile",
			"https://www.toyota-ej.co.jp/company/profile/",
		]) {
			expect(pageKind(url, "TOYOTA MOTOR CORPORATION")).toBeNull();
		}
	});

	it("adds the slash a refused trailing-slash redirect wanted, only to a directory path", () => {
		expect(withTrailingSlash("https://www.taiheiyo-cement.co.jp/company")).toBe(
			"https://www.taiheiyo-cement.co.jp/company/",
		);
		expect(withTrailingSlash("https://www.example.co.jp/company/")).toBeNull();
		expect(withTrailingSlash("https://www.example.co.jp/company/index.html")).toBeNull();
		expect(withTrailingSlash("not a url")).toBeNull();
	});

	it("reads how long a paused search waits", () => {
		expect(
			cooldownSeconds(
				"The search service is rate limited or unavailable. … this search is paused for 60 seconds.",
			),
		).toBe(60);
		expect(cooldownSeconds("paused for 125 seconds")).toBe(125);
		expect(cooldownSeconds("unavailable")).toBe(60);
	});

	it("finds the registered name under a country's second level", () => {
		expect(registeredLabel("ir.toyota.co.jp")).toBe("toyota");
		expect(registeredLabel("www.toyota.jp")).toBe("toyota");
		expect(registeredLabel("www.coca-colacompany.com")).toBe("coca-colacompany");
	});

	it("never uses Wikipedia, social media, forums, 四季報's site or plain http", () => {
		for (const url of [
			"https://ja.wikipedia.org/wiki/秋川牧園",
			"https://x.com/apple",
			"https://www.reddit.com/r/stocks",
			"https://detail.chiebukuro.yahoo.co.jp/qa/1",
			"https://shikiho.toyokeizai.net/stocks/1380",
			"https://tavily.com/knowledge/company/nRbj17LFf8vs",
			"https://job.mynavi.jp/28/pc/search/corp16/outline.html",
			"http://www.akikawabokuen.com/",
		]) {
			expect(pageKind(url, "AKIKAWA FOODS & FARMS")).toBeNull();
		}
	});

	it("chooses acceptable pages, official first, each once, up to the limit", () => {
		const chosen = choosePages(
			[
				{ url: "https://ja.wikipedia.org/wiki/x" },
				{ url: "https://www.reuters.com/company/ko" },
				{ url: "https://www.coca-colacompany.com/about-us" },
				{ url: "https://www.coca-colacompany.com/about-us" },
				{ url: "https://www.sec.gov/x" },
				{ url: "https://example.com/a" },
			],
			"COCA COLA CO",
			3,
		);
		expect(chosen).toEqual([
			{ url: "https://www.coca-colacompany.com/about-us", kind: "official" },
			{ url: "https://www.sec.gov/x", kind: "regulator" },
			{ url: "https://www.reuters.com/company/ko", kind: "other" },
		]);
	});
});

describe("pages found by the Haiku agent (PoC, ADR-0064)", () => {
	it("treats a trailing slash, a fragment and host case as the same page", () => {
		expect(samePageKey("https://WWW.Example.co.jp/company/#top")).toBe(
			samePageKey("https://www.example.co.jp/company"),
		);
		expect(samePageKey("not a url")).toBeNull();
	});

	it("keeps only the picked URLs that were search results, in the agent's order", () => {
		const results = [
			"https://kitaishihon.com/company/7433/business",
			"https://www.example.co.jp/company/",
			"https://irbank.net/E02802",
			"https://jobhakase.com/x",
		];
		const picked = [
			"https://www.example.co.jp/company",
			// Written from memory: never read.
			"https://www.example.co.jp/ir/",
			"https://irbank.net/E02802",
		];
		// Results the agent passed over (a job site here) are not read either.
		expect(pagesFromResults(picked, results)).toEqual([
			"https://www.example.co.jp/company/",
			"https://irbank.net/E02802",
		]);
	});
});

describe("claim check (PoC, ADR-0064 §5d)", () => {
	it("names the terms a field must not invent: katakana and Latin names, capitalised English words", () => {
		expect(claimTerms("トヨタグループの繊維メーカー。Lumadaを展開", true)).toEqual([
			"トヨタグループ",
			"Lumada",
		]);
		expect(
			claimTerms("Sells concentrate to Coca-Cola bottlers. The company is in Japan.", false),
		).toEqual(["Coca-Cola"]);
	});

	it("checks the name in a hyphenated word, not the whole word", () => {
		expect(claimTerms("A Bermuda-based life insurer.", false)).toEqual(["Bermuda"]);
		expect(claimTerms("Bermuda-based の生命保険会社。e-commerce", true)).toEqual([
			"Bermuda",
			"e-commerce",
		]);
	});

	it("matches a quote of a markdown link's text and reads spelled-out numbers", () => {
		// Pages read by Claude's web fetch are markdown (US:AEG, 2026-11-04).
		expect(normalizeForQuote("is [World Financial Group](https://wfg.example/), an")).toBe(
			"is world financial group, an",
		);
		expect(quotedNumbersIn("consists of four global platforms, 2 of them new")).toEqual([2, 4]);
		const source: CompanySource = {
			id: "S2",
			title: { en: "About", ja: "会社概要" },
			publisher: "aegon.com",
			asOf: null,
			url: "https://www.aegon.com/about",
			note: null,
			text: "Aegon AM consists of four global investment platforms. Sold through [World Financial Group](https://www.worldfinancialgroup.com/).",
		};
		const checked = checkDescription(
			description({
				businesses: [
					{
						en: "Runs four investment platforms, sold through World Financial Group.",
						ja: "4つの運用プラットフォームを展開。World Financial Groupで販売。",
						evidence: [
							{ source: "S2", quote: "consists of four global investment platforms" },
							{ source: "S2", quote: "Sold through World Financial Group" },
						],
					},
				],
			}),
			[...sources, source],
		);
		expect(describeProblems(checked)).toEqual([]);
	});

	it("reads Japanese-era years as Western ones", () => {
		expect(westernYearsIn("1930（昭和5年）設立、平成元年に上場")).toEqual([1930, 1989]);
	});

	it("rejects a name that is in none of the field's quotes or cited sources", () => {
		const source: CompanySource = {
			id: "S4",
			title: { en: "Profile", ja: "会社概要" },
			publisher: "example.co.jp",
			asOf: null,
			url: "https://www.example.co.jp/",
			note: null,
			text: "自動車用シートと内装品を製造・販売。航空機シートも手がける。1918（大正7）年創業。",
		};
		const draft: CompanyDescription = {
			feature: {
				en: "Toyota group maker of seats.",
				ja: "トヨタグループのシートメーカー。",
				evidence: [{ source: "S4", quote: "自動車用シートと内装品を製造・販売" }],
			},
			businesses: [
				{
					en: "Makes seats; also aircraft seats.",
					ja: "自動車用シートを製造。航空機シートも手がける。",
					evidence: [{ source: "S4", quote: "自動車用シートと内装品を製造・販売" }],
				},
			],
			segments: [],
			overseasSales: null,
			profile: [],
			themes: [],
		};
		const problems = checkDescription(draft, [source]);
		expect(problems[0]?.problems).toEqual([{ kind: "unquoted-term", term: "トヨタグループ" }]);
		// 航空機シート is not in the quote but in the cited source: accepted.
		expect(problems[1]?.problems).toEqual([]);
	});
});

describe("style check (PoC)", () => {
	it("asks for a repair on banned phrases the source does not use, and on 'The company' openings", () => {
		const source: CompanySource = {
			id: "S2",
			title: { en: "10-K", ja: "10-K" },
			publisher: "SEC",
			asOf: null,
			url: "https://www.sec.gov/",
			note: null,
			text: "We are a leading maker of concentrate.",
		};
		const statement = (en: string, ja: string) => ({
			en,
			ja,
			evidence: [{ source: "S2", quote: "maker of concentrate" }],
		});
		const draft: CompanyDescription = {
			feature: statement("The company makes concentrate.", "原液を製造。"),
			businesses: [statement("A leading maker of concentrate.", "幅広い製品を通じて原液を製造。")],
			segments: [],
			overseasSales: null,
			profile: [],
			themes: [],
		};
		const problems = styleProblems(draft, [source]);
		expect(
			problems.some((line) => line.startsWith('feature: the English starts with "The company"')),
		).toBe(true);
		// "leading" is the source's own word: allowed.
		expect(problems.some((line) => line.includes('"leading"'))).toBe(false);
		expect(problems.filter((line) => line.startsWith("businesses[0]"))).toHaveLength(2);
	});
});

describe("job and recruiting sites (PoC)", () => {
	it("are recognised by their host names", () => {
		expect(isJobSiteHost("mid-tenshoku.com")).toBe(true);
		expect(isJobSiteHost("www.careermap.jp")).toBe(true);
		expect(isJobSiteHost("recruit-d.kyoritsugroup.co.jp")).toBe(true);
		expect(isJobSiteHost("recruit.tokyu-fudosan-hd.co.jp")).toBe(true);
		// Recruit Holdings' own site is not a recruiting page.
		expect(isJobSiteHost("recruit-holdings.com")).toBe(false);
		expect(isJobSiteHost("www.toyota.co.jp")).toBe(false);
		expect(pageKind("https://www.nikkei.com/nkd/company/gaiyo?scode=4188", "X")).toBeNull();
	});
});

describe("run policy (PoC)", () => {
	const stock = {
		stock: { market: "JP" as const, symbol: "3116" },
		name: { en: "TOYOTA BOSHOKU", ja: "トヨタ紡織" },
		hasBusinessText: false,
		sources,
		profile: { listing: "prime", sector: null, fiscalYearEnd: "03-31" },
		// S1 is the fixture's 10-K text: a business source, not a record.
		cites: { listing: null, sector: null, figures: null },
		figures: [],
	};
	const statement = {
		en: "Makes seats.",
		ja: "シートを製造。",
		evidence: [{ source: "S1", quote: "seats" }],
	};
	const entry = {
		feature: statement,
		businesses: [statement],
		segments: [],
		overseasSales: null,
		profile: [],
		themes: [],
	};

	it("does not store an entry without 事業内容 when a source describes the business", () => {
		expect(storeRefusal(entry, stock)).toBeNull();
		expect(storeRefusal({ ...entry, businesses: [] }, stock)).toBe(NO_SUMMARY);
	});

	it("replaces a stored entry only with one at least as full that keeps 事業内容", () => {
		expect(mayReplace(entry, null)).toBe(true);
		expect(mayReplace({ ...entry, businesses: [] }, entry)).toBe(false);
		expect(mayReplace({ ...entry, feature: null }, entry)).toBe(false);
		expect(mayReplace(entry, { ...entry, feature: null })).toBe(true);
		expect(KEPT_STORED).toContain("kept");
	});

	it("leaves out for 30 days only stocks this provider searched without a usable result", () => {
		const now = Date.parse("2026-11-04T00:00:00Z");
		const line = (stock: string, searchedWith: string | null, error: string | null) =>
			JSON.stringify({ at: "2026-11-03T00:00:00Z", stock, searched: true, searchedWith, error });
		const log = [
			line("JP:1", "claude", NO_BUSINESS_SOURCE),
			line("JP:2", null, NO_BUSINESS_SOURCE),
			line("JP:3", "claude", null),
			'{"at": "2026-11-03T0', // cut off mid-write
		].join("\n");
		expect([...recentlyUnreadable(log, now, "claude")]).toEqual(["JP:1"]);
		expect([...recentlyUnreadable(log, now, "tavily")]).toEqual(["JP:2"]);
		expect(recentlyUnreadable(log, now + 31 * 86_400_000, "claude").size).toBe(0);
	});

	it("pauses searches after a run of failures instead of turning them off", async () => {
		let now = 0;
		const budget = new WebBudget(true, () => now);
		for (let index = 0; index < MAX_SEARCH_FAILURES_IN_A_ROW; index += 1) {
			budget.record({ code: "HTTP 529", detail: "overloaded" });
		}
		expect(budget.enabled).toBe(true);
		expect(budget.paused()).toBe(true);
		const slept: number[] = [];
		const ready = await budget.ready(async (ms) => {
			slept.push(ms);
			now += ms;
		});
		expect(ready).toBe(true);
		expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(SEARCH_PAUSE_MS);
		budget.record({ code: "HTTP 400", detail: "Your credit balance is too low" });
		expect(budget.enabled).toBe(false);
		expect(budget.exhaustedBy).toBe("HTTP 400 Your credit balance is too low");
	});

	it("stops the run on a model turn the account cannot pay for", () => {
		expect(isOutOfCredit("PROVIDER_PAYMENT_REQUIRED (HTTP 400)")).toBe(true);
		expect(isOutOfCredit("PROVIDER_REQUEST_REJECTED (HTTP 400)")).toBe(false);
		expect(isOutOfCredit("PROVIDER_RATE_LIMITED (HTTP 429)")).toBe(false);
	});
});

describe("listings that are not companies (PoC, ADR-0064 §5e)", () => {
	it("finds the issuer of a preferred share, warrant, unit or right when it is listed", () => {
		const listed = new Set(["US:AHL", "US:AAC", "JP:7203"]);
		expect(issuerOf({ market: "US", symbol: "AHL-PD" }, listed)).toEqual({
			market: "US",
			symbol: "AHL",
		});
		expect(issuerOf({ market: "US", symbol: "AAC-WT" }, listed)?.symbol).toBe("AAC");
		// No listed issuer, a common stock, a Japanese code: written on their own.
		expect(issuerOf({ market: "US", symbol: "BML-PH" }, listed)).toBeNull();
		expect(issuerOf({ market: "US", symbol: "AHL" }, listed)).toBeNull();
		expect(issuerOf({ market: "JP", symbol: "7203" }, listed)).toBeNull();
	});
});

describe("web fetch fallback (PoC, ADR-0064 §2c)", () => {
	it("drops the fetched text's metadata header and table padding", () => {
		expect(
			cleanFetchedText(
				"---\ncanonical: https://x\ntitle: 会社情報\n---\n\n| 社名    | 第一三共 |\n|-------|----|\n",
			),
		).toBe("| 社名 | 第一三共 |\n|");
	});

	const stock = {
		stock: { market: "JP" as const, symbol: "4568" },
		name: { en: "DAIICHI SANKYO COMPANY,LIMITED", ja: "第一三共" },
		hasBusinessText: false,
		sources: [],
		profile: { listing: "prime", sector: null, fiscalYearEnd: "03-31" },
		cites: { listing: null, sector: null, figures: null },
		figures: [],
	};
	const failingFetch = (code: string): ToolDefinition => ({
		toolId: "web.fetch_page",
		version: "test",
		description: "test",
		argsSchema: z.unknown(),
		argsHint: "",
		timeoutMs: 1_000,
		permission: "research-read",
		costCategory: "free",
		sideEffect: "none",
		networkAllowlist: { kind: "public-web" },
		execute: async () => ({ ok: false, error: { code, detail: code, retryable: false } }),
	});
	const urls = ["https://www.daiichisankyo.co.jp/about_us/corporate_info/"];
	const findPages = async () => ({
		ok: true as const,
		urls,
		order: "as-given" as const,
		costUsd: 0.01,
	});
	const read: string[] = [];
	const fallbackRead = async (url: string) => {
		read.push(url);
		return {
			ok: true as const,
			url,
			title: "会社情報",
			text: "医薬品の研究開発、製造、販売。".repeat(20),
			retrievedAt: "2026-11-04T00:48:39Z",
			costUsd: 0.001,
		};
	};

	it("reads a page the runner's fetcher could not, through the web fetch tool", async () => {
		read.length = 0;
		const result = await withWebSources(stock, findPages, failingFetch("HTTP_ERROR"), fallbackRead);
		expect(read).toEqual(urls);
		expect(result.stock.sources).toHaveLength(1);
		expect(result.stock.sources[0]?.url).toBe(urls[0]);
		expect(result.costUsd).toBeCloseTo(0.011);
	});

	it("never reads a page robots.txt refuses, or a PDF, that way", async () => {
		for (const code of ["ROBOTS_DISALLOWED", "UNSUPPORTED_CONTENT_TYPE", "UNSAFE_URL"]) {
			read.length = 0;
			const result = await withWebSources(stock, findPages, failingFetch(code), fallbackRead);
			expect(read).toEqual([]);
			expect(result.stock.sources).toHaveLength(0);
		}
	});
});
