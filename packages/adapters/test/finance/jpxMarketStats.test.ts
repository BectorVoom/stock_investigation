/**
 * JPX market statistics source tests (ADR-0076) on SYNTHETIC files built
 * in-test: a one-page PDF whose content stream is zlib-compressed with the
 * observed drawing (numbers as literal strings, labels as CID hex strings)
 * beside a binary "font" stream, and `.xlsx` workbooks with the observed
 * cell layout of 2026-11-19. JPX's files are never downloaded or committed.
 */
import { deflateSync } from "node:zlib";
import type {
	BinaryDocument,
	Clock,
	FetchedDocument,
	MarketRequestAdmission,
	SafeBinaryFetcher,
	SafeFetcher,
} from "@research/application";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { JPX_SHEET_PATH, JPX_STRINGS_PATH } from "../../src/finance/jpxEarnings.ts";
import {
	createJpxMarketStatsSource,
	excelSerial,
	JPX_MARGIN_HISTORY_URL,
	JPX_MARGIN_WEEKLY_URL,
	JPX_SERIES_META,
	JPX_SHORT_SELLING_URL,
	JPX_STATS_PAGE_TTL_MS,
	marginHistoryLink,
	marginRatio,
	marginWeeklyLinks,
	readMarginHistoryWorkbook,
	readMarginWeeklyWorkbook,
	readShortSellingPdf,
	serialDate,
	shortSellingLinks,
	shortSellingRatio,
} from "../../src/finance/jpxMarketStats.ts";
import type { WorkbookCell } from "../../src/finance/jpxWorkbook.ts";
import { pdfTextTokens, readPdfTextTokens } from "../../src/node/pdfText.ts";
import { buildTestZip } from "../zipTestUtils.ts";

/* ---------- Synthetic short-selling PDF ---------- */

function pdfStream(content: Uint8Array): Uint8Array {
	const data = deflateSync(content);
	return Buffer.concat([
		Buffer.from(`<</Filter/FlateDecode/Length ${data.length}>>stream\r\n`, "latin1"),
		data,
		Buffer.from("\r\nendstream\r\nendobj\r\n", "latin1"),
	]);
}

/** One text object drawing `text` as a literal string at x. */
function drawn(x: number, text: string): string {
	return `BT\r\n/F2 10.08 Tf\r\n1 0 0 1 ${x} 378.19 Tm\r\n[(${text})] TJ\r\nET\r\n`;
}

const NUMBERS = [
	drawn(209.54, "4,925,148"),
	drawn(323.57, "56.3%"),
	// A TJ that kerns one number into pieces still reads whole.
	"BT\r\n/F2 10.08 Tf\r\n1 0 0 1 385.49 378.19 Tm\r\n[(3,012,)-3(856)] TJ\r\nET\r\n",
	drawn(499.51, "34.4%"),
	drawn(570.55, "809,020"),
	drawn(681.94, "9.2%"),
	drawn(738.12, "8,747,024"),
];

function shortSellingPdf(numbers: readonly string[] = NUMBERS): Uint8Array {
	const content =
		"/Artifact BMC q\r\nBT\r\n/F1 14.76 Tf\r\n[<0001>4<00020003>] TJ\r\nET\r\nQ\r\n" +
		drawn(737.4, "2026/11/18") +
		drawn(216.38, "\\(a\\)") +
		numbers.join("") +
		"BT\r\n/F1 10.08 Tf\r\n[<0007000B>] TJ\r\nET\r\n";
	// A binary stream (a font program) that would read as text if not dropped.
	const font = Buffer.concat([
		Buffer.from([0x00, 0x01, 0x00, 0x00, 0xff]),
		Buffer.from(" BT (1,234,567) ET ", "latin1"),
	]);
	return Buffer.concat([
		Buffer.from("%PDF-1.7\r\n%\xb5\xb5\r\n1 0 obj\r\n", "latin1"),
		pdfStream(Buffer.from(content, "latin1")),
		Buffer.from("2 0 obj\r\n", "latin1"),
		pdfStream(font),
		Buffer.from("3 0 obj\r\n<</Length 4>>stream\r\nnope\r\nendstream\r\n%%EOF", "latin1"),
	]);
}

