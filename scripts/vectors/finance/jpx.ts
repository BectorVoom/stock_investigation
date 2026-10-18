/**
 * JPX earnings dates (crate `research-finance`): the workbook parser, the
 * hand-written ZIP reader, the index scrape and the stateful source
 * (`jpxWorkbook.ts`, `zipReader.ts`, `jpxEarnings.ts`).
 *
 * Workbook cases are synthetic sheets in the observed layout, varied in every
 * way the parser distinguishes (header spellings and positions, cell kinds,
 * hostile serials, entity soup, truncations). ZIP cases are archives built
 * with the TypeScript test writer and then patched at structural offsets or
 * cut. Source cases are multi-step transcripts so the index and workbook
 * caches are exercised across calls.
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
	createJpxEarningsSource,
	extractJpxWorkbookUrls,
	JPX_INDEX_URL,
	JPX_SHEET_PATH,
	JPX_STRINGS_PATH,
} from "../../../packages/adapters/src/finance/jpxEarnings.ts";
import {
	decodeWorkbookText,
	headerMatches,
	parseJpxWorkbook,
	slugFiscalKind,
} from "../../../packages/adapters/src/finance/jpxWorkbook.ts";
import {
	MAX_ZIP_ARCHIVE_BYTES,
	MAX_ZIP_ENTRY_BYTES,
	readZipEntries,
} from "../../../packages/adapters/src/node/zipReader.ts";
import {
	buildTestZip,
	findSignature,
	patchByte,
	patchU16,
	patchU32,
} from "../../../packages/adapters/test/zipTestUtils.ts";
import {
	base64,
	type FetchEvent,
	fetchError,
	plain,
	Rng,
	type ScriptEntry,
	scriptedBefore,
	scriptedFetcher,
	tickingClock,
} from "./support.ts";

const NEVER = new AbortController().signal;
const SHEET = JPX_SHEET_PATH;
const STRINGS = JPX_STRINGS_PATH;

/* ---------- workbook generator ---------- */

const HEADER_TEXTS = {
	date: [
		"決算発表予定日\r\nScheduled Dates for Earnings Announcements",
		"決算発表予定日\nScheduled Dates for Earnings Announcements",
		"決算発表予定日\rScheduled Dates for Earnings Announcements",
		"決算発表予定日 / Scheduled Dates for Earnings Announcements",
		"Scheduled Dates for Earnings Announcements",
		" Scheduled Dates for Earnings Announcements ",
		"scheduled dates for earnings announcements",
	],
	code: ["コード\r\nCode", "コード / Code", "Code", "コード\nCode ", "Code ", "Stock Code"],
	name: ["Issue Name", "会社名\nIssue Name", "会社名 / Issue Name", "Name"],
	end: ["決算期末\r\nFiscal Year-end", "Fiscal Year-end", "決算期末 / Fiscal Year-end", "Year-end"],
	label: ["Fiscal Year/Quarter", "種別\nFiscal Year/Quarter", "Quarter", "Fiscal Year/Quarter "],
};

const NAMES = [
	"Toyota Motor Corp.",
	"SoftBank Group Corp.  ",
	"Sony &amp; Co &lt;Group&gt;",
	"&#x30C8;&#x30E8;&#x30BF;",
	"A&#0;B",
	"A&#xD800;B",
	"&lol; &amp;amp;",
	"  ",
	"",
	"Nintendo Co., Ltd.",
	"N".repeat(250),
	"名".repeat(300),
	"x&#1114112;y",
];

const LABELS = [
	"Second quarter",
	"Third quarter",
	"First quarter",
	"Full year",
	"  Fourth Quarter  ",
	"Q1/2027",
	"---",
	"",
	"x".repeat(80),
	"x".repeat(81),
	"y".repeat(60),
	"第2四半期 Second",
	"Fiscal Year/Quarter&amp;more",
];

const CODES = ["7203", "9984", "130A", "130a", " 7203 ", "6758", "12345", "AB", "", "7203\u0085", "2914", "A123", "0001", "9999"];

function excelSerial(iso: string): number {
	const [year, month, day] = iso.split("-").map(Number);
	return Math.round(
		(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) - Date.UTC(1899, 11, 30)) / 86_400_000,
	);
}

