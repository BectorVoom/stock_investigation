import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BUSINESS_DESCRIPTION_LIMITS,
	type BusinessParagraph,
	businessParagraphKind,
	businessParagraphs,
	businessSectionBounds,
	businessSummaryCount,
	type SectionMark,
} from "../../src/finance/businessDescription.ts";

const LIMITS = BUSINESS_DESCRIPTION_LIMITS;
const heading = (text: string): BusinessParagraph => ({ kind: "heading", text });
const text = (value: string): BusinessParagraph => ({ kind: "text", text: value });

/**
 * The specification `businessSectionBounds` is checked against: every start
 * mark followed by an end mark is a candidate whose body is the sum of the
 * counted sizes strictly between; the largest positive body wins, the
 * earliest among equals. Quadratic, which is what the one backward pass avoids.
 */
function referenceBounds(
	marks: readonly SectionMark[],
	sizes: readonly number[],
): { start: number; end: number } | null {
	const counted = (index: number): number => {
		const size = sizes[index] ?? 0;
		return Number.isSafeInteger(size) && size > 0 ? size : 0;
	};
	let best: { start: number; end: number } | null = null;
	let bestBody = 0;
	for (let start = 0; start < marks.length; start += 1) {
		if (marks[start] !== "start") continue;
		let body = 0;
		let end = start + 1;
		while (end < marks.length && marks[end] !== "end") {
			body += counted(end);
			end += 1;
		}
		if (end === marks.length) continue;
		if (body > bestBody) {
			best = { start, end };
			bestBody = body;
		}
	}
	return best;
}

describe("businessSectionBounds", () => {
	it("skips the table of contents and takes the body's section", () => {
		const marks: SectionMark[] = [
			"other", // cover page
			"start", // ToC: Item 1. Business
			"end", // ToC: Item 1A. Risk Factors
			"end", // ToC: Item 2. Properties
			"start", // Item 1. Business
			"other",
			"other",
			"end", // Item 1A. Risk Factors
			"other",
		];
		const sizes = [500, 20, 25, 22, 20, 4_000, 3_000, 25, 9_000];
		expect(businessSectionBounds(marks, sizes)).toEqual({ start: 4, end: 7 });
	});

	it("takes the largest body when a running header repeats the heading", () => {
		const marks: SectionMark[] = ["start", "other", "start", "other", "other", "end"];
		// The first start's body includes the second start's block and body.
		expect(businessSectionBounds(marks, [1, 10, 1, 5, 5, 1])).toEqual({ start: 0, end: 5 });
	});

	it("keeps the earliest start among equal bodies", () => {
		const marks: SectionMark[] = ["start", "other", "end", "start", "other", "end"];
		expect(businessSectionBounds(marks, [1, 7, 1, 1, 7, 1])).toEqual({ start: 0, end: 2 });
		expect(businessSectionBounds(marks, [1, 7, 1, 1, 8, 1])).toEqual({ start: 3, end: 5 });
	});

	it("is null without a start followed by an end and a body", () => {
		expect(businessSectionBounds([], [])).toBeNull();
		expect(businessSectionBounds(["start", "other"], [1, 100])).toBeNull();
		expect(businessSectionBounds(["other", "end"], [100, 1])).toBeNull();
		expect(businessSectionBounds(["end", "start", "other"], [1, 1, 100])).toBeNull();
		expect(businessSectionBounds(["start", "end"], [100, 100])).toBeNull();
		expect(businessSectionBounds(["start", "other", "end"], [1, 0, 1])).toBeNull();
	});

	it("counts a missing, negative, fractional or non-finite size as zero", () => {
		const marks: SectionMark[] = ["start", "other", "other", "end"];
		expect(businessSectionBounds(marks, [1])).toBeNull();
		expect(businessSectionBounds(marks, [1, -5, Number.NaN, 1])).toBeNull();
		expect(businessSectionBounds(marks, [1, 1.5, Number.POSITIVE_INFINITY, 1])).toBeNull();
		expect(businessSectionBounds(marks, [1, 2 ** 53, 0, 1])).toBeNull();
		expect(businessSectionBounds(marks, [1, -5, 3])).toEqual({ start: 0, end: 3 });
	});

	it("agrees with the specification on random filings", () => {
		const mark = fc.constantFrom<SectionMark>("start", "end", "other", "other", "other");
		const size = fc.oneof(
			fc.integer({ min: 0, max: 6 }),
			fc.integer({ min: -3, max: 1_000_000 }),
			fc.constantFrom(Number.NaN, 0.5, Number.POSITIVE_INFINITY),
		);
		fc.assert(
			fc.property(
				fc.array(mark, { maxLength: 40 }),
				fc.array(size, { maxLength: 40 }),
				(marks, sizes) => {
					expect(businessSectionBounds(marks, sizes)).toEqual(referenceBounds(marks, sizes));
				},
			),
		);
	});
});

