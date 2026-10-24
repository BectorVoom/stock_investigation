import { stockDirectoryRows } from "@research/application";
import { STOCK_DIRECTORY_LIMITS, type StockDirectoryEntry } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	chunkStockDirectoryRows,
	STOCK_DIRECTORY_CHUNK_BYTES,
} from "../../src/sql/stockDirectoryChunks.ts";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** The worst case per row: longest names, Japanese (3 UTF-8 bytes a character) and astral emoji. */
function maximalJpEntries(): StockDirectoryEntry[] {
	return Array.from({ length: STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket }, (_, index) => {
		const symbol = `${1000 + (index % 9000)}`;
		const name = `${"株式会社テスト😀".repeat(30)}`.slice(0, STOCK_DIRECTORY_LIMITS.maxNameChars);
		return { symbol, name, localName: name, listing: "tse-prime" as const };
	});
}

describe("stock directory insert chunking (S5, ADR-0034)", () => {
	it("keeps every chunk within the byte budget and every row in order", () => {
		const rows = stockDirectoryRows("JP", maximalJpEntries());
		const chunks = chunkStockDirectoryRows(rows);
		expect(chunks.length).toBeGreaterThan(10);
		const decoded: unknown[] = [];
		for (const chunk of chunks) {
			expect(bytes(chunk)).toBeLessThanOrEqual(STOCK_DIRECTORY_CHUNK_BYTES);
			const parsed: unknown = JSON.parse(chunk);
			if (!Array.isArray(parsed)) throw new Error("a chunk is a JSON array");
			decoded.push(...parsed);
		}
		expect(decoded).toHaveLength(rows.length);
		expect(decoded[0]).toEqual([
			rows[0]?.symbol,
			rows[0]?.name,
			rows[0]?.localName,
			"tse-prime",
			rows[0]?.symbolKey,
			rows[0]?.nameKey,
			rows[0]?.localNameKey,
			rows[0]?.searchKey,
		]);
		expect(decoded.map((tuple) => (Array.isArray(tuple) ? tuple[0] : null))).toEqual(
			rows.map((row) => row.symbol),
		);
	});

	it("counts UTF-8 bytes exactly at the budget edge", () => {
		const rows = stockDirectoryRows("US", [
			{ symbol: "A", name: "Ａ😀é", listing: "nyse" },
			{ symbol: "B", name: "Plain", listing: "nyse" },
		]);
		const one = chunkStockDirectoryRows(rows, Number.MAX_SAFE_INTEGER);
		expect(one).toHaveLength(1);
		const exact = bytes(one[0] ?? "");
		// A budget of exactly the array's size keeps one chunk; one byte less splits it.
		expect(chunkStockDirectoryRows(rows, exact)).toHaveLength(1);
		expect(chunkStockDirectoryRows(rows, exact - 1)).toHaveLength(2);
	});

	it("gives a row larger than the budget a chunk of its own, and no rows no chunks", () => {
		const rows = stockDirectoryRows("US", [
			{ symbol: "A", name: "Alpha", listing: "nyse" },
			{ symbol: "B", name: "Beta", listing: "nyse" },
		]);
		expect(chunkStockDirectoryRows(rows, 10)).toHaveLength(2);
		expect(chunkStockDirectoryRows([])).toEqual([]);
	});
});
