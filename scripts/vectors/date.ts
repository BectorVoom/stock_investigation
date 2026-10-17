/**
 * V8 `Date.parse` and `Date.prototype.toISOString` (crate `research-js`,
 * module `date`). The runner hands untrusted text to `Date.parse` (feed
 * timestamps, `article:published_time`), and V8 falls back to a lenient
 * legacy parser for anything that is not ECMA-262's format, so the corpus
 * covers the feed timestamp shapes exhaustively and a large seeded token
 * soup of real-world and malformed strings.
 *
 * Text without a zone is local time, so every case is parsed twice, with the
 * process zone switched to UTC and to Etc/GMT-9 (a fixed +09:00 offset); the
 * Rust test replays both with the same fixed zones.
 */
import { seededRandom, type VectorExporter } from "./shared.ts";

/** Real-world shapes (RSS, Atom, meta tags, HTTP dates) and known V8 quirks. */
const LITERALS = [
	"Mon, 05 Oct 2026 09:30:00 GMT",
	"Mon, 05 Oct 2026 09:30:00 gmt",
	"Sat, 10 Oct 2026 21:00:00 +0900",
	"Sat, 10 Oct 2026 12:00:00 GMT",
	"Sat, 10 Oct 2026 12:00:00",
	"Sat,10 Oct 2026 12:00:00 GMT",
	"10 Oct 2026 12:00 EST",
	"10 Oct 2026 12:00 edt",
	"10 Oct 2026 12:00:61 UTC",
	"10 Oct 2026 12:60 UTC",
	"10 Oct 2026 25:00 UTC",
	"31 Feb 2026 10:00 GMT",
	"0 Jan 2026 10:00 GMT",
	"32 Jan 2026 10:00 GMT",
	"1 Jan 0049 00:00 GMT",
	"1 Jan 0050 00:00 GMT",
	"1 Jan 0099 00:00 GMT",
	"1 Jan 0100 00:00 GMT",
	"1 Jan 12345 00:00 GMT",
	"32 Foo 2026",
	"yesterday-ish",
	"garbage",
	"",
	" ",
	"2026-10-04T08:00:00+09:00",
	"2026-10-05T06:00:00Z",
	"2026-10-01T10:00:00+09:00",
	"2026-10-10T12:00:00.000Z",
	"2026-10-10T12:00:00",
	"2026-10-10T12:00",
	"2026-10-10 12:00",
	"2026-10-10 12:00Z",
	"2026-10-10 12:00 Z",
	"2026-10-10T12:00 Z",
	"2026-10-10T12:00:00 +09:00",
	"2026-10-10T12:00:00+0900",
	"2026-10-10T12:00:00+09",
	"2026-10-10T12:00:00+9:00",
	"2026-10-10T12:00:00+24:00",
	"2026-10-10T12:00:00+2400",
	"2026-10-10T12:00:00.1239Z",
	"2026-10-10T12:00:00.123456789Z",
	"2026-10-10T12:00:00.0001234567890123Z",
	"2026-10-10T12:00:00.Z",
	"2026-10-10T24:00Z",
	"2026-10-10T24:00:01Z",
	"2026-10-10T24:01Z",
	"2026-10-10T25:00Z",
	"2026-10-10T10:60Z",
	"2026-10-10T10:00:60Z",
	"2026-13-01",
	"2026-00-01",
	"2026-01-00",
	"2026-01-32",
	"2026-02-30",
	"2026-02-29",
	"2024-02-29",
	"2026-02-30T10:00Z",
	"2026",
	"2026-10",
	"2026 ",
	"+002026-10-10T00:00:00Z",
	"-002026-10-10T00:00:00Z",
	"-000000-01-01T00:00:00Z",
	"+000000-01-01T00:00:00Z",
	"+275760-09-13T00:00:00Z",
	"+275760-09-13T00:00:00.001Z",
	"-271821-04-20T00:00:00Z",
	"-271821-04-19T23:59:59.999Z",
	"+275760-09-13T00:00:00",
	"-271821-04-20T00:00:00",
	"2020-01-01t10:00z",
	"2020-01-01T10:00:00z",
	"2020-01-01\u0000garbage",
	"Jan 5",
	"Jan 5 10:00",
	"Jan 5 2020",
	"January 5, 2020",
	"January 5, 2020 10:00 AM",
	"January 5, 2020 10:00 PM PST",
	"Oct 10, 2026 9:05 pm",
	"Oct 10, 2026 12:00 AM",
	"Oct 10, 2026 12:00 PM",
	"Oct 10, 2026 13:00 PM",
	"10/10/2026",
	"10/10/2026 10:00",
	"2026/10/10",
	"2026/10/10 10:00:00",
	"2026.10.10",
	"10.10.2026",
	"10-10-2026",
	"1 2 3",
	"12/31/2020 11:59 PM",
	"Thu, 01 Jan 1970 00:00:00 GMT+0100 (CET)",
	"Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)",
	"Thu Jan 01 1970 09:00:00 GMT+0900 (Japan Standard Time)",
	"Tue, 13 Oct 2026 07:14:05 -0000",
	"Tue, 13 Oct 2026 07:14:05 +0000 (UTC)",
	"Tue, 13 Oct 2026 07:14:05 UT",
	"Tue, 13 Oct 2026 07:14:05 Z",
	"Tue, 13 Oct 2026 07:14:05 GMT-8",
	"Tue, 13 Oct 2026 07:14:05 GMT-08",
	"Tue, 13 Oct 2026 07:14:05 GMT-080",
	"Tue, 13 Oct 2026 07:14:05 GMT-08:00",
	"Tue, 13 Oct 2026 07:14:05 GMT-12345",
	"Tue, 13 Oct 2026 07:14:05 GMT+",
	"Tue, 13 Oct 2026 07:14:05 +",
	"2020-01-01 00:00 +300000:",
	"2020-01-01 00:00 +596523:",
	"2020-01-01 00:00 +596524:",
	"(comment) 10 Oct 2026",
	"10 Oct 2026 (comment",
	"10 Oct 2026 ((nested) comment) 10:00",
	"10 Oct 2026)",
	"word 10 Oct 2026",
	"word10 Oct 2026",
	"10 Oct 2026 word",
	"10 Octo 2026",
	"10 October 2026",
	"10 Octobre 2026",
	"10 Oc 2026",
	"10:00",
	"10:00 10 Oct 2026",
	"10::00 Oct 2026",
	"10:00:00.5 Oct 1 2026",
	"10.5 Oct 1 2026",
	"2026-10-10T10:00:00.000+09:00",
	"2026-10-10T10:00:00.000-00:00",
	"2026-10-10 10:00",
	"2026-10-10　10:00",
	"2026-10-10 10:00",
	"10 Oct 2026",
	"10　Oct　2026 10:00 GMT",
	"10 Oct 2026",
	"﻿2026-10-10",
	"2026-10-10﻿",
	" 2026-10-10",
	"2026-10-10 ",
	"Ｊａｎ 5 2026",
	"10 Ｏｃｔ 2026",
	"１０ Oct 2026",
	"10 Oct 2026 😀",
	"😀 10 Oct 2026",
	"2026-10-10T10:00:00+09:00[Asia/Tokyo]",
	"20261010T100000Z",
	"20261010",
	"2026-W41-6",
	"2026-283",
	"1e3",
	"0",
	"1",
	"12",
	"123",
	"1234",
	"12345",
	"-1",
	"+1",
	"Infinity",
	"NaN",
	"null",
	"true",
	"am",
	"pm 10 Oct 2026",
	"10 Oct 2026 10:00 am pm",
	"T10:00",
	"t",
	"z",
	"utc",
	"10 Oct 2026 utc+9",
	"10 Oct 2026 10:00 utc+9",
	"10 Oct 2026 10:00 utc-0930",
	"10 Oct 2026 10:00 +09:30",
	"10 Oct 2026 10:00 +9:30",
];