describe("businessParagraphKind", () => {
	it("calls a short line with a letter and without closing punctuation a heading", () => {
		expect(businessParagraphKind("Products")).toBe("heading");
		expect(businessParagraphKind("iPhone and Mac")).toBe("heading");
		expect(businessParagraphKind("当社グループの事業")).toBe("heading");
		expect(businessParagraphKind("a".repeat(LIMITS.maxHeadingChars))).toBe("heading");
	});

	it("calls everything else text", () => {
		expect(businessParagraphKind("a".repeat(LIMITS.maxHeadingChars + 1))).toBe("text");
		expect(businessParagraphKind("2025")).toBe("text");
		expect(businessParagraphKind("• Products")).toBe("text");
		expect(businessParagraphKind("- Products")).toBe("text");
		// A bullet glyph needs no space after it; a dash does (it also starts words).
		expect(businessParagraphKind("•In 2024 the Firm")).toBe("text");
		expect(businessParagraphKind("-Products")).toBe("heading");
		for (const closing of [...".。．:：;；!！?？,，、)）」』", '"', "”"]) {
			expect(businessParagraphKind(`The Company designs phones${closing}`), closing).toBe("text");
		}
	});
});

describe("businessParagraphs", () => {
	it("collapses whitespace, drops empty blocks and classifies each block", () => {
		expect(
			businessParagraphs([
				"  Company Background ",
				"",
				" \n\t ",
				"The Company designs,\n  manufactures and markets smartphones.",
			]),
		).toEqual({
			paragraphs: [
				heading("Company Background"),
				text("The Company designs, manufactures and markets smartphones."),
			],
			truncated: false,
		});
	});

	it("joins a lone list marker to the next block", () => {
		expect(businessParagraphs(["Products", "•", "iPhone", "・", "  ", "Mac"])).toEqual({
			paragraphs: [heading("Products"), text("• iPhone"), text("・ Mac")],
			truncated: false,
		});
	});

	it("drops trailing headings and describes nothing without text", () => {
		expect(businessParagraphs(["Overview", "We sell phones.", "Segments", "Americas"])).toEqual({
			paragraphs: [heading("Overview"), text("We sell phones.")],
			truncated: false,
		});
		expect(businessParagraphs(["Overview", "Segments"])).toEqual({
			paragraphs: [],
			truncated: false,
		});
		expect(businessParagraphs([])).toEqual({ paragraphs: [], truncated: false });
		expect(businessParagraphs(["•"])).toEqual({ paragraphs: [], truncated: false });
	});

	it("keeps the leading paragraphs that fit the stored-text budget", () => {
		const half = `${"a".repeat(LIMITS.maxStoredChars / 2 - 1)}.`;
		expect(businessParagraphs([half, half])).toEqual({
			paragraphs: [text(half), text(half)],
			truncated: false,
		});
		expect(businessParagraphs([half, half, "b."])).toEqual({
			paragraphs: [text(half), text(half)],
			truncated: true,
		});
		// A paragraph that does not fit ends the kept ones; later short ones are not squeezed in.
		expect(businessParagraphs([half, `${half}x`, "b."])).toEqual({
			paragraphs: [text(half)],
			truncated: true,
		});
	});

	it("keeps at most maxParagraphs paragraphs", () => {
		const blocks = Array.from({ length: LIMITS.maxParagraphs + 1 }, (_, index) => `Line ${index}.`);
		const result = businessParagraphs(blocks);
		expect(result.paragraphs).toHaveLength(LIMITS.maxParagraphs);
		expect(result.truncated).toBe(true);
		expect(result.paragraphs.at(-1)?.text).toBe(`Line ${LIMITS.maxParagraphs - 1}.`);
		expect(businessParagraphs(blocks.slice(1)).truncated).toBe(false);
	});

	it("cuts a first paragraph longer than the budget with an ellipsis", () => {
		const long = "word ".repeat(LIMITS.maxStoredChars);
		const result = businessParagraphs([long, "Next."]);
		expect(result.truncated).toBe(true);
		expect(result.paragraphs).toHaveLength(1);
		const [first] = result.paragraphs;
		expect(first?.kind).toBe("text");
		expect(first?.text).toHaveLength(LIMITS.maxStoredChars);
		expect(first?.text.endsWith("…")).toBe(true);
	});

	it("cuts a long paragraph after a leading heading to the room left", () => {
		const long = "word ".repeat(LIMITS.maxStoredChars);
		const result = businessParagraphs(["Overview", long, "Next."]);
		expect(result.truncated).toBe(true);
		expect(result.paragraphs.map((paragraph) => paragraph.kind)).toEqual(["heading", "text"]);
		const total = result.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
		expect(total).toBe(LIMITS.maxStoredChars);
		expect(result.paragraphs[1]?.text.endsWith("…")).toBe(true);
	});

	it("keeps the limits and the order of the blocks on random input", () => {
		const piece = fc.constantFrom(
			"Products",
			"We sell phones.",
			"•",
			"・",
			" ",
			"\n",
			"　",
			"事業の内容",
			"当社は電子機器を製造しています。",
			"x".repeat(3_000),
			`${"y".repeat(6_000)}.`,
			"",
		);
		const block = fc.array(piece, { maxLength: 4 }).map((parts) => parts.join(""));
		fc.assert(
			fc.property(fc.array(block, { maxLength: 30 }), (blocks) => {
				const { paragraphs, truncated } = businessParagraphs(blocks);
				const total = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
				expect(total).toBeLessThanOrEqual(LIMITS.maxStoredChars);
				expect(paragraphs.length).toBeLessThanOrEqual(LIMITS.maxParagraphs);
				if (paragraphs.length === 0) {
					expect(truncated).toBe(false);
					return;
				}
				expect(paragraphs.some((paragraph) => paragraph.kind === "text")).toBe(true);
				expect(paragraphs.at(-1)?.kind).toBe("text");
				for (const paragraph of paragraphs) {
					expect(paragraph.text.length).toBeGreaterThan(0);
					expect(paragraph.text).toBe(paragraph.text.trim());
					expect(paragraph.text).not.toMatch(/\s\s|[^\S ]/u);
				}
				// Each kept paragraph is the next non-empty block, in order (the first may be cut).
				const collapsed = blocks
					.map((value) => value.replace(/\s+/gu, " ").trim())
					.filter((value) => value.length > 0);
				const joined = collapsed.join("\n");
				let from = 0;
				for (const paragraph of paragraphs) {
					const needle = paragraph.text.endsWith("…")
						? paragraph.text.slice(0, -1)
						: paragraph.text;
					const at = joined.indexOf(needle.replace(/^[•・] /u, ""), from);
					expect(at).toBeGreaterThanOrEqual(from);
					from = at;
				}
			}),
		);
	});
});

