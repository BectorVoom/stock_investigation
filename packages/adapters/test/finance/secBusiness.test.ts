/**
 * "Item 1. Business" of a 10-K (ADR-0053 §3) over small synthetic Markdown
 * documents, each in one shape seen on live 10-Ks (2026-11-01): Apple's
 * plain heading after a table of contents, Amazon's heading as a table row,
 * Microsoft's running page headers, Amazon's and Coca-Cola's preamble before
 * the first subheading, and a document without the section.
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
	])("marks %s as the start", (text) => {
		expect(secSectionMark(text)).toBe("start");
	});

	it.each([
		"Item 1A",
		"ITEM 1A. RISK FACTORS",
		"Item 1B. Unresolved Staff Comments",
		"Item 1C. Cybersecurity",
		"Item 2. Properties",
		"Item 3. Legal Proceedings",
	])("marks %s as an end", (text) => {
		expect(secSectionMark(text)).toBe("end");
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
		expect(secSectionMark(text)).toBe("other");
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
		expect(secBusinessParagraphs(markdown)).toEqual({
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
		expect(secBusinessParagraphs(markdown).paragraphs).toEqual([
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
		expect(secBusinessParagraphs(markdown).paragraphs).toEqual([
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
		expect(secBusinessBlocks(two(terms))).toEqual(["General", DESCRIBES]);
		expect(secBusinessBlocks(two(terms, MORE))).toEqual(["General", DESCRIBES]);
		// Three paragraphs before the first subheading are the description itself.
		expect(secBusinessBlocks(two(terms, MORE, RISK))).toEqual([
			terms,
			MORE,
			RISK,
			"General",
			DESCRIBES,
		]);
		// A list marker and its item are one paragraph.
		expect(secBusinessBlocks(two(terms, "•", MORE))).toEqual(["General", DESCRIBES]);
		// A marker after a marker replaces it: still one paragraph.
		expect(secBusinessBlocks(two(terms, "•", "•", MORE))).toEqual(["General", DESCRIBES]);
		expect(secBusinessBlocks(two(terms, "•", MORE, RISK))).toEqual([
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
			secBusinessBlocks(doc("Item 1. Business", "Overview", long, "Item 2. Properties")),
		).toEqual(["Overview", long]);
	});

	it("reads Items 1 and 2 to Item 3", () => {
		const markdown = doc(
			"Items 1 and 2. Business and Properties",
			"Overview",
			DESCRIBES,
			"Item 3. Legal Proceedings",
		);
		expect(secBusinessParagraphs(markdown).paragraphs).toHaveLength(2);
	});

	it("finds nothing without the section, with an empty one, or without an end", () => {
		const none = { paragraphs: [], truncated: false };
		expect(secBusinessParagraphs(doc("Overview", DESCRIBES, "Item 1A. Risk Factors"))).toEqual(
			none,
		);
		expect(secBusinessParagraphs(doc("Item 1. Business", "Item 1A. Risk Factors", RISK))).toEqual(
			none,
		);
		expect(secBusinessParagraphs(doc("Item 1. Business", "Overview", DESCRIBES))).toEqual(none);
		// Only headings and furniture: nothing describes the business.
		expect(
			secBusinessParagraphs(doc("Item 1. Business", "Overview", "3", "Item 1A. Risk Factors")),
		).toEqual(none);
		expect(secBusinessParagraphs("")).toEqual(none);
	});

	it("keeps the leading paragraphs within the stored-text limit", () => {
		const paragraph = `${"The Company makes instruments. ".repeat(30)}End.`;
		const body = Array.from({ length: 40 }, () => paragraph);
		const result = secBusinessParagraphs(
			doc("Item 1. Business", "Overview", ...body, "Item 1A. Risk Factors"),
		);
		expect(result.truncated).toBe(true);
		const total = result.paragraphs.reduce((sum, entry) => sum + entry.text.length, 0);
		expect(total).toBeLessThanOrEqual(BUSINESS_DESCRIPTION_LIMITS.maxStoredChars);
		expect(result.paragraphs[0]).toEqual({ kind: "heading", text: "Overview" });
	});
});
