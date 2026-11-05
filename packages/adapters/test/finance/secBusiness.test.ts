/**
 * "Item 1. Business" of a 10-K (ADR-0053 §3) over small synthetic Markdown
 * documents, each in one shape seen on live 10-Ks (2026-11-01): Apple's
 * plain heading after a table of contents, Amazon's heading as a table row,
 * Microsoft's running page headers, Amazon's and Coca-Cola's preamble before
 * the first subheading, and a document without the section. Then a 20-F's
 * Item 4.B "Business Overview" (ADR-0058 §5), in the shapes of the Form 20-F
 * instructions (Item 4.A–4.D, Item 4A): the sub-item first, Item 4 only
 * without it, and a primary document that only cross-references an
 * annual-report exhibit (not found).
 */
import { BUSINESS_DESCRIPTION_LIMITS } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	secBlock,
	secBusinessBlocks,
	secBusinessParagraphs,
	secSectionMark,
} from "../../src/finance/secBusiness.ts";

const doc = (...blocks: string[]) => blocks.join("\n\n");

const DESCRIBES =
	"The Company designs, manufactures and sells laboratory instruments and related services.";
const MORE = "The Company sells its instruments directly and through distributors in 40 countries.";
const RISK = "The Company's business can be affected by many factors outside its control.";

describe("secBlock", () => {
	it("joins a table's cells without its separator row, and strips heading and bold markers", () => {
		expect(secBlock("| Item 1. | Business |\n| --- | --- |")).toEqual({
			text: "Item 1. Business",
			table: true,
		});
		expect(secBlock("|  | **Item 1A.** |  | Risk  Factors | 12 |")).toEqual({
			text: "Item 1A. Risk Factors 12",
			table: true,
		});
		expect(secBlock("## **Item 1. Business**")).toEqual({
			text: "Item 1. Business",
			table: false,
		});
		expect(secBlock("A line\nwith __two__ lines")).toEqual({
			text: "A line with two lines",
			table: false,
		});
	});
});

describe("secSectionMark", () => {
	it.each([
		"Item 1. Business",
		"ITEM 1. BUSINESS",
		"Item 1. Business.",
		"Item 1 Business",
		"Item 1 — Business",
		"Item 1: Business Overview",
		"Items 1 and 2. Business and Properties",
		"Items 1. and 2. Business and Properties.",
		"Item 1. *Business*",
		"*Item 1. Business*",
	])("marks %s as the start", (text) => {
		expect(secSectionMark(text, "10-K item 1")).toBe("start");
	});

	it.each([
		"Item 1A",
		"ITEM 1A. RISK FACTORS",
		"Item 1B. Unresolved Staff Comments",
		"Item 1C. Cybersecurity",
		"Item 2. Properties",
		"Item 3. Legal Proceedings",
	])("marks %s as an end", (text) => {
		expect(secSectionMark(text, "10-K item 1")).toBe("end");
	});

	it.each([
		"Item 1",
		"Item 12. Business Combinations",
		"Item 20",
		"Item 4. Mine Safety Disclosures",
		`Item 1. Business ${"x".repeat(60)}`,
		`Item 2. ${"Properties ".repeat(12)}`,
		"The Company's business is described in Item 1. Business.",
	])("marks %s as other", (text) => {
		expect(secSectionMark(text, "10-K item 1")).toBe("other");
	});
});

