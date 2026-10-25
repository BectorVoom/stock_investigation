/**
 * The stock-directory list parsers and sources (ADR-0034; crate
 * `research-finance`): `secDirectory.ts`, `jpxDirectory.ts` and the generic
 * row reader of `jpxWorkbook.ts`.
 *
 * Parser cases are small and synthetic, varied in every way the parsers
 * distinguish (field order, exchanges, ticker shapes, names at the UTF-16
 * length bound, header spellings and positions, cell kinds, sections,
 * dates, joins with missing or over-long names). The row-count floor and
 * ceiling are exercised by recipes both sides rebuild (a JSON body of a
 * thousand rows is not worth storing). Source cases are transcripts over the
 * scripted fetcher: every request, pacing grant and SEC wait is recorded
 * with the result, so the Rust source must make the same calls in the same
 * order.
 */

import {
	createJpxDirectorySource,
	extractJpxListingUrl,
	JPX_LISTING_PAGE_URLS,
	type JpxListingLanguage,
	type JpxListingRow,
	jpxDirectoryEntries,
	listingDate,
	parseJpxListingSheet,
} from "../../../packages/adapters/src/finance/jpxDirectory.ts";
import { createSecClient } from "../../../packages/adapters/src/finance/secClient.ts";
import {
	createSecDirectorySource,
	parseSecDirectory,
	secDirectoryEntries,
} from "../../../packages/adapters/src/finance/secDirectory.ts";
import { buildTestZip } from "../../../packages/adapters/test/zipTestUtils.ts";
import {
	base64,
	digestOf,
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
const SHEET = "xl/worksheets/sheet1.xml";
const STRINGS = "xl/sharedStrings.xml";

/** A Result as the replays compare it. */
function resultJson<T>(
	result: { ok: true; value: T } | { ok: false; error: unknown },
	value: (inner: T) => unknown,
): unknown {
	return result.ok ? { ok: plain(value(result.value)) } : { err: result.error };
}

/** A long entry list as its length and digest (the replays recompute both). */
function listSummary(data: { asOf: string | null; entries: readonly unknown[] }): unknown {
	return { asOf: data.asOf, length: data.entries.length, digest: digestOf(data.entries) };
}

/* ---------- SEC ---------- */

const SEC_NAMES: readonly unknown[] = [
	"Apple Inc.",
	"  Spaced Name  ",
	"",
	"   ",
	"　全角　",
	"﻿BOM Corp",
	"N".repeat(200),
	"N".repeat(201),
	"😀".repeat(100),
	"😀".repeat(101),
	`${"é".repeat(199)}😀`,
	"TOYOTA MOTOR CORP/",
	12,
	null,
];
const SEC_TICKERS: readonly unknown[] = [
	"AAPL",
	"aapl",
	" msft ",
	"BRK.B",
	"BRK-B",
	"brk.b",
	"1ABC",
	"ABCDEFGHIJ",
	"ABCDEFGHIJK",
	"A",
	"",
	"  ",
	"ÄBC",
	"TM",
	"A B",
	"X_Y",
	5,
	null,
];
const SEC_EXCHANGES: readonly unknown[] = [
	"Nasdaq",
	"NYSE",
	"CBOE",
	"TXSE",
	"OTC",
	null,
	"nasdaq",
	" NYSE ",
	"",
	3,
];
const SEC_CIKS: readonly unknown[] = [320193, 789019, 0, -5, 1.5, "320193", null, 1e21];

function secDirectoryCase(rng: Rng): unknown {
	const roll = rng.float();
	if (roll < 0.04) return rng.pick([null, [], "x", 3, { fields: ["cik"] }, { data: [] }]);
	const fields = rng.shuffle(["cik", "name", "ticker", "exchange"]);
	if (rng.chance(0.1)) fields.push("sic");
	if (rng.chance(0.05)) fields.splice(rng.int(0, fields.length - 1), 1);
	if (rng.chance(0.03)) fields.push(rng.pick(["cik", "name"]));
	const rows: unknown[] = [];
	const count = rng.int(0, 14);
	for (let index = 0; index < count; index += 1) {
		if (rng.chance(0.02)) {
			rows.push(rng.pick([null, "row", { cik: 1 }]));
			continue;
		}
		const value: { [field: string]: unknown } = {
			cik: rng.pick(SEC_CIKS),
			name: rng.pick(SEC_NAMES),
			ticker: rng.pick(SEC_TICKERS),
			exchange: rng.pick(SEC_EXCHANGES),
			sic: "3571",
		};
		const row = fields.map((field) => value[field]);
		if (rng.chance(0.05)) row.pop();
		rows.push(row);
	}
	const body: { [key: string]: unknown } = { fields, data: rows };
	if (rng.chance(0.03)) body.fields = [...fields, 7];
	return body;
}

/** The floor / ceiling recipe both sides rebuild: two rows to drop, then `count` NYSE rows. */
function secRecipe(count: number): unknown {
	const rows: unknown[][] = [
		[9, "N".repeat(201), "LONG", "NYSE"],
		[8, "Over the counter", "OTCX", "OTC"],
	];
	for (let index = 0; index < count; index += 1) {
		rows.push([100_000 + index, `Company ${index}`, `T${String(index).padStart(4, "0")}`, "NYSE"]);
	}
	return { fields: ["cik", "name", "ticker", "exchange"], data: rows };
}

const SEC_RECIPE_COUNTS = [0, 1, 999, 1_000, 1_001, 9_999, 10_000, 10_001];

const USER_AGENT = "Vector Owner research owner@example.com";

interface SecSourceCase {
	readonly userAgent: string | null;
	readonly before: readonly boolean[];
	readonly script: readonly ScriptEntry[];
	readonly events: unknown;
	readonly dropped: readonly number[];
	readonly output: unknown;
}

async function secSourceCase(rng: Rng): Promise<SecSourceCase> {
	const userAgent = rng.chance(0.85) ? USER_AGENT : rng.pick([null, "no contact here"]);
	const roll = rng.float();
	const script: ScriptEntry[] = [];
	if (roll < 0.35) {
		script.push({ text: JSON.stringify(secRecipe(rng.pick([999, 1_000, 1_000, 1_005]))) });
	} else if (roll < 0.5) {
		script.push({ text: rng.pick(["<html>", "", "{", "[]", JSON.stringify(secRecipe(3))]) });
	} else if (roll < 0.75) {
		script.push(
			fetchError("HTTP_ERROR", rng.pick(["HTTP 429", "HTTP 403", "HTTP 404", "HTTP 503"])),
		);
	} else {
		script.push(
			fetchError(
				rng.pick(["TIMEOUT", "NETWORK_ERROR", "RESPONSE_TOO_LARGE", "UNSAFE_REDIRECT"]),
				"detail",
			),
		);
	}
	const before = rng.chance(0.85) ? [] : [false];
	const events: FetchEvent[] = [];
	const dropped: number[] = [];
	const source = createSecDirectorySource({
		client: createSecClient({
			fetcher: scriptedFetcher(script, events),
			clock: tickingClock(Date.UTC(2026, 9, 24, 3, 0, 0)),
			userAgent,
			sleep: async (ms) => {
				events.push({ sleep: ms });
			},
		}),
		onDroppedRows: (count) => dropped.push(count),
	});
	const result = await source.fetchDirectory({
		signal: NEVER,
		beforeRequest: scriptedBefore(before, events),
	});
	return {
		userAgent,
		before,
		script,
		events: plain(events),
		dropped,
		output: resultJson(result, listSummary),
	};
}

/* ---------- JPX ---------- */

const JA_SECTIONS = [
	"プライム（内国株式）",
	"プライム（外国株式）",
	"スタンダード（内国株式）",
	"スタンダード（外国株式）",
	"グロース（内国株式）",
	"グロース（外国株式）",
	"ETF・ETN",
	"PRO Market",
	"REIT・ベンチャーファンド・カントリーファンド・インフラファンド",
	"出資証券",
	" プライム（内国株式） ",
	"プライム(内国株式)",
	"",
];
const EN_SECTIONS = ["Prime Market (Domestic)", "ETFs/ ETNs", "Growth Market (Foreign)", ""];
const CODES = [
	"7203",
	"6758",
	"130A",
	"130a",
	" 1301 ",
	"25935",
	"ABCD",
	"0001",
	"",
	"7203.5",
	"9984",
	"1111",
];
const JA_NAMES = [
	"トヨタ自動車",
	"ソニーグループ",
	"Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
	"  空白  ",
	"",
	"名".repeat(200),
	"名".repeat(201),
	"𠮷".repeat(100),
	"𠮷".repeat(101),
	"&amp;記号&lt;",
];
const EN_NAMES = [
	"TOYOTA MOTOR CORPORATION",
	"SONY GROUP CORPORATION",
	"K&amp;O Energy Group Inc.",
	" Trailing ",
	"",
	"N".repeat(200),
	"N".repeat(201),
	"&#x1F600; Emoji",
];
const DATES = ["20260930", "20260930", "20260930", "20261031", "2026093", "", "20260230", "46295"];

const HEADERS: { readonly [L in JpxListingLanguage]: readonly string[] } = {
	ja: ["日付", "コード", "銘柄名", "市場・商品区分"],
	en: ["Effective Date", "Local Code", "Name (English)", "Section/Products"],
};

interface SheetPlan {
	readonly sheet: string;
	readonly shared: string;
}

/** A listing sheet in the observed layout, with the variations the reader distinguishes. */
function listingSheet(
	rng: Rng,
	language: JpxListingLanguage,
	rows: readonly (readonly [string, string, string, string])[],
	options: { readonly variations: boolean },
): SheetPlan {
	const strings: string[] = [];
	const known = new Map<string, number>();
	const shared = (text: string): number => {
		const index = known.get(text);
		if (index !== undefined) return index;
		strings.push(text);
		known.set(text, strings.length - 1);
		return strings.length - 1;
	};
	const vary = options.variations;
	// Header texts: exact, padded, the other language's, or one missing.
	const header = HEADERS[language].map((text) =>
		vary && rng.chance(0.08)
			? rng.pick([` ${text} `, `${text}\n`, HEADERS[language === "ja" ? "en" : "ja"][0] ?? "", ""])
			: text,
	);
	const columns =
		vary && rng.chance(0.3) ? rng.shuffle(["A", "B", "C", "D"]) : ["A", "B", "C", "D"];
	const cell = (column: string, rowNumber: number, text: string, numericOk: boolean): string => {
		const ref = vary && rng.chance(0.03) ? "" : ` r="${column}${rowNumber}"`;
		if (numericOk && /^[0-9]+$/.test(text) && (!vary || rng.chance(0.8))) {
			return `<c${ref}><v>${text}</v></c>`;
		}
		if (vary && rng.chance(0.1)) return `<c${ref} t="inlineStr"><is><t>${text}</t></is></c>`;
		if (vary && rng.chance(0.03)) return `<c${ref}/>`;
		return `<c${ref} t="s"><v>${shared(text)}</v></c>`;
	};
	const rowXml = (rowNumber: number, texts: readonly string[], numeric: boolean): string => {
		const cells = texts.map((text, index) => ({
			column: columns[index] ?? "A",
			xml: cell(columns[index] ?? "A", rowNumber, text, numeric && (index === 0 || index === 1)),
		}));
		cells.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
		return `<row r="${rowNumber}">${cells.map((entry) => entry.xml).join("")}<c r="E${rowNumber}"><v>50</v></c></row>`;
	};
	let xml = "";
	let rowNumber = 1;
	if (vary && rng.chance(0.15)) {
		xml += `<row r="${rowNumber}"><c r="A${rowNumber}" t="s"><v>${shared("上場銘柄一覧")}</v></c></row>`;
		rowNumber += 1;
	}
	if (!(vary && rng.chance(0.05))) {
		xml += rowXml(rowNumber, header, false);
		rowNumber += 1;
	}
	for (const row of rows) {
		if (vary && rng.chance(0.03)) xml += `<row r="${rowNumber}"/>`;
		xml += rowXml(rowNumber, row, true);
		rowNumber += 1;
	}
	let sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><sheetData>${xml}</sheetData></worksheet>`;
	let sharedXml = `<sst>${strings.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>`;
	if (vary && rng.chance(0.04)) sheet = sheet.slice(0, rng.int(0, sheet.length));
	if (vary && rng.chance(0.03)) sharedXml = sharedXml.slice(0, rng.int(0, sharedXml.length));
	return { sheet, shared: sharedXml };
}

function randomRows(rng: Rng, language: JpxListingLanguage, count: number) {
	return Array.from({ length: count }, (): readonly [string, string, string, string] => [
		rng.pick(DATES),
		rng.pick(CODES),
		rng.pick(language === "ja" ? JA_NAMES : EN_NAMES),
		rng.pick(language === "ja" ? JA_SECTIONS : EN_SECTIONS),
	]);
}

/** `count` Prime rows with distinct codes (`1000` …), for lists at the floor. */
function bulkRows(language: JpxListingLanguage, count: number, date = "20260930") {
	return Array.from({ length: count }, (_, index): readonly [string, string, string, string] => [
		date,
		String(1000 + index),
		language === "ja" ? `銘柄${index}` : `Issue ${index}`,
		language === "ja" ? "プライム（内国株式）" : "Prime Market (Domestic)",
	]);
}

function listingRow(rng: Rng, language: JpxListingLanguage): JpxListingRow {
	return {
		code: rng.pick(["7203", "6758", "130A", "1111", "9984", "2222"]),
		name: rng.pick(language === "ja" ? JA_NAMES : EN_NAMES).trim(),
		section: rng.pick(language === "ja" ? JA_SECTIONS : EN_SECTIONS).trim(),
		date: rng.pick(DATES),
	};
}

const LINK_PAGES: readonly string[] = [
	"/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx",
	"/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx",
	"/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/jyoujyou(updated)_e.xlsx",
	"https://www.jpx.co.jp/markets/statistics-equities/misc/x-att/data_j.xlsx",
	"https://WWW.JPX.CO.JP/markets/statistics-equities/misc/x-att/data_j.xlsx",
	"http://www.jpx.co.jp/markets/statistics-equities/misc/x-att/data_j.xlsx",
	"https://evil.example/markets/statistics-equities/misc/x-att/data_j.xlsx",
	"other-att/data_j.xlsx?x=1#f",
	"../../english/markets/statistics-equities/misc/y-att/data_e.xlsx",
	"/markets/statistics-equities/misc/a/b/data_j.xlsx",
	"/markets/statistics-equities/misc/a%20b/data_j.xlsx",
	"/markets/statistics-equities/misc/a-att/data_j.xls",
	"/markets/statistics-equities/misc/a-att/DATA_J.xlsx",
	"//www.jpx.co.jp/markets/statistics-equities/misc/z-att/data_j.xlsx",
	"javascript:alert(1)",
	"",
];

function linkHtml(rng: Rng): string {
	const anchors = rng.picks(LINK_PAGES, rng.int(0, 4)).map((href) => {
		const quote = rng.pick(['"', "'", ""]);
		const tag = rng.pick(["a", "A", "a "]);
		return quote === "" && /\s/.test(href)
			? `<${tag} href="${href}">`
			: `<${tag} class="x" href=${quote}${href}${quote}>`;
	});
	return `<html><body>${anchors.join("<br>")}</body></html>`;
}

interface JpxSourceCase {
	readonly before: readonly boolean[];
	readonly script: readonly ScriptEntry[];
	readonly events: unknown;
	readonly dropped: readonly number[];
	readonly output: unknown;
}

/** Stored entries only for small sheets: a stored thousand-row sheet is 250 KB of vector. */
function zipOf(plan: SheetPlan, rng: Rng): string {
	const method = (text: string): 0 | 8 => (text.length < 4_000 && rng.chance(0.3) ? 0 : 8);
	return base64(
		buildTestZip([
			{ name: SHEET, text: plan.sheet, method: method(plan.sheet) },
			{ name: STRINGS, text: plan.shared, method: method(plan.shared) },
		]),
	);
}

const JA_PAGE = `<a href="/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx" rel="external">`;
const EN_PAGE = `<a href="/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx" rel="external">`;

async function jpxSourceCase(rng: Rng): Promise<JpxSourceCase> {
	const script: ScriptEntry[] = [];
	const page = (html: string): ScriptEntry =>
		rng.chance(0.04)
			? fetchError("HTTP_ERROR", rng.pick(["HTTP 429", "HTTP 503", "HTTP 404"]))
			: rng.chance(0.04)
				? { text: "<html>moved</html>" }
				: { text: html };
	const book = (language: JpxListingLanguage): ScriptEntry => {
		const roll = rng.float();
		if (roll < 0.05) return fetchError(rng.pick(["TIMEOUT", "NETWORK_ERROR"]), "detail");
		if (roll < 0.08) return fetchError("HTTP_ERROR", "HTTP 429");
		if (roll < 0.11) return { bytes: base64(new Uint8Array([80, 75, 3, 4, 1])) };
		const count =
			language === "ja" ? rng.pick([5, 995, 1_000, 1_000, 1_000, 1_003]) : rng.pick([0, 3, 1_000]);
		const rows = [
			...randomRows(rng, language, rng.int(0, 6)),
			...bulkRows(language, count, rng.chance(0.85) ? "20260930" : "20261031"),
		];
		return {
			bytes: zipOf(listingSheet(rng, language, rows, { variations: rng.chance(0.15) }), rng),
		};
	};
	script.push(page(JA_PAGE), book("ja"), page(EN_PAGE), book("en"));
	const before = rng.chance(0.75)
		? []
		: rng.pick([[false], [true, false], [true, true, false], [true, true, true, false]]);
	const events: FetchEvent[] = [];
	const dropped: number[] = [];
	const fetcher = scriptedFetcher(script, events);
	const source = createJpxDirectorySource({
		fetcher,
		binaryFetcher: fetcher,
		onDroppedRows: (count) => dropped.push(count),
	});
	const result = await source.fetchDirectory({
		signal: NEVER,
		beforeRequest: scriptedBefore(before, events),
	});
	return {
		before,
		script,
		events: plain(events),
		dropped,
		output: resultJson(result, listSummary),
	};
}

export async function directoryFiles(): Promise<{ path: string; content: unknown }[]> {
	const rng = new Rng(0x5d1);
	const secEntries = Array.from({ length: 400 }, () => {
		const input = JSON.stringify(secDirectoryCase(rng));
		return { input, output: resultJson(secDirectoryEntries(JSON.parse(input)), (value) => value) };
	});
	const secRecipes = SEC_RECIPE_COUNTS.map((count) => ({
		count,
		output: resultJson(parseSecDirectory(secRecipe(count)), (value) => ({
			...(listSummary(value.data) as object),
			droppedRows: value.droppedRows,
		})),
	}));
	const jpxLinks = Array.from({ length: 300 }, () => {
		const html = linkHtml(rng);
		const language = rng.pick<JpxListingLanguage>(["ja", "en"]);
		return { html, language, output: extractJpxListingUrl(html, language) };
	});
	const jpxSheets = Array.from({ length: 300 }, () => {
		const language = rng.pick<JpxListingLanguage>(["ja", "en"]);
		const plan = listingSheet(rng, language, randomRows(rng, language, rng.int(0, 8)), {
			variations: true,
		});
		return {
			sheet: plan.sheet,
			shared: plan.shared,
			language,
			output: resultJson(parseJpxListingSheet(plan.sheet, plan.shared, language), (rows) => rows),
		};
	});
	const jpxJoins = Array.from({ length: 300 }, () => {
		const japanese = Array.from({ length: rng.int(0, 8) }, () => listingRow(rng, "ja"));
		const english = Array.from({ length: rng.int(0, 6) }, () => listingRow(rng, "en"));
		return { japanese, english, output: plain(jpxDirectoryEntries(japanese, english)) };
	});
	const listingDates = [
		...DATES,
		"20240229",
		"20230229",
		"00000101",
		"99991231",
		"２０２６０９３０",
		" 20260930",
		"202609300",
	].map((input) => ({ input, output: listingDate(input) }));
	const secSources: SecSourceCase[] = [];
	for (let index = 0; index < 60; index += 1) secSources.push(await secSourceCase(rng));
	const jpxSources: JpxSourceCase[] = [];
	for (let index = 0; index < 80; index += 1) jpxSources.push(await jpxSourceCase(rng));
	return [
		{
			path: "finance/stock_directory.json",
			content: {
				pageUrls: JPX_LISTING_PAGE_URLS,
				secEntries,
				secRecipes,
				jpxLinks,
				jpxSheets,
				jpxJoins,
				listingDates,
			},
		},
		{ path: "finance/stock_directory_sources.json", content: { secSources, jpxSources } },
	];
}