/** Field values around every boundary the parsers check. */
const YEARS = [
	"0000",
	"0049",
	"0050",
	"0099",
	"0100",
	"1900",
	"1969",
	"1970",
	"2000",
	"2024",
	"2026",
	"9999",
];
const MONTHS = ["00", "01", "02", "09", "12", "13"];
const DAYS = ["00", "01", "28", "29", "30", "31", "32"];
const HOURS = ["00", "09", "12", "23", "24", "25"];
const MINUTES = ["00", "30", "59", "60"];
const SECONDS = ["00", "59", "60", "61"];
const FRACTIONS = ["", ".0", ".5", ".12", ".123", ".1239", ".123456789", ".000000001", ".999"];
const ISO_ZONES = [
	"",
	"Z",
	"z",
	"+00:00",
	"-00:00",
	"+09:00",
	"-05:30",
	"+0900",
	"-0530",
	"+23:59",
	"+24:00",
	"+2400",
	"+12:60",
];
const MONTH_NAMES = [
	"Jan",
	"feb",
	"MAR",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
	"Foo",
	"Ja",
];
const RFC_ZONES = [
	"",
	"GMT",
	"UTC",
	"UT",
	"Z",
	"gmt",
	"Utc",
	"EST",
	"EDT",
	"CST",
	"CDT",
	"MST",
	"MDT",
	"PST",
	"PDT",
	"est",
	"+0000",
	"-0000",
	"+0900",
	"-0530",
	"+2400",
	"+9999",
	"-1260",
	"AST",
	"XYZ",
];
const RFC_DAYS = ["1", "01", "9", "29", "30", "31", "0", "32", "99"];
const SEPARATORS = [" ", "  ", "\t", " ", "　", "\n"];

