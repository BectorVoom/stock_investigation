/**
 * Systematic mutations of valid contract values (ADR-0030 decision 4): for
 * every node of a baseline value, the changes that probe a zod schema's
 * edges — a dropped key, an unknown key, a wrong type, length and range
 * boundaries found by search (ASCII, BMP and astral padding), JavaScript
 * whitespace around strings, non-ASCII digits, 2^53, every enum value the
 * schema names in its own issue. zod's verdict, issues and parsed output
 * are recorded for each, so the Rust decoder can be replayed against them.
 */
import type { z } from "zod";
import { seededRandom } from "../shared.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = readonly (string | number)[];

export interface IssueRecord {
	readonly code: string;
	readonly path: readonly (string | number)[];
	readonly message: string;
}

export interface ContractCase {
	/** The JSON text the decoder reads. */
	readonly input: string;
	readonly valid: boolean;
	/** `JSON.stringify(safeParse(input).data)` for a valid input. */
	readonly output?: string;
	/** zod's issues (code, path, message) for an invalid input. */
	readonly issues?: readonly IssueRecord[];
}

export interface MutationOptions {
	/** Nodes deeper than this are not mutated (composites rely on their parts' vectors). */
	readonly maxDepth?: number;
	/** Keep at most this many mutated cases (seeded sample). */
	readonly maxCases?: number;
	/** Skip boundary searches on arrays (large elements). */
	readonly arrayBoundaries?: boolean;
}

export function evaluate(schema: z.ZodType, input: string): ContractCase {
	const value: unknown = JSON.parse(input);
	const result = schema.safeParse(value);
	if (result.success) return { input, valid: true, output: JSON.stringify(result.data) };
	return {
		input,
		valid: false,
		issues: result.error.issues.map((issue) => ({
			code: issue.code,
			path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
			message: issue.message,
		})),
	};
}

function clone(value: Json): Json {
	return JSON.parse(JSON.stringify(value)) as Json;
}

const REMOVE = Symbol("remove");