describe("secBusinessParagraphs", () => {
	it("skips the table of contents and reads the body section (Apple)", () => {
		const markdown = doc(
			"FORM 10-K",
			"Item 1. Business",
			"Item 1A. Risk Factors",
			"Item 2. Properties",
			"This Annual Report on Form 10-K contains forward-looking statements that involve risks.",
			"PART I",
			"Item 1. Business",
			"Company Background",
			DESCRIBES,
			"Products",
			MORE,
			"Item 1A. Risk Factors",
			RISK,
		);
		expect(secBusinessParagraphs(markdown, "10-K")).toEqual({
			paragraphs: [
				{ kind: "heading", text: "Company Background" },
				{ kind: "text", text: DESCRIBES },
				{ kind: "heading", text: "Products" },
				{ kind: "text", text: MORE },
			],
			truncated: false,
		});
	});

	it("finds a heading written as a table row and drops the preamble (Amazon)", () => {
		const markdown = doc(
			"| Item 1. | Business | 3 |\n| --- | --- | --- |\n| Item 1A. | Risk Factors | 6 |",
			"PART I",
			"| Item 1. | Business |\n| --- | --- |",
			"This Annual Report on Form 10-K and the documents incorporated herein by reference contain forward-looking statements.",
			"General",
			DESCRIBES,
			"| Segment | Share |\n| --- | --- |\n| North America | 60% |",
			MORE,
			"| Item 1A. | Risk Factors |\n| --- | --- |",
			RISK,
		);
		expect(secBusinessParagraphs(markdown, "10-K").paragraphs).toEqual([
			{ kind: "heading", text: "General" },
			{ kind: "text", text: DESCRIBES },
			{ kind: "text", text: MORE },
		]);
	});

	it("drops running page headers, footers, page numbers and breaks (Microsoft)", () => {
		const markdown = doc(
			"PART I",
			"Item 1",
			"Note About Forward-Looking Statements",
			"This report includes estimates, projections and statements that are forward-looking.",
			"PART I",
			"ITEM 1. BUSINESS",
			"GENERAL",
			DESCRIBES,
			"Synthetic Devices Inc. | 2025 Form 10-K | 3",
			"3",
			"---",
			"PART I",
			"Item 1",
			"Table of Contents",
			MORE,
			"•",
			"Calibration on site.",
			"PART I",
			"Item 1A",
			"ITEM 1A. RISK FACTORS",
			RISK,
		);
		expect(secBusinessParagraphs(markdown, "10-K").paragraphs).toEqual([
			{ kind: "heading", text: "GENERAL" },
			{ kind: "text", text: DESCRIBES },
			{ kind: "text", text: MORE },
			{ kind: "text", text: "• Calibration on site." },
		]);
	});

	it("drops text before the first subheading only when it is the second or third paragraph (Coca-Cola)", () => {
		const terms =
			"In this report, the terms “Company,” “we” and “our” mean the Company and its subsidiaries.";
		const two = (...preamble: string[]) =>
			doc("ITEM 1. BUSINESS", ...preamble, "General", DESCRIBES, "ITEM 1A. RISK FACTORS");
		expect(secBusinessBlocks(two(terms), "10-K")).toEqual(["General", DESCRIBES]);
		expect(secBusinessBlocks(two(terms, MORE), "10-K")).toEqual(["General", DESCRIBES]);
		// Three paragraphs before the first subheading are the description itself.
		expect(secBusinessBlocks(two(terms, MORE, RISK), "10-K")).toEqual([
			terms,
			MORE,
			RISK,
			"General",
			DESCRIBES,
		]);
		// A list marker and its item are one paragraph.
		expect(secBusinessBlocks(two(terms, "•", MORE), "10-K")).toEqual(["General", DESCRIBES]);
		// A marker after a marker replaces it: still one paragraph.
		expect(secBusinessBlocks(two(terms, "•", "•", MORE), "10-K")).toEqual(["General", DESCRIBES]);
		expect(secBusinessBlocks(two(terms, "•", MORE, RISK), "10-K")).toEqual([
			terms,
			"•",
			MORE,
			RISK,
			"General",
			DESCRIBES,
		]);
	});

	it("keeps a short footer-like line without Form 10-K, and a long one that names it", () => {
		const long = `Our annual report on Form 10-K is available free of charge on our website, together with every quarterly report.`;
		expect(
			secBusinessBlocks(doc("Item 1. Business", "Overview", long, "Item 2. Properties"), "10-K"),
		).toEqual(["Overview", long]);
	});

	it("reads Items 1 and 2 to Item 3", () => {
		const markdown = doc(
			"Items 1 and 2. Business and Properties",
			"Overview",
			DESCRIBES,
			"Item 3. Legal Proceedings",
		);
		expect(secBusinessParagraphs(markdown, "10-K").paragraphs).toHaveLength(2);
	});

	it("reads a start heading split into a bare Item 1. and Business (Capital City Bank Group)", () => {
		const markdown = doc(
			"Item 1. Business",
			"Item 1A. Risk Factors",
			"PART I",
			"Item 1.",
			"Business",
			"Overview",
			DESCRIBES,
			"Item 1A.",
			"Risk Factors",
			RISK,
		);
		expect(secBusinessBlocks(markdown, "10-K")).toEqual(["Overview", DESCRIBES]);
		// Only "Business" (or "Business.") right after a bare "Item 1." starts it: a longer
		// body after a lookalike is not read while the 10-K has an Item 1 heading.
		const longer = `${DESCRIBES} ${DESCRIBES} ${DESCRIBES}`;
		for (const lookalike of [
			["Item 1.", "Businesses"],
			["Item 2.", "Business"],
		]) {
			const markdown = doc(
				"Item 1. Business",
				DESCRIBES,
				"Item 1A",
				...lookalike,
				longer,
				"Item 2",
			);
			expect(secBusinessBlocks(markdown, "10-K"), lookalike.join(" ")).toEqual([DESCRIBES]);
		}
	});

	it("reads a 10-K that writes its item numbers only in the table of contents (Morgan Stanley)", () => {
		const markdown = doc(
			"| Table of Contents | Part | Item | Page |",
			"| --- | --- | --- | --- |",
			"| Business | I | 1 | 5 |",
			"| Business |  |  |",
			"Business",
			"Overview",
			DESCRIBES,
			"Risk Factors",
			RISK,
		);
		expect(secBusinessBlocks(markdown, "10-K")).toEqual(["Overview", DESCRIBES]);
		// Not while the 10-K has an Item 1 heading, and never at a table row.
		expect(
			secBusinessBlocks(
				doc("Item 1. Business", RISK, "Item 1A", "Business", DESCRIBES, "Risk Factors"),
				"10-K",
			),
		).toEqual([RISK]);
		expect(secBusinessBlocks(doc("| Business |", DESCRIBES, "Risk Factors"), "10-K")).toBe(null);
	});

	it("reads Item 1 headed after Part I, with a pipe, or as Description of Business", () => {
		for (const heading of [
			"Part I. Item 1. Business",
			"ITEM 1 | Business",
			"| Item 1. | Description of Business |",
		]) {
			const markdown = doc(heading, DESCRIBES, heading, RISK, "Part I. Item 1A. Risk Factors");
			// The heading repeated as a running page header is not description.
			expect(secBusinessBlocks(markdown, "10-K"), heading).toEqual([DESCRIBES, RISK]);
		}
		expect(secSectionMark("Part II. Item 1. Business", "10-K item 1")).toBe("other");
		expect(secSectionMark("Item 1. Description of Properties", "10-K item 1")).toBe("other");
	});

	it("finds nothing without the section, with an empty one, or without an end", () => {
		const none = { paragraphs: [], truncated: false };
		const tenK = (markdown: string) => secBusinessParagraphs(markdown, "10-K");
		expect(tenK(doc("Overview", DESCRIBES, "Item 1A. Risk Factors"))).toEqual(none);
		expect(tenK(doc("Item 1. Business", "Item 1A. Risk Factors", RISK))).toEqual(none);
		expect(tenK(doc("Item 1. Business", "Overview", DESCRIBES))).toEqual(none);
		// Only headings and furniture: nothing describes the business.
		expect(tenK(doc("Item 1. Business", "Overview", "3", "Item 1A. Risk Factors"))).toEqual(none);
		expect(tenK("")).toEqual(none);
	});

	it("keeps the leading paragraphs within the stored-text limit", () => {
		const paragraph = `${"The Company makes instruments. ".repeat(30)}End.`;
		const body = Array.from({ length: 40 }, () => paragraph);
		const result = secBusinessParagraphs(
			doc("Item 1. Business", "Overview", ...body, "Item 1A. Risk Factors"),
			"10-K",
		);
		expect(result.truncated).toBe(true);
		const total = result.paragraphs.reduce((sum, entry) => sum + entry.text.length, 0);
		expect(total).toBeLessThanOrEqual(BUSINESS_DESCRIPTION_LIMITS.maxStoredChars);
		expect(result.paragraphs[0]).toEqual({ kind: "heading", text: "Overview" });
	});
});

