/**
 * "Item 1. Business" of a 10-K (ADR-0053 §3) and Item 4.B "Business
 * Overview" (else Item 4 "Information on the Company") of a 20-F (ADR-0058
 * §5), pure: the primary document's Markdown (`htmlToMarkdown`) in, the
 * section's stored paragraphs out.
 *
 * 1. Blocks are the Markdown's blank-line separated parts. A block whose
 *    every line starts with "|" is a table: its separator rows go and its
 *    non-empty cells are joined with one space; any other block loses a
 *    leading `#` heading marker. Both lose `**` / `__` emphasis markers, and
 *    whitespace runs collapse.
 * 2. Each block is marked (`secSectionMarks`) for a section and
 *    `businessSectionBounds` picks it: the table of contents names the item
 *    too, and some filings repeat it as a running page header. A form's
 *    sections are tried in turn (`SEC_SECTIONS_OF_FORM`); the first found
 *    is read. A 20-F's Item 4.B comes first: Item 4 also holds 4.A, the
 *    company's history, which is not its description.
 * 3. The body is cleaned for SEC: tables (the description is prose), page
 *    numbers, `---` page breaks, "Table of Contents", "Part I", a bare
 *    "Item 1" (20-F: "Item 4") or repeated start heading running header
 *    and short running footers
 *    naming "Form 10-K" (20-F: "Form 20-F") go; in a 20-F also a short
 *    note incorporating text "by reference" (many foreign issuers put the
 *    description in an annual-report exhibit: then nothing is left and the
 *    description is not found). Text before the first subheading goes when
 *    that subheading is the second or third paragraph
 *    (forward-looking-statement or defined-terms boilerplate: Amazon,
 *    Coca-Cola).
 * 4. `businessParagraphs` keeps the leading paragraphs within the limits.
 *
 * Lengths are UTF-16 code units (the Rust port counts the same). One pass
 * over the blocks for the marks, one over the section for the cleaning.
 */
import {
	type BusinessParagraphs,
	businessParagraphKind,
	businessParagraphs,
	businessSectionBounds,
	isLoneBullet,
	type SectionMark,
} from "@research/domain";

/**
 * A 10-K's (or 20-F's) primary document: 1–13 MB on the companies first
 * checked (ADR-0053 §2); Regency Centers' and BlackRock TCP Capital's are
 * 21 MB (2026-11-04).
 */
export const SEC_TEN_K_MAX_BYTES = 32_000_000;
/** Markdown kept of a primary document; Item 1 sits in its first part. */
export const SEC_TEN_K_MAX_MARKDOWN_CHARS = 4_000_000;
/** The start heading is short: "Items 1 and 2. Business and Properties" is 38. */
const MAX_START_CHARS = 60;
/** An end heading may carry its title: "Item 1A. Risk Factors". */
const MAX_END_CHARS = 120;
/** Running footers ("Apple Inc. | 2025 Form 10-K | 3") are short. */
const MAX_FOOTER_CHARS = 100;
/** A 20-F's cross-reference note ("… is incorporated herein by reference.") is short. */
const MAX_CROSS_REFERENCE_CHARS = 400;

/** The primary documents a description is read from: an original 10-K or 20-F. */
export type SecDescribedForm = "10-K" | "20-F";

/** The sections the description is read from: a 10-K's Item 1, a 20-F's Item 4.B or Item 4. */
export const SEC_BUSINESS_SECTIONS = ["10-K item 1", "20-F item 4B", "20-F item 4"] as const;
export type SecBusinessSection = (typeof SEC_BUSINESS_SECTIONS)[number];

/** Each form's sections, in the order tried. */
export const SEC_SECTIONS_OF_FORM: {
	readonly [F in SecDescribedForm]: readonly SecBusinessSection[];
} = {
	"10-K": ["10-K item 1"],
	"20-F": ["20-F item 4B", "20-F item 4"],
};

const BLOCK_SEPARATOR = /\n{2,}/;
const TABLE_SEPARATOR_ROW = /^\|[\s:|-]+\|$/;
const HEADING_MARKER = /^#+\s*/;
const EMPHASIS_MARKER = /\*\*|__/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * "Item 1. Business", "ITEM 1 — BUSINESS", "Items 1 and 2. Business and
 * Properties", "Items 1. and 2. Business and Properties." (Freeport-McMoRan),
 * "Part I. Item 1. Business" (Expedia), "ITEM 1 | Business" (AIG), "Item 1.
 * Description of Business" (World Acceptance, a table row).
 */
const START_HEADING =
	/^(?:part\s+i\s*[.,:\-–—]?\s*)?items?\s*1\.?(?:\s*(?:and|&)\s*2\.?)?\s*[.:\-–—|]?\s*(?:description\s+of\s+(?:the\s+)?)?business\b/i;