const SERIAL_CHOICES: readonly string[] = [
	"46331",
	"46332",
	"46477",
	"46000",
	"46300",
	"46400",
	"61",
	"60",
	"2958465",
	"2958466",
	"46331.5",
	"46331.0",
	"4.6331e4",
	"0x10",
	"abc",
	"",
	" 46331 ",
	"-5",
	"1e400",
	"61.0",
];

interface SheetPlan {
	sheet: string;
	shared: string;
}

/** One workbook. `valid` biases the generator towards parseable rows. */
function randomWorkbook(rng: Rng, valid: boolean): SheetPlan {
	const strings: string[] = [];
	const intern = (text: string): number => {
		const found = strings.indexOf(text);
		if (found >= 0) return found;
		strings.push(text);
		return strings.length - 1;
	};
	// Shared-string items are written as <si> raw; a few use runs and phonetics.
	const siFor = (text: string): string => {
		const roll = rng.float();
		if (roll < 0.06) return `<si><r><t>${text.slice(0, 1)}</t></r><r><t>${text.slice(1)}</t></r></si>`;
		if (roll < 0.1) return `<si><t>${text}</t><rPh sb="0" eb="1"><t>かな</t></rPh></si>`;
		if (roll < 0.14) return `<si><t xml:space="preserve">${text}</t></si>`;
		return `<si><t>${text}</t></si>`;
	};
	const letters = rng.shuffle(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]).slice(0, 5);
	const [dateCol, codeCol, nameCol, endCol, labelCol] = letters as [string, string, string, string, string];
	const cellAt = (col: string, rowNumber: number, body: string, kind: string | null, withRef = true): string => {
		const ref = withRef ? ` r="${col}${rowNumber}"` : "";
		const t = kind === null ? "" : ` t="${kind}"`;
		if (body === "") return `<c${ref} s="3"${t}/>`;
		return `<c${ref} s="3"${t}>${body}</c>`;
	};
	const sharedCell = (col: string, rowNumber: number, text: string, withRef = true): string =>
		cellAt(col, rowNumber, `<v>${intern(text)}</v>`, "s", withRef);
	const inlineCell = (col: string, rowNumber: number, text: string): string =>
		cellAt(col, rowNumber, `<is><t>${text}</t></is>`, "inlineStr");
	const literalCell = (col: string, rowNumber: number, text: string): string =>
		cellAt(col, rowNumber, `<v>${text}</v>`, rng.pick([null, "str", "n"]));

	const headerGoodRate = valid ? 0.97 : 0.8;
	const pickHeader = (kind: keyof typeof HEADER_TEXTS, good: number): string => {
		const options = HEADER_TEXTS[kind];
		return rng.chance(headerGoodRate) ? (options[rng.int(0, good)] ?? "") : rng.pick(options);
	};
	const headerCells = [
		[dateCol, pickHeader("date", 4)],
		[codeCol, pickHeader("code", 2)],
		[nameCol, pickHeader("name", 2)],
		[endCol, pickHeader("end", 2)],
		[labelCol, pickHeader("label", 0)],
	] as const;
	const headerRowNumber = rng.int(1, 6);
	let headerRow = "";
	for (const [col, text] of rng.shuffle([...headerCells])) {
		const withRef = rng.chance(0.9);
		headerRow += rng.chance(0.85)
			? sharedCell(col, headerRowNumber, text, withRef)
			: inlineCell(col, headerRowNumber, text);
	}
	const rows: string[] = [];
	for (let title = 1; title < headerRowNumber; title += 1) {
		rows.push(
			rng.pick([
				`<row r="${title}"><c r="A${title}" s="1" t="s"><v>${intern("タイトル")}</v></c></row>`,
				`<row r="${title}"/>`,
				`<row r="${title}"></row>`,
				`<row r="${title}"><c r="A${title}"/></row>`,
			]),
		);
	}
	rows.push(`<row r="${headerRowNumber}">${headerRow}</row>`);
	const dataCount = rng.int(valid ? 1 : 0, 9);
	for (let index = 0; index < dataCount; index += 1) {
		const number = headerRowNumber + 1 + index;
		const cells: string[] = [];
		const okRate = valid ? 0.95 : 0.75;
		const good = () => rng.chance(okRate);
		// date
		if (!rng.chance(valid ? 0.01 : 0.06)) {
			const roll = rng.float();
			if (roll < 0.12) cells.push(sharedCell(dateCol, number, "未定_Undecided"));
			else if (good())
				cells.push(
					rng.chance(0.8)
						? cellAt(dateCol, number, `<v>${excelSerial(rng.pick(["2026-10-13", "2026-10-29", "2027-01-15", "2027-04-16", "2026-10-12", "2027-04-17", "2025-05-01"]))}</v>`, null)
						: literalCell(dateCol, number, rng.pick(["46331", "46477", "46332"])),
				);
			else cells.push(literalCell(dateCol, number, rng.pick(SERIAL_CHOICES)));
		}
		// code
		const codeRoll = rng.float();
		if (!rng.chance(valid ? 0.01 : 0.05)) {
			const code = good() ? rng.pick(["7203", "9984", "130A", "6758"]) : rng.pick(CODES);
			if (codeRoll < 0.4) cells.push(cellAt(codeCol, number, `<v>${code}</v>`, null));
			else if (codeRoll < 0.8) cells.push(sharedCell(codeCol, number, code));
			else if (codeRoll < 0.9) cells.push(inlineCell(codeCol, number, code));
			else cells.push(cellAt(codeCol, number, "", null));
		}
		// name
		if (!rng.chance(0.08)) {
			const name = rng.pick(NAMES);
			cells.push(rng.chance(0.7) ? sharedCell(nameCol, number, name) : inlineCell(nameCol, number, name));
		}
		// fiscal end
		if (!rng.chance(valid ? 0.01 : 0.05)) {
			cells.push(literalCell(endCol, number, good() ? rng.pick(["46477", "46112", "46203"]) : rng.pick(SERIAL_CHOICES)));
		}
		// label
		if (!rng.chance(valid ? 0.01 : 0.05)) {
			const label = good() ? rng.pick(LABELS.slice(0, 5)) : rng.pick(LABELS);
			cells.push(sharedCell(labelCol, number, label));
		}
		if (rng.chance(0.1)) cells.push(`<c r="Z${number}" s="2"/>`);
		rng.shuffle(cells);
		rows.push(`<row r="${number}">${cells.join("")}</row>`);
		if (rng.chance(0.05)) rows.push(`<row r="${number}"/>`);
	}
	const decoy = rng.chance(0.1) ? "<rows><row r=\"1\"><c><v>1</v></c></row></rows>" : "";
	const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet>${decoy}<sheetData>${rows.join("")}</sheetData></worksheet>`;
	const shared = `<?xml version="1.0" encoding="UTF-8"?><sst count="${strings.length}">${strings.map(siFor).join("")}</sst>`;
	return { sheet, shared };
}

function truncate(rng: Rng, text: string): string {
	if (text.length < 4) return text;
	return text.slice(0, rng.int(1, text.length - 1));
}

interface WorkbookCase {
	readonly sheet: string;
	readonly shared: string;
	readonly output: unknown;
}

function workbookCase(sheet: string, shared: string): WorkbookCase {
	return { sheet, shared, output: plain(parseJpxWorkbook(sheet, shared)) };
}

/** Synthetic recipes for the bound checks (the same XML is rebuilt in Rust). */
interface RecipeCase {
	readonly recipe: string;
	readonly count: number;
	readonly output: unknown;
}

const RECIPE_STRINGS =
	'<si><t>Scheduled Dates for Earnings Announcements</t></si><si><t>Code</t></si><si><t>Issue Name</t></si><si><t>Fiscal Year-end</t></si><si><t>Fiscal Year/Quarter</t></si><si><t>Second quarter</t></si>';
const RECIPE_HEADER =
	'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>';

export function recipeSheet(recipe: string, count: number): { sheet: string; shared: string } {
	const shared = `<sst>${RECIPE_STRINGS}${recipe === "strings" ? "<si><t>x</t></si>".repeat(count) : ""}</sst>`;
	let rows = "";
	if (recipe === "rows") {
		for (let index = 0; index < count; index += 1) {
			rows += `<row><c r="A${index + 2}"><v>46331</v></c><c r="B${index + 2}"><v>7203</v></c><c r="C${index + 2}" t="s"><v>5</v></c><c r="D${index + 2}"><v>46477</v></c><c r="E${index + 2}" t="s"><v>5</v></c></row>`;
		}
	} else if (recipe === "emptyRows") {
		rows = "<row><c/></row>".repeat(count);
	} else if (recipe === "cells") {
		// One row of `count` empty cells after the header.
		rows = `<row>${"<c/>".repeat(count)}</row>`;
	} else if (recipe === "cellsAcrossRows") {
		rows = `<row>${"<c/>".repeat(500_000)}</row>`.repeat(count);
	}
	return {
		sheet: `<worksheet><sheetData>${RECIPE_HEADER}${rows}</sheetData></worksheet>`,
		shared,
	};
}

function recipeCases(): RecipeCase[] {
	const specs: [string, number][] = [
		["rows", 20_000],
		["rows", 20_001],
		["rows", 100],
		["strings", 100_000],
		["strings", 100_001],
		["emptyRows", 20_500],
		["emptyRows", 21_001],
		["cells", 999_990],
		["cells", 1_000_000],
		["cellsAcrossRows", 2],
		["cellsAcrossRows", 3],
	];
	return specs.map(([recipe, count]) => {
		const { sheet, shared } = recipeSheet(recipe, count);
		const result = parseJpxWorkbook(sheet, shared);
		// Large row lists are summarised: their length and both ends.
		const output = result.ok
			? { ok: { length: result.value.length, first: result.value[0] ?? null, last: result.value.at(-1) ?? null } }
			: { err: result.error };
		return { recipe, count, output: plain(output) };
	});
}

function decodeCases(rng: Rng): unknown[] {
	const parts = [
		"&amp;",
		"&lt;",
		"&gt;",
		"&quot;",
		"&apos;",
		"&AMP;",
		"&#65;",
		"&#x41;",
		"&#X41;",
		"&#0;",
		"&#x0;",
		"&#1114111;",
		"&#1114112;",
		"&#xD800;",
		"&#xDFFF;",
		"&#55357;",
		"&#128512;",
		"&#x1F600;",
		"&#12345678;",
		"&#x1234567;",
		"&#;",
		"&#x;",
		"&#-5;",
		"&;",
		"&",
		"&amp",
		"&lol;",
		"&amp;amp;",
		"&&amp;;",
		"a",
		"日本",
		"\n",
		"😀",
		" ",
		";",
	];
	const cases: unknown[] = [];
	for (let index = 0; index < 400; index += 1) {
		const input = rng.picks(parts, rng.int(0, 8)).join("");
		cases.push({ input, output: decodeWorkbookText(input) });
	}
	return cases;
}

function headerCases(rng: Rng): unknown[] {
	const english = [
		"Scheduled Dates for Earnings Announcements",
		"Code",
		"Issue Name",
		"Fiscal Year-end",
		"Fiscal Year/Quarter",
		"Quarter",
	];
	const pieces = [
		"",
		" ",
		"\r\n",
		"\r",
		"\n",
		"コード",
		"決算期末",
		" / ",
		"/ ",
		"/",
		" ",
		"﻿",
		"\u0085",
		...english,
	];
	const cases: unknown[] = [];
	for (let index = 0; index < 500; index += 1) {
		const text = rng.picks(pieces, rng.int(0, 6)).join("");
		const wanted = rng.pick(english);
		cases.push({ text, english: wanted, output: headerMatches(text, wanted) });
	}
	const slugs: unknown[] = [];
	for (let index = 0; index < 300; index += 1) {
		const label = rng.picks(["Second", " quarter", "--", "Q1/", "２", "É", "ß", "İ", "ΑΣ", "Σ", " ", "﻿", "x", "9", "_", "-"], rng.int(0, 6)).join("");
		slugs.push({ label, output: slugFiscalKind(label) });
	}
	return [cases, slugs];
}

/* ---------- index scraping ---------- */

function indexCases(rng: Rng): unknown[] {
	const base = "/listing/event-schedules/financial-announcement";
	const hrefs = [
		`${base}/aaa-att/kessan09_1009.xlsx`,
		`${base}/bbb-att/kessan10_1010.xlsx`,
		`https://www.jpx.co.jp${base}/ccc/kessan11_1111.xlsx`,
		`https://WWW.JPX.CO.JP${base}/ddd/kessan12_1212.xlsx`,
		`http://www.jpx.co.jp${base}/eee/kessan01_0101.xlsx`,
		`https://www.jpx.co.jp:8443${base}/fff/kessan02_0202.xlsx`,
		`https://www.jpx.co.jp:443${base}/ggg/kessan03_0303.xlsx`,
		`https://evil.example${base}/hhh/kessan04_0404.xlsx`,
		`${base}/iii/kessan05_0505.xlsx?x=1#frag`,
		`${base}/jjj/kessan06_0606.xlsx#frag`,
		`${base}/kkk/kessan06_060.xlsx`,
		`${base}/lll/kessan6_0606.xlsx`,
		`${base}/mmm/kessan06_0606.xls`,
		`${base}/kessan06_0606.xlsx`,
		`${base}/a/b/kessan06_0606.xlsx`,
		`${base}/a%20b/kessan06_0606.xlsx`,
		`${base}/ÄÖ/kessan06_0606.xlsx`,
		`../financial-announcement/nnn/kessan07_0707.xlsx`,
		`./ooo/kessan08_0808.xlsx`,
		`//www.jpx.co.jp${base}/ppp/kessan09_0909.xlsx`,
		`//evil.example${base}/qqq/kessan09_0909.xlsx`,
		`/other${base}/rrr/kessan09_0909.xlsx`,
		`${base}/sss/kessan09_0909.XLSX`,
		`${base}/ttt/KESSAN09_0909.xlsx`,
		`javascript:alert(1)`,
		`mailto:a@b.c`,
		`https://www.jpx.co.jp\\listing\\event-schedules\\financial-announcement\\uuu\\kessan09_0909.xlsx`,
		`${base}/vvv/kessan09_0909.xlsx&amp;x`,
		``,
		`#`,
		`http://[`,
		`https://www.jpx.co.jp:99999${base}/www/kessan09_0909.xlsx`,
		`${base}/xxx/../yyy/kessan09_0909.xlsx`,
		`${base}/z_z-1/kessan99_9999.xlsx`,
	];
	const anchors = (href: string): string => {
		const form = rng.int(0, 7);
		if (form === 0) return `<a href="${href}">x</a>`;
		if (form === 1) return `<a href='${href}'>x</a>`;
		if (form === 2 && !/[\s>]/.test(href)) return `<a href=${href}>x</a>`;
		if (form === 3) return `<A HREF="${href}">x</A>`;
		if (form === 4) return `<a class="x" target=_blank href = "${href}">x</a>`;
		if (form === 5) return `<a data-href="${href}">x</a>`;
		if (form === 6) return `<a\nhref\n=\n"${href}">x</a>`;
		return `<a href="${href}" >x</a>`;
	};
	const noise = [
		"<p>text</p>",
		"<a>no href</a>",
		"<abbr href=\"/x\">",
		"<a href>",
		"<a href=>",
		"<a href=\"\">",
		"<a href=\"unterminated",
		"<link href=\"/listing/event-schedules/financial-announcement/ccc/kessan11_1111.xlsx\">",
		"<script>var a='<a href=\"/x\">'</script>",
		"<a href=\"  \">",
	];
	const cases: unknown[] = [];
	for (let index = 0; index < 600; index += 1) {
		const count = rng.int(0, 12);
		let html = "";
		for (let item = 0; item < count; item += 1) {
			html += rng.chance(0.2) ? rng.pick(noise) : anchors(rng.pick(hrefs));
			if (rng.chance(0.3)) html += "\n";
		}
		cases.push({ html, output: extractJpxWorkbookUrls(html) });
	}
	// More than six distinct, and duplicates.
	let many = "";
	for (let item = 0; item < 9; item += 1) {
		many += `<a href="${base}/m${item}/kessan09_100${item}.xlsx">x</a><a href="${base}/m${item}/kessan09_100${item}.xlsx">dup</a>`;
	}
	cases.push({ html: many, output: extractJpxWorkbookUrls(many) });
	cases.push({ html: "", output: extractJpxWorkbookUrls("") });
	return cases;
}

