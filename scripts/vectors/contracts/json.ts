/**
 * `JSON.parse` / `JSON.stringify` vectors for `research_js::json` (ADR-0030):
 * hand-picked edge cases plus a seeded corpus of generated texts (duplicate
 * keys, array-index keys, escapes, lone surrogates, odd number spellings)
 * and their one-character mutations. Expected values come from V8.
 */
import { doubleBits, seededRandom, wellFormed } from "../shared.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface ParseCase {
	readonly input: string;
	readonly ok: boolean;
	/** `JSON.stringify` of the parsed value, lone surrogates as U+FFFD. */
	readonly canonical?: string;
	/** Every number of the parsed value in enumeration order, as bit patterns. */
	readonly numbers?: readonly string[];
}

interface StringifyCase {
	readonly input: string;
	readonly gap: string | number;
	readonly output: string;
}

function wellFormedDeep(value: Json): Json {
	if (typeof value === "string") return wellFormed(value);
	if (Array.isArray(value)) return value.map(wellFormedDeep);
	if (value !== null && typeof value === "object") {
		const out: { [key: string]: Json } = {};
		// defineProperty: an own "__proto__" key must stay a plain property, as JSON.parse made it.
		for (const [key, child] of Object.entries(value)) {
			Object.defineProperty(out, wellFormed(key), {
				value: wellFormedDeep(child),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return out;
	}
	return value;
}

function numbersOf(value: Json, out: string[]): void {
	const pending: Json[] = [value];
	// Pre-order, children in enumeration order (the Rust replay walks the same way).
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (typeof next === "number") out.push(doubleBits(next));
		else if (Array.isArray(next))
			for (let i = next.length - 1; i >= 0; i -= 1) pending.push(next[i] ?? null);
		else if (next !== null && typeof next === "object") {
			const values = Object.values(next);
			for (let i = values.length - 1; i >= 0; i -= 1) pending.push(values[i] ?? null);
		}
	}
}

function parseCase(input: string): ParseCase {
	let parsed: Json;
	try {
		parsed = JSON.parse(input) as Json;
	} catch {
		return { input, ok: false };
	}
	const numbers: string[] = [];
	numbersOf(parsed, numbers);
	return { input, ok: true, canonical: JSON.stringify(wellFormedDeep(parsed)), numbers };
}

const EDGE_TEXTS = [
	"",
	" ",
	"null",
	"true",
	"false",
	"0",
	"-0",
	"-0.0",
	"0e0",
	"1E+2",
	"1e-2",
	"-1.5e-7",
	"1e21",
	"123456789012345678901234567890",
	"12345678901234567890",
	"9007199254740993",
	"1e400",
	"-1e400",
	"1e-400",
	"4.9406564584124654e-324",
	"2.4703282292062327e-324",
	"1.7976931348623157e308",
	"1.7976931348623158e308",
	"0.1",
	"0.30000000000000004",
	"01",
	"-01",
	"+1",
	".5",
	"1.",
	"1e",
	"1e+",
	"-",
	"--1",
	"0x10",
	"NaN",
	"Infinity",
	"-Infinity",
	"undefined",
	"'a'",
	'"a',
	'"\\x"',
	'"\\u12"',
	'"\\u12g4"',
	'"\\uD800"',
	'"\\uDC00"',
	'"\\uD83D\\uDE00"',
	'"\\uD83D\\u0041"',
	'"\\uD83D\\uD83D\\uDE00"',
	'"\\uDE00\\uD83D"',
	'"\\ud83d\\ude00"',
	'"\\/\\b\\f\\n\\r\\t\\"\\\\"',
	'"\t"',
	'"\n"',
	'"\u001f"',
	'"\u007f  "',
	'"\u{1F600}é"',
	"﻿1",
	" 1",
	"\u000B1",
	"\u000C1",
	" \t\n\r1 \t\n\r",
	"[1,]",
	"[,1]",
	"[1 2]",
	"[]",
	"[ ]",
	"{}",
	"{ }",
	'{"a":1,}',
	'{"a" 1}',
	"{a:1}",
	'{"a":1 "b":2}',
	'{"a":1}x',
	"[1]]",
	"[[[]]]",
	'{"b":1,"a":2,"b":3}',
	'{"10":1,"9":2,"a":3,"1":4,"0":5}',
	'{"4294967294":1,"4294967295":2,"4294967296":3,"1":4}',
	'{"01":1,"1":2,"-1":3,"1.0":4,"1e3":5," 1":6}',
	'{"__proto__":{"x":1},"a":2}',
	'{"":1,"":2}',
	'{"a":{"b":{"c":[1,{"d":null}]}}}',
	"[1e2,1E2,1e+2,100.0,-0,0]",
	"/* c */1",
	"tru",
	"nulll",
	'"unterminated',
	"[",
	"{",
	'{"a":',
];

const KEY_POOL = [
	"a",
	"b",
	"z",
	"0",
	"1",
	"2",
	"10",
	"01",
	"4294967294",
	"4294967295",
	"-1",
	"",
	"__proto__",
	"é",
	"😀",
	"1.5",
];

function randomString(random: () => number): string {
	const length = Math.floor(random() * 6);
	let out = "";
	for (let i = 0; i < length; i += 1) {
		const roll = random();
		if (roll < 0.4) out += String.fromCharCode(0x61 + Math.floor(random() * 26));
		else if (roll < 0.5)
			out += ["\\n", "\\t", '\\"', "\\\\", "\\/", "\\b", "\\f", "\\r"][Math.floor(random() * 8)];
		else if (roll < 0.6)
			out += `\\u${Math.floor(random() * 0x10000)
				.toString(16)
				.padStart(4, "0")}`;
		else if (roll < 0.65) out += "\\ud83d\\ude00";
		else if (roll < 0.7) out += "\\ud800";
		else if (roll < 0.8) out += ["é", "日", "😀", " ", "\u007f", " "][Math.floor(random() * 6)];
		else out += String.fromCharCode(0x30 + Math.floor(random() * 10));
	}
	return `"${out}"`;
}

function randomNumber(random: () => number): string {
	const roll = random();
	if (roll < 0.3) return String(Math.floor(random() * 1000) - 500);
	if (roll < 0.5) return String((random() - 0.5) * 10 ** Math.floor(random() * 40 - 20));
	if (roll < 0.6) return `${Math.floor(random() * 10)}e${Math.floor(random() * 700 - 350)}`;
	if (roll < 0.7) return `-0${random() < 0.5 ? ".0" : ""}`;
	if (roll < 0.8)
		return `${Math.floor(random() * 1e9)}${Math.floor(random() * 1e9)}${Math.floor(random() * 1e9)}`;
	return `${Math.floor(random() * 100)}.${Math.floor(random() * 1e6)}E${random() < 0.5 ? "+" : "-"}${Math.floor(random() * 30)}`;
}

function space(random: () => number): string {
	return random() < 0.8 ? "" : ([" ", "\n", "\t", "\r", "  "][Math.floor(random() * 5)] ?? "");
}

function randomText(random: () => number, depth: number): string {
	const roll = random();
	if (depth > 0 && roll < 0.25) {
		const count = Math.floor(random() * 5);
		const items = Array.from(
			{ length: count },
			() => `${space(random)}${randomText(random, depth - 1)}${space(random)}`,
		);
		return `[${items.join(",")}]`;
	}
	if (depth > 0 && roll < 0.5) {
		const count = Math.floor(random() * 6);
		const members = Array.from({ length: count }, () => {
			const key = KEY_POOL[Math.floor(random() * KEY_POOL.length)] ?? "a";
			return `${space(random)}${JSON.stringify(key)}${space(random)}:${space(random)}${randomText(random, depth - 1)}`;
		});
		return `{${members.join(",")}}`;
	}
	if (roll < 0.65) return randomString(random);
	if (roll < 0.9) return randomNumber(random);
	return ["true", "false", "null"][Math.floor(random() * 3)] ?? "null";
}

function mutate(random: () => number, text: string): string {
	const at = Math.floor(random() * (text.length + 1));
	const roll = random();
	if (roll < 0.4) return text.slice(0, at) + text.slice(at + 1);
	const insert =
		[",", "]", "}", '"', "\\", ":", "0", "-", ".", "e", " ", "\u0001"][Math.floor(random() * 12)] ??
		",";
	return text.slice(0, at) + insert + text.slice(at);
}

export function jsonVectors(): { parse: ParseCase[]; stringify: StringifyCase[] } {
	const random = seededRandom(0x15_0a_7e);
	const texts = [...EDGE_TEXTS];
	for (let i = 0; i < 1500; i += 1) texts.push(randomText(random, 4));
	for (let i = 0; i < 600; i += 1) {
		const base = texts[EDGE_TEXTS.length + Math.floor(random() * 1500)] ?? "[]";
		// A deletion can split a raw astral character; a Rust &str cannot hold the half.
		texts.push(wellFormed(mutate(random, base)));
	}
	texts.push(`${"[".repeat(1000)}${"]".repeat(1000)}`);
	texts.push(`${'{"a":'.repeat(800)}1${"}".repeat(800)}`);
	const parse = texts.map(parseCase);
	const stringify: StringifyCase[] = [];
	const gaps: readonly (string | number)[] = ["", "\t", "  ", "abcdefghijklmn", 4, 20, 0];
	for (const [index, entry] of parse.entries()) {
		if (!entry.ok) continue;
		const gap = gaps[index % gaps.length] ?? "";
		const value = wellFormedDeep(JSON.parse(entry.input) as Json);
		stringify.push({ input: JSON.stringify(value), gap, output: JSON.stringify(value, null, gap) });
	}
	return { parse, stringify };
}
