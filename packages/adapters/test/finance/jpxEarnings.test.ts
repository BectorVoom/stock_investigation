/**
 * JPX earnings source tests on a SYNTHETIC `.xlsx` built in-test (zlib
 * `deflateRaw` + a hand-written ZIP container) with the real layout observed
 * on 2026-10-13. JPX's file is never downloaded or committed — the opt-in
 * live check is `earningsLive.test.ts`.
 */
import type {
	BinaryDocument,
	Clock,
	FetchedDocument,
	SafeBinaryFetcher,
	SafeFetchError,
	SafeFetcher,
	SafeFetchOptions,
} from "@research/application";
import { err, ok, type Result } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	createJpxEarningsSource,
	extractJpxWorkbookUrls,
	JPX_INDEX_URL,
	JPX_PUBLISHER,
	JPX_SHEET_PATH,
	JPX_SOURCE_URL,
	JPX_STRINGS_PATH,
} from "../../src/finance/jpxEarnings.ts";
import { buildTestZip } from "../zipTestUtils.ts";

/* ---------- Synthetic workbook with the observed layout ---------- */

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
	"未定_Undecided",
];

function sharedCell(ref: string, index: number): string {
	return `<c r="${ref}" s="7" t="s"><v>${index}</v></c>`;
}

function numericCell(ref: string, value: string): string {
	return `<c r="${ref}" s="6"><v>${value}</v></c>`;
}

const SHEET_XML =
	`<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>` +
	`<row r="4"><c r="A4" s="1" t="s"><v>0</v></c></row>` +
	`<row r="5">${sharedCell("A5", 0)}${sharedCell("B5", 1)}${sharedCell("C5", 2)}${sharedCell("D5", 3)}${sharedCell("E5", 4)}${sharedCell("H5", 5)}${sharedCell("I5", 6)}${sharedCell("K5", 7)}</row>` +
	`<row r="6">${numericCell("A6", "46331")}${numericCell("B6", "7203")}${sharedCell("D6", 8)}${numericCell("E6", "46477")}${sharedCell("I6", 10)}</row>` +
	`<row r="7">${sharedCell("A7", 11)}${numericCell("B7", "9984")}${sharedCell("D7", 9)}${numericCell("E7", "46477")}${sharedCell("I7", 10)}</row>` +
	`<row r="8">${numericCell("A8", "46000")}${numericCell("B8", "7203")}${sharedCell("D8", 8)}${numericCell("E8", "46477")}${sharedCell("I8", 10)}</row>` +
	`<row r="9"><c r="A9" s="11"/></row>` +
	`</sheetData></worksheet>`;

const STRINGS_XML =
	`<?xml version="1.0" encoding="UTF-8"?><sst count="${STRINGS.length}" uniqueCount="${STRINGS.length}">` +
	STRINGS.map((text) => `<si><t>${text}</t></si>`).join("") +
	`</sst>`;

const WORKBOOK_BYTES = buildTestZip([
	{ name: JPX_SHEET_PATH, text: SHEET_XML, method: 8 },
	{ name: JPX_STRINGS_PATH, text: STRINGS_XML, method: 0 },
]);

const WORKBOOK_URL =
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1009.xlsx";

const INDEX_HTML = `<html><body><a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1009.xlsx">kessan09</a></body></html>`;

/* ---------- Scripted text + binary network ---------- */

interface ScriptedNetwork {
	readonly fetcher: SafeFetcher;
	readonly binaryFetcher: SafeBinaryFetcher;
	readonly textCalls: string[];
	readonly binaryCalls: string[];
}

function scriptedNetwork(
	textPages: { readonly [url: string]: string },
	binaryPages: { readonly [url: string]: Uint8Array },
): ScriptedNetwork {
	const textCalls: string[] = [];
	const binaryCalls: string[] = [];
	function pinned(url: string, options: SafeFetchOptions): Result<null, SafeFetchError> {
		if (options.allowedHosts !== undefined && !options.allowedHosts.has(new URL(url).hostname)) {
			return err({ code: "HOST_NOT_ALLOWED", detail: "host is not on the allowlist" });
		}
		return ok(null);
	}
	const fetcher: SafeFetcher = {
		fetchText: (url, options) => {
			textCalls.push(url);
			const allowed = pinned(url, options);
			if (!allowed.ok) return Promise.resolve(allowed);
			const page = Object.hasOwn(textPages, url) ? textPages[url] : undefined;
			if (page === undefined) {
				return Promise.resolve(err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 }));
			}
			const document: FetchedDocument = { finalUrl: url, contentType: "text/html", text: page };
			return Promise.resolve(ok(document));
		},
	};
	const binaryFetcher: SafeBinaryFetcher = {
		fetchBytes: (url, options) => {
			binaryCalls.push(url);
			const allowed = pinned(url, options);
			if (!allowed.ok) return Promise.resolve(allowed);
			const page = Object.hasOwn(binaryPages, url) ? binaryPages[url] : undefined;
			if (page === undefined) {
				return Promise.resolve(err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 }));
			}
			const document: BinaryDocument = {
				finalUrl: url,
				contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				bytes: page,
			};
			return Promise.resolve(ok(document));
		},
	};
	return { fetcher, binaryFetcher, textCalls, binaryCalls };
}