/** "Item 1A", "Item 1B", "Item 1C", "Item 2", "Item 3", with or without a title or "Part I." before it. */
const END_HEADING = /^(?:part\s+i\s*[.,:\-–—]?\s*)?item\s*(?:1a|1b|1c|2|3)\b/i;
/** A bare "Risk Factors" heading: Item 1A's title where a 10-K writes no item numbers. */
const BARE_END_TITLE = /^risk\s+factors\.?$/i;

/** "Item 4.B Business Overview", "4B. Business overview", "B. Business Overview". */
const OVERVIEW_HEADING = /^(?:(?:item\s*)?4\s*\.?\s*)?b\s*[.:\-–—]?\s*business\s+overview\b/i;
/** "Item 4. Information on the Company", "Item 4. Information On Our Company". */
const COMPANY_HEADING = /^item\s*4\s*[.:\-–—]?\s*information\s+on\s+(?:the|our)\s+company\b/i;
/**
 * What follows Item 4.B in a 20-F: "Item 4.C" / "4.D" (with or without a
 * title), "C. Organizational Structure", "D. Property, Plants and
 * Equipment", "Item 4A" (Unresolved Staff Comments), "Item 5".
 */
const TWENTY_F_END_HEADINGS: readonly RegExp[] = [
	/^(?:item\s*)?4\s*\.?\s*[cd]\b/i,
	/^[cd]\s*[.:\-–—]\s*(?:organi[sz]ational\s+structure|propert(?:y|ies))\b/i,
	/^item\s*(?:4a|5)\b/i,
];

const PAGE_NUMBER = /^\d+$/;
const PAGE_BREAK = /^-{3,}$/;
const TABLE_OF_CONTENTS = /^table of contents$/i;
const PART_HEADING = /^part\s+[ivx]+$/i;
const BARE_ITEM_ONE = /^item\s*1\.?$/i;
/** The title of a start heading split from its bare "Item 1." (Capital City Bank Group). */
const SPLIT_START_TITLE = /^business\.?$/i;
/** Italic emphasis left in a heading: "Item 1. *Business*" (AXT, Mason Industrial). */
const ITALIC_MARKER = /\*/g;
const BARE_ITEM_FOUR = /^item\s*4\.?$/i;
const FORM_10K = /form 10-k/i;
const FORM_20F = /form 20-f/i;
const BY_REFERENCE = /by reference/i;
/** A block that is only a list marker: `businessParagraphs` joins it to the next block. */

/** One block of the converted document. */
export interface SecBlock {
	/** Whitespace-collapsed text without heading and emphasis markers. */
	readonly text: string;
	readonly table: boolean;
}

function collapse(text: string): string {
	return text.replace(WHITESPACE_RUN, " ").trim();
}

/** A Markdown block's text (rule 1 above). */
export function secBlock(block: string): SecBlock {
	const lines = block.split("\n");
	if (lines.every((line) => line.startsWith("|"))) {
		const cells: string[] = [];
		for (const line of lines) {
			if (TABLE_SEPARATOR_ROW.test(line.trim())) continue;
			for (const cell of line.split("|")) {
				const text = collapse(cell.replace(EMPHASIS_MARKER, ""));
				if (text !== "") cells.push(text);
			}
		}
		return { text: cells.join(" "), table: true };
	}
	return {
		text: collapse(block.replace(HEADING_MARKER, "").replace(EMPHASIS_MARKER, "")),
		table: false,
	};
}

