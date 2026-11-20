/**
 * The examples in docs/external-apis/apis/jpx.md, fed through the JPX code the
 * TypeScript runner uses (conventions §4). The page excerpts go through the
 * link discovery of both JPX sources. The decoded workbook contents
 * (`<ref>: <JSON text>` per cell) are turned back into a real `.xlsx` the way
 * JPX writes it — text cells as shared strings, numbers as numbers, deflated
 * ZIP entries — and its BYTES go through `parseJpxListingWorkbook` (what the
 * directory source calls on a download) and through the whole earnings source,
 * served by a scripted network at the URLs the schedule page links. JPX's real
 * workbooks are never committed (JPX terms of use).
 */
import { deflateSync } from "node:zlib";
import type {
	BinaryDocument,
	Clock,
	FetchedDocument,
	SafeBinaryFetcher,
	SafeFetcher,
} from "@research/application";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	extractJpxListingUrl,
	jpxDirectoryEntries,
	parseJpxListingWorkbook,
} from "../../src/finance/jpxDirectory.ts";
import {
	createJpxEarningsSource,
	extractJpxWorkbookUrls,
	JPX_INDEX_URL,
	JPX_SHEET_PATH,
	JPX_STRINGS_PATH,
} from "../../src/finance/jpxEarnings.ts";
import {
	createJpxMarketStatsSource,
	JPX_MARGIN_HISTORY_URL,
	JPX_MARGIN_WEEKLY_URL,
	JPX_SERIES_META,
	JPX_SHORT_SELLING_URL,
	marginHistoryLink,
	marginWeeklyLinks,
	readShortSellingPdf,
	shortSellingLinks,
	shortSellingRatio,
} from "../../src/finance/jpxMarketStats.ts";
import { docExampleText } from "../docExamples.ts";
import { buildTestZip } from "../zipTestUtils.ts";
import { expectOk } from "./support.ts";

const SCHEDULE_BASE =
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att";
const AUGUST_URL = `${SCHEDULE_BASE}/kessan08_1002.xlsx`;
const SEPTEMBER_URL = `${SCHEDULE_BASE}/kessan09_1030.xlsx`;

interface ExampleCell {
	readonly column: string;
	readonly row: number;
	readonly text: string;
}

/** The `<ref>: <JSON text>` lines of a decoded workbook example; `…` lines mark omissions. */
function exampleCells(text: string): ExampleCell[] {
	const cells: ExampleCell[] = [];
	for (const line of text.split("\n")) {
		if (line === "…") continue;
		const match = /^([A-Z]+)([0-9]+): (".*")$/.exec(line);
		if (match === null) throw new Error(`unexpected example line: ${line}`);
		const value: unknown = JSON.parse(match[3] ?? "");
		if (typeof value !== "string") throw new Error(`not a string cell: ${line}`);
		cells.push({ column: match[1] ?? "", row: Number(match[2]), text: value });
	}
	return cells;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A workbook as JPX writes it (observed in the 2026-10-31 captures): digits-only
 * cells are numbers (`<c r="B3276"><v>7203</v></c>`), every other text is a
 * shared string (`<c r="C3276" t="s"><v>1084</v></c>`).
 */
function workbookBytes(cells: readonly ExampleCell[]): Uint8Array {
	const strings: string[] = [];
	const indexOf = new Map<string, number>();
	const rows = new Map<number, string[]>();
	for (const cell of cells) {
		const ref = `${cell.column}${cell.row}`;
		let xml: string;
		if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(cell.text)) {
			xml = `<c r="${ref}"><v>${cell.text}</v></c>`;
		} else {
			let index = indexOf.get(cell.text);
			if (index === undefined) {
				index = strings.length;
				strings.push(cell.text);
				indexOf.set(cell.text, index);
			}
			xml = `<c r="${ref}" t="s"><v>${index}</v></c>`;
		}
		const row = rows.get(cell.row) ?? [];
		row.push(xml);
		rows.set(cell.row, row);
	}
	const sheetData = [...rows.entries()]
		.sort(([a], [b]) => a - b)
		.map(([row, xml]) => `<row r="${row}">${xml.join("")}</row>`)
		.join("");
	const sharedStrings = strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join("");
	return buildTestZip([
		{
			name: JPX_SHEET_PATH,
			text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><sheetData>${sheetData}</sheetData></worksheet>`,
			method: 8,
		},
		{
			name: JPX_STRINGS_PATH,
			text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst count="${strings.length}" uniqueCount="${strings.length}">${sharedStrings}</sst>`,
			method: 8,
		},
	]);
}