function fixedClock(nowMs: number): Clock & { advance: (ms: number) => void } {
	let current = nowMs;
	return {
		nowMs: () => current,
		nowIso: () => new Date(current).toISOString(),
		advance: (ms: number) => {
			current += ms;
		},
	};
}

const NEVER = new AbortController().signal;
const FROM = "2026-10-13";
const TO = "2027-04-16";

describe("extractJpxWorkbookUrls", () => {
	it("accepts only the observed workbook shape on the JPX host", () => {
		const html = [
			`<a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1009.xlsx">a</a>`,
			`<a href="https://www.jpx.co.jp/listing/event-schedules/financial-announcement/other-dir/kessan03_0401.xlsx">b</a>`,
			`<a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1009.xlsx">dup</a>`,
			`<a href="/listing/event-schedules/financial-announcement/x/kessan9_1009.xlsx">short</a>`,
			`<a href="https://evil.example.com/listing/event-schedules/financial-announcement/x/kessan09_1009.xlsx">evil</a>`,
			`<a href="/english/equities/schedule/index.html">english</a>`,
		].join("");
		expect(extractJpxWorkbookUrls(html)).toEqual([
			"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1009.xlsx",
			"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/other-dir/kessan03_0401.xlsx",
		]);
	});

	it("caps the workbook list at six", () => {
		const html = Array.from(
			{ length: 8 },
			(_, index) =>
				`<a href="/listing/event-schedules/financial-announcement/dir${index}/kessan09_100${index}.xlsx">x</a>`,
		).join("");
		expect(extractJpxWorkbookUrls(html)).toHaveLength(6);
	});
});