function pick<T>(random: () => number, values: readonly T[]): T {
	const value = values[Math.floor(random() * values.length)];
	if (value === undefined) throw new Error("empty choice");
	return value;
}

/** Candidates `parseFeedTimestamp` builds: `${date}T${time}${zone}` and `${rfc} ${zone}`. */
function feedCandidates(random: () => number): string[] {
	const out: string[] = [];
	for (const year of YEARS) {
		for (const month of MONTHS) {
			for (const day of DAYS) out.push(`${year}-${month}-${day}`);
		}
	}
	for (let index = 0; index < 9000; index += 1) {
		const date = `${pick(random, YEARS)}-${pick(random, MONTHS)}-${pick(random, DAYS)}`;
		const shape = Math.floor(random() * 3);
		const hm = `${pick(random, HOURS)}:${pick(random, MINUTES)}`;
		const time =
			shape === 0
				? hm
				: shape === 1
					? `${hm}:${pick(random, SECONDS)}`
					: `${hm}:${pick(random, SECONDS)}${pick(random, FRACTIONS)}`;
		const zone = pick(random, ISO_ZONES);
		out.push(`${date}T${time}${zone === "" ? "Z" : zone}`);
		if (index % 3 === 0) out.push(`${date}T${time}${zone}`);
	}
	for (let index = 0; index < 9000; index += 1) {
		const separator = index % 4 === 0 ? pick(random, SEPARATORS) : " ";
		const seconds = random() < 0.5 ? "" : `:${pick(random, SECONDS)}`;
		const day = pick(random, RFC_DAYS);
		const rfc = [
			day,
			pick(random, MONTH_NAMES),
			pick(random, YEARS),
			`${pick(random, HOURS)}:${pick(random, MINUTES)}${seconds}`,
		].join(separator);
		const zone = pick(random, RFC_ZONES);
		out.push(`${rfc} ${zone === "" ? "UTC" : zone}`);
		if (index % 3 === 0)
			out.push(
				`${pick(random, ["Mon, ", "Tue,", "sat, ", "Xyz, "])}${rfc}${zone === "" ? "" : ` ${zone}`}`,
			);
	}
	return out;
}

