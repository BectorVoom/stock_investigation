import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	articleMention,
	mentionLikePattern,
	type StockMentionTerm,
	termOccurs,
	termOccursAt,
} from "../../src/news/stockMentions.ts";

/**
 * Conformance between the stock mention matcher and its Lean 4 model,
 * `formal/ResearchFormal/StockMentions.lean` (ADR-0049 §7–§8).
 *
 * The theorems (soundness, first term in term order, word boundaries, the
 * `LIKE` prefilter never drops a true mention) are about the Lean
 * definitions. `formal/Export.lean` evaluates those verified definitions and
 * writes the `stockMentions` family of `formal/vectors.json`; every vector is
 * replayed here against the TypeScript, so a divergence between model and
 * code fails this suite. The model's `LIKE` is replayed against real SQLite
 * (`node:sqlite`, the engine D1 runs), so the model of the prefilter is
 * checked too, not only assumed.
 *
 * The model reads text as UTF-16 code units, as the TypeScript does; the
 * premise checked first is that every vector string is well-formed UTF-16
 * (stored text and terms are), which the SQLite argument needs.
 */

// The domain project typechecks without Node globals, so the vectors come in
// through a JSON module import (resolved by Vite at test time) and SQLite
// through a module specifier held in a variable; both are parsed with zod
// like every other boundary.
const VECTORS_PATH = new URL("../../../../formal/vectors.json", import.meta.url).pathname;
const SQLITE_MODULE = "node:sqlite";

const index = z.number().int().nonnegative();
const term = z.object({ text: z.string(), kind: z.enum(["name", "symbol"]) });

const stockMentionsVectors = z.object({
	stockMentions: z.object({
		terms: z.array(term),
		texts: z.array(z.string()),
		occurs: z.array(
			z.object({ text: index, term: index, positions: z.array(index), occurs: z.boolean() }),
		),
		pattern: z.array(z.object({ term: index, pattern: z.string() })),
		like: z.array(z.object({ text: index, pattern: z.string(), matches: z.boolean() })),
		mention: z.array(
			z.object({
				terms: z.array(index),
				texts: z.array(index.nullable()),
				mention: index.nullable(),
				prefilter: z.boolean(),
			}),
		),
	}),
});

const imported: unknown = await import(/* @vite-ignore */ VECTORS_PATH, {
	with: { type: "json" },
});
const vectors = z.object({ default: stockMentionsVectors }).parse(imported).default.stockMentions;

interface LikeStatement {
	get(text: string, pattern: string): unknown;
}
interface LikeDatabase {
	prepare(sql: string): LikeStatement;
	close(): void;
}
const sqliteModule = z.object({
	DatabaseSync: z.custom<new (path: string) => LikeDatabase>(
		(value) => typeof value === "function",
	),
});
const { DatabaseSync } = sqliteModule.parse(await import(/* @vite-ignore */ SQLITE_MODULE));
const db = new DatabaseSync(":memory:");
afterAll(() => db.close());
// The API's prefilter: `LIKE` with `\` as the escape, SQLite's default ASCII-only case folding.
const likeStatement = db.prepare("SELECT ? LIKE ? ESCAPE '\\' AS matches");
const likeRow = z.object({ matches: z.union([z.literal(0), z.literal(1)]) });
const sqliteLike = (text: string, pattern: string): boolean =>
	likeRow.parse(likeStatement.get(text, pattern)).matches === 1;

/** The terms as `StockMentionTerm` objects; `articleMention` returns them by identity. */
const terms: readonly StockMentionTerm[] = vectors.terms;
const texts: readonly string[] = vectors.texts;

const termAt = (at: number): StockMentionTerm => {
	const found = terms[at];
	if (found === undefined) throw new Error(`no vector term ${at}`);
	return found;
};
const textAt = (at: number): string => {
	const found = texts[at];
	if (found === undefined) throw new Error(`no vector text ${at}`);
	return found;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** A lone surrogate does not survive UTF-8 and back. */
const isWellFormed = (text: string): boolean => decoder.decode(encoder.encode(text)) === text;

describe("Lean model conformance: stock mentions", () => {
	it("stays inside the model's premise (well-formed UTF-16)", () => {
		for (const text of [...texts, ...terms.map((entry) => entry.text)]) {
			expect(isWellFormed(text), JSON.stringify(text)).toBe(true);
		}
		// The grid reaches outside the Basic Multilingual Plane, where units and code points differ.
		expect(texts.some((text) => [...text].length !== text.length)).toBe(true);
	});

	it(`agrees with termOccursAt and termOccurs on all ${vectors.occurs.length} vectors`, () => {
		expect(vectors.occurs.length).toBe(texts.length * terms.length);
		expect(vectors.occurs.length).toBe(779);
		for (const vector of vectors.occurs) {
			const text = textAt(vector.text);
			const searched = termAt(vector.term);
			const label = JSON.stringify({ text, term: searched });
			const positions: number[] = [];
			// One index beyond either end too: the TypeScript rejects them as the model does.
			for (let at = -1; at <= text.length + 1; at += 1) {
				if (termOccursAt(text, searched, at)) positions.push(at);
			}
			expect(positions, label).toEqual(vector.positions);
			expect(termOccurs(text, searched), label).toBe(vector.occurs);
		}
	});

	it(`agrees with mentionLikePattern on all ${vectors.pattern.length} terms`, () => {
		expect(vectors.pattern.length).toBe(terms.length);
		for (const vector of vectors.pattern) {
			const searched = termAt(vector.term);
			expect(mentionLikePattern(searched), JSON.stringify(searched)).toBe(vector.pattern);
		}
	});

	it(`the LIKE model agrees with SQLite on all ${vectors.like.length} vectors`, () => {
		expect(vectors.like.length).toBe(1508);
		for (const vector of vectors.like) {
			const text = textAt(vector.text);
			expect(
				sqliteLike(text, vector.pattern),
				JSON.stringify({ text, pattern: vector.pattern }),
			).toBe(vector.matches);
		}
	});

	it("SQLite never drops a true mention (the prefilter theorem, on the real engine)", () => {
		let occurrences = 0;
		for (const vector of vectors.occurs) {
			if (!vector.occurs) continue;
			occurrences += 1;
			const text = textAt(vector.text);
			const searched = termAt(vector.term);
			expect(
				sqliteLike(text, mentionLikePattern(searched)),
				JSON.stringify({ text, term: searched }),
			).toBe(true);
		}
		expect(occurrences).toBeGreaterThan(30);
	});

	it(`agrees with articleMention and the prefilter on all ${vectors.mention.length} articles`, () => {
		expect(vectors.mention.length).toBe(456);
		for (const vector of vectors.mention) {
			const searched = vector.terms.map(termAt);
			const articleTexts = vector.texts.map((at) => (at === null ? null : textAt(at)));
			const label = JSON.stringify({ terms: searched, texts: articleTexts });
			const found = articleMention(articleTexts, searched);
			expect(found === null ? null : searched.indexOf(found), label).toBe(vector.mention);
			// The SQL keeps an article when any term's pattern matches any non-null text.
			const prefilter = searched.some((entry) =>
				articleTexts.some((text) => text !== null && sqliteLike(text, mentionLikePattern(entry))),
			);
			expect(prefilter, label).toBe(vector.prefilter);
		}
	});
});