describe("JPX adapter: success on the synthetic workbook", () => {
	it("maps dated and undecided rows, drops out-of-window rows, keeps result order", async () => {
		const network = scriptedNetwork(
			{ [JPX_INDEX_URL]: INDEX_HTML },
			{ [WORKBOOK_URL]: WORKBOOK_BYTES },
		);
		const source = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		expect(source.sourceId).toBe("jpx");
		expect(JPX_PUBLISHER).toBe("Japan Exchange Group (JPX)");
		expect(JPX_SOURCE_URL).toBe(JPX_INDEX_URL);
		const results = await source.fetchEarnings({
			stocks: [
				{ symbol: "7203", needName: true },
				{ symbol: "9984", needName: true },
				{ symbol: "0001", needName: false },
			],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(results).toHaveLength(3);
		const [toyota, softbank, missing] = results;
		if (toyota === undefined || !toyota.ok) {
			throw new Error(`expected 7203 success, got ${JSON.stringify(toyota)}`);
		}
		// Row 8 (serial 46000 = 2025-12-12) is before fromDate and dropped.
		expect(toyota.value).toEqual({
			name: "Toyota Motor Corp.",
			events: [
				{
					periodKey: "fy2027-03-31-second-quarter",
					announcementDate: "2026-11-05",
					fiscalPeriodLabel: "Second quarter",
					fiscalPeriodEnd: "2027-03-31",
					timing: "unknown",
				},
			],
		});
		if (softbank === undefined || !softbank.ok) {
			throw new Error(`expected 9984 success, got ${JSON.stringify(softbank)}`);
		}
		expect(softbank.value).toEqual({
			name: "SoftBank Group Corp.",
			events: [
				{
					periodKey: "fy2027-03-31-second-quarter",
					announcementDate: null,
					fiscalPeriodLabel: "Second quarter",
					fiscalPeriodEnd: "2027-03-31",
					timing: "unknown",
				},
			],
		});
		expect(missing).toEqual({ ok: false, error: { code: "NO_SCHEDULED_DATE", name: null } });
	});

	it("returns a null name when the name is not needed", async () => {
		const network = scriptedNetwork(
			{ [JPX_INDEX_URL]: INDEX_HTML },
			{ [WORKBOOK_URL]: WORKBOOK_BYTES },
		);
		const source = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "7203", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) throw new Error("expected success");
		expect(result.value.name).toBeNull();
		expect(result.value.events).toHaveLength(1);
	});

	it("sends null for an over-long company name instead of failing the refresh", async () => {
		const longName = "B".repeat(201);
		const strings = [...STRINGS.slice(0, 8), longName, ...STRINGS.slice(9)];
		const sheet =
			`<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>` +
			`<row r="4"><c r="A4" s="1" t="s"><v>0</v></c></row>` +
			`<row r="5">${sharedCell("A5", 0)}${sharedCell("B5", 1)}${sharedCell("C5", 2)}${sharedCell("D5", 3)}${sharedCell("E5", 4)}${sharedCell("H5", 5)}${sharedCell("I5", 6)}${sharedCell("K5", 7)}</row>` +
			`<row r="6">${numericCell("A6", "46331")}${numericCell("B6", "7203")}${sharedCell("D6", 8)}${numericCell("E6", "46477")}${sharedCell("I6", 10)}</row>` +
			`</sheetData></worksheet>`;
		const stringsXml =
			`<?xml version="1.0" encoding="UTF-8"?><sst count="${strings.length}" uniqueCount="${strings.length}">` +
			strings.map((text) => `<si><t>${text}</t></si>`).join("") +
			`</sst>`;
		const network = scriptedNetwork(
			{ [JPX_INDEX_URL]: INDEX_HTML },
			{
				[WORKBOOK_URL]: buildTestZip([
					{ name: JPX_SHEET_PATH, text: sheet, method: 8 },
					{ name: JPX_STRINGS_PATH, text: stringsXml, method: 0 },
				]),
			},
		);
		const source = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		const [result] = await source.fetchEarnings({
			stocks: [{ symbol: "7203", needName: true }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		if (result === undefined || !result.ok) {
			throw new Error(`expected success, got ${JSON.stringify(result)}`);
		}
		expect(result.value.name).toBeNull();
		expect(result.value.events).toHaveLength(1);
	});

	it("takes one grant per sent request and stops when the hook refuses", async () => {
		const network = scriptedNetwork(
			{ [JPX_INDEX_URL]: INDEX_HTML },
			{ [WORKBOOK_URL]: WORKBOOK_BYTES },
		);
		const source = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		let grants = 0;
		const results = await source.fetchEarnings({
			stocks: [{ symbol: "7203", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => {
				grants += 1;
				return Promise.resolve(true);
			},
		});
		// One index page plus one workbook: two sent requests, two grants.
		expect(grants).toBe(2);
		expect(results).toHaveLength(1);

		// A refused hook sends nothing and fails the batch.
		const refused = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		const textBefore = network.textCalls.length;
		const refusedResults = await refused.fetchEarnings({
			stocks: [{ symbol: "7203", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(false),
		});
		expect(refusedResults).toEqual([
			{ ok: false, error: { code: "SOURCE_FAILED", upstreamStatus: null } },
		]);
		expect(network.textCalls).toHaveLength(textBefore);
	});

	it("fetches nothing for an empty request and caches the index and workbooks", async () => {
		const network = scriptedNetwork(
			{ [JPX_INDEX_URL]: INDEX_HTML },
			{ [WORKBOOK_URL]: WORKBOOK_BYTES },
		);
		const clock = fixedClock(Date.parse("2026-10-13T00:00:00.000Z"));
		const source = createJpxEarningsSource({ ...network, clock });
		expect(
			await source.fetchEarnings({
				stocks: [],
				fromDate: FROM,
				toDate: TO,
				signal: NEVER,
				beforeRequest: () => Promise.resolve(true),
			}),
		).toEqual([]);
		expect(network.textCalls).toHaveLength(0);
		expect(network.binaryCalls).toHaveLength(0);

		const query = {
			stocks: [{ symbol: "7203", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		};
		await source.fetchEarnings(query);
		await source.fetchEarnings(query);
		expect(network.textCalls).toEqual([JPX_INDEX_URL]);
		expect(network.binaryCalls).toEqual([WORKBOOK_URL]);

		clock.advance(31 * 60 * 1_000);
		await source.fetchEarnings(query);
		expect(network.textCalls).toEqual([JPX_INDEX_URL, JPX_INDEX_URL]);
		// The workbook is cached by URL (its name carries the update date).
		expect(network.binaryCalls).toEqual([WORKBOOK_URL]);
	});
});

describe("JPX adapter: failures", () => {
	it("reports SOURCE_FAILED for every stock when the index fails", async () => {
		const network = scriptedNetwork({}, {});
		const source = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		const results = await source.fetchEarnings({
			stocks: [{ symbol: "7203", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(results).toEqual([{ ok: false, error: { code: "SOURCE_FAILED", upstreamStatus: 404 } }]);
	});

	it("evicts parsed workbooks the current index no longer lists", async () => {
		const otherUrl =
			"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan12_1225.xlsx";
		const otherIndex = `<html><body><a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan12_1225.xlsx">kessan12</a></body></html>`;
		let index = INDEX_HTML;
		const network = scriptedNetwork(
			{ [JPX_INDEX_URL]: INDEX_HTML },
			{ [WORKBOOK_URL]: WORKBOOK_BYTES },
		);
		const textCalls: string[] = [];
		const binaryCalls: string[] = [];
		const clock = fixedClock(Date.parse("2026-10-13T00:00:00.000Z"));
		const source = createJpxEarningsSource({
			fetcher: {
				fetchText: (url, options) => {
					textCalls.push(url);
					const allowed =
						options.allowedHosts !== undefined && !options.allowedHosts.has(new URL(url).hostname)
							? err({ code: "HOST_NOT_ALLOWED" as const, detail: "host is not on the allowlist" })
							: null;
					if (allowed !== null) return Promise.resolve(allowed);
					return Promise.resolve(ok({ finalUrl: url, contentType: "text/html", text: index }));
				},
			},
			binaryFetcher: {
				fetchBytes: (url, options) => {
					binaryCalls.push(url);
					const allowed =
						options.allowedHosts !== undefined && !options.allowedHosts.has(new URL(url).hostname)
							? err({ code: "HOST_NOT_ALLOWED" as const, detail: "host is not on the allowlist" })
							: null;
					if (allowed !== null) return Promise.resolve(allowed);
					if (url === otherUrl) {
						return Promise.resolve(
							ok({
								finalUrl: url,
								contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
								bytes: WORKBOOK_BYTES,
							}),
						);
					}
					return network.binaryFetcher.fetchBytes(url, options);
				},
			},
			clock,
		});
		const query = {
			stocks: [{ symbol: "7203", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		};
		await source.fetchEarnings(query);
		expect(binaryCalls).toEqual([WORKBOOK_URL]);
		// The next index lists only the other workbook: it is downloaded and
		// the first workbook's parsed rows are evicted.
		index = otherIndex;
		clock.advance(31 * 60 * 1_000);
		await source.fetchEarnings(query);
		expect(binaryCalls).toEqual([WORKBOOK_URL, otherUrl]);
		// The first workbook is listed again: without eviction it would still
		// be cached, but a new URL means a new file, so it is re-downloaded.
		index = INDEX_HTML;
		clock.advance(31 * 60 * 1_000);
		await source.fetchEarnings(query);
		expect(binaryCalls).toEqual([WORKBOOK_URL, otherUrl, WORKBOOK_URL]);
	});

	it("reports SOURCE_FAILED when a workbook download fails", async () => {
		const network = scriptedNetwork({ [JPX_INDEX_URL]: INDEX_HTML }, {});
		const source = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		const results = await source.fetchEarnings({
			stocks: [{ symbol: "7203", needName: false }],
			fromDate: FROM,
			toDate: TO,
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(results).toEqual([{ ok: false, error: { code: "SOURCE_FAILED", upstreamStatus: 404 } }]);
	});

	it("keeps the company name on NO_SCHEDULED_DATE results", async () => {
		const network = scriptedNetwork(
			{ [JPX_INDEX_URL]: INDEX_HTML },
			{ [WORKBOOK_URL]: WORKBOOK_BYTES },
		);
		const source = createJpxEarningsSource({
			...network,
			clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
		});
		const results = await source.fetchEarnings({
			stocks: [
				{ symbol: "7203", needName: true },
				{ symbol: "0001", needName: true },
			],
			fromDate: "2027-01-01",
			toDate: "2027-01-31",
			signal: NEVER,
			beforeRequest: () => Promise.resolve(true),
		});
		// Row 6 (2026-11-05) is outside the window: both are listed-nothing
		// successes — the listed stock still yields its name.
		expect(results).toEqual([
			{ ok: false, error: { code: "NO_SCHEDULED_DATE", name: "Toyota Motor Corp." } },
			{ ok: false, error: { code: "NO_SCHEDULED_DATE", name: null } },
		]);
	});

	it("reports SOURCE_FAILED when a workbook is not a ZIP or misses its headers", async () => {
		for (const bytes of [
			new TextEncoder().encode("not a zip at all"),
			buildTestZip([{ name: JPX_SHEET_PATH, text: "<worksheet></worksheet>", method: 0 }]),
		]) {
			const network = scriptedNetwork({ [JPX_INDEX_URL]: INDEX_HTML }, { [WORKBOOK_URL]: bytes });
			const source = createJpxEarningsSource({
				...network,
				clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")),
			});
			const results = await source.fetchEarnings({
				stocks: [{ symbol: "7203", needName: false }],
				fromDate: FROM,
				toDate: TO,
				signal: NEVER,
				beforeRequest: () => Promise.resolve(true),
			});
			expect(results).toEqual([
				{ ok: false, error: { code: "SOURCE_FAILED", upstreamStatus: null } },
			]);
		}
	});
});