describe("pdf text tokens", () => {
	it("joins one text object's literals and decodes escapes", () => {
		const stream = Buffer.from(
			"BT [(a\\(b\\))5(\\101\\n)] TJ ET (outside) BT <0041> Tj ET BT (x) Tj (y) Tj ET",
			"latin1",
		);
		expect(pdfTextTokens(stream)).toEqual(["a(b)A\n", "xy"]);
	});

	it("drops binary streams and refuses a file that inflates past the cap", () => {
		expect(readPdfTextTokens(shortSellingPdf())).not.toContain("1,234,567");
		const huge = Buffer.concat([
			Buffer.from("%PDF-1.7\r\n", "latin1"),
			pdfStream(Buffer.alloc(4_194_305, 0x20)),
		]);
		expect(readPdfTextTokens(huge)).toBeNull();
	});
});

describe("readShortSellingPdf", () => {
	it("reads the four amounts and computes the ratio of short sales", () => {
		const day = readShortSellingPdf(shortSellingPdf());
		expect(day).toEqual({
			actual: 4_925_148,
			restricted: 3_012_856,
			unrestricted: 809_020,
			total: 8_747_024,
		});
		if (day === null) throw new Error("unreachable");
		expect(shortSellingRatio(day)).toBe(43.7);
	});

	it("refuses amounts that do not add up, a missing number and a wrong percentage", () => {
		const replaced = (index: number, text: string) =>
			NUMBERS.map((entry, at) => (at === index ? drawn(0, text) : entry));
		expect(readShortSellingPdf(shortSellingPdf(replaced(6, "8,747,124")))).toBeNull();
		expect(readShortSellingPdf(shortSellingPdf(NUMBERS.slice(0, 6)))).toBeNull();
		expect(readShortSellingPdf(shortSellingPdf(replaced(3, "35.4%")))).toBeNull();
		expect(readShortSellingPdf(Buffer.from("not a pdf"))).toBeNull();
	});
});

/* ---------- Synthetic margin workbooks ---------- */

function row(cells: readonly (readonly [string, string])[]): WorkbookCell[] {
	return cells.map(([column, text]) => ({ column, text }));
}

const WEEKLY_ROWS: WorkbookCell[][] = [
	row([["B", "46339"]]),
	row([
		["B", "46339"],
		["C", "46339"],
	]),
	row([
		["B", "46343"],
		["C", "46343"],
	]),
	row([["L", "(単位：千株、百万円）(Unit: thou. shares, JPY mil.)"]]),
	row([
		["E", "二市場 Tokyo&Nagoya"],
		["I", "東京 Tokyo"],
	]),
	row([
		["E", "売残高・\n貸株残高\nSales"],
		["F", "前週比\nWeekly change"],
		["G", "買残高・\n融資残高\nPurchases"],
		["H", "前週比\nWeekly change"],
		["I", "売残高・\n貸株残高\nSales"],
		["K", "買残高・\n融資残高\nPurchases"],
	]),
	row([
		["B", "制度信用取引残高"],
		["D", "株数Shs."],
		["E", "79690"],
		["G", "1595"],
	]),
	row([
		["D", "金額Val."],
		["E", "108626"],
		["G", "2072"],
	]),
	row([
		["B", "信用取引残高合計\nTotal Outstanding Margin Trading"],
		["D", "株数Shs."],
		["E", "356858"],
		["F", "24439"],
		["G", "3396354"],
		["H", "-64338"],
		["I", "356856"],
		["K", "3393654"],
	]),
	row([
		["D", "金額Val."],
		["E", "660000"],
		["F", "46513"],
		["G", "5768159"],
		["H", "-112836"],
		["I", "659998"],
		["K", "5764651"],
	]),
];

const HISTORY_ROWS: WorkbookCell[][] = [
	row([["A", "信用取引現在高"]]),
	row([
		["A", "Month\nor\nDay"],
		["N", "株数(A)"],
		["O", "金額"],
		["P", "株数(B)"],
		["Q", "金額"],
	]),
	row([["A", "[東京・名古屋 Tokyo & Nagoya]"]]),
	row([
		["A", "46318"],
		["N", "375064"],
		["O", "688573"],
		["P", "3660529"],
		["Q", "6534069"],
	]),
	row([
		["A", "46325"],
		["N", "349230"],
		["O", "643859"],
		["P", "3654854"],
		["Q", "6505887"],
	]),
	row([
		["A", "not a date"],
		["N", "1"],
	]),
	row([["A", "[東京 Tokyo]"]]),
	row([
		["A", "46325"],
		["N", "1"],
		["O", "2"],
		["P", "3"],
		["Q", "4"],
	]),
];

