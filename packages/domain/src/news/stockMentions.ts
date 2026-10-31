import type { WatchMarket } from "../watchlist/stockId.ts";

/**
 * Which stored articles mention a stock (ADR-0049 §7): the terms a stock is
 * searched by, the match of one term in an article's text, and the SQL
 * `LIKE` prefilter that selects candidates before the match. Pure.
 *
 * Article text is matched exactly as stored (no normalisation), so the SQL
 * prefilter and the match read the same characters: every true mention
 * passes the prefilter (`formal/ResearchFormal/StockMentions.lean`).
 */
export const STOCK_MENTION_LIMITS = {
	/** Terms one stock is searched by. */
	maxTerms: 4,
	/** A shorter name (after its corporate suffix is removed) is not a term. */
	minNameChars: 2,
	/** A longer name is not a term (a stored name is at most 200 characters). */
	maxTermChars: 80,
	/** A shorter US symbol is not a term: "A", "F" or "T" stand alone in ordinary text ("Series A"). */
	minSymbolChars: 2,
} as const;

/** One searched-for term: a company name (case-insensitive) or a US symbol (case-sensitive). */
export interface StockMentionTerm {
	readonly text: string;
	readonly kind: "name" | "symbol";
}

/**
 * Corporate suffixes removed from the end of an English name, repeatedly
 * ("COCA COLA CO" → "COCA COLA", "Toyota Motor Co., Ltd." → "Toyota Motor"),
 * compared case-insensitively after trailing punctuation is dropped.
 */
const ENGLISH_SUFFIXES = [
	"inc",
	"incorporated",
	"corp",
	"corporation",
	"co",
	"company",
	"ltd",
	"limited",
	"plc",
	"llc",
	"lp",
	"l.p",
	"n.v",
	"s.a",
	"ag",
	"se",
] as const;

/** Japanese corporate forms removed from either end of a name. */
const JAPANESE_FORMS = ["株式会社", "（株）", "(株)", "㈱", "有限会社"] as const;

/** An SEC state-of-incorporation tag such as "/DE/" or "/NEW/" at the end of a name. */
const SEC_STATE_TAG = /\s*\/[A-Za-z]{1,4}\/$/;

const TRAILING_PUNCTUATION = /[\s.,]+$/;

function stripEnglishSuffixes(name: string): string {
	let current = name.replace(SEC_STATE_TAG, "").replace(TRAILING_PUNCTUATION, "");
	for (;;) {
		const lastSpace = current.lastIndexOf(" ");
		if (lastSpace <= 0) return current;
		const last = current
			.slice(lastSpace + 1)
			.replace(/\.$/, "")
			.toLowerCase();
		if (!ENGLISH_SUFFIXES.some((suffix) => suffix === last)) return current;
		current = current.slice(0, lastSpace).replace(TRAILING_PUNCTUATION, "");
	}
}

function stripJapaneseForms(name: string): string {
	let current = name;
	for (const form of JAPANESE_FORMS) {
		if (current.startsWith(form)) current = current.slice(form.length).trimStart();
		if (current.endsWith(form)) current = current.slice(0, -form.length).trimEnd();
	}
	return current;
}

/** A stored name as a term: NFKC, one space between words, corporate forms removed; null when unusable. */
export function nameMentionTerm(name: string): string | null {
	const normalized = name.normalize("NFKC").replace(/\s+/g, " ").trim();
	const stripped = stripEnglishSuffixes(stripJapaneseForms(normalized)).trim();
	if (stripped.length < STOCK_MENTION_LIMITS.minNameChars) return null;
	if (stripped.length > STOCK_MENTION_LIMITS.maxTermChars) return null;
	return stripped;
}

/**
 * The terms a stock is searched by, in priority order: its distinct names
 * (input order, compared case-insensitively), then — for a US stock — its
 * symbol when it has at least `minSymbolChars` characters. At most
 * `maxTerms`; the symbol keeps its place. A Japanese code is never a term:
 * four digits match amounts and dates.
 */
