/**
 * JPX workbook parser tests on SYNTHETIC XML with the real layout observed on
 * 2026-10-13 (rows 1–4 titles, row 5 header, data from row 6; cells like
 * `<c r="B700" s="6"><v>7203</v></c>`). JPX's file is never downloaded or
 * committed — `jpxEarnings.test.ts` builds the whole `.xlsx` container the
 * same way, and `earningsLive.test.ts` holds the opt-in live check.
 */
import { describe, expect, it } from "vitest";
import {
	decodeWorkbookText,
	headerMatches,
	parseJpxWorkbook,
	slugFiscalKind,
} from "../../src/finance/jpxWorkbook.ts";
import { expectErr, expectOk } from "./support.ts";

function sharedStringsXml(strings: readonly string[]): string {
	const items = strings.map((text) => `<si><t>${text}</t></si>`).join("");
	return `<?xml version="1.0" encoding="UTF-8"?><sst count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function cell(ref: string, style: string, body: string): string {
	return `<c r="${ref}" s="${style}"${body}>`;
}

function numericCell(ref: string, value: string): string {
	return cell(ref, "6", `><v>${value}</v></c>`);
}

function sharedCell(ref: string, index: number): string {
	return cell(ref, "7", ` t="s"><v>${index}</v></c>`);
}

function row(number: number, cells: string): string {
	return `<row r="${number}">${cells}</row>`;
}

/**
 * A synthetic sheet with the observed layout: title rows, the row-5 header
 * with the real English halves, then data rows. Shared-string table:
 * 0 date header, 1 code header, 2 company header, 3 issue-name header,
 * 4 fiscal-end header, 5 kind header, 6 quarter header, 7 segment header,
 * 8 Toyota name, 9 SoftBank name (trailing spaces), 10 Second quarter,
 * 11 Third quarter, 12 Undecided, 13 a string code.
 */
const STRINGS = [
	"決算発表予定日\r\nScheduled Dates for Earnings Announcements",
	"コード\r\nCode",
	"会社名",
	"Issue Name",
	"決算期末\r\nFiscal Year-end",
	"種別",
	"Fiscal Year/Quarter",
	"Market Segment",
	"Toyota Motor Corp.",
	"SoftBank Group Corp.  ",
	"Second quarter",
	"Third quarter",
	"未定_Undecided",
	"130A",
];

function headerRow(): string {
	return row(
		5,
		sharedCell("A5", 0) +
			sharedCell("B5", 1) +
			sharedCell("C5", 2) +
			sharedCell("D5", 3) +
			sharedCell("E5", 4) +
			sharedCell("H5", 5) +
			sharedCell("I5", 6) +
			sharedCell("K5", 7),
	);
}

function sheetXml(dataRows: string): string {
	return (
		`<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>` +
		`<row r="1"><c r="A1" s="1" t="s"><v>0</v></c></row>` +
		`<row r="4"><c r="A4" s="1" t="s"><v>0</v></c></row>` +
		headerRow() +
		dataRows +
		`</sheetData></worksheet>`
	);
}

describe("decodeWorkbookText", () => {
	it("decodes predefined entities and numeric references in one pass", () => {
		expect(decodeWorkbookText("A &amp; B &lt;C&gt;")).toBe("A & B <C>");
		expect(decodeWorkbookText("&#x7D50;&#x7B97;")).toBe("結算");
		expect(decodeWorkbookText("&lol; &amp;amp;")).toBe("&lol; &amp;");
	});
});

describe("slugFiscalKind", () => {
	it("slugs the English kind column", () => {
		expect(slugFiscalKind("Second quarter")).toBe("second-quarter");
		expect(slugFiscalKind("Third quarter")).toBe("third-quarter");
		expect(slugFiscalKind("Full year")).toBe("full-year");
	});
});

describe("headerMatches", () => {
	it("matches the observed newline form and the slash form, without cross-matching", () => {
		expect(
			headerMatches(
				"決算発表予定日\r\nScheduled Dates for Earnings Announcements",
				"Scheduled Dates for Earnings Announcements",
			),
		).toBe(true);
		expect(headerMatches("コード / Code", "Code")).toBe(true);
		expect(headerMatches("Issue Name", "Issue Name")).toBe(true);
		expect(headerMatches("Fiscal Year/Quarter", "Fiscal Year/Quarter")).toBe(true);
		expect(headerMatches("Fiscal Year/Quarter", "Quarter")).toBe(false);
		expect(headerMatches("Market Segment", "Code")).toBe(false);
		expect(headerMatches("種別", "Fiscal Year/Quarter")).toBe(false);
	});
});

describe("parseJpxWorkbook", () => {
	it("parses dated rows with numeric and string codes", () => {
		const sheet = sheetXml(
			row(
				6,
				numericCell("A6", "46331") +
					numericCell("B6", "7203") +
					sharedCell("D6", 8) +
					numericCell("E6", "46477") +
					sharedCell("I6", 10),
			) +
				row(
					7,
					numericCell("A7", "46332") +
						sharedCell("B7", 13) +
						sharedCell("D7", 8) +
						numericCell("E7", "46477") +
						sharedCell("I7", 10),
				),
		);
		const rows = expectOk(parseJpxWorkbook(sheet, sharedStringsXml(STRINGS)));
		expect(rows.map((entry) => entry.code)).toEqual(["7203", "130A"]);
	});

	it("maps a full row the way the source needs it", () => {
		const sheet = sheetXml(
			row(
				6,
				numericCell("A6", "46331") +
					numericCell("B6", "7203") +
					sharedCell("C6", 8) +
					sharedCell("D6", 9) +
					numericCell("E6", "46477") +
					sharedCell("I6", 10) +
					`<c r="G6" s="11"/>`,
			),
		);
		const rows = expectOk(parseJpxWorkbook(sheet, sharedStringsXml(STRINGS)));
		expect(rows).toEqual([
			{
				code: "7203",
				name: "SoftBank Group Corp.",
				announcementDate: "2026-11-05",
				fiscalPeriodEnd: "2027-03-31",
				fiscalPeriodLabel: "Second quarter",
				periodKey: "fy2027-03-31-second-quarter",
			},
		]);
	});

	it("reads shared strings as Excel shows them, without phonetic <rPh> readings (F3)", () => {
		const phonetic = (text: string, reading: string): string =>
			`<si><r><rPr><b/></rPr><t>${text}</t></r><rPh sb="0" eb="2"><t>${reading}</t></rPh><phoneticPr fontId="1"/></si>`;
		const shared = `<sst>${STRINGS.map((text, index) =>
			index === 3 || index === 8 ? phonetic(text, "ｶﾅ") : `<si><t>${text}</t></si>`,
		).join("")}</sst>`;
		const sheet = sheetXml(
			row(
				6,
				numericCell("A6", "46331") +
					numericCell("B6", "7203") +
					sharedCell("D6", 8) +
					numericCell("E6", "46477") +
					sharedCell("I6", 10),
			),
		);
		// Header "Issue Name" carries a reading too: it must still be recognised.
		const rows = expectOk(parseJpxWorkbook(sheet, shared));
		expect(rows.map((entry) => entry.name)).toEqual(["Toyota Motor Corp."]);
	});

	it("keeps Undecided rows dateless and trims trailing spaces from names", () => {
		const sheet = sheetXml(
			row(
				6,
				sharedCell("A6", 12) +
					numericCell("B6", "7203") +
					sharedCell("D6", 9) +
					numericCell("E6", "46477") +
					sharedCell("I6", 11),
			),
		);
		const rows = expectOk(parseJpxWorkbook(sheet, sharedStringsXml(STRINGS)));
		expect(rows).toEqual([
			{
				code: "7203",
				name: "SoftBank Group Corp.",
				announcementDate: null,
				fiscalPeriodEnd: "2027-03-31",
				fiscalPeriodLabel: "Third quarter",
				periodKey: "fy2027-03-31-third-quarter",
			},
		]);
	});

	it("fails closed when a required header is missing", () => {
		const broken = row(
			5,
			sharedCell("A5", 0) + sharedCell("B5", 1) + sharedCell("D5", 3) + numericCell("E5", "46477"),
		);
		const sheet = `<?xml version="1.0"?><worksheet><sheetData>${broken}</sheetData></worksheet>`;
		expect(expectErr(parseJpxWorkbook(sheet, sharedStringsXml(STRINGS)))).toBe("MISSING_HEADERS");
	});

	it("fails a truncated workbook as MALFORMED_WORKBOOK instead of hanging", () => {
		// Many cell openers without a closer inside one closed row: a lazy
		// `<c>…</c>` regex re-scans to the end per opener (quadratic — the
		// old pattern needs seconds here and minutes at the entry ceiling);
		// the linear scan fails at the first unclosed opener.
		const truncated =
			`<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>` +
			`<row r="5">${sharedCell("A5", 0)}${sharedCell("B5", 1)}${sharedCell("C5", 2)}${sharedCell("D5", 3)}${sharedCell("E5", 4)}${sharedCell("H5", 5)}${sharedCell("I5", 6)}${sharedCell("K5", 7)}</row>` +
			`<row r="6">` +
			`<c r="A6" s="6"><v>46331`.repeat(100_000) +
			`</row></sheetData></worksheet>`;
		const started = Date.now();
		expect(expectErr(parseJpxWorkbook(truncated, sharedStringsXml(STRINGS)))).toBe(
			"MALFORMED_WORKBOOK",
		);
		expect(Date.now() - started).toBeLessThan(10_000);
		const truncatedStrings = `<sst>${"<si><t>aaa".repeat(30_000)}</sst>`;
		expect(
			expectErr(parseJpxWorkbook(sheetXml(row(6, numericCell("A6", "46331"))), truncatedStrings)),
		).toBe("MALFORMED_WORKBOOK");
	});

	it("fails closed when the header is found but no data row parses", () => {
		const sheet = sheetXml(
			row(
				6,
				numericCell("A6", "99999999") +
					numericCell("B6", "7203") +
					sharedCell("D6", 8) +
					numericCell("E6", "46477") +
					sharedCell("I6", 10),
			),
		);
		expect(expectErr(parseJpxWorkbook(sheet, sharedStringsXml(STRINGS)))).toBe(
			"MALFORMED_WORKBOOK",
		);
	});

	it("skips malformed data rows instead of failing the workbook", () => {
		const sheet = sheetXml(
			row(
				6,
				numericCell("A6", "99999999") +
					numericCell("B6", "7203") +
					sharedCell("D6", 8) +
					numericCell("E6", "46477") +
					sharedCell("I6", 10),
			) +
				row(
					7,
					numericCell("A7", "46331") +
						numericCell("B7", "7203") +
						sharedCell("D7", 8) +
						numericCell("E7", "46477") +
						sharedCell("I7", 10),
				),
		);
		const rows = expectOk(parseJpxWorkbook(sheet, sharedStringsXml(STRINGS)));
		expect(rows.map((entry) => entry.announcementDate)).toEqual(["2026-11-05"]);
	});
});
