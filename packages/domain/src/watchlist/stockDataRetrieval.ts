import { foldStockSearchText } from "./stockSearch.ts";

/**
 * Retrieval over a stock's stored records (ADR-0071): the `stocks.search_data`
 * research tool turns each stored record into short passages and ranks them
 * against the model's query with Okapi BM25, so the agent reads the few
 * passages that answer its question instead of every stored row.
 *
 * Text is folded like the stock search (NFKC, ASCII lower case, hiragana to
 * katakana). Latin letters and digits form words; Japanese has no spaces, so
 * every other letter run is split into overlapping character bigrams (a run of
 * one character is kept whole). Punctuation separates tokens.
 */

export const STOCK_DATA_RETRIEVAL_LIMITS = {
	maxQueryChars: 300,
	/** Distinct query terms scored; the rest are ignored (bounded work). */
	maxQueryTerms: 24,
	maxResults: 12,
} as const;

/** BM25's usual constants: term-frequency saturation and length normalisation. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Question words that would otherwise match nearly every English passage. */
const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"did",
	"do",
	"does",
	"for",
	"from",
	"how",
	"in",
	"is",
	"it",
	"its",
	"of",
	"on",
	"or",
	"the",
	"to",
	"was",
	"what",
	"when",
	"which",
	"who",
	"with",
]);

function isAsciiWordUnit(code: number): boolean {
	return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a);
}

/** A letter of a script without spaces between words (kana, CJK ideographs, Hangul). */
function isBigramUnit(code: number): boolean {
	return (
		(code >= 0x3040 && code <= 0x30ff) || // hiragana, katakana (incl. ー)
		(code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
		(code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
		(code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
	);
}

/**
 * The tokens of a text, in order, repeats kept: folded ASCII words (stop
 * words dropped) and bigrams of every kana / ideograph run.
 */
export function retrievalTokens(text: string): string[] {
	const folded = foldStockSearchText(text);
	const tokens: string[] = [];
	let index = 0;
	while (index < folded.length) {
		const code = folded.charCodeAt(index);
		if (isAsciiWordUnit(code)) {
			let end = index + 1;
			while (end < folded.length && isAsciiWordUnit(folded.charCodeAt(end))) end += 1;
			const word = folded.slice(index, end);
			if (!STOP_WORDS.has(word)) tokens.push(word);
			index = end;
		} else if (isBigramUnit(code)) {
			let end = index + 1;
			while (end < folded.length && isBigramUnit(folded.charCodeAt(end))) end += 1;
			if (end - index === 1) {
				tokens.push(folded[index] ?? "");
			} else {
				for (let at = index; at + 1 < end; at += 1) tokens.push(folded.slice(at, at + 2));
			}
			index = end;
		} else {
			index += 1;
		}
	}
	return tokens;
}

/** The distinct terms of a query, first occurrence first, at most `maxQueryTerms`. */
export function retrievalQueryTerms(query: string): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const token of retrievalTokens(query.slice(0, STOCK_DATA_RETRIEVAL_LIMITS.maxQueryChars))) {
		if (seen.has(token)) continue;
		seen.add(token);
		terms.push(token);
		if (terms.length === STOCK_DATA_RETRIEVAL_LIMITS.maxQueryTerms) break;
	}
	return terms;
}

export interface RankedPassage {
	/** The passage's index in the input. */
	readonly index: number;
	readonly score: number;
}

/**
 * The passages that share at least one term with the query, best BM25 score
 * first (ties: input order), at most `limit` (clamped to 1..maxResults). The
 * corpus statistics (document frequency, average length) are the given
 * passages', so a term every passage contains weighs little.
 */
export function rankStockPassages(
	query: string,
	passages: readonly string[],
	limit: number,
): RankedPassage[] {
	const cap = Math.min(
		STOCK_DATA_RETRIEVAL_LIMITS.maxResults,
		Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1),
	);
	const terms = retrievalQueryTerms(query);
	if (terms.length === 0 || passages.length === 0) return [];
	const termIndex = new Map<string, number>();
	for (const [position, term] of terms.entries()) termIndex.set(term, position);

	// One tokenisation per passage; only the query terms are counted.
	const lengths = new Float64Array(passages.length);
	const counts: (Uint16Array | null)[] = new Array(passages.length);
	const documentFrequency = new Uint32Array(terms.length);
	let totalLength = 0;
	for (const [passageIndex, passage] of passages.entries()) {
		const tokens = retrievalTokens(passage);
		lengths[passageIndex] = tokens.length;
		totalLength += tokens.length;
		let row: Uint16Array | null = null;
		for (const token of tokens) {
			const position = termIndex.get(token);
			if (position === undefined) continue;
			row ??= new Uint16Array(terms.length);
			if (row[position] === 0) documentFrequency[position] = (documentFrequency[position] ?? 0) + 1;
			row[position] = Math.min(0xffff, (row[position] ?? 0) + 1);
		}
		counts[passageIndex] = row;
	}
	const averageLength = totalLength / passages.length || 1;
	const idf = Array.from(documentFrequency, (frequency) =>
		Math.log(1 + (passages.length - frequency + 0.5) / (frequency + 0.5)),
	);

	const ranked: RankedPassage[] = [];
	for (const [passageIndex, row] of counts.entries()) {
		if (row === null) continue;
		const norm = BM25_K1 * (1 - BM25_B + (BM25_B * (lengths[passageIndex] ?? 0)) / averageLength);
		let score = 0;
		for (const [position, frequency] of row.entries()) {
			if (frequency === 0) continue;
			score += ((idf[position] ?? 0) * (frequency * (BM25_K1 + 1))) / (frequency + norm);
		}
		ranked.push({ index: passageIndex, score });
	}
	ranked.sort((a, b) => b.score - a.score || a.index - b.index);
	return ranked.slice(0, cap);
}