describe("a 20-F's Item 4.B (ADR-0058 §5)", () => {
	const OVERVIEW = "The Group is a global mining company producing iron ore, copper and aluminium.";
	const HISTORY = "The Company was incorporated in 1873 and has been listed in London since 1905.";

	it.each([
		["Item 4.B Business Overview", "20-F item 4B"],
		["ITEM 4.B. BUSINESS OVERVIEW", "20-F item 4B"],
		["4B. Business overview", "20-F item 4B"],
		["B. Business Overview", "20-F item 4B"],
		["Item 4. B. Business Overview", "20-F item 4B"],
		["Item 4. Information on the Company", "20-F item 4"],
		["ITEM 4 — INFORMATION ON THE COMPANY", "20-F item 4"],
		["Item 4. Information On Our Company", "20-F item 4"],
	] as const)("marks %s as the start of %s", (text, section) => {
		expect(secSectionMark(text, section)).toBe("start");
	});

	it.each([
		"Item 4.C Organizational Structure",
		"4.D Property, plants and equipment",
		"C. Organisational structure",
		"D. Property, Plants and Equipment",
		"Item 4A. Unresolved Staff Comments",
		"Item 5. Operating and Financial Review and Prospects",
	])("marks %s as an end", (text) => {
		expect(secSectionMark(text, "20-F item 4B")).toBe("end");
		expect(secSectionMark(text, "20-F item 4")).toBe("end");
	});

	it.each([
		"Item 4",
		"Item 4.A History and Development of the Company",
		"Item 1. Business",
		"Item 1A. Risk Factors",
		"Business Overview",
		"B. Business Overviews",
		"Item 40",
	])("marks %s as other for 4.B", (text) => {
		expect(secSectionMark(text, "20-F item 4B")).toBe("other");
	});

	it("reads Item 4.B, not Item 4's history, and drops 20-F furniture", () => {
		const markdown = doc(
			"Item 4. Information on the Company",
			"Item 4.B Business Overview",
			"Item 4.C Organizational Structure",
			"PART I",
			"Item 4. Information on the Company",
			"A. History and Development of the Company",
			HISTORY,
			"B. Business Overview",
			"Item 4",
			"Overview",
			OVERVIEW,
			"Synthetic Mining plc | 2024 Form 20-F | 31",
			"31",
			MORE,
			"C. Organizational Structure",
			"The Group's principal subsidiaries are listed in Exhibit 8.1.",
		);
		expect(secBusinessParagraphs(markdown, "20-F")).toEqual({
			paragraphs: [
				{ kind: "heading", text: "Overview" },
				{ kind: "text", text: OVERVIEW },
				{ kind: "text", text: MORE },
			],
			truncated: false,
		});
		// A 10-K reading finds no Item 1 in a 20-F.
		expect(secBusinessParagraphs(markdown, "10-K").paragraphs).toEqual([]);
	});

	it("reads Item 4 when the document has no Item 4.B heading", () => {
		const markdown = doc(
			"Item 4. Information on the Company",
			"Overview",
			OVERVIEW,
			"Item 4A. Unresolved Staff Comments",
			"None.",
		);
		expect(secBusinessBlocks(markdown, "20-F")).toEqual(["Overview", OVERVIEW]);
	});

	it("finds nothing when Item 4.B only incorporates an annual-report exhibit by reference", () => {
		const markdown = doc(
			"Item 4.B Business Overview",
			"The information set forth under the heading “Strategic report — Our business” on pages 12 to 45 of the 2024 Annual Report, included as Exhibit 15.1, is incorporated herein by reference.",
			"| Item 4.B | Business overview | Annual Report pages 12–45 |",
			"Item 4.C Organizational Structure",
		);
		expect(secBusinessParagraphs(markdown, "20-F")).toEqual({ paragraphs: [], truncated: false });
	});
});

describe("annual-report layouts with a 10-K cross-reference index", () => {
	it.each([
		"ABOUT HONEYWELL",
		"OUR BUSINESS",
		"BUSINESS SUMMARY",
		"ABOUT GE AEROSPACE.",
	])("reads %s and stops before MD&A", (heading) => {
		const embedded = heading.endsWith(".");
		const text = [
			"| Item 1. | Business | 4 |\n| --- | --- | --- |\n| Item 1A. | Risk Factors | 20 |",
			embedded ? `${heading} ${DESCRIBES}` : heading,
			...(embedded ? [] : [DESCRIBES]),
			MORE,
			"MANAGEMENT’S DISCUSSION AND ANALYSIS. Results follow.",
			RISK,
		].join("\n\n");
		const result = secBusinessParagraphs(text, "10-K");
		expect(result.paragraphs.map((p) => p.text)).toEqual([DESCRIBES, MORE]);
	});
});