describe("margin workbooks", () => {
	it("converts Excel 1900 serials", () => {
		expect(excelSerial("2026-11-13")).toBe(46339);
		expect(serialDate(46325)).toBe("2026-10-30");
	});

	it("reads the weekly Tokyo-and-Nagoya totals", () => {
		const figures = readMarginWeeklyWorkbook(WEEKLY_ROWS, "2026-11-13");
		expect(figures).toEqual({
			sellShares: 356_858,
			sellValue: 660_000,
			buyShares: 3_396_354,
			buyValue: 5_768_159,
		});
		if (figures === null) throw new Error("unreachable");
		expect(marginRatio(figures)).toBe(9.52);
		expect(marginRatio({ ...figures, sellShares: 0 })).toBeNull();
	});

	it("refuses a weekly workbook of another week or without its totals", () => {
		expect(readMarginWeeklyWorkbook(WEEKLY_ROWS, "2026-11-06")).toBeNull();
		expect(readMarginWeeklyWorkbook(WEEKLY_ROWS.slice(0, 8), "2026-11-13")).toBeNull();
	});

	it("reads only the Tokyo-and-Nagoya section of the history workbook", () => {
		expect(readMarginHistoryWorkbook(HISTORY_ROWS)).toEqual([
			{
				date: "2026-10-23",
				figures: {
					sellShares: 375_064,
					sellValue: 688_573,
					buyShares: 3_660_529,
					buyValue: 6_534_069,
				},
			},
			{
				date: "2026-10-30",
				figures: {
					sellShares: 349_230,
					sellValue: 643_859,
					buyShares: 3_654_854,
					buyValue: 6_505_887,
				},
			},
		]);
		expect(readMarginHistoryWorkbook(HISTORY_ROWS.slice(2))).toEqual([]);
	});
});

/* ---------- Pages and links ---------- */

const PDF_PATH = "/markets/statistics-equities/short-selling/t13vrt000002q127-att";
const SHORT_SELLING_HTML = [
	`<a href="${PDF_PATH}/261118-m.pdf">m</a>`,
	`<a href="${PDF_PATH}/261118-g.pdf">g</a>`,
	`<a href="${PDF_PATH}/261117-m.pdf">m</a>`,
	`<a href="${PDF_PATH}/261117-m.pdf">duplicate</a>`,
	`<a href="${PDF_PATH}/261340-m.pdf">not a date</a>`,
	`<a href="https://evil.example.com${PDF_PATH}/261116-m.pdf">evil</a>`,
].join("");
const WEEKLY_PATH = "/markets/statistics-equities/margin/tvdivq0000001rk9-att";
const WEEKLY_HTML = `<a href="${WEEKLY_PATH}/20261113_mtcurrent.xlsx">x</a><a href="${WEEKLY_PATH}/20261113_mtcurrent.pdf">p</a><a href="${WEEKLY_PATH}/20261106_mtcurrent.xlsx">x</a>`;
const HISTORY_HTML = `<a href="/markets/statistics-equities/margin/tvdivq0000001rq1-att/tvdivq0000015969.xlsx">x</a><a href="/markets/statistics-equities/margin/tvdivq0000001rq1-att/20260925_mtgk.xls">old</a>`;

const PDF_18 = `https://www.jpx.co.jp${PDF_PATH}/261118-m.pdf`;
const PDF_17 = `https://www.jpx.co.jp${PDF_PATH}/261117-m.pdf`;
const WEEK_13 = `https://www.jpx.co.jp${WEEKLY_PATH}/20261113_mtcurrent.xlsx`;
const WEEK_06 = `https://www.jpx.co.jp${WEEKLY_PATH}/20261106_mtcurrent.xlsx`;
const HISTORY =
	"https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rq1-att/tvdivq0000015969.xlsx";