/** The blocks of a converted primary document, in order. */
export function secMarkdownBlocks(markdown: string): readonly SecBlock[] {
	return markdown.split(BLOCK_SEPARATOR).flatMap((raw) => {
		const block = secBlock(raw);
		const about = !block.table ? /^(ABOUT [A-Z][A-Z &’'’-]{1,60}\.)\s+/.exec(block.text) : null;
		return about?.[1]
			? [
					{ text: about[1], table: false },
					{ text: block.text.slice(about[0].length), table: false },
				]
			: [block];
	});
}

function isStartHeading(text: string, section: SecBusinessSection): boolean {
	switch (section) {
		case "10-K item 1":
			return START_HEADING.test(text);
		case "20-F item 4B":
			return OVERVIEW_HEADING.test(text);
		case "20-F item 4":
			return COMPANY_HEADING.test(text);
	}
}

function isEndHeading(text: string, section: SecBusinessSection): boolean {
	return section === "10-K item 1"
		? END_HEADING.test(text)
		: TWENTY_F_END_HEADINGS.some((heading) => heading.test(text));
}

/**
 * What a block is to the search for one section (ADR-0053 §3, ADR-0058 §5),
 * read without italic `*` markers.
 */
export function secSectionMark(text: string, section: SecBusinessSection): SectionMark {
	const plain = text.replace(ITALIC_MARKER, "");
	if (plain.length <= MAX_START_CHARS && isStartHeading(plain, section)) return "start";
	if (plain.length <= MAX_END_CHARS && isEndHeading(plain, section)) return "end";
	return "other";
}

/**
 * Every block's mark for one section: `secSectionMark`, and in a 10-K a
 * "Business" block right after a bare "Item 1." block also starts the
 * section (the heading split in two). A 10-K with no start heading at all
 * writes its item numbers only in the table of contents (Morgan Stanley,
 * Cardinal Health): then a bare "Business" block starts the section and a
 * bare "Risk Factors" block ends it.
 */
export function secSectionMarks(
	blocks: readonly SecBlock[],
	section: SecBusinessSection,
): SectionMark[] {
	const marks = blocks.map((block) => secSectionMark(block.text, section));
	if (section !== "10-K item 1") return marks;
	for (let index = 1; index < blocks.length; index += 1) {
		const previous = blocks[index - 1]?.text ?? "";
		const text = blocks[index]?.text ?? "";
		if (BARE_ITEM_ONE.test(previous) && SPLIT_START_TITLE.test(text)) marks[index] = "start";
	}
	if (marks.some((mark, index) => mark === "start" && !blocks[index]?.table)) return marks;
	// Annual-report layouts put item numbers in a cross-reference table only.
	const reportMarks: SectionMark[] = blocks.map((block) => {
		if (block.table) return "other";
		if (/^(?:about [a-z][a-z &’'’-]{1,60}\.?|our business|business summary)$/i.test(block.text))
			return "start";
		if (/^(?:management[’']s discussion and analysis|risk factors\b)/i.test(block.text))
			return "end";
		return "other";
	});
	if (reportMarks.includes("start")) return reportMarks;
	if (marks.includes("start")) return marks;
	blocks.forEach((block, index) => {
		// A one-cell table row "Business" is a page header, not the heading.
		if (block.table) return;
		if (SPLIT_START_TITLE.test(block.text)) marks[index] = "start";
		else if (BARE_END_TITLE.test(block.text)) marks[index] = "end";
	});
	return marks;
}

/** A block of the section that is page furniture, not description (rule 3 above). */
function isFurniture(block: SecBlock, form: SecDescribedForm): boolean {
	const text = block.text;
	if (
		block.table ||
		text === "" ||
		PAGE_NUMBER.test(text) ||
		PAGE_BREAK.test(text) ||
		TABLE_OF_CONTENTS.test(text) ||
		PART_HEADING.test(text)
	) {
		return true;
	}
	if (form === "10-K") {
		return (
			BARE_ITEM_ONE.test(text) ||
			// A start heading repeated as a running page header ("ITEM 1 | Business", AIG).
			(text.length <= MAX_START_CHARS && START_HEADING.test(text)) ||
			(text.length < MAX_FOOTER_CHARS && FORM_10K.test(text))
		);
	}
	return (
		BARE_ITEM_FOUR.test(text) ||
		(text.length < MAX_FOOTER_CHARS && FORM_20F.test(text)) ||
		(text.length < MAX_CROSS_REFERENCE_CHARS && BY_REFERENCE.test(text))
	);
}

/**
 * Where the description starts among the cleaned blocks: at the first
 * subheading when it is paragraph 1 or 2 (what comes before it is
 * boilerplate), else at the first block. Paragraphs are counted as
 * `businessParagraphs` forms them: a lone list marker belongs to the next
 * block (and such a paragraph is never a heading).
 */
function preambleEnd(texts: readonly string[]): number {
	let paragraph = 0;
	let lonePrevious = false;
	for (let index = 0; index < texts.length && paragraph <= 2; index += 1) {
		const text = texts[index] ?? "";
		// A marker after a marker replaces it; the paragraph is the marker and the next text.
		if (isLoneBullet(text)) {
			lonePrevious = true;
			continue;
		}
		if (lonePrevious) {
			lonePrevious = false;
			paragraph += 1;
			continue;
		}
		if (businessParagraphKind(text) === "heading") return paragraph === 0 ? 0 : index;
		paragraph += 1;
	}
	return 0;
}

/**
 * The cleaned blocks of the form's business section (rules 1–3 above): the
 * first of its sections the document has with a body, or null when it has
 * none.
 */
export function secBusinessBlocks(
	markdown: string,
	form: SecDescribedForm,
): readonly string[] | null {
	const blocks = secMarkdownBlocks(markdown);
	const sizes = blocks.map((block) => block.text.length);
	for (const section of SEC_SECTIONS_OF_FORM[form]) {
		const marks = secSectionMarks(blocks, section);
		const bounds = businessSectionBounds(marks, sizes);
		if (bounds === null) continue;
		const texts: string[] = [];
		for (let index = bounds.start + 1; index < bounds.end; index += 1) {
			const block = blocks[index];
			if (block !== undefined && !isFurniture(block, form)) texts.push(block.text);
		}
		return texts.slice(preambleEnd(texts));
	}
	return null;
}

/**
 * The stored paragraphs of a 10-K's or 20-F's business section; no
 * paragraphs when the document has none that could be read (the description
 * is then "not-found").
 */
export function secBusinessParagraphs(
	markdown: string,
	form: SecDescribedForm,
): BusinessParagraphs {
	const blocks = secBusinessBlocks(markdown, form);
	return blocks === null ? { paragraphs: [], truncated: false } : businessParagraphs(blocks);
}