/** Token soup: everything V8's tokenizer distinguishes, in random order. */
const SOUP_TOKENS = [
	"0",
	"1",
	"5",
	"9",
	"00",
	"01",
	"10",
	"12",
	"13",
	"24",
	"25",
	"29",
	"31",
	"32",
	"49",
	"50",
	"59",
	"60",
	"61",
	"99",
	"100",
	"999",
	"1000",
	"0900",
	"2026",
	"1969",
	"9999",
	"12345",
	"002026",
	"275760",
	"1234567890",
	"0000000000012",
	":",
	"::",
	"-",
	"+",
	".",
	",",
	"/",
	")",
	"(",
	"(x)",
	"((a)b)",
	"T",
	"t",
	"Z",
	"z",
	"W",
	"Jan",
	"jan",
	"January",
	"Febr",
	"Oct",
	"Octopus",
	"Dec",
	"May",
	"AM",
	"am",
	"PM",
	"p.m.",
	"GMT",
	"UTC",
	"UT",
	"EST",
	"PDT",
	"CET",
	"JST",
	"Mon",
	"Monday",
	"Sat,",
	"foo",
	"x",
	" ",
	" ",
	" ",
	"\t",
	"\n",
	"\r",
	"\u000b",
	"\u000c",
	" ",
	" ",
	" ",
	" ",
	" ",
	" ",
	"　",
	"﻿",
	"\u0085",
	"\u0000",
	"@",
	"[",
	"_",
	"é",
	"日",
	"😀",
	"Ｊａｎ",
	"１",
];

function tokenSoup(random: () => number, count: number): string[] {
	const out: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const length = 1 + Math.floor(random() * 9);
		let text = "";
		for (let part = 0; part < length; part += 1) text += pick(random, SOUP_TOKENS);
		out.push(text);
	}
	return out;
}

/** Plausible dates with one random mutation (insert, delete or replace a character). */
function mutations(random: () => number, bases: readonly string[], count: number): string[] {
	const alphabet = "0123456789:-+.T Z()/,AaPpMm ";
	const out: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const base = pick(random, bases);
		const at = Math.floor(random() * (base.length + 1));
		const ch = alphabet[Math.floor(random() * alphabet.length)] ?? "";
		const kind = Math.floor(random() * 3);
		out.push(
			kind === 0
				? base.slice(0, at) + ch + base.slice(at)
				: kind === 1
					? base.slice(0, at) + base.slice(at + 1)
					: base.slice(0, at) + ch + base.slice(at + 1),
		);
	}
	return out;
}

function hasLoneSurrogate(text: string): boolean {
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

function msOrNull(value: number): number | null {
	return Number.isNaN(value) ? null : value;
}

/** Parses every input in each zone; restores the process zone afterwards. */
function parseInZones(inputs: readonly string[]): [string, number | null, number | null][] {
	const original = process.env.TZ;
	try {
		process.env.TZ = "UTC";
		const utc = inputs.map((input) => msOrNull(Date.parse(input)));
		process.env.TZ = "Etc/GMT-9";
		const plusNine = inputs.map((input) => msOrNull(Date.parse(input)));
		return inputs.map((input, index) => [input, utc[index] ?? null, plusNine[index] ?? null]);
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}
}

function isoCases(random: () => number): [number, string | null][] {
	const times = [
		0,
		-1,
		1,
		8.64e15,
		-8.64e15,
		8.64e15 + 1,
		-8.64e15 - 1,
		253402300799999,
		253402300800000,
		-62167219200000,
		-62167219200001,
		951782400000,
		1791712800000,
	];
	for (let index = 0; index < 3000; index += 1) {
		const scale = pick(random, [1e3, 1e9, 1e12, 1e14, 8.64e15]);
		times.push(Math.trunc((random() * 2 - 1) * scale));
	}
	return times.map((time) => {
		const date = new Date(time);
		return [time, Number.isNaN(date.getTime()) ? null : date.toISOString()];
	});
}

export const dateExporter: VectorExporter = {
	name: "date",
	async build() {
		const random = seededRandom(20_261_017);
		const candidates = feedCandidates(random);
		const inputs = [
			...LITERALS,
			...candidates,
			...mutations(random, [...LITERALS, ...candidates.slice(0, 2000)], 6000),
			...tokenSoup(random, 14_000),
		];
		const unique = [...new Set(inputs)].filter((input) => !hasLoneSurrogate(input));
		return [
			{
				path: "js/date-parse.json",
				content: { parse: parseInZones(unique), toISOString: isoCases(random) },
			},
		];
	},
};
