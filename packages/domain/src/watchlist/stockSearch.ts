import type { WatchMarket } from "./stockId.ts";

/**
 * Stock directory search (ADR-0033): text folding, query terms, matching and
 * ranking. Pure and allocation-light. The API stores each row's folded keys
 * and ranks in SQL; this module is the reference the SQL is tested against,
 * and `formal/ResearchFormal/StockSearch.lean` models it from the folded
 * text on (NFKC itself is outside the model).
 */
export const STOCK_SEARCH_LIMITS = {
	/** Longest query accepted, before folding. */
	maxQueryChars: 64,
	/** Terms beyond this are ignored. */
	maxTerms: 4,
	/** Most hits one search returns. */
	maxResults: 20,
	/** Hits returned when the caller names no limit. */
	defaultResults: 10,
} as const;

const WHITESPACE = /\s/u;
/** Kana voicing marks: after the hiragana shift they may compose with the katakana before them. */
const KANA_VOICING_MARKS = /[\u3099\u309a]/u;
const HIRAGANA_FIRST = 0x3041;
const HIRAGANA_LAST = 0x3096;
const HIRAGANA_TO_KATAKANA = 0x60;

/**
 * Folds text for matching: NFKC (full-width letters and digits to
 * half-width, half-width kana to full-width, U+3000 to a space), ASCII-only
 * lower-casing, hiragana to katakana (so "とよた" finds "トヨタ"), and
 * whitespace runs to one space, trimmed. ASCII-only lower-casing keeps the
 * fold exactly modelled in Lean; company names are ASCII or Japanese.
 *
 * Hiragana わゐゑを have no precomposed voiced form but their katakana do
 * (ヷヸヹヺ), so "わ" + U+3099 only composes after the shift: the result is
 * composed again (NFC) when it holds a voicing mark, which keeps the fold
 * idempotent and lets such input find a stored "ヷ".
 */
export function foldStockSearchText(text: string): string {
	const normalized = text.normalize("NFKC");
	let folded = "";
	let pendingSpace = false;
	for (const char of normalized) {
		const code = char.codePointAt(0) ?? 0;
		if (WHITESPACE.test(char)) {
			pendingSpace = folded.length > 0;
			continue;
		}
		if (pendingSpace) {
			folded += " ";
			pendingSpace = false;
		}
		if (code >= 0x41 && code <= 0x5a) {
			folded += String.fromCharCode(code + 0x20);
		} else if (code >= HIRAGANA_FIRST && code <= HIRAGANA_LAST) {
			folded += String.fromCharCode(code + HIRAGANA_TO_KATAKANA);
		} else {
			folded += char;
		}
	}
	return KANA_VOICING_MARKS.test(folded) ? folded.normalize("NFC") : folded;
}

/** The folded query split into terms; empty for a blank query. */
export function stockSearchTerms(query: string): readonly string[] {
	const folded = foldStockSearchText(query.slice(0, STOCK_SEARCH_LIMITS.maxQueryChars));
	if (folded === "") return [];
	return folded.split(" ").slice(0, STOCK_SEARCH_LIMITS.maxTerms);
}

/** One row of the directory, as searched. */
export interface StockSearchRow {
	readonly market: WatchMarket;
	readonly symbol: string;
	readonly name: string;
	/** The Japanese name of a JP listing; null for US rows. */
	readonly localName: string | null;
}

/** A row's folded keys; the API stores them beside the row. */
export interface StockSearchKeys {
	readonly symbolKey: string;
	readonly nameKey: string;
	/** Empty when the row has no local name. */
	readonly localNameKey: string;
}

export function stockSearchKeys(row: StockSearchRow): StockSearchKeys {
	return {
		symbolKey: foldStockSearchText(row.symbol),
		nameKey: foldStockSearchText(row.name),
		localNameKey: row.localName === null ? "" : foldStockSearchText(row.localName),
	};
}

/**
 * The text a term must be a substring of. The keys hold no newline (the fold
 * turns every whitespace into a space) and terms hold no space, so a term
 * found here lies inside one key — never across two.
 */
export function stockSearchHaystack(keys: StockSearchKeys): string {
	return `${keys.symbolKey}\n${keys.nameKey}\n${keys.localNameKey}`;
}

/** 0 exact symbol, 1 symbol prefix, 2 name or local-name prefix, 3 other match. */
export type StockSearchTier = 0 | 1 | 2 | 3;

/**
 * The row's tier for `terms`, or null when some term is missing from it (or
 * there are no terms). Only the first term decides the prefix tiers.
 */
export function stockSearchTier(
	keys: StockSearchKeys,
	terms: readonly string[],
): StockSearchTier | null {
	const first = terms[0];
	if (first === undefined) return null;
	const haystack = stockSearchHaystack(keys);
	for (const term of terms) {
		if (!haystack.includes(term)) return null;
	}
	if (terms.length === 1 && keys.symbolKey === first) return 0;
	if (keys.symbolKey.startsWith(first)) return 1;
	if (keys.nameKey.startsWith(first) || keys.localNameKey.startsWith(first)) return 2;
	return 3;
}

interface RankedRow<T extends StockSearchRow> {
	readonly row: T;
	readonly tier: StockSearchTier;
}

/**
 * Hit order: tier, then shorter symbol, then symbol, then market. Symbols and
 * markets are ASCII, so UTF-16 order here equals SQLite's BINARY order.
 */
export function compareStockSearchHits(
	a: { readonly tier: StockSearchTier; readonly row: StockSearchRow },
	b: { readonly tier: StockSearchTier; readonly row: StockSearchRow },
): number {
	if (a.tier !== b.tier) return a.tier - b.tier;
	if (a.row.symbol.length !== b.row.symbol.length) return a.row.symbol.length - b.row.symbol.length;
	if (a.row.symbol !== b.row.symbol) return a.row.symbol < b.row.symbol ? -1 : 1;
	if (a.row.market !== b.row.market) return a.row.market < b.row.market ? -1 : 1;
	return 0;
}

/**
 * Reference search: every row matching all terms, ranked, at most `limit`
 * (clamped to 1..maxResults). Used by in-memory repositories and as the
 * oracle the SQL ranking is tested against.
 */
export function rankStockSearch<T extends StockSearchRow>(
	rows: readonly T[],
	query: string,
	limit: number = STOCK_SEARCH_LIMITS.defaultResults,
): readonly T[] {
	const terms = stockSearchTerms(query);
	if (terms.length === 0) return [];
	const bounded = Math.min(Math.max(Math.trunc(limit), 1), STOCK_SEARCH_LIMITS.maxResults);
	const hits: RankedRow<T>[] = [];
	for (const row of rows) {
		const tier = stockSearchTier(stockSearchKeys(row), terms);
		if (tier !== null) hits.push({ row, tier });
	}
	hits.sort(compareStockSearchHits);
	return hits.slice(0, bounded).map((hit) => hit.row);
}