export function stockMentionTerms(input: {
	readonly market: WatchMarket;
	readonly symbol: string;
	readonly names: readonly (string | null)[];
}): StockMentionTerm[] {
	const withSymbol =
		input.market === "US" && input.symbol.length >= STOCK_MENTION_LIMITS.minSymbolChars;
	const nameSlots = STOCK_MENTION_LIMITS.maxTerms - (withSymbol ? 1 : 0);
	const seen = new Set<string>();
	const terms: StockMentionTerm[] = [];
	for (const name of input.names) {
		if (terms.length >= nameSlots) break;
		if (name === null) continue;
		const term = nameMentionTerm(name);
		if (term === null) continue;
		const key = asciiLower(term);
		if (seen.has(key)) continue;
		seen.add(key);
		terms.push({ text: term, kind: "name" });
	}
	if (withSymbol) terms.push({ text: input.symbol, kind: "symbol" });
	return terms;
}

function isAsciiAlphanumeric(char: string): boolean {
	const code = char.charCodeAt(0);
	return (
		(code >= 48 && code <= 57) || // 0-9
		(code >= 65 && code <= 90) || // A-Z
		(code >= 97 && code <= 122) // a-z
	);
}

function asciiLowerChar(char: string): string {
	const code = char.charCodeAt(0);
	return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
}

function asciiLower(text: string): string {
	let out = "";
	for (const char of text) out += asciiLowerChar(char);
	return out;
}

function isSeparator(char: string): boolean {
	return char === " " || char === "-";
}

/** One term character against one text character (see `termOccursAt`). */
function charMatches(termChar: string, textChar: string, caseInsensitive: boolean): boolean {
	if (isSeparator(termChar)) return isSeparator(textChar);
	if (caseInsensitive) return asciiLowerChar(termChar) === asciiLowerChar(textChar);
	return termChar === textChar;
}

/**
 * Whether `term` occurs in `text` at code-unit index `at`: every term
 * character matches (a space or hyphen matches a space or hyphen; a name's
 * ASCII letters match either case), and an ASCII letter or digit at either
 * end of the term is not continued by one in the text (a word boundary).
 * A term end that is not ASCII (Japanese text) needs no boundary.
 */
export function termOccursAt(text: string, term: StockMentionTerm, at: number): boolean {
	const length = term.text.length;
	if (length === 0 || at < 0 || at + length > text.length) return false;
	const caseInsensitive = term.kind === "name";
	for (let k = 0; k < length; k += 1) {
		if (!charMatches(term.text.charAt(k), text.charAt(at + k), caseInsensitive)) return false;
	}
	if (isAsciiAlphanumeric(term.text.charAt(0)) && at > 0) {
		if (isAsciiAlphanumeric(text.charAt(at - 1))) return false;
	}
	if (isAsciiAlphanumeric(term.text.charAt(length - 1)) && at + length < text.length) {
		if (isAsciiAlphanumeric(text.charAt(at + length))) return false;
	}
	return true;
}

/** Whether `term` occurs anywhere in `text` (`termOccursAt` at some index). */
export function termOccurs(text: string, term: StockMentionTerm): boolean {
	const last = text.length - term.text.length;
	for (let at = 0; at <= last; at += 1) {
		if (termOccursAt(text, term, at)) return true;
	}
	return false;
}

/**
 * The first term (in term order) that occurs in any of the texts (an
 * article's title and excerpt), or null. Null texts are skipped.
 */
export function articleMention(
	texts: readonly (string | null)[],
	terms: readonly StockMentionTerm[],
): StockMentionTerm | null {
	for (const term of terms) {
		for (const text of texts) {
			if (text !== null && termOccurs(text, term)) return term;
		}
	}
	return null;
}

/**
 * The SQL `LIKE … ESCAPE '\'` pattern that every text containing a mention
 * of `term` matches: `%`, then each term character (a separator as `_`, the
 * characters `%`, `_` and `\` escaped), then `%`. SQLite's `LIKE` folds ASCII
 * case, which only widens the symbol's case-sensitive match, and it compares
 * other characters exactly, as `termOccursAt` does.
 */
export function mentionLikePattern(term: StockMentionTerm): string {
	let pattern = "%";
	for (const char of term.text) {
		if (isSeparator(char)) pattern += "_";
		else if (char === "%" || char === "_" || char === "\\") pattern += `\\${char}`;
		else pattern += char;
	}
	return `${pattern}%`;
}