/* ---------- ZIP reader ---------- */

/** An archive as concatenated parts: literal bytes (base64) or a run of zero bytes. */
type ArchivePart = { readonly b64: string } | { readonly zeros: number };

interface ZipCase {
	readonly archive: readonly ArchivePart[];
	readonly names: readonly string[];
	readonly output: unknown;
}

function describeZip(
	archive: Uint8Array,
	names: readonly string[],
	parts: readonly ArchivePart[] = [{ b64: base64(archive) }],
): ZipCase {
	const result = readZipEntries(archive, names);
	let output: unknown;
	if (result.ok) {
		output = {
			ok: [...result.value.entries()].map(([name, bytes]) => ({
				name,
				length: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			})),
		};
	} else output = { err: result.error };
	return { archive: parts, names, output };
}

function zipCases(rng: Rng): ZipCase[] {
	const cases: ZipCase[] = [];
	const sheetText = "<sheet>data</sheet>".repeat(100);
	const stringsText = "<strings>tiny</strings>";
	const base = buildTestZip([
		{ name: SHEET, text: sheetText, method: 8 },
		{ name: STRINGS, text: stringsText, method: 0 },
	]);
	const both = [SHEET, STRINGS];
	cases.push(describeZip(base, both));
	cases.push(describeZip(base, [STRINGS, SHEET]));
	cases.push(describeZip(base, []));
	cases.push(describeZip(base, ["missing"]));
	cases.push(describeZip(base, [SHEET, "missing"]));
	cases.push(describeZip(base, [SHEET, SHEET]));
	cases.push(
		describeZip(
			buildTestZip([
				{ name: "dup.txt", text: "first", method: 0 },
				{ name: "dup.txt", text: "second", method: 0 },
			]),
			["dup.txt"],
		),
	);
	cases.push(describeZip(new Uint8Array(MAX_ZIP_ARCHIVE_BYTES + 1), both, [{ zeros: MAX_ZIP_ARCHIVE_BYTES + 1 }]));
	cases.push(describeZip(new Uint8Array(MAX_ZIP_ARCHIVE_BYTES), both, [{ zeros: MAX_ZIP_ARCHIVE_BYTES }]));
	cases.push(describeZip(new TextEncoder().encode("hello"), both));
	cases.push(describeZip(new Uint8Array(0), both));
	cases.push(describeZip(new Uint8Array(21), both));
	cases.push(describeZip(new Uint8Array(22), both));
	// Structural patches.
	const central = findSignature(base, 0x02014b50);
	const end = findSignature(base, 0x06054b50);
	const offsets = [
		0,
		6,
		8,
		26,
		28,
		central,
		central + 4,
		central + 8,
		central + 10,
		central + 20,
		central + 24,
		central + 28,
		central + 30,
		central + 32,
		central + 42,
		end + 4,
		end + 6,
		end + 8,
		end + 10,
		end + 12,
		end + 16,
		end + 20,
	];
	for (const offset of offsets) {
		if (offset < 0 || offset + 4 > base.byteLength) continue;
		for (const value of [0, 1, 8, 12, 0xff, 0xffff]) {
			cases.push(describeZip(patchU16(base, offset, value), both));
		}
		for (const value of [0, 1, 0x7fffffff, 0xffffffff, base.byteLength, base.byteLength + 1]) {
			cases.push(describeZip(patchU32(base, offset, value), both));
		}
		cases.push(describeZip(patchByte(base, offset, 0), both));
	}
	// Random corruption and truncation.
	for (let index = 0; index < 600; index += 1) {
		let archive: Uint8Array = base;
		const edits = rng.int(1, 3);
		for (let edit = 0; edit < edits; edit += 1) {
			const position = rng.int(0, archive.byteLength - 1);
			archive = rng.chance(0.5)
				? patchByte(archive, position, rng.int(0, 255))
				: patchByte(archive, position, (archive[position] ?? 0) ^ (1 << rng.int(0, 7)));
		}
		if (rng.chance(0.2)) archive = archive.slice(0, rng.int(0, archive.byteLength));
		if (rng.chance(0.1)) archive = new Uint8Array([...archive, ...rng.picks([0, 1, 80, 75], rng.int(1, 40))]);
		cases.push(describeZip(archive, rng.chance(0.8) ? both : [rng.pick([SHEET, STRINGS, "x"])]));
	}
	// Prefix junk (stub before the archive) and a trailing comment.
	cases.push(describeZip(new Uint8Array([...new Uint8Array(100), ...base]), both));
	for (const gap of [70_000, 65_536, 65_557, 65_558]) {
		cases.push(
			describeZip(new Uint8Array([...base, ...new Uint8Array(gap)]), both, [
				{ b64: base64(base) },
				{ zeros: gap },
			]),
		);
	}
	// Names: non-ASCII, BOM, lossy bytes.
	for (const name of ["日本.xml", "﻿bom.xml", "a b.xml", "dir/", ""]) {
		cases.push(describeZip(buildTestZip([{ name, text: "x", method: 0 }]), [name]));
	}
	// Ceilings (the same sizes the TypeScript tests use).
	const bigDeclared = patchU32(
		buildTestZip([{ name: "a.txt", text: "x".repeat(100), method: 8 }]),
		findSignature(buildTestZip([{ name: "a.txt", text: "x".repeat(100), method: 8 }]), 0x02014b50) + 24,
		MAX_ZIP_ENTRY_BYTES + 1,
	);
	cases.push(describeZip(bigDeclared, ["a.txt"]));
	for (const size of [MAX_ZIP_ENTRY_BYTES - 1, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_ENTRY_BYTES + 1, MAX_ZIP_ENTRY_BYTES + 5000]) {
		const archive = buildTestZip([{ name: "bomb.bin", text: "\u0000".repeat(size), method: 8 }]);
		cases.push(describeZip(archive, ["bomb.bin"]));
		// Declared size says "cap" while the stream inflates beyond it.
		const lying = patchU32(archive, findSignature(archive, 0x02014b50) + 24, MAX_ZIP_ENTRY_BYTES);
		cases.push(describeZip(lying, ["bomb.bin"]));
	}
	// Stored entry with a deflate-looking payload, deflate with trailing bytes.
	const deflated = deflateRawSync(Buffer.from("hello world hello world"));
	const trailing = Buffer.concat([deflated, Buffer.from([1, 2, 3, 4, 5])]);
	cases.push(describeZip(rawArchive("t.txt", trailing, 8, 23), ["t.txt"]));
	cases.push(describeZip(rawArchive("t.txt", deflated.subarray(0, deflated.length - 2), 8, 23), ["t.txt"]));
	cases.push(describeZip(rawArchive("t.txt", Buffer.from("not deflate data at all"), 8, 23), ["t.txt"]));
	cases.push(describeZip(rawArchive("t.txt", deflated, 8, 24), ["t.txt"]));
	cases.push(describeZip(rawArchive("t.txt", deflated, 8, 22), ["t.txt"]));
	return cases;
}

