/**
 * "Item 1. Business" of a 10-K (ADR-0053 §3), pure: the primary document's
 * Markdown (`htmlToMarkdown`) in, the section's stored paragraphs out.
 *
 * 1. Blocks are the Markdown's blank-line separated parts. A block whose
 *    every line starts with "|" is a table: its separator rows go and its
 *    non-empty cells are joined with one space; any other block loses a
 *    leading `#` heading marker. Both lose `**` / `__` emphasis markers, and
 *    whitespace runs collapse.
 * 2. Each block is marked (`secSectionMark`) and `businessSectionBounds`
 *    picks the section: the table of contents names Item 1 too, and some
 *    filings repeat it as a running page header.
 * 3. The body is cleaned for SEC: tables (the description is prose), page
 *    numbers, `---` page breaks, "Table of Contents", "Part I", a bare
 *    "Item 1" running header and short running footers naming "Form 10-K"
 *    go. Text before the first subheading goes when that subheading is the
 *    second or third paragraph (forward-looking-statement or defined-terms
 *    boilerplate: Amazon, Coca-Cola).
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

/** A 10-K's primary document: 1–13 MB on the companies checked (ADR-0053 §2). */
export const SEC_TEN_K_MAX_BYTES = 16_000_000;
/** Markdown kept of a primary document; Item 1 sits in its first part. */
export const SEC_TEN_K_MAX_MARKDOWN_CHARS = 4_000_000;
/** The start heading is short: "Items 1 and 2. Business and Properties" is 38. */
const MAX_START_CHARS = 60;
/** An end heading may carry its title: "Item 1A. Risk Factors". */
const MAX_END_CHARS = 120;
/** Running footers ("Apple Inc. | 2025 Form 10-K | 3") are short. */
const MAX_FOOTER_CHARS = 100;

const BLOCK_SEPARATOR = /\n{2,}/;
const TABLE_SEPARATOR_ROW = /^\|[\s:|-]+\|$/;
const HEADING_MARKER = /^#+\s*/;
const EMPHASIS_MARKER = /\*\*|__/g;
const WHITESPACE_RUN = /\s+/g;

/** "Item 1. Business", "ITEM 1 — BUSINESS", "Items 1 and 2. Business and Properties". */
const START_HEADING = /^items?\s*1(?:\s*(?:and|&)\s*2)?\s*[.:\-–—]?\s*business\b/i;
/** "Item 1A", "Item 1B", "Item 1C", "Item 2", "Item 3", with or without a title. */
const END_HEADING = /^item\s*(?:1a|1b|1c|2|3)\b/i;

const PAGE_NUMBER = /^\d+$/;
const PAGE_BREAK = /^-{3,}$/;
const TABLE_OF_CONTENTS = /^table of contents$/i;
const PART_HEADING = /^part\s+[ivx]+$/i;
const BARE_ITEM_ONE = /^item\s*1\.?$/i;
const FORM_10K = /form 10-k/i;
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
	return markdown.split(BLOCK_SEPARATOR).map(secBlock);
}

/** What a block is to the section search (ADR-0053 §3). */
export function secSectionMark(text: string): SectionMark {
	if (text.length <= MAX_START_CHARS && START_HEADING.test(text)) return "start";
	if (text.length <= MAX_END_CHARS && END_HEADING.test(text)) return "end";
	return "other";
}

/** A block of the section that is page furniture, not description (rule 3 above). */
function isFurniture(block: SecBlock): boolean {
	const text = block.text;
	return (
		block.table ||
		text === "" ||
		PAGE_NUMBER.test(text) ||
		PAGE_BREAK.test(text) ||
		TABLE_OF_CONTENTS.test(text) ||
		PART_HEADING.test(text) ||
		BARE_ITEM_ONE.test(text) ||
		(text.length < MAX_FOOTER_CHARS && FORM_10K.test(text))
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
 * The cleaned blocks of the 10-K's "Item 1. Business" (rules 1–3 above), or
 * null when the document has no such section with a body.
 */
export function secBusinessBlocks(markdown: string): readonly string[] | null {
	const blocks = secMarkdownBlocks(markdown);
	const marks = blocks.map((block) => secSectionMark(block.text));
	const sizes = blocks.map((block) => block.text.length);
	const bounds = businessSectionBounds(marks, sizes);
	if (bounds === null) return null;
	const texts: string[] = [];
	for (let index = bounds.start + 1; index < bounds.end; index += 1) {
		const block = blocks[index];
		if (block !== undefined && !isFurniture(block)) texts.push(block.text);
	}
	return texts.slice(preambleEnd(texts));
}

/**
 * The stored paragraphs of a 10-K's business section; no paragraphs when the
 * document has none that could be read (the description is then
 * "not-found").
 */
export function secBusinessParagraphs(markdown: string): BusinessParagraphs {
	const blocks = secBusinessBlocks(markdown);
	return blocks === null ? { paragraphs: [], truncated: false } : businessParagraphs(blocks);
}
