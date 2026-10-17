/**
 * JavaScript primitives (crate `research-js`): number formatting, UTF-16
 * lengths and slices, whitespace, `encodeURIComponent`, `JSON.stringify` of
 * strings. Expected values come from V8 itself.
 */
import {
	doubleBits,
	randomDouble,
	seededRandom,
	type VectorExporter,
	wellFormed,
} from "./shared.ts";

const SPECIAL_NUMBERS = [
	0,
	-0,
	1,
	-1,
	0.1,
	0.2,
	0.1 + 0.2,
	1 / 3,
	2 / 3,
	10,
	100,
	1e20,
	1e21,
	1e22,
	123456789012345680000,
	9007199254740991,
	9007199254740992,
	-9007199254740992 - 1,
	1e-6,
	1e-7,
	1.5e-7,
	0.000001,
	0.0000012345,
	5e-324,
	2.2250738585072014e-308,
	1.7976931348623157e308,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	0.125,
	0.375,
	1.005,
	2.5,
	-2.5,
	99.995,
	1.45,
	8.345,
	1234.5678,
	0.5,
	-0.5,
	4.35,
	0.045,
	1e15 + 0.3,
	12.345e10,
];

function numberCorpus(): number[] {
	const random = seededRandom(20261017);
	const values = [...SPECIAL_NUMBERS];
	for (let exponent = -30; exponent <= 30; exponent += 1) {
		values.push(10 ** exponent, 1.5 * 10 ** exponent, -7.25 * 10 ** exponent);
	}
	for (let index = 0; index < 400; index += 1) values.push(randomDouble(random));
	for (let index = 0; index < 400; index += 1) {
		// Money- and percentage-sized values: where toFixed is actually used.
		values.push(Math.round(random() * 1e7) / 10 ** Math.floor(random() * 6));
		values.push((random() - 0.5) * 10 ** Math.floor(random() * 12));
	}
	return values;
}

const STRINGS = [
	"",
	"plain ascii",
	"é accent",
	"😀 emoji",
	"a😀b😀c",
	"日本語のテキスト",
	"\u{FEFF}bom",
	"\u{0085}nel",
	" \t\n\v\f\r\u{00A0}\u{1680}\u{2000}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}x y\u{3000}",
	'quote " backslash \\ slash /',
	"\u{0000}\u{0001}\u{0008}\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{001F}\u{007F}\u{2028}\u{2029}",
	"a&b=c/d?e#f g+h%i",
	"-_.!~*'()",
	"𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
];

export const jsExporter: VectorExporter = {
	name: "js",
	async build() {
		const numbers = numberCorpus();
		const fixedDigits = [0, 1, 2, 3, 6, 20];
		const toFixedCases = numbers
			.filter((value) => Number.isFinite(value))
			.flatMap((value) =>
				fixedDigits.map((digits) => ({
					bits: doubleBits(value),
					digits,
					output: value.toFixed(digits),
				})),
			);
		const whitespace: number[] = [];
		for (let code = 0; code <= 0xffff; code += 1) {
			if (code >= 0xd800 && code <= 0xdfff) continue;
			if (/\s/.test(String.fromCharCode(code))) whitespace.push(code);
		}
		const sliceCases = STRINGS.flatMap((text) => {
			const cases: { input: string; start: number; end: number; output: string }[] = [];
			for (let start = 0; start <= text.length; start += 1) {
				for (let end = start; end <= text.length + 1; end += 1) {
					const output = text.slice(start, end);
					// A Rust String cannot hold a lone surrogate; the port writes U+FFFD (crate docs).
					cases.push({ input: text, start, end, output: wellFormed(output) });
				}
			}
			return cases;
		});
		return [
			{
				path: "js/number.json",
				content: {
					toString: numbers.map((value) => ({ bits: doubleBits(value), output: String(value) })),
					toFixed: toFixedCases,
				},
			},
			{
				path: "js/string.json",
				content: {
					whitespace,
					length: STRINGS.map((input) => ({ input, output: input.length })),
					trim: STRINGS.map((input) => ({ input, output: input.trim() })),
					collapse: STRINGS.map((input) => ({ input, output: input.replace(/\s+/g, " ") })),
					slice: sliceCases,
					encodeURIComponent: STRINGS.map((input) => ({
						input,
						output: encodeURIComponent(input),
					})),
					jsonQuote: STRINGS.map((input) => ({ input, output: JSON.stringify(input) })),
				},
			},
		];
	},
};
