/**
 * Model-text helpers shared by every tool and prompt: `extractJsonObject`,
 * `fenceUntrustedText` (crate `research-agent-core`) and `boundModelText`
 * (crate `research-tools`, module `shared`).
 */
import { extractJsonObject, fenceUntrustedText } from "@research/agent-core";
import { boundModelText } from "../../packages/adapters/src/tools/shared.ts";
import { seededRandom, type VectorExporter, wellFormed } from "./shared.ts";

// A lone surrogate (`"\ud800"`) is the crate-wide U+FFFD divergence, pinned by
// vectors/js/json.json; it is not repeated here.
const EXTRACT_CASES = [
	"",
	"no braces",
	"{",
	"}",
	"{}",
	'{"a":1}',
	'Plan: {"a": "}{", "b": [1]} trailing {"c":2}',
	'{not json} then {"ok":true}',
	'{"esc":"\\"}"} rest',
	'{"k":"\\\\"}',
	'{"u":"\\u00e9😀"}',
	'é{"k":"\\"😀"}',
	'```json\n{"plan": {"steps": [1, 2, 3]}}\n```',
	'{"a": {"b": {"c": {}}}}}}',
	'{"dup":1,"dup":2}',
	'{"1":"x","b":"y","0":"z"}',
	'{"n": 1e400}',
	'{"n": -0}',
	"[1, 2, 3]",
	'{"trailing": 1,}',
	`${"{x} ".repeat(16)}{"late":1}`,
	`${"{x} ".repeat(15)}{"in":1}`,
	"{ unbalanced { still",
	'{"a":"unterminated}',
	'{"text": "line\nbreak"}',
];

function generatedTexts(): string[] {
	const random = seededRandom(41);
	const pieces = [
		"{",
		"}",
		'"',
		"\\",
		":",
		",",
		"a",
		"1",
		" ",
		"\n",
		"[",
		"]",
		"é",
		"😀",
		'{"k":1}',
		'"s"',
		"null",
		"true",
	];
	const texts: string[] = [];
	for (let index = 0; index < 3000; index += 1) {
		let text = "";
		const length = Math.floor(random() * 30);
		for (let piece = 0; piece < length; piece += 1) {
			text += pieces[Math.floor(random() * pieces.length)] ?? "";
		}
		texts.push(text);
	}
	return texts;
}

function generatedLineSets(): string[][] {
	const random = seededRandom(42);
	const alphabets = ["a", "é", "日", "😀", " "];
	const sets: string[][] = [];
	for (let index = 0; index < 400; index += 1) {
		const lines: string[] = [];
		const count = 1 + Math.floor(random() * 6);
		for (let line = 0; line < count; line += 1) {
			const alphabet = alphabets[Math.floor(random() * alphabets.length)] ?? "a";
			lines.push(alphabet.repeat(Math.floor(random() * 3000)));
		}
		sets.push(lines);
	}
	return sets;
}

export const modelTextExporter: VectorExporter = {
	name: "model-text",
	async build() {
		const texts = [...EXTRACT_CASES, ...generatedTexts()];
		const lineSets = [[], [""], ["a", "b"], ...generatedLineSets()];
		const fences = [
			["page", "plain text", "tok"],
			["page", "a tok<tok>en b", "tok"],
			["x", "totokenken", "token"],
			["label with spaces", "multi\nline\ncontent", "0e7c6f2a-1b2c-4d5e-8f90-123456789abc"],
			["x", "😀token😀", "token"],
		];
		return [
			{
				path: "model-text/extract-json-object.json",
				content: texts.map((input) => {
					const result = extractJsonObject(input);
					return {
						input,
						output: result.ok ? { ok: JSON.stringify(result.value) } : { err: result.error },
					};
				}),
			},
			{
				path: "model-text/fence.json",
				content: fences.map(([label = "", text = "", token = ""]) => ({
					label,
					text,
					token,
					output: fenceUntrustedText(label, text, token),
				})),
			},
			{
				path: "model-text/bound-model-text.json",
				content: lineSets.map((lines) => ({ lines, output: wellFormed(boundModelText(lines)) })),
			},
		];
	},
};
