import type { StockDirectoryEntry, StockListing, WatchMarket } from "@research/contracts";

/**
 * Deterministic stock-directory fixtures (ADR-0034): seeded generators for
 * full-size lists and search queries, so the SQL-versus-reference tests and
 * the timing run on the same rows every time.
 */

/** mulberry32: a tiny seeded PRNG; the same seed always yields the same sequence. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export function pick<T>(random: () => number, items: readonly T[]): T {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

const US_WORDS = [
	"Apple",
	"Alpha",
	"Global",
	"Holdings",
	"Inc.",
	"Corp",
	"Technologies",
	"Bank",
	"Energy",
	"Pharma",
	"Capital",
	"Trust",
	"Group",
	"Systems",
	"Toyota",
	"Sony",
	"Motor",
	"AT&T",
	"Micro",
	"Devices",
	"Bio",
	"Realty",
	"Acquisition",
	"Partners",
	"L.P.",
	"Co",
	"Ltd",
	"Semiconductor",
	"Software",
	"Networks",
];

const JP_LOCAL_WORDS = [
	"トヨタ",
	"自動車",
	"ソニー",
	"グループ",
	"銀行",
	"ホールディングス",
	"電機",
	"日本",
	"製薬",
	"商事",
	"工業",
	"化学",
	"ﾃﾞﾝｷ",
	"株式会社",
	"ＮＴＴ",
	"データ",
	"三菱",
	"ＵＦＪ",
	"フィナンシャル",
	"ゆうちょ",
	"エレクトロン",
	"東京",
	"ヤマハ",
];

const JP_ENGLISH_WORDS = [
	"Toyota",
	"Motor",
	"Corporation",
	"Sony",
	"Group",
	"Bank",
	"Holdings",
	"Electric",
	"Japan",
	"Pharmaceutical",
	"Trading",
	"Industries",
	"Chemical",
	"NTT",
	"Data",
	"Mitsubishi",
	"UFJ",
	"Financial",
	"Tokyo",
	"Electron",
	"Yamaha",
	"Co.,Ltd.",
];

function words(random: () => number, list: readonly string[], min: number, max: number): string {
	const count = min + Math.floor(random() * (max - min + 1));
	return Array.from({ length: count }, () => pick(random, list)).join(" ");
}

function usSymbol(random: () => number): string {
	const length = 1 + Math.floor(random() * 5);
	let symbol = pick(random, [...LETTERS]);
	for (let index = 1; index < length; index += 1) {
		const roll = random();
		symbol +=
			roll < 0.85
				? pick(random, [...LETTERS])
				: roll < 0.93
					? pick(random, [...DIGITS])
					: pick(random, [".", "-"]);
	}
	return symbol;
}

function jpSymbol(random: () => number): string {
	let symbol = pick(random, [...DIGITS.slice(1)]);
	for (let index = 1; index < 4; index += 1) {
		symbol += random() < 0.95 || index < 3 ? pick(random, [...DIGITS]) : pick(random, [...LETTERS]);
	}
	return symbol;
}

/** `count` distinct US entries (English names only), seeded. */
export function generateUsEntries(seed: number, count: number): StockDirectoryEntry[] {
	const random = seededRandom(seed);
	const seen = new Set<string>();
	const entries: StockDirectoryEntry[] = [];
	const listings: readonly StockListing[] = ["nasdaq", "nyse", "cboe", "txse"];
	while (entries.length < count) {
		const symbol = usSymbol(random);
		if (seen.has(symbol)) continue;
		seen.add(symbol);
		entries.push({ symbol, name: words(random, US_WORDS, 1, 4), listing: pick(random, listings) });
	}
	return entries;
}

/** `count` distinct JP entries (English and Japanese names), seeded. */
export function generateJpEntries(seed: number, count: number): StockDirectoryEntry[] {
	const random = seededRandom(seed);
	const seen = new Set<string>();
	const entries: StockDirectoryEntry[] = [];
	const listings: readonly StockListing[] = ["tse-prime", "tse-standard", "tse-growth"];
	while (entries.length < count) {
		const symbol = jpSymbol(random);
		if (seen.has(symbol)) continue;
		seen.add(symbol);
		entries.push({
			symbol,
			name: words(random, JP_ENGLISH_WORDS, 1, 4),
			localName: words(random, JP_LOCAL_WORDS, 1, 3).replaceAll(" ", ""),
			listing: pick(random, listings),
		});
	}
	return entries;
}

/** A row as the reference ranking reads it. */
export interface ReferenceRow {
	readonly market: WatchMarket;
	readonly symbol: string;
	readonly name: string;
	readonly localName: string | null;
}

export function referenceRows(market: WatchMarket, entries: readonly StockDirectoryEntry[]) {
	return entries.map(
		(entry): ReferenceRow => ({
			market,
			symbol: entry.symbol,
			name: entry.name,
			localName: entry.localName ?? null,
		}),
	);
}

const KATAKANA_FIRST = 0x30a1;
const KATAKANA_LAST = 0x30f6;

/** Katakana to hiragana: the owner types "とよた" for "トヨタ". */
function toHiragana(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		out +=
			code >= KATAKANA_FIRST && code <= KATAKANA_LAST ? String.fromCodePoint(code - 0x60) : char;
	}
	return out;
}

/** ASCII letters and digits to their full-width forms (an IME's "ＡＰＰＬＥ"). */
function toFullWidth(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		out += code > 0x20 && code < 0x7f ? String.fromCodePoint(code + 0xfee0) : char;
	}
	return out;
}

function substringOf(random: () => number, text: string): string {
	const chars = [...text];
	if (chars.length === 0) return "x";
	const start = Math.floor(random() * chars.length);
	const length = 1 + Math.floor(random() * Math.min(6, chars.length - start));
	return chars.slice(start, start + length).join("");
}

/**
 * Seeded search queries over `rows`: substrings of symbols, names and local
 * names, case-changed, hiragana and full-width variants, multi-term queries
 * with assorted whitespace, single characters and strings that match nothing.
 */
export function generateQueries(
	seed: number,
	rows: readonly ReferenceRow[],
	count: number,
): string[] {
	const random = seededRandom(seed);
	const queries: string[] = [];
	const separators = [" ", "  ", "　", "\t", " 　 "];
	const fragment = (): string => {
		const row = pick(random, rows);
		const field = random();
		const source =
			field < 0.35 ? row.symbol : field < 0.75 || row.localName === null ? row.name : row.localName;
		let text = substringOf(random, source);
		const variant = random();
		if (variant < 0.2) text = text.toUpperCase();
		else if (variant < 0.35) text = text.toLowerCase();
		else if (variant < 0.5) text = toHiragana(text);
		else if (variant < 0.6) text = toFullWidth(text);
		return text;
	};
	while (queries.length < count) {
		const kind = random();
		if (kind < 0.55) queries.push(fragment());
		else if (kind < 0.8) {
			const terms = 2 + Math.floor(random() * 4);
			queries.push(
				Array.from({ length: terms }, fragment)
					.map((term, index) => (index === 0 ? term : `${pick(random, separators)}${term}`))
					.join(""),
			);
		} else if (kind < 0.9)
			queries.push(pick(random, [...LETTERS, ...DIGITS, "ト", "と", "&", "."]));
		else queries.push(pick(random, ["zzzqx", "ヴヴヴ", "q9q9", "  ", "银行", "Ｚｚｚ"]));
	}
	return queries;
}