describe("JPX statistics links", () => {
	it("keeps the dated files of each page on the JPX host", () => {
		expect(shortSellingLinks(SHORT_SELLING_HTML)).toEqual([
			{ url: PDF_18, date: "2026-11-18" },
			{ url: PDF_17, date: "2026-11-17" },
		]);
		expect(marginWeeklyLinks(WEEKLY_HTML)).toEqual([
			{ url: WEEK_13, date: "2026-11-13" },
			{ url: WEEK_06, date: "2026-11-06" },
		]);
		expect(marginHistoryLink(HISTORY_HTML)).toBe(HISTORY);
	});
});

/* ---------- The source over a scripted network ---------- */

function workbookCellXml(cell: WorkbookCell, rowNumber: number, strings: string[]): string {
	const ref = `${cell.column}${rowNumber}`;
	if (/^-?[0-9]+$/.test(cell.text)) return `<c r="${ref}"><v>${cell.text}</v></c>`;
	strings.push(cell.text);
	return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
}

function workbook(rows: readonly (readonly WorkbookCell[])[]): Uint8Array {
	const strings: string[] = [];
	const sheet = rows
		.map(
			(cells, index) =>
				`<row r="${index + 1}">${cells.map((cell) => workbookCellXml(cell, index + 1, strings)).join("")}</row>`,
		)
		.join("");
	const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
	return buildTestZip([
		{
			name: JPX_SHEET_PATH,
			text: `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
			method: 8,
		},
		{
			name: JPX_STRINGS_PATH,
			text: `<sst>${strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join("")}</sst>`,
			method: 8,
		},
	]);
}

interface Network {
	readonly fetcher: SafeFetcher;
	readonly binaryFetcher: SafeBinaryFetcher;
	readonly calls: string[];
}

function network(
	text: { readonly [url: string]: string },
	binary: { readonly [url: string]: Uint8Array | number },
): Network {
	const calls: string[] = [];
	return {
		calls,
		fetcher: {
			fetchText: (url) => {
				calls.push(url);
				const page = text[url];
				if (page === undefined)
					return Promise.resolve(err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 }));
				const document: FetchedDocument = { finalUrl: url, contentType: "text/html", text: page };
				return Promise.resolve(ok(document));
			},
		},
		binaryFetcher: {
			fetchBytes: (url) => {
				calls.push(url);
				const file = binary[url];
				if (file === undefined || typeof file === "number") {
					const status = typeof file === "number" ? file : 404;
					return Promise.resolve(err({ code: "HTTP_ERROR", detail: `HTTP ${status}`, status }));
				}
				const document: BinaryDocument = {
					finalUrl: url,
					contentType: "application/octet-stream",
					bytes: file,
				};
				return Promise.resolve(ok(document));
			},
		},
	};
}

function clockAt(nowMs: number): Clock & { advance(ms: number): void } {
	let current = nowMs;
	return {
		nowMs: () => current,
		nowIso: () => new Date(current).toISOString(),
		advance: (ms) => {
			current += ms;
		},
	};
}

const NEVER = new AbortController().signal;

function query(
	symbol: string,
	grants: { count: number },
	admission: MarketRequestAdmission = "granted",
) {
	return {
		symbol,
		from: null,
		maxObservations: 800,
		signal: NEVER,
		beforeRequest: () => {
			grants.count += 1;
			return Promise.resolve(admission);
		},
	};
}

describe("createJpxMarketStatsSource", () => {
	const pages = {
		[JPX_SHORT_SELLING_URL]: SHORT_SELLING_HTML,
		[JPX_MARGIN_WEEKLY_URL]: WEEKLY_HTML,
		[JPX_MARGIN_HISTORY_URL]: HISTORY_HTML,
	};
	const files = {
		[PDF_18]: shortSellingPdf(),
		[PDF_17]: Buffer.from("%PDF-1.7 unreadable"),
		[WEEK_13]: workbook(WEEKLY_ROWS),
		[WEEK_06]: workbook(WEEKLY_ROWS),
		[HISTORY]: workbook(HISTORY_ROWS),
	};

	it("answers the short-selling ratio, skips an unreadable file and caches every download", async () => {
		const net = network(pages, files);
		const clock = clockAt(Date.parse("2026-11-19T02:00:00Z"));
		const source = createJpxMarketStatsSource({ ...net, clock });
		const grants = { count: 0 };
		const first = await source.fetchSeries(query("SHORT_SELLING_RATIO", grants));
		expect(first).toEqual(
			ok({
				meta: JPX_SERIES_META.SHORT_SELLING_RATIO,
				observations: [{ observedOn: "2026-11-18", value: 43.7 }],
			}),
		);
		expect(net.calls).toEqual([JPX_SHORT_SELLING_URL, PDF_18, PDF_17]);
		expect(grants.count).toBe(3);
		// Within the page TTL nothing is sent and no grant is taken.
		await source.fetchSeries(query("SHORT_SELLING_RATIO", grants));
		expect(net.calls).toHaveLength(3);
		expect(grants.count).toBe(3);
		// After it only the page is asked again; both files stay cached.
		clock.advance(JPX_STATS_PAGE_TTL_MS);
		await source.fetchSeries(query("SHORT_SELLING_RATIO", grants));
		expect(net.calls).toEqual([JPX_SHORT_SELLING_URL, PDF_18, PDF_17, JPX_SHORT_SELLING_URL]);
	});

	it("answers both margin series from one set of downloads, weekly figures over the history", async () => {
		const net = network(pages, files);
		const source = createJpxMarketStatsSource({ ...net, clock: clockAt(0) });
		const grants = { count: 0 };
		// The 06 workbook carries the 13th's serial: it does not read for its own week.
		const value = await source.fetchSeries(query("MARGIN_BUYING_VALUE", grants));
		expect(value).toEqual(
			ok({
				meta: JPX_SERIES_META.MARGIN_BUYING_VALUE,
				observations: [
					{ observedOn: "2026-10-23", value: 6_534_069 },
					{ observedOn: "2026-10-30", value: 6_505_887 },
					{ observedOn: "2026-11-13", value: 5_768_159 },
				],
			}),
		);
		const ratio = await source.fetchSeries(query("MARGIN_RATIO", grants));
		expect(ratio.ok && ratio.value.observations.map((point) => point.value)).toEqual([
			9.76, 10.47, 9.52,
		]);
		expect(net.calls).toEqual([
			JPX_MARGIN_WEEKLY_URL,
			JPX_MARGIN_HISTORY_URL,
			HISTORY,
			WEEK_13,
			WEEK_06,
		]);
	});

	it("fails with JPX's status and keeps nothing of a failed download", async () => {
		const limited = network(pages, { ...files, [PDF_18]: 429 });
		const source = createJpxMarketStatsSource({ ...limited, clock: clockAt(0) });
		const answer = await source.fetchSeries(query("SHORT_SELLING_RATIO", { count: 0 }));
		expect(answer.ok ? null : answer.error).toMatchObject({
			code: "RATE_LIMITED",
			upstreamStatus: 429,
		});
		const missingPage = network({}, files);
		const other = createJpxMarketStatsSource({ ...missingPage, clock: clockAt(0) });
		const failed = await other.fetchSeries(query("MARGIN_RATIO", { count: 0 }));
		expect(failed.ok ? null : failed.error).toMatchObject({
			code: "SOURCE_FAILED",
			upstreamStatus: 404,
		});
	});

	it("fails without a request when the page lists nothing or the grant is refused", async () => {
		const empty = network({ [JPX_SHORT_SELLING_URL]: "<html></html>" }, {});
		const source = createJpxMarketStatsSource({ ...empty, clock: clockAt(0) });
		const answer = await source.fetchSeries(query("SHORT_SELLING_RATIO", { count: 0 }));
		expect(answer.ok ? null : answer.error).toMatchObject({
			code: "SOURCE_FAILED",
			upstreamStatus: null,
		});
		const refused = network(pages, files);
		const gated = createJpxMarketStatsSource({ ...refused, clock: clockAt(0) });
		const spent = await gated.fetchSeries(
			query("SHORT_SELLING_RATIO", { count: 0 }, "budget-spent"),
		);
		expect(spent.ok ? null : spent.error).toMatchObject({
			code: "RATE_LIMITED",
			upstreamStatus: null,
		});
		expect(refused.calls).toEqual([]);
		const unknown = await gated.fetchSeries(query("NIKKEI", { count: 0 }));
		expect(unknown.ok ? null : unknown.error).toMatchObject({ code: "SERIES_NOT_FOUND" });
	});
});
