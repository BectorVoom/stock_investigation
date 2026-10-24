/**
 * The Japanese stock directory (ADR-0034) on JPX's "List of TSE-listed
 * Issues". The workbooks are SYNTHETIC `.xlsx` files built in-test in the
 * layout observed on 2026-10-24 (shared-string text cells, numeric
 * YYYYMMDD dates and numeric codes, headers in row 1); the trimmed rows below
 * are copied from that day's `data_j.xlsx` / `data_e.xlsx`, one per section.
 * JPX's files are never committed.
 */
import type {
	BinaryDocument,
	FetchedDocument,
	SafeBinaryFetcher,
	SafeFetchError,
	SafeFetcher,
	SafeFetchOptions,
} from "@research/application";
import { STOCK_DIRECTORY_LIMITS } from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	createJpxDirectorySource,
	extractJpxListingUrl,
	JPX_LISTING_PAGE_URLS,
	type JpxListingRow,
	jpxDirectoryEntries,
	jpxListingRows,
	listingDate,
	parseJpxDirectory,
	parseJpxListingWorkbook,
} from "../../src/finance/jpxDirectory.ts";
import { readWorkbookRows } from "../../src/finance/jpxWorkbook.ts";
import { buildTestZip } from "../zipTestUtils.ts";
import { expectErr, expectOk } from "./support.ts";

type Row = readonly [date: string, code: string, name: string, section: string];

const JA_HEADER: Row = ["日付", "コード", "銘柄名", "市場・商品区分"];
const EN_HEADER: Row = ["Effective Date", "Local Code", "Name (English)", "Section/Products"];

/** Real rows of 2026-10-24, one per 市場・商品区分 (plus 7203, 6758 and a five-digit preferred share). */
const REAL_JA: readonly Row[] = [
	["20260930", "1301", "極洋", "プライム（内国株式）"],
	["20260930", "1305", "ｉＦｒｅｅＥＴＦ　ＴＯＰＩＸ（年１回決算型）", "ETF・ETN"],
	["20260930", "130A", "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ", "グロース（内国株式）"],
	["20260930", "131A", "ＣＣＮグループ", "PRO Market"],
	["20260930", "1376", "カネコ種苗", "スタンダード（内国株式）"],
	["20260930", "1773", "ワイ・ティー・エル・コーポレーション・バーハッド", "プライム（外国株式）"],
	["20260930", "25935", "伊藤園第１種優先株式", "プライム（内国株式）"],
	[
		"20260930",
		"2971",
		"エスコンジャパンリート投資法人",
		"REIT・ベンチャーファンド・カントリーファンド・インフラファンド",
	],
	["20260930", "4875", "メディシノバ・インク", "スタンダード（外国株式）"],
	["20260930", "6758", "ソニーグループ", "プライム（内国株式）"],
	["20260930", "7203", "トヨタ自動車", "プライム（内国株式）"],
	["20260930", "7699", "オムニ・プラス・システム・リミテッド　ＪＤＲ", "グロース（外国株式）"],
	["20260930", "8301", "日本銀行　出資証券", "出資証券"],
];
const REAL_EN: readonly Row[] = [
	["20260930", "1301", "KYOKUYO CO.,LTD.", "Prime Market (Domestic)"],
	["20260930", "1305", "iFreeETF TOPIX (Yearly Dividend Type)", "ETFs/ ETNs"],
	["20260930", "130A", "Veritas In Silico Inc.", "Growth Market(Domestic)"],
	["20260930", "131A", "CCN Group Corporation", "PRO Market"],
	["20260930", "1376", "KANEKO SEEDS CO.,LTD.", "Standard Market(Domestic)"],
	["20260930", "1773", "YTL Corporation Berhad", "Prime Market(Foreign)"],
	["20260930", "25935", "Class-A Preferred Stock of ITO EN,LTD.", "Prime Market (Domestic)"],
	[
		"20260930",
		"2971",
		"ESCON JAPAN REIT Investment Corporation",
		"REIT, Venture Funds, Country Funds and Infrastructure Funds",
	],
	["20260930", "4875", "MediciNova,Inc.", "Standard Market(Foreign)"],
	["20260930", "6758", "SONY GROUP CORPORATION", "Prime Market (Domestic)"],
	["20260930", "7203", "TOYOTA MOTOR CORPORATION", "Prime Market (Domestic)"],
	["20260930", "7699", "OMNI-PLUS SYSTEM LIMITED", "Growth Market (Foreign)"],
	["20260930", "8301", "BANK OF JAPAN", "Equity Contribution Securities"],
];