/** A one-entry archive with caller-chosen payload bytes and declared size. */
function rawArchive(name: string, data: Uint8Array, method: number, declared: number): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const local = [
		...u32(0x04034b50),
		...u16(20),
		...u16(0),
		...u16(method),
		...u16(0),
		...u16(0),
		...u32(0),
		...u32(data.byteLength),
		...u32(declared),
		...u16(nameBytes.byteLength),
		...u16(0),
		...nameBytes,
		...data,
	];
	const central = [
		...u32(0x02014b50),
		...u16(20),
		...u16(20),
		...u16(0),
		...u16(method),
		...u16(0),
		...u16(0),
		...u32(0),
		...u32(data.byteLength),
		...u32(declared),
		...u16(nameBytes.byteLength),
		...u16(0),
		...u16(0),
		...u16(0),
		...u16(0),
		...u32(0),
		...u32(0),
		...nameBytes,
	];
	const end = [
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(1),
		...u16(1),
		...u32(central.length),
		...u32(local.length),
		...u16(0),
	];
	return new Uint8Array([...local, ...central, ...end]);
}

function u16(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/* ---------- the stateful source ---------- */

interface SourceStep {
	readonly nowMs: number;
	readonly stocks: readonly { readonly symbol: string; readonly needName: boolean }[];
	readonly fromDate: string;
	readonly toDate: string;
	readonly before: readonly boolean[];
	readonly script: readonly ScriptEntry[];
	events: unknown;
	output: unknown;
}

function workbookZip(rng: Rng, valid: boolean): { zip: Uint8Array; plan: SheetPlan } {
	const plan = randomWorkbook(rng, valid);
	const zip = buildTestZip([
		{ name: SHEET, text: plan.sheet, method: rng.chance(0.7) ? 8 : 0 },
		{ name: STRINGS, text: plan.shared, method: rng.chance(0.5) ? 8 : 0 },
	]);
	return { zip, plan };
}

const WORKBOOK_URLS = [
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/aaa-att/kessan09_1009.xlsx",
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/bbb-att/kessan10_1010.xlsx",
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/ccc-att/kessan11_1111.xlsx",
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/ddd-att/kessan12_1212.xlsx",
];

function indexHtml(urls: readonly string[]): string {
	return `<html><body>${urls.map((url) => `<a href="${url.replace("https://www.jpx.co.jp", "")}">x</a>`).join("")}</body></html>`;
}

async function runSourceCase(rng: Rng): Promise<{ steps: SourceStep[] }> {
	const clock = tickingClock(Date.UTC(2026, 9, 13, 3, 0, 0));
	// Each step gets its own fresh fetcher; the SOURCE (and its caches) persists.
	let fetcher = scriptedFetcher([], []);
	const source = createJpxEarningsSource({
		fetcher: { fetchText: (url, options) => fetcher.fetchText(url, options) },
		binaryFetcher: { fetchBytes: (url, options) => fetcher.fetchBytes(url, options) },
		clock,
	});
	const steps: SourceStep[] = [];
	const stepCount = rng.int(1, 4);
	const urlCount = rng.int(0, 4);
	let urls = WORKBOOK_URLS.slice(0, urlCount);
	for (let step = 0; step < stepCount; step += 1) {
		clock.advance(rng.pick([0, 1000, 60_000, 1_799_999, 1_800_000, 1_800_001, 3_600_000]));
		if (rng.chance(0.3)) urls = rng.shuffle([...WORKBOOK_URLS]).slice(0, rng.int(0, 4));
		const script: ScriptEntry[] = [];
		const stocks = rng.picks(["7203", "9984", "130A", "6758", "0000"], rng.int(0, 3)).map((symbol) => ({
			symbol,
			needName: rng.chance(0.6),
		}));
		script.push(
			rng.chance(0.08) ? fetchError("HTTP_ERROR", "HTTP 503") : { text: indexHtml(urls), contentType: "text/html" },
		);
		for (let item = 0; item < urls.length; item += 1) {
			const roll = rng.float();
			if (roll < 0.05) script.push(fetchError("TIMEOUT", "no complete response"));
			else if (roll < 0.1) script.push({ bytes: base64(new Uint8Array([1, 2, 3])) });
			else {
				const { zip } = workbookZip(rng, rng.chance(0.85));
				script.push({ bytes: base64(zip) });
			}
		}
		const before = rng.pick([[], [], [], [false], [true, false], [true, true, false], [true, true, true, false]]);
		const fresh: FetchEvent[] = [];
		fetcher = scriptedFetcher(script, fresh);
		const results = await source.fetchEarnings({
			stocks,
			fromDate: "2026-10-13",
			toDate: "2027-04-16",
			signal: NEVER,
			beforeRequest: scriptedBefore(before, fresh),
		});
		steps.push({
			nowMs: clock.nowMs(),
			stocks,
			fromDate: "2026-10-13",
			toDate: "2027-04-16",
			before,
			script,
			events: plain(fresh),
			output: plain(results.map((result) => (result.ok ? { ok: result.value } : { err: result.error }))),
		});
	}
	return { steps };
}

export async function jpxFiles(): Promise<{ path: string; content: unknown }[]> {
	const rng = new Rng(0x19c);
	// Workbooks.
	const workbooks: WorkbookCase[] = [];
	for (let index = 0; index < 330; index += 1) {
		const { sheet, shared } = randomWorkbook(rng, index % 3 !== 0);
		workbooks.push(workbookCase(sheet, shared));
		if (index % 5 === 0) workbooks.push(workbookCase(truncate(rng, sheet), shared));
		if (index % 7 === 0) workbooks.push(workbookCase(sheet, truncate(rng, shared)));
	}
	workbooks.push(workbookCase("", ""));
	workbooks.push(workbookCase("<row>", "<si>"));
	workbooks.push(workbookCase("<worksheet/>", "<sst/>"));
	workbooks.push(workbookCase("<row/>", "<sst></sst>"));
	const sources: { steps: SourceStep[] }[] = [];
	for (let index = 0; index < 150; index += 1) sources.push(await runSourceCase(rng));
	const [headers, slugs] = headerCases(rng);
	return [
		{
			path: "finance/jpx_workbook.json",
			content: {
				workbooks,
				recipes: recipeCases(),
				decode: decodeCases(rng),
				headerMatches: headers,
				slugs,
			},
		},
		{ path: "finance/jpx_index.json", content: indexCases(rng) },
		{ path: "finance/zip.json", content: zipCases(rng) },
		{ path: "finance/jpx_source.json", content: sources },
	];
}

export { JPX_INDEX_URL };