describe("businessSummaryCount", () => {
	it("is zero without a text paragraph", () => {
		expect(businessSummaryCount([])).toBe(0);
		expect(businessSummaryCount([heading("Overview")])).toBe(0);
	});

	it("shows the paragraphs that fit, always through the first text paragraph", () => {
		const paragraphs = [heading("Overview"), text("a".repeat(10)), text("b".repeat(10))];
		expect(businessSummaryCount(paragraphs, 100)).toBe(3);
		expect(businessSummaryCount(paragraphs, 25)).toBe(2);
		expect(businessSummaryCount(paragraphs, 5)).toBe(2);
		expect(businessSummaryCount([text("a".repeat(2_000)), text("b")])).toBe(1);
	});

	it("never ends on a heading that a later text paragraph belongs to", () => {
		const paragraphs = [text("a".repeat(10)), heading("Segments"), text("b".repeat(100))];
		expect(businessSummaryCount(paragraphs, 25)).toBe(1);
		expect(businessSummaryCount(paragraphs, 200)).toBe(3);
	});

	it("uses the 700-character summary by default", () => {
		const paragraphs = [text("a".repeat(400)), text("b".repeat(300)), text("c")];
		expect(businessSummaryCount(paragraphs)).toBe(2);
	});

	it("ends on text and stays within the budget past the first text on random input", () => {
		const paragraph = fc.record({
			kind: fc.constantFrom<BusinessParagraph["kind"]>("heading", "text"),
			text: fc.string({ minLength: 1, maxLength: 300 }),
		});
		fc.assert(
			fc.property(
				fc.array(paragraph, { maxLength: 12 }),
				fc.integer({ min: 0, max: 1_500 }),
				(paragraphs, budget) => {
					const count = businessSummaryCount(paragraphs, budget);
					const firstText = paragraphs.findIndex((item) => item.kind === "text");
					if (firstText === -1) {
						expect(count).toBe(0);
						return;
					}
					expect(count).toBeGreaterThanOrEqual(firstText + 1);
					expect(count).toBeLessThanOrEqual(paragraphs.length);
					expect(paragraphs[count - 1]?.kind).toBe("text");
					if (count > firstText + 1) {
						const shown = paragraphs.slice(0, count);
						const total = shown.reduce((sum, item) => sum + item.text.length, 0);
						expect(total).toBeLessThanOrEqual(budget);
					}
				},
			),
		);
	});
});