function scriptedNetwork(
	pages: { readonly [url: string]: string },
	workbooks: { readonly [url: string]: Uint8Array },
): { readonly fetcher: SafeFetcher; readonly binaryFetcher: SafeBinaryFetcher } {
	const notFound = err({ code: "HTTP_ERROR" as const, detail: "HTTP 404", status: 404 });
	return {
		fetcher: {
			fetchText: async (url) => {
				const text = Object.hasOwn(pages, url) ? pages[url] : undefined;
				if (text === undefined) return notFound;
				const document: FetchedDocument = { finalUrl: url, contentType: "text/html", text };
				return ok(document);
			},
		},
		binaryFetcher: {
			fetchBytes: async (url) => {
				const bytes = Object.hasOwn(workbooks, url) ? workbooks[url] : undefined;
				if (bytes === undefined) return notFound;
				const document: BinaryDocument = { finalUrl: url, contentType: null, bytes };
				return ok(document);
			},
		},
	};
}

const CLOCK: Clock = { nowMs: () => 0, nowIso: () => "2026-10-31T00:00:00.000Z" };

describe("JPX document examples", () => {
	it("finds the data_j.xlsx link on the Japanese listed-issues page", () => {
		const html = docExampleText("jpx", "jpx-listing-page-ja");
		expect(extractJpxListingUrl(html, "ja")).toBe(
			"https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx",
		);
	});

	it("finds the data_e.xlsx link, not the updated-issues file, on the English page", () => {
		const html = docExampleText("jpx", "jpx-listing-page-en");
		expect(extractJpxListingUrl(html, "en")).toBe(
			"https://www.jpx.co.jp/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx",
		);
	});

	it("finds the monthly schedule workbooks and skips the next-day list", () => {
		const html = docExampleText("jpx", "jpx-earnings-index");
		expect(extractJpxWorkbookUrls(html)).toEqual([AUGUST_URL, SEPTEMBER_URL]);
	});

	it("parses workbooks rebuilt from the listed-issues contents and joins them", () => {
		const japanese = expectOk(
			parseJpxListingWorkbook(
				workbookBytes(exampleCells(docExampleText("jpx", "jpx-listed-issues-ja"))),
				"ja",
			),
		);
		const english = expectOk(
			parseJpxListingWorkbook(
				workbookBytes(exampleCells(docExampleText("jpx", "jpx-listed-issues-en"))),
				"en",
			),
		);
		expect(japanese).toHaveLength(2);
		const joined = jpxDirectoryEntries(japanese, english);
		expect(joined.asOf).toBe("2026-09-30");
		expect(joined.entries).toEqual([
			{
				symbol: "130A",
				name: "Veritas In Silico Inc.",
				localName: "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
				listing: "tse-growth",
			},
			{
				symbol: "7203",
				name: "TOYOTA MOTOR CORPORATION",
				localName: "トヨタ自動車",
				listing: "tse-prime",
			},
		]);
	});

	it("dates JP stocks from the schedule page and a workbook rebuilt from its contents", async () => {
		const cells = exampleCells(docExampleText("jpx", "jpx-earnings-schedule"));
		// The August workbook is not documented: the same titles and header, no data rows.
		const headerOnly = cells.filter((cell) => cell.row <= 5);
		const { fetcher, binaryFetcher } = scriptedNetwork(
			{ [JPX_INDEX_URL]: docExampleText("jpx", "jpx-earnings-index") },
			{ [AUGUST_URL]: workbookBytes(headerOnly), [SEPTEMBER_URL]: workbookBytes(cells) },
		);
		const source = createJpxEarningsSource({ fetcher, binaryFetcher, clock: CLOCK });
		const [toyota, undecided] = await source.fetchEarnings({
			stocks: [
				{ symbol: "7203", needName: true },
				{ symbol: "254A", needName: false },
			],
			fromDate: "2026-10-31",
			toDate: "2027-05-04",
			signal: new AbortController().signal,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(toyota).toEqual(
			ok({
				name: "TOYOTA MOTOR CORPORATION",
				events: [
					{
						periodKey: "fy2027-03-31-second-quarter",
						announcementDate: "2026-11-05",
						fiscalPeriodLabel: "Q2 2027",
						fiscalPeriodEnd: "2027-03-31",
						timing: "unknown",
					},
				],
			}),
		);
		expect(undecided).toEqual(
			ok({
				name: null,
				events: [
					{
						periodKey: "fy2027-03-31-second-quarter",
						announcementDate: null,
						fiscalPeriodLabel: "Q2 2027",
						fiscalPeriodEnd: "2027-03-31",
						timing: "unknown",
					},
				],
			}),
		);
	});

	it("reads the short-selling and margin series from the documented pages, PDF tokens and workbooks", async () => {
		const ssHtml = docExampleText("jpx", "jpx-short-selling-page");
		const ssLinks = shortSellingLinks(ssHtml);
		expect(ssLinks).toEqual([
			{
				url: "https://www.jpx.co.jp/markets/statistics-equities/short-selling/t13vrt000002q127-att/261118-m.pdf",
				date: "2026-11-18",
			},
			{
				url: "https://www.jpx.co.jp/markets/statistics-equities/short-selling/t13vrt000002py6q-att/261117-m.pdf",
				date: "2026-11-17",
			},
		]);

		const weeklyHtml = docExampleText("jpx", "jpx-margin-weekly-page");
		const weeklyLinks = marginWeeklyLinks(weeklyHtml);
		expect(weeklyLinks).toEqual([
			{
				url: "https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rk9-att/20261113_mtcurrent.xlsx",
				date: "2026-11-13",
			},
			{
				url: "https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rk9-att/20261106_mtcurrent.xlsx",
				date: "2026-11-06",
			},
		]);

		const historyHtml = docExampleText("jpx", "jpx-margin-history-page");
		const historyUrl = marginHistoryLink(historyHtml);
		expect(historyUrl).toBe(
			"https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rq1-att/tvdivq0000015969.xlsx",
		);

		const pdfTokens = docExampleText("jpx", "jpx-short-selling-pdf")
			.split("\n")
			.map((line) => {
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed !== "string") throw new Error(`not a string token: ${line}`);
				return parsed;
			});
		const streamBody = pdfTokens
			.map((token) => {
				const escaped = token
					.replaceAll("\\", "\\\\")
					.replaceAll("(", "\\(")
					.replaceAll(")", "\\)");
				return `BT\r\n/F2 10.08 Tf\r\n[(${escaped})] TJ\r\nET\r\n`;
			})
			.join("");
		const deflated = deflateSync(Buffer.from(streamBody, "latin1"));
		const pdfBytes = Buffer.concat([
			Buffer.from(
				`%PDF-1.7\r\n1 0 obj\r\n<</Filter/FlateDecode/Length ${deflated.length}>>stream\r\n`,
				"latin1",
			),
			deflated,
			Buffer.from("\r\nendstream\r\nendobj\r\n%%EOF", "latin1"),
		]);
		const day = readShortSellingPdf(pdfBytes);
		expect(day).toEqual({
			actual: 4_925_148,
			restricted: 3_012_856,
			unrestricted: 809_020,
			total: 8_747_024,
		});
		if (day === null) throw new Error("unreachable");
		expect(shortSellingRatio(day)).toBe(43.7);

		const weeklyBytes = workbookBytes(exampleCells(docExampleText("jpx", "jpx-margin-weekly")));
		const historyBytes = workbookBytes(exampleCells(docExampleText("jpx", "jpx-margin-history")));
		const { fetcher, binaryFetcher } = scriptedNetwork(
			{
				[JPX_SHORT_SELLING_URL]: ssHtml,
				[JPX_MARGIN_WEEKLY_URL]: weeklyHtml,
				[JPX_MARGIN_HISTORY_URL]: historyHtml,
			},
			{
				[ssLinks[0]?.url ?? ""]: pdfBytes,
				[ssLinks[1]?.url ?? ""]: Buffer.from("%PDF-1.7 omitted"),
				[weeklyLinks[0]?.url ?? ""]: weeklyBytes,
				[weeklyLinks[1]?.url ?? ""]: weeklyBytes,
				[historyUrl ?? ""]: historyBytes,
			},
		);
		const source = createJpxMarketStatsSource({ fetcher, binaryFetcher, clock: CLOCK });
		const ask = (symbol: string) =>
			source.fetchSeries({
				symbol,
				from: null,
				maxObservations: 800,
				signal: new AbortController().signal,
				beforeRequest: () => Promise.resolve("granted"),
			});
		expect(await ask("SHORT_SELLING_RATIO")).toEqual(
			ok({
				meta: JPX_SERIES_META.SHORT_SELLING_RATIO,
				observations: [{ observedOn: "2026-11-18", value: 43.7 }],
			}),
		);
		expect(await ask("MARGIN_BUYING_VALUE")).toEqual(
			ok({
				meta: JPX_SERIES_META.MARGIN_BUYING_VALUE,
				observations: [
					{ observedOn: "2026-10-23", value: 6_534_069 },
					{ observedOn: "2026-10-30", value: 6_505_887 },
					{ observedOn: "2026-11-13", value: 5_768_159 },
				],
			}),
		);
		expect(await ask("MARGIN_RATIO")).toEqual(
			ok({
				meta: JPX_SERIES_META.MARGIN_RATIO,
				observations: [
					{ observedOn: "2026-10-23", value: 9.76 },
					{ observedOn: "2026-10-30", value: 10.47 },
					{ observedOn: "2026-11-13", value: 9.52 },
				],
			}),
		);
	});
});
