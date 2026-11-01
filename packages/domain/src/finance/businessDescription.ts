/**
 * The business description of a company (ADR-0053): the "Item 1. Business"
 * section of its newest 10-K (SEC) or the 事業の内容 section of its newest
 * annual securities report (EDINET), kept as paragraphs and shown on the
 * Stocks page's Company tab as a summary with "Show more".
 *
 * Pure and total. `businessSectionBounds` is modelled in Lean
 * (`formal/ResearchFormal/BusinessSection.lean`); the paragraph rules are
 * covered by unit tests and replayed by the Rust runner from vectors.
 */
import { truncateText } from "../text/truncate.ts";

export const BUSINESS_DESCRIPTION_LIMITS = {
	/** UTF-16 units of paragraph text one company keeps (the rest stays in the filing). */
	maxStoredChars: 20_000,
	/** Paragraphs one company keeps. */
	maxParagraphs: 400,
	/** A heading is a short line without closing punctuation. */
	maxHeadingChars: 80,
	/** UTF-16 units the Company tab shows before "Show more". */
	summaryChars: 700,
} as const;

export const BUSINESS_PARAGRAPH_KINDS = ["heading", "text"] as const;
export type BusinessParagraphKind = (typeof BUSINESS_PARAGRAPH_KINDS)[number];

export interface BusinessParagraph {
	readonly kind: BusinessParagraphKind;
	/** Whitespace-collapsed, trimmed, never empty. */
	readonly text: string;
}

export interface BusinessParagraphs {
	readonly paragraphs: readonly BusinessParagraph[];
	/** True when paragraphs were left out (or the first cut) to fit the limits. */
	readonly truncated: boolean;
}

/* ---------- Locating the section ---------- */

/**
 * What one block of a converted filing is to the section search: the
 * section's heading ("Item 1. Business"), a heading that ends it ("Item 1A.
 * Risk Factors", "Item 2. Properties", …), or anything else.
 */
export type SectionMark = "start" | "end" | "other";

export interface SectionBounds {
	/** Index of the chosen start heading. */
	readonly start: number;
	/** Index of the first end heading after it; the body is the blocks strictly between. */
	readonly end: number;
}

/**
 * The section among several candidate headings (ADR-0053 §3). A filing names
 * "Item 1. Business" in its table of contents and again (sometimes as a
 * running page header) in the body; every start heading followed by an end
 * heading is a candidate whose body runs to the first end heading after it.
 * The chosen candidate has the largest body (the sum of `sizes` strictly
 * between start and end), the earliest start among equals; a table of
 * contents entry, whose next row is "Item 1A", has an empty body. Null when
 * no candidate has a non-empty body.
 *
 * `marks` and `sizes` have one entry per block (a missing size counts as 0).
 * One backward pass: O(blocks).
 */
export function businessSectionBounds(
	marks: readonly SectionMark[],
	sizes: readonly number[],
): SectionBounds | null {
	let best: SectionBounds | null = null;
	let bestSize = 0;
	// Walking backwards, `nextEnd` is the first end heading after the current
	// index and `sizeToEnd` the sum of sizes from just after the current index
	// up to (excluding) that end heading.
	let nextEnd: number | null = null;
	let sizeToEnd = 0;
	for (let index = marks.length - 1; index >= 0; index -= 1) {
		const mark = marks[index];
		if (mark === "start" && nextEnd !== null && sizeToEnd > 0 && sizeToEnd >= bestSize) {
			// `>=` while walking backwards keeps the earliest start among equals.
			best = { start: index, end: nextEnd };
			bestSize = sizeToEnd;
		}
		if (mark === "end") {
			nextEnd = index;
			sizeToEnd = 0;
		} else {
			const size = sizes[index] ?? 0;
			sizeToEnd += Number.isSafeInteger(size) && size > 0 ? size : 0;
		}
	}
	return best;
}

/* ---------- Paragraphs ---------- */

const WHITESPACE_RUN = /\s+/gu;
/** A block that is only a list marker: the item's text is the next block. */
const LONE_BULLET = /^[•●◦▪■・‐–—-]$/u;
const BULLET_START = /^[•●◦▪■・‐–—-]\s/u;
/** Closing punctuation of a sentence or a lead-in. */
const CLOSING = /[.。．:：;；!！?？,，、)）」』"”]$/u;
const HAS_LETTER = /\p{L}/u;

function collapse(text: string): string {
	return text.replace(WHITESPACE_RUN, " ").trim();
}

/** A heading: short, has a letter, not a list item, no closing punctuation. */
export function businessParagraphKind(text: string): BusinessParagraphKind {
	return text.length <= BUSINESS_DESCRIPTION_LIMITS.maxHeadingChars &&
		HAS_LETTER.test(text) &&
		!BULLET_START.test(text) &&
		!CLOSING.test(text)
		? "heading"
		: "text";
}

/**
 * The stored paragraphs of a section's blocks (ADR-0053 §4): whitespace runs
 * collapse to one space, empty blocks go, a lone list marker joins the next
 * block ("• text"), each block is a heading or text
 * (`businessParagraphKind`). Then the leading paragraphs that fit
 * `maxStoredChars` and `maxParagraphs` are kept (the first is cut with "…"
 * when it alone is longer), and trailing headings are dropped (a heading
 * without its text says nothing).
 */
export function businessParagraphs(blocks: readonly string[]): BusinessParagraphs {
	const texts: string[] = [];
	let pendingBullet: string | null = null;
	for (const block of blocks) {
		const text = collapse(block);
		if (text.length === 0) continue;
		if (LONE_BULLET.test(text)) {
			pendingBullet = text;
			continue;
		}
		texts.push(pendingBullet === null ? text : `${pendingBullet} ${text}`);
		pendingBullet = null;
	}
	const limits = BUSINESS_DESCRIPTION_LIMITS;
	const kept: BusinessParagraph[] = [];
	let total = 0;
	let truncated = false;
	for (const text of texts) {
		if (kept.length === limits.maxParagraphs || total + text.length > limits.maxStoredChars) {
			if (kept.length === 0) {
				const cut = truncateText(text, limits.maxStoredChars);
				kept.push({ kind: "text", text: cut });
			}
			truncated = true;
			break;
		}
		kept.push({ kind: businessParagraphKind(text), text });
		total += text.length;
	}
	while (kept.length > 1 && kept.at(-1)?.kind === "heading") kept.pop();
	// A section of headings only describes nothing.
	if (!kept.some((paragraph) => paragraph.kind === "text")) {
		return { paragraphs: [], truncated: false };
	}
	return { paragraphs: kept, truncated };
}

/**
 * How many leading paragraphs the Company tab shows before "Show more"
 * (ADR-0053 §6): those that fit `summaryChars`, but always through the first
 * text paragraph, and never ending on a heading that a later text paragraph
 * belongs to.
 */
export function businessSummaryCount(
	paragraphs: readonly BusinessParagraph[],
	summaryChars: number = BUSINESS_DESCRIPTION_LIMITS.summaryChars,
): number {
	const firstText = paragraphs.findIndex((paragraph) => paragraph.kind === "text");
	if (firstText === -1) return 0;
	let count = 0;
	let total = 0;
	for (const paragraph of paragraphs) {
		if (total + paragraph.text.length > summaryChars) break;
		total += paragraph.text.length;
		count += 1;
	}
	while (count > firstText + 1 && paragraphs[count - 1]?.kind === "heading") count -= 1;
	return Math.max(count, firstText + 1);
}