/** `count` generated Prime issues (`9000` …), to reach the contract floor. */
function padding(count: number, language: "ja" | "en"): Row[] {
	return Array.from({ length: count }, (_, index): Row => {
		const code = String(9000 + index);
		return language === "ja"
			? ["20260930", code, `銘柄${index}`, "プライム（内国株式）"]
			: ["20260930", code, `Issue ${index}`, "Prime Market (Domestic)"];
	});
}

const XML_ESCAPES: { readonly [char: string]: string } = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};
const escapeXml = (text: string): string =>
	text.replace(/[&<>"]/g, (char) => XML_ESCAPES[char] ?? char);

/** Sheet + shared strings as JPX writes them: text as shared strings, dates and numeric codes as numbers. */
function sheetXml(header: Row, rows: readonly Row[]): { sheet: string; shared: string } {
	const strings: string[] = [];
	const index = new Map<string, number>();
	const shared = (text: string): number => {
		const known = index.get(text);
		if (known !== undefined) return known;
		strings.push(text);
		index.set(text, strings.length - 1);
		return strings.length - 1;
	};
	const cell = (ref: string, text: string, numeric: boolean): string =>
		numeric ? `<c r="${ref}"><v>${text}</v></c>` : `<c r="${ref}" t="s"><v>${shared(text)}</v></c>`;
	const headerCells = [...header, "33業種コード"]
		.map((text, column) => cell(`${"ABCDE"[column]}1`, text, false))
		.join("");
	const body = rows
		.map((row, at) => {
			const r = at + 2;
			const [date, code, name, section] = row;
			return (
				`<row r="${r}" spans="1:10">${cell(`A${r}`, date, true)}` +
				`${cell(`B${r}`, code, /^[0-9]+$/.test(code))}${cell(`C${r}`, name, false)}` +
				`${cell(`D${r}`, section, false)}<c r="E${r}"><v>50</v></c></row>`
			);
		})
		.join("");
	return {
		sheet: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><dimension ref="A1:J4448"/><sheetData><row r="1" spans="1:10">${headerCells}</row>${body}</sheetData></worksheet>`,
		shared: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join("")}</sst>`,
	};
}

function workbook(header: Row, rows: readonly Row[]): Uint8Array {
	const { sheet, shared } = sheetXml(header, rows);
	return buildTestZip([
		{ name: "xl/worksheets/sheet1.xml", text: sheet, method: 8 },
		{ name: "xl/sharedStrings.xml", text: shared, method: 8 },
	]);
}

function listingRows(header: Row, rows: readonly Row[], language: "ja" | "en"): JpxListingRow[] {
	const { sheet, shared } = sheetXml(header, rows);
	return expectOk(jpxListingRows(expectOk(readWorkbookRows(sheet, shared)), language));
}

const FLOOR = STOCK_DIRECTORY_LIMITS.minEntriesPerMarket;
const MAX_NAME = STOCK_DIRECTORY_LIMITS.maxNameChars;

describe("extractJpxListingUrl", () => {
	it("finds each language's workbook link on its own page, without hard-coding the folder", () => {
		const ja = `<a href="/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx" rel="external">`;
		const en =
			`<a href="/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/jyoujyou(updated)_e.xlsx">` +
			`<a href="/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx" rel="external">`;
		expect(extractJpxListingUrl(ja, "ja")).toBe(
			"https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx",
		);
		expect(extractJpxListingUrl(en, "en")).toBe(
			"https://www.jpx.co.jp/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx",
		);
		expect(extractJpxListingUrl(ja, "en")).toBeNull();
		expect(extractJpxListingUrl(en, "ja")).toBeNull();
	});

	it("resolves relative links against the page and refuses other hosts, schemes and shapes", () => {
		expect(extractJpxListingUrl(`<a href='other-att/data_j.xlsx?x=1#f'>`, "ja")).toBe(
			"https://www.jpx.co.jp/markets/statistics-equities/misc/other-att/data_j.xlsx",
		);
		for (const href of [
			"https://evil.example/markets/statistics-equities/misc/a-att/data_j.xlsx",
			"http://www.jpx.co.jp/markets/statistics-equities/misc/a-att/data_j.xlsx",
			"/markets/statistics-equities/misc/a/b/data_j.xlsx",
			"/markets/statistics-equities/misc/a-att/data_j.xls",
			"/markets/statistics-equities/misc/a%20b/data_j.xlsx",
		]) {
			expect(extractJpxListingUrl(`<a href="${href}">`, "ja")).toBeNull();
		}
		expect(extractJpxListingUrl("<p>no links</p>", "ja")).toBeNull();
	});
});

describe("jpxListingRows", () => {
	it("reads the four columns by header text, upper-cases codes and skips rows without a JP code", () => {
		const rows = listingRows(
			JA_HEADER,
			[
				...REAL_JA,
				["20260930", "", "注記", ""],
				["20260930", "130a", "小文字", "グロース（内国株式）"],
			],
			"ja",
		);
		expect(rows.map((row) => row.code)).toEqual([
			"1301",
			"1305",
			"130A",
			"131A",
			"1376",
			"1773",
			"2971",
			"4875",
			"6758",
			"7203",
			"7699",
			"8301",
			"130A",
		]);
		expect(rows[0]).toEqual({
			code: "1301",
			name: "極洋",
			section: "プライム（内国株式）",
			date: "20260930",
		});
	});

	it("fails a sheet without the language's headers", () => {
		const { sheet, shared } = sheetXml(EN_HEADER, REAL_EN);
		const cells = expectOk(readWorkbookRows(sheet, shared));
		expect(expectErr(jpxListingRows(cells, "ja"))).toBe("DIRECTORY_PARSE_FAILED");
		expect(expectOk(jpxListingRows(cells, "en"))).toHaveLength(12);
	});
});

describe("jpxDirectoryEntries (the join)", () => {
	const ja = listingRows(JA_HEADER, REAL_JA, "ja");
	const en = listingRows(EN_HEADER, REAL_EN, "en");

	it("keeps Prime, Standard and Growth issues (domestic and foreign) with both names", () => {
		const joined = jpxDirectoryEntries(ja, en);
		expect(joined.asOf).toBe("2026-09-30");
		expect(joined.droppedRows).toBe(0);
		expect(joined.entries).toEqual([
			{ symbol: "1301", name: "KYOKUYO CO.,LTD.", localName: "極洋", listing: "tse-prime" },
			{
				symbol: "130A",
				name: "Veritas In Silico Inc.",
				localName: "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
				listing: "tse-growth",
			},
			{
				symbol: "1376",
				name: "KANEKO SEEDS CO.,LTD.",
				localName: "カネコ種苗",
				listing: "tse-standard",
			},
			{
				symbol: "1773",
				name: "YTL Corporation Berhad",
				localName: "ワイ・ティー・エル・コーポレーション・バーハッド",
				listing: "tse-prime",
			},
			{
				symbol: "4875",
				name: "MediciNova,Inc.",
				localName: "メディシノバ・インク",
				listing: "tse-standard",
			},
			{
				symbol: "6758",
				name: "SONY GROUP CORPORATION",
				localName: "ソニーグループ",
				listing: "tse-prime",
			},
			{
				symbol: "7203",
				name: "TOYOTA MOTOR CORPORATION",
				localName: "トヨタ自動車",
				listing: "tse-prime",
			},
			{
				symbol: "7699",
				name: "OMNI-PLUS SYSTEM LIMITED",
				localName: "オムニ・プラス・システム・リミテッド　ＪＤＲ",
				listing: "tse-growth",
			},
		]);
	});

	it("falls back to the Japanese name, swaps an over-long name for the other language and drops a row with neither", () => {
		const long = "N".repeat(MAX_NAME + 1);
		const japanese: JpxListingRow[] = [
			{ code: "1111", name: "英語なし", section: "プライム（内国株式）", date: "20260930" },
			{ code: "2222", name: "長い英語名", section: "プライム（内国株式）", date: "20260930" },
			{ code: "3333", name: long, section: "グロース（内国株式）", date: "20260930" },
			{ code: "4444", name: long, section: "グロース（内国株式）", date: "20260930" },
			{ code: "1111", name: "重複", section: "プライム（内国株式）", date: "20260930" },
		];
		const english: JpxListingRow[] = [
			{ code: "2222", name: long, section: "", date: "" },
			{ code: "3333", name: "Short English", section: "", date: "" },
			{ code: "4444", name: long, section: "", date: "" },
			{ code: "3333", name: "Second English row", section: "", date: "" },
		];
		const joined = jpxDirectoryEntries(japanese, english);
		expect(joined.entries).toEqual([
			{ symbol: "1111", name: "英語なし", localName: "英語なし", listing: "tse-prime" },
			{ symbol: "2222", name: "長い英語名", localName: "長い英語名", listing: "tse-prime" },
			{ symbol: "3333", name: "Short English", localName: "Short English", listing: "tse-growth" },
		]);
		expect(joined.droppedRows).toBe(1);
	});

	it("states asOf only when every kept row carries the same valid date", () => {
		const row = (code: string, date: string): JpxListingRow => ({
			code,
			name: "名",
			section: "プライム（内国株式）",
			date,
		});
		expect(jpxDirectoryEntries([row("1111", "20260930"), row("2222", "20260930")], []).asOf).toBe(
			"2026-09-30",
		);
		expect(
			jpxDirectoryEntries([row("1111", "20260930"), row("2222", "20261031")], []).asOf,
		).toBeNull();
		expect(jpxDirectoryEntries([row("1111", "20260230")], []).asOf).toBeNull();
		expect(jpxDirectoryEntries([], []).asOf).toBeNull();
		expect(listingDate("20240229")).toBe("2024-02-29");
		expect(listingDate("2026-09-30")).toBeNull();
		expect(listingDate("46295")).toBeNull();
	});

	it("refuses a list below the floor", () => {
		expect(expectErr(parseJpxDirectory(ja, en))).toBe("DIRECTORY_PARSE_FAILED");
		const big = listingRows(JA_HEADER, [...REAL_JA, ...padding(FLOOR - 8, "ja")], "ja");
		expect(expectOk(parseJpxDirectory(big, en)).data.entries).toHaveLength(FLOOR);
		const short = listingRows(JA_HEADER, [...REAL_JA, ...padding(FLOOR - 9, "ja")], "ja");
		expect(expectErr(parseJpxDirectory(short, en))).toBe("DIRECTORY_PARSE_FAILED");
	});
});

describe("parseJpxListingWorkbook", () => {
	it("reads a real-shape .xlsx and fails anything that is not one", () => {
		expect(expectOk(parseJpxListingWorkbook(workbook(JA_HEADER, REAL_JA), "ja"))).toHaveLength(12);
		expect(expectErr(parseJpxListingWorkbook(new Uint8Array([1, 2, 3]), "ja"))).toBe(
			"DIRECTORY_PARSE_FAILED",
		);
		const sheetOnly = buildTestZip([
			{ name: "xl/worksheets/sheet1.xml", text: "<worksheet/>", method: 0 },
		]);
		expect(expectErr(parseJpxListingWorkbook(sheetOnly, "ja"))).toBe("DIRECTORY_PARSE_FAILED");
	});
});

/* ---------- The source ---------- */

const JA_PAGE = `<html><a href="/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx" rel="external">一覧</a></html>`;
const EN_PAGE = `<html><a href="/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx" rel="external">List</a></html>`;

type Answer = Result<string, SafeFetchError> | Result<Uint8Array, SafeFetchError>;

function scripted(answers: readonly Answer[]) {
	const calls: { url: string; options: SafeFetchOptions }[] = [];
	let next = 0;
	const take = (url: string, options: SafeFetchOptions): Answer => {
		calls.push({ url, options });
		const answer = answers[next] ?? err({ code: "HTTP_ERROR", detail: "HTTP 404" });
		next += 1;
		return answer;
	};
	const fetcher: SafeFetcher = {
		async fetchText(url, options): Promise<Result<FetchedDocument, SafeFetchError>> {
			const answer = take(url, options);
			if (!answer.ok) return answer;
			if (typeof answer.value !== "string") throw new Error("binary answer for a page");
			return ok({ finalUrl: url, contentType: "text/html", text: answer.value });
		},
	};
	const binaryFetcher: SafeBinaryFetcher = {
		async fetchBytes(url, options): Promise<Result<BinaryDocument, SafeFetchError>> {
			const answer = take(url, options);
			if (!answer.ok) return answer;
			if (typeof answer.value === "string") throw new Error("text answer for a workbook");
			return ok({ finalUrl: url, contentType: null, bytes: answer.value });
		},
	};
	return { fetcher, binaryFetcher, calls };
}

const never = new AbortController().signal;

describe("createJpxDirectorySource", () => {
	const fullJa = workbook(JA_HEADER, [...REAL_JA, ...padding(FLOOR, "ja")]);
	const fullEn = workbook(EN_HEADER, REAL_EN);

	it("fetches page, workbook, page, workbook in order, each after one pacing grant", async () => {
		const { fetcher, binaryFetcher, calls } = scripted([
			ok(JA_PAGE),
			ok(fullJa),
			ok(EN_PAGE),
			ok(fullEn),
		]);
		const dropped: number[] = [];
		const source = createJpxDirectorySource({
			fetcher,
			binaryFetcher,
			onDroppedRows: (count) => dropped.push(count),
		});
		const order: string[] = [];
		const result = await source.fetchDirectory({
			signal: never,
			beforeRequest: async () => {
				order.push(`grant${calls.length}`);
				return true;
			},
		});
		const data = expectOk(result);
		expect(source.market).toBe("JP");
		expect(data.asOf).toBe("2026-09-30");
		expect(data.entries).toHaveLength(8 + FLOOR);
		expect(data.entries.find((entry) => entry.symbol === "7203")).toEqual({
			symbol: "7203",
			name: "TOYOTA MOTOR CORPORATION",
			localName: "トヨタ自動車",
			listing: "tse-prime",
		});
		expect(data.entries.find((entry) => entry.symbol === "9000")).toEqual({
			symbol: "9000",
			name: "銘柄0",
			localName: "銘柄0",
			listing: "tse-prime",
		});
		expect(dropped).toEqual([]);
		expect(order).toEqual(["grant0", "grant1", "grant2", "grant3"]);
		expect(calls.map((call) => call.url)).toEqual([
			JPX_LISTING_PAGE_URLS.ja,
			"https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx",
			JPX_LISTING_PAGE_URLS.en,
			"https://www.jpx.co.jp/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx",
		]);
		for (const call of calls)
			expect([...(call.options.allowedHosts ?? [])]).toEqual(["www.jpx.co.jp"]);
		expect(calls[1]?.options).toMatchObject({ maxBytes: 4_194_304, timeoutMs: 60_000 });
	});

	it("stops before the English page when the Japanese list is broken", async () => {
		const { fetcher, binaryFetcher, calls } = scripted([
			ok(JA_PAGE),
			ok(workbook(EN_HEADER, REAL_EN)),
		]);
		const source = createJpxDirectorySource({ fetcher, binaryFetcher });
		const result = await source.fetchDirectory({ signal: never, beforeRequest: async () => true });
		expect(expectErr(result)).toBe("DIRECTORY_PARSE_FAILED");
		expect(calls).toHaveLength(2);
	});

	it("fails a page without the link as DIRECTORY_PARSE_FAILED", async () => {
		const { fetcher, binaryFetcher, calls } = scripted([ok("<html>moved</html>")]);
		const source = createJpxDirectorySource({ fetcher, binaryFetcher });
		const result = await source.fetchDirectory({ signal: never, beforeRequest: async () => true });
		expect(expectErr(result)).toBe("DIRECTORY_PARSE_FAILED");
		expect(calls).toHaveLength(1);
	});

	it("maps HTTP 429 to DIRECTORY_RATE_LIMITED and other failures to DIRECTORY_SOURCE_FAILED", async () => {
		const cases: [Answer[], string][] = [
			[[err({ code: "HTTP_ERROR", detail: "HTTP 429" })], "DIRECTORY_RATE_LIMITED"],
			[[ok(JA_PAGE), err({ code: "HTTP_ERROR", detail: "HTTP 429" })], "DIRECTORY_RATE_LIMITED"],
			[[err({ code: "HTTP_ERROR", detail: "HTTP 500" })], "DIRECTORY_SOURCE_FAILED"],
			[[ok(JA_PAGE), ok(fullJa), err({ code: "TIMEOUT", detail: "x" })], "DIRECTORY_SOURCE_FAILED"],
			[
				[ok(JA_PAGE), ok(fullJa), ok(EN_PAGE), err({ code: "NETWORK_ERROR", detail: "x" })],
				"DIRECTORY_SOURCE_FAILED",
			],
		];
		for (const [answers, code] of cases) {
			const { fetcher, binaryFetcher } = scripted(answers);
			const source = createJpxDirectorySource({ fetcher, binaryFetcher });
			const result = await source.fetchDirectory({
				signal: never,
				beforeRequest: async () => true,
			});
			expect(expectErr(result)).toBe(code);
		}
	});

	it("sends nothing further once the pacing hook refuses", async () => {
		const { fetcher, binaryFetcher, calls } = scripted([ok(JA_PAGE), ok(fullJa)]);
		const source = createJpxDirectorySource({ fetcher, binaryFetcher });
		const answers = [true, false];
		const result = await source.fetchDirectory({
			signal: never,
			beforeRequest: async () => answers.shift() ?? true,
		});
		expect(expectErr(result)).toBe("DIRECTORY_SOURCE_FAILED");
		expect(calls).toHaveLength(1);
	});

	it("reports rows dropped for an over-long name as a count", async () => {
		const long = "名".repeat(MAX_NAME + 1);
		const { fetcher, binaryFetcher } = scripted([
			ok(JA_PAGE),
			ok(
				workbook(JA_HEADER, [
					["20260930", "8888", long, "プライム（内国株式）"],
					...padding(FLOOR, "ja"),
				]),
			),
			ok(EN_PAGE),
			ok(workbook(EN_HEADER, [])),
		]);
		const dropped: number[] = [];
		const source = createJpxDirectorySource({
			fetcher,
			binaryFetcher,
			onDroppedRows: (count) => dropped.push(count),
		});
		const result = await source.fetchDirectory({ signal: never, beforeRequest: async () => true });
		expect(expectOk(result).entries).toHaveLength(FLOOR);
		expect(dropped).toEqual([1]);
	});
});