/** A copy of `root` with the node at `path` replaced (or removed). */
function replaced(root: Json, path: Path, next: Json | typeof REMOVE): Json {
	if (path.length === 0) return next === REMOVE ? null : clone(next);
	const copy = clone(root);
	let parent: Json = copy;
	for (const segment of path.slice(0, -1)) {
		parent = (parent as Record<string | number, Json>)[segment] as Json;
	}
	const last = path[path.length - 1] as string | number;
	if (Array.isArray(parent)) {
		if (next === REMOVE) parent.splice(last as number, 1);
		else parent[last as number] = clone(next);
	} else if (parent !== null && typeof parent === "object") {
		if (next === REMOVE) delete parent[last as string];
		else {
			Object.defineProperty(parent, last as string, {
				value: clone(next),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return copy;
}

function nodesOf(root: Json, maxDepth: number): { path: Path; value: Json }[] {
	const out: { path: Path; value: Json }[] = [];
	const visit = (value: Json, path: Path) => {
		out.push({ path, value });
		if (path.length >= maxDepth) return;
		if (Array.isArray(value)) {
			for (const [index, child] of value.entries()) visit(child, [...path, index]);
		} else if (value !== null && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
		}
	};
	visit(root, []);
	return out;
}

const WHITESPACE = [
	"\t",
	"\n",
	"\u000b",
	"\f",
	"\r",
	" ",
	" ",
	" ",
	" ",
	" ",
	" ",
	" ",
	" ",
	" ",
	"　",
	"﻿",
	// Not JavaScript whitespace: Rust's char::is_whitespace disagrees on U+0085.
	"\u0085",
	"​",
	"᠎",
];

const NON_ASCII_DIGITS = ["０", "٠", "०"];

function accepts(schema: z.ZodType, root: Json, path: Path, value: Json): boolean {
	return schema.safeParse(replaced(root, path, value)).success;
}

/** Largest n in [from, cap] with `ok(n)`, assuming `ok(from)` (monotone search). */
function searchUp(ok: (n: number) => boolean, from: number, cap: number): number {
	let low = from;
	let step = 1;
	let high = from + step;
	while (high <= cap && ok(high)) {
		low = high;
		step *= 2;
		high = from + step;
	}
	if (high > cap) {
		if (ok(cap)) return cap;
		high = cap;
	}
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (ok(middle)) low = middle;
		else high = middle;
	}
	return low;
}

function stringMutations(schema: z.ZodType, root: Json, path: Path, text: string): Json[] {
	const out: Json[] = ["", "WRONG-VALUE", text.toUpperCase(), text.toLowerCase(), `${text}\u0000`];
	for (const space of WHITESPACE) out.push(`${space}${text}${space}`);
	if (/[0-9]/.test(text)) {
		for (const digit of NON_ASCII_DIGITS) out.push(text.replace(/[0-9]/, digit));
	}
	const codePoints = [...text];
	if (!accepts(schema, root, path, text)) return out;
	// Maximum length: pad the value itself, so prefixes such as "https://" stay.
	const padded = (fill: string, count: number) => text + fill.repeat(count);
	const extra = searchUp((n) => accepts(schema, root, path, padded("a", n)), 0, 9000);
	if (extra < 9000) {
		for (const fill of ["a", "é", "😀"]) {
			out.push(padded(fill, extra), padded(fill, extra + 1));
		}
	}
	// Minimum length: the shortest accepted prefix (in code points).
	if (codePoints.length > 0) {
		let shortest = codePoints.length;
		while (
			shortest > 0 &&
			accepts(schema, root, path, codePoints.slice(0, shortest - 1).join(""))
		) {
			shortest -= 1;
		}
		out.push(codePoints.slice(0, shortest).join(""));
		if (shortest > 0) out.push(codePoints.slice(0, shortest - 1).join(""));
	}
	return out;
}

const TWO_53 = 9007199254740992;

function numberMutations(schema: z.ZodType, root: Json, path: Path, value: number): Json[] {
	const out: Json[] = [
		-1,
		0,
		1,
		0.5,
		1.5,
		value + 1,
		value - 1,
		value + 0.5,
		TWO_53 - 1,
		TWO_53,
		-TWO_53,
		1e21,
		-1e-7,
	];
	if (Number.isInteger(value) && accepts(schema, root, path, value)) {
		const top = searchUp((n) => accepts(schema, root, path, value + n), 0, TWO_53);
		const bottom = searchUp((n) => accepts(schema, root, path, value - n), 0, TWO_53);
		out.push(value + top, value + top + 1, value - bottom, value - bottom - 1);
	}
	return out;
}

/** Texts JSON cannot produce from a value: `-0`, overflow to Infinity. */
function numberTexts(root: Json, path: Path): string[] {
	const marker = "__NUMBER_MARKER__";
	const template = JSON.stringify(replaced(root, path, marker));
	return ["-0", "1e400", "-1e400", "1.0", "2e0"].map((literal) =>
		template.replace(`"${marker}"`, literal),
	);
}

function wrongTypes(value: Json): Json[] {
	if (value === null) return ["null-was-here", 0];
	if (typeof value === "string") return [null, 1, ["x"], { length: 1 }];
	if (typeof value === "number") return [null, String(value), true];
	if (typeof value === "boolean") return [null, String(value), 1];
	if (Array.isArray(value)) return [null, {}, "x".repeat(3)];
	return [null, [], "x"];
}

function enumValues(schema: z.ZodType, root: Json, path: Path): Json[] {
	const result = schema.safeParse(replaced(root, path, "\u0000not-an-option"));
	if (result.success) return [];
	const out: Json[] = [];
	for (const issue of result.error.issues) {
		const values = (issue as { values?: unknown[] }).values;
		if (issue.code === "invalid_value" && Array.isArray(values)) {
			for (const option of values) if (typeof option === "string") out.push(option);
		}
	}
	return out;
}

/** Every mutation of every baseline, evaluated by zod. */
export function mutationCases(
	schema: z.ZodType,
	baselines: readonly Json[],
	options: MutationOptions = {},
	seed = 1,
): ContractCase[] {
	const maxDepth = options.maxDepth ?? 64;
	const inputs = new Set<string>();
	const add = (value: Json) => inputs.add(JSON.stringify(value));
	for (const baseline of baselines) {
		add(baseline);
		for (const { path, value } of nodesOf(baseline, maxDepth)) {
			for (const wrong of wrongTypes(value)) add(replaced(baseline, path, wrong));
			if (path.length > 0) add(replaced(baseline, path, REMOVE));
			if (value !== null && typeof value === "object" && !Array.isArray(value)) {
				add(replaced(baseline, [...path, "zzUnknownKey"], 1));
				add(replaced(baseline, [...path, "__proto__"], 1));
			}
			if (typeof value === "string") {
				for (const next of stringMutations(schema, baseline, path, value))
					add(replaced(baseline, path, next));
				for (const option of enumValues(schema, baseline, path))
					add(replaced(baseline, path, option));
			}
			if (typeof value === "number") {
				for (const next of numberMutations(schema, baseline, path, value))
					add(replaced(baseline, path, next));
				for (const text of numberTexts(baseline, path)) inputs.add(text);
			}
			if (typeof value === "boolean") add(replaced(baseline, path, !value));
			if (Array.isArray(value) && path.length > 0) {
				add(replaced(baseline, path, []));
				const first = value[0];
				if (first !== undefined && options.arrayBoundaries !== false) {
					const size = JSON.stringify(first).length;
					const cap = Math.min(2048, Math.floor(400_000 / Math.max(size, 1)));
					const filled = (count: number) => Array.from({ length: count }, () => first);
					const accepted = accepts(schema, baseline, path, value);
					if (accepted && cap > value.length) {
						const top = searchUp(
							(n) => accepts(schema, baseline, path, filled(value.length + n)),
							0,
							cap - value.length,
						);
						if (value.length + top < cap) {
							add(replaced(baseline, path, filled(value.length + top)));
							add(replaced(baseline, path, filled(value.length + top + 1)));
						}
					}
				}
			}
		}
	}
	let texts = [...inputs];
	const baselineTexts = new Set(baselines.map((baseline) => JSON.stringify(baseline)));
	if (options.maxCases !== undefined && texts.length > options.maxCases) {
		const random = seededRandom(seed);
		const rest = texts.filter((text) => !baselineTexts.has(text));
		for (let index = rest.length - 1; index > 0; index -= 1) {
			const other = Math.floor(random() * (index + 1));
			const swap = rest[index] as string;
			rest[index] = rest[other] as string;
			rest[other] = swap;
		}
		texts = [...baselineTexts, ...rest.slice(0, options.maxCases)];
	}
	return texts.map((text) => evaluate(schema, text));
}
