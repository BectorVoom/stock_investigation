import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	foldStockSearchText,
	rankStockSearch,
	type StockSearchRow,
	stockSearchKeys,
	stockSearchTerms,
	stockSearchTier,
} from "../../src/watchlist/stockSearch.ts";

/**
 * Conformance between the stock directory search and its Lean 4 model,
 * `formal/ResearchFormal/StockSearch.lean` (ADR-0034).
 *
 * The theorems (soundness, completeness, order, fold idempotence, no
 * cross-field match, exact symbol first) are about the Lean definitions.
 * `formal/Export.lean` evaluates those verified definitions and writes the
 * `stockSearch` family of `formal/vectors.json`; every vector is replayed here
 * against the TypeScript, so a divergence between model and code fails this
 * suite.
 *
 * The model starts after NFKC and counts code points where the TypeScript
 * counts UTF-16 units, so the premises are checked first: every vector string
 * is NFKC-stable and inside the Basic Multilingual Plane.
 */

// The domain project typechecks without Node globals, so the vectors come in
// through a JSON module import (resolved by Vite at test time) and are parsed
// with zod like every other boundary.
const VECTORS_PATH = new URL("../../../../formal/vectors.json", import.meta.url).pathname;

const row = z.object({
	market: z.enum(["US", "JP"]),
	symbol: z.string(),
	name: z.string(),
	localName: z.string().nullable(),
});
const tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).nullable();

const stockSearchVectors = z.object({
	stockSearch: z.object({
		rows: z.array(row),
		fold: z.array(z.object({ input: z.string(), folded: z.string() })),
		tier: z.array(
			z.object({ query: z.string(), terms: z.array(z.string()), tiers: z.array(tier) }),
		),
		rank: z.array(
			z.object({
				order: z.enum(["forward", "reversed"]),
				query: z.string(),
				limit: z.number().int(),
				ranked: z.array(z.number().int().nonnegative()),
			}),
		),
	}),
});

const jsonModule = z.object({ default: stockSearchVectors });
const imported: unknown = await import(/* @vite-ignore */ VECTORS_PATH, {
	with: { type: "json" },
});
const vectors = jsonModule.parse(imported).default.stockSearch;

/** The rows, as the objects `rankStockSearch` returns by identity. */
const rows: readonly StockSearchRow[] = vectors.rows;

const isNfkcStable = (text: string): boolean => text.normalize("NFKC") === text;
/** No surrogate pairs: UTF-16 length and order then equal code-point ones. */
const isBmp = (text: string): boolean => [...text].length === text.length;

describe("Lean model conformance: stock directory search", () => {
	it("stays inside the model's premises (NFKC-stable, BMP text)", () => {
		const texts = [
			...vectors.fold.flatMap((vector) => [vector.input, vector.folded]),
			...vectors.tier.map((vector) => vector.query),
			...rows.flatMap((entry) => [entry.market, entry.symbol, entry.name, entry.localName ?? ""]),
		];
		for (const text of texts) {
			expect(isNfkcStable(text), JSON.stringify(text)).toBe(true);
			expect(isBmp(text), JSON.stringify(text)).toBe(true);
		}
	});

	it(`agrees with foldStockSearchText on all ${vectors.fold.length} vectors`, () => {
		expect(vectors.fold.length).toBe(74);
		for (const vector of vectors.fold) {
			expect(foldStockSearchText(vector.input), JSON.stringify(vector)).toBe(vector.folded);
			// `fold_idem`, carried over: the output is NFKC-stable, so folding again is the identity.
			expect(foldStockSearchText(vector.folded), JSON.stringify(vector)).toBe(vector.folded);
		}
	});

	it(`agrees with stockSearchTerms and stockSearchTier on all ${vectors.tier.length} queries`, () => {
		expect(vectors.tier.length).toBe(51);
		expect(rows.length).toBe(18);
		for (const vector of vectors.tier) {
			const terms = stockSearchTerms(vector.query);
			expect(terms, JSON.stringify(vector.query)).toEqual(vector.terms);
			expect(vector.tiers.length).toBe(rows.length);
			rows.forEach((entry, index) => {
				const label = `${JSON.stringify(vector.query)} row ${index}`;
				expect(stockSearchTier(stockSearchKeys(entry), terms), label).toBe(vector.tiers[index]);
			});
		}
	});

	it(`agrees with rankStockSearch on all ${vectors.rank.length} vectors`, () => {
		expect(vectors.rank.length).toBe(816);
		const reversed = [...rows].reverse();
		for (const vector of vectors.rank) {
			const ordered = vector.order === "forward" ? rows : reversed;
			const ranked = rankStockSearch(ordered, vector.query, vector.limit);
			expect(
				ranked.map((hit) => rows.indexOf(hit)),
				JSON.stringify({ order: vector.order, query: vector.query, limit: vector.limit }),
			).toEqual(vector.ranked);
		}
	});
});
