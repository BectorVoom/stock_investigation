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
		if (/^[0-9]+$/.test(cell.text)) {
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
						fiscalPeriodLabel: "Second quarter",
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
						fiscalPeriodLabel: "Second quarter",
						fiscalPeriodEnd: "2027-03-31",
						timing: "unknown",
					},
				],
			}),
		);
	});
});
