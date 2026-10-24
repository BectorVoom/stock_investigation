import type { StockDirectoryRow } from "@research/application";

/**
 * S5 for the stock directory (ADR-0034), shared by the completion's inserts
 * and the re-key UPDATEs after a fold change: a completion carries up to
 * `STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket` rows, each bound with its
 * name, local name and four folded keys — about 1.5 MB of JSON for the US
 * list, 3 bytes a character for Japanese names. The insert is split into
 * `json_each` chunks of at most this many UTF-8 bytes of bound JSON, well
 * under 1 MB (and D1's ~2 MB string limit). Chunking by measured bytes
 * rather than a row count keeps the bound fixed whatever the name lengths
 * or NFKC expansions of a particular list.
 */
export const STOCK_DIRECTORY_CHUNK_BYTES = 512 * 1024;

/** UTF-8 length of a string, without allocating an encoded copy. */
function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				// A surrogate pair is one 4-byte character.
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else bytes += 3;
	}
	return bytes;
}

/** The bound form of one row: a positional array, about half the bytes of an object. */
type StockDirectoryTuple = readonly [
	symbol: string,
	name: string,
	localName: string | null,
	listing: string,
	symbolKey: string,
	nameKey: string,
	localNameKey: string,
	searchKey: string,
];

function stockDirectoryTuple(row: StockDirectoryRow): StockDirectoryTuple {
	return [
		row.symbol,
		row.name,
		row.localName,
		row.listing,
		row.symbolKey,
		row.nameKey,
		row.localNameKey,
		row.searchKey,
	];
}

/**
 * Packs rows into insert chunks whose serialized JSON array stays within
 * `budgetBytes` UTF-8 bytes (a single row larger than the budget still gets
 * a chunk of its own; contract limits keep a row to a few kilobytes).
 * Returns each chunk already serialized, ready to bind.
 */
export function chunkStockDirectoryRows(
	rows: readonly StockDirectoryRow[],
	budgetBytes: number = STOCK_DIRECTORY_CHUNK_BYTES,
): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	// "[" + "]" around the comma-joined rows.
	let currentBytes = 2;
	for (const row of rows) {
		const json = JSON.stringify(stockDirectoryTuple(row));
		const bytes = utf8ByteLength(json);
		const added = current.length === 0 ? bytes : bytes + 1;
		if (current.length > 0 && currentBytes + added > budgetBytes) {
			chunks.push(`[${current.join(",")}]`);
			current = [];
			currentBytes = 2;
		}
		currentBytes += current.length === 0 ? bytes : bytes + 1;
		current.push(json);
	}
	if (current.length > 0) chunks.push(`[${current.join(",")}]`);
	return chunks;
}
