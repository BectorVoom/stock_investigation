import type { StockDirectorySource, StockDirectorySourceRegistry } from "@research/application";
import {
	isoDateSchema,
	STOCK_DIRECTORY_LIMITS,
	type StockDirectoryEntry,
	stockDirectoryEntrySchema,
	type WatchMarket,
} from "@research/contracts";
import { ok } from "@research/domain";
import { z } from "zod";
import { STOCK_DIRECTORY_FIXTURE_DATA } from "./fixtures.ts";

/**
 * Canned stock lists for the browser E2E run (ADR-0033): the stock-directory
 * sources answer these lists instead of SEC and JPX — no keys, no network.
 * The data lives in `fixtures/e2e-fixtures.json` (`stockDirectory`), which
 * the Rust E2E runner (`research-runner-testkit`) reads too, so both
 * runners store the same rows.
 *
 * Each market has a few named rows the specs search for (Apple, Toyota,
 * Microsoft; トヨタ, 日野, ソニー) and generated padding rows
 * (`ZA000` … "Fixture Company 1" …, `9000` … "Fixture Company 1" /
 * "フィクスチャ 1" …) up to the contract's floor
 * (`STOCK_DIRECTORY_LIMITS.minEntriesPerMarket`), below which the API
 * refuses a list.
 */

const paddingSchema = z.strictObject({
	symbolPrefix: z.string(),
	digits: z.number().int().min(1).max(6),
	name: z.string(),
	localName: z.string().nullable(),
	listing: stockDirectoryEntrySchema.shape.listing,
});
const marketSchema = z.strictObject({
	asOf: isoDateSchema.nullable(),
	entries: z.array(stockDirectoryEntrySchema).min(1),
	padding: paddingSchema,
});
const fixtureSchema = z.strictObject({ US: marketSchema, JP: marketSchema });

/** The fixture file, validated against the public contract. */
const fixtures = fixtureSchema.parse(STOCK_DIRECTORY_FIXTURE_DATA);

/** The named rows per market, as the specs type and see them. */
export const DIRECTORY_FIXTURE_ROWS: {
	readonly [M in WatchMarket]: readonly StockDirectoryEntry[];
} = { US: fixtures.US.entries, JP: fixtures.JP.entries };

/** The date each canned list states (JPX does, SEC does not). */
export const DIRECTORY_FIXTURE_AS_OF: { readonly [M in WatchMarket]: string | null } = {
	US: fixtures.US.asOf,
	JP: fixtures.JP.asOf,
};

/** One named row by market and symbol (throws on a typo, so a spec fails loudly). */
export function directoryFixtureRow(market: WatchMarket, symbol: string): StockDirectoryEntry {
	const row = DIRECTORY_FIXTURE_ROWS[market].find((entry) => entry.symbol === symbol);
	if (row === undefined) throw new Error(`no ${market} directory fixture for ${symbol}`);
	return row;
}

/**
 * The full canned list of a market: the named rows, then padding rows
 * numbered from 1 (`{n}` in the templates) up to exactly the floor. The Rust
 * testkit builds the same rows from the same file.
 */
export function fixtureDirectoryEntries(market: WatchMarket): StockDirectoryEntry[] {
	const { entries, padding } = fixtures[market];
	const rows: StockDirectoryEntry[] = [...entries];
	const count = STOCK_DIRECTORY_LIMITS.minEntriesPerMarket - entries.length;
	for (let n = 1; n <= count; n += 1) {
		const fill = (template: string): string => template.replaceAll("{n}", String(n));
		rows.push(
			stockDirectoryEntrySchema.parse({
				symbol: `${padding.symbolPrefix}${String(n - 1).padStart(padding.digits, "0")}`,
				name: fill(padding.name),
				...(padding.localName === null ? {} : { localName: fill(padding.localName) }),
				listing: padding.listing,
			}),
		);
	}
	return rows;
}

function fixtureSource(market: WatchMarket): StockDirectorySource {
	const data = { asOf: fixtures[market].asOf, entries: fixtureDirectoryEntries(market) };
	return { market, fetchDirectory: () => Promise.resolve(ok(data)) };
}

/** Both markets' canned sources, keyed like the runner's registry. */
export function fixtureStockDirectorySources(): StockDirectorySourceRegistry {
	return new Map([
		["US", fixtureSource("US")],
		["JP", fixtureSource("JP")],
	]);
}
