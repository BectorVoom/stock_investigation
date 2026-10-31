/**
 * EDINET documents, XBRL-to-CSV reports and the EDINET sync source
 * (ADR-0045 §4, §6), over the synthetic filer in examples/fixtures/equity-sync/.
 */
import type { EquityPendingFiling } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	decodeUtf16Le,
	EDINET_CSV_HEADER,
	edinetContext,
	extractEdinetReport,
	forEachTsvRow,
	parseEdinetCsv,
	selectEdinetReportEntry,
} from "../../src/finance/edinetCsv.ts";
import {
	type EdinetAnnualRow,
	edinetDocumentListUrl,
	edinetDocumentUrl,
	edinetDownloadPlan,
	edinetErrorStatus,
	edinetFilingMetadata,
	edinetIdentity,
	parseEdinetDocumentList,
} from "../../src/finance/edinetDocuments.ts";
import {
	createEdinetSource,
	EDINET_DAY_CACHE_TTL_MS,
	EDINET_LIST_MAX_BYTES,
	EDINET_ZIP_MAX_BYTES,
} from "../../src/finance/edinetSync.ts";
import { buildTestZip } from "../zipTestUtils.ts";
import {
	EDINET_CONCEPTS,
	edinetTarget,
	equityFixtureBytes,
	equityFixtureJson,
	equityFixtureText,
	type FakeAnswer,
	fakeFetcher,
	httpError,
	movableClock,
	queryFor,
} from "./equitySyncSupport.ts";
import { expectErr, expectOk } from "./support.ts";

const KEY = "test-edinet-key-0001";
const DATES = [
	"2020-06-26",
	"2021-06-25",
	"2022-06-24",
	"2023-06-23",
	"2024-06-21",
	"2024-09-10",
	"2025-06-20",
	"2025-07-01",
];
const DOCS = ["S100SY20", "S100SY21", "S100SY22", "S100SY23", "S100SY24", "S100SYA4", "S100SY25"];

function rowsOf(date: string): readonly EdinetAnnualRow[] {
	return expectOk(
		parseEdinetDocumentList(equityFixtureJson(`edinet-documents-${date}.synthetic.json`)),
	);
}

function utf16(text: string, bom = true): Uint8Array {
	const body = new Uint8Array(Buffer.from(text, "utf16le"));
	if (!bom) return body;
	const bytes = new Uint8Array(body.length + 2);
	bytes.set([0xff, 0xfe]);
	bytes.set(body, 2);
	return bytes;
}

const quoted = (fields: readonly string[]) => fields.map((field) => `"${field}"`).join("\t");
const HEADER = quoted(EDINET_CSV_HEADER);

describe("parseEdinetDocumentList", () => {
	it("keeps annual rows that are not withdrawn", () => {
		const rows = rowsOf("2025-06-20");
		expect(rows.map((row) => [row.docId, row.docTypeCode, row.secCode])).toEqual([
			["S10620OT", "120", "88880"],
			["S100SY25", "120", "99990"],
		]);
		// The withdrawn S100SYW5, the fund's 030 and the internal control report 235 are gone.
	});

	it("reads parent, CSV flag and nullable fields", () => {
		const [, amendment] = rowsOf("2024-09-10");
		expect(amendment).toMatchObject({
			docId: "S100SYA4",
			docTypeCode: "130",
			parentDocId: "S100SY24",
			csvAvailable: true,
		});
		const [, noCsv] = rowsOf("2025-07-01");
		expect(noCsv).toMatchObject({ docId: "S100SYB5", csvAvailable: false });
	});

	it("carries a non-200 metadata status and refuses another shape", () => {
		expect(
			expectErr(parseEdinetDocumentList({ metadata: { status: "401", message: "x" } })),
		).toEqual({ kind: "status", status: 401 });
		expect(expectErr(parseEdinetDocumentList({ metadata: { status: "oops" } }))).toEqual({
			kind: "status",
			status: null,
		});
		expect(expectErr(parseEdinetDocumentList({ results: [] }))).toEqual({ kind: "parse" });
		expect(expectErr(parseEdinetDocumentList({ metadata: { status: "200" } }))).toEqual({
			kind: "parse",
		});
	});

	it("drops malformed rows instead of failing the date", () => {
		const rows = expectOk(
			parseEdinetDocumentList({
				metadata: { status: "200" },
				results: [
					"not a row",
					{
						docID: "bad",
						edinetCode: "E99991",
						docTypeCode: "120",
						withdrawalStatus: "0",
						submitDateTime: "2025-06-20 15:00",
					},
					{
						docID: "S100AAAA",
						edinetCode: "E99991",
						docTypeCode: "120",
						withdrawalStatus: "0",
						submitDateTime: "2025-06-31 15:00",
					},
					{
						docID: "S100AAAB",
						edinetCode: "E99991",
						docTypeCode: "120",
						withdrawalStatus: "0",
						submitDateTime: "2025-06-20 15:00",
						secCode: "99990",
						periodEnd: "2025-02-30",
					},
				],
			}),
		);
		expect(rows.map((row) => [row.docId, row.periodEnd])).toEqual([["S100AAAB", null]]);
	});
});

describe("edinetErrorStatus", () => {
	it("reads the v2 metadata status or the gateway's StatusCode", () => {
		expect(edinetErrorStatus({ metadata: { status: "404", message: "Not Found" } })).toBe(404);
		expect(edinetErrorStatus({ StatusCode: 401, message: "Access denied" })).toBe(401);
		expect(edinetErrorStatus({ statusCode: 429 })).toBe(429);
		expect(edinetErrorStatus({ message: "x" })).toBeNull();
		expect(edinetErrorStatus("x")).toBeNull();
	});
});

describe("edinetFilingMetadata and edinetIdentity", () => {
	it("builds metadata in Japan time with the viewer link", () => {
		const [, amendment] = rowsOf("2024-09-10");
		if (amendment === undefined) throw new Error("fixture");
		expect(edinetFilingMetadata(amendment)).toEqual({
			sourceDocumentId: "S100SYA4",
			form: "amended-securities-report",
			filedOn: "2024-09-10",
			submittedAt: "2024-09-10T10:30:00+09:00",
			periodStart: "2023-04-01",
			periodEnd: "2024-03-31",
			amendsSourceDocumentId: "S100SY24",
			sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100SYA4",
		});
		expect(edinetFilingMetadata({ ...amendment, periodEnd: null })).toBeNull();
	});

	it("names the company from the first match, the year end from an original report", () => {
		const amendmentOnly = rowsOf("2024-09-10").filter((row) => row.secCode === "99990");
		expect(edinetIdentity(amendmentOnly, null)).toEqual({
			sourceCompanyId: "E99991",
			name: "シンセティック工業株式会社",
			fiscalYearEnd: null,
		});
		const both = [
			...amendmentOnly,
			...rowsOf("2025-06-20").filter((row) => row.secCode === "99990"),
		];
		expect(edinetIdentity(both, null)?.fiscalYearEnd).toBe("03-31");
		expect(edinetIdentity([], "E99991")).toEqual({
			sourceCompanyId: "E99991",
			name: null,
			fiscalYearEnd: null,
		});
		expect(edinetIdentity([], null)).toBeNull();
	});
});

describe("edinetDownloadPlan", () => {
	const listed = DATES.flatMap((date) =>
		rowsOf(date)
			.filter((row) => row.secCode === "99990")
			.map((row) => ({ row, listedOn: date })),
	);
	const pending: EquityPendingFiling = {
		sourceDocumentId: "S100PEND",
		form: "securities-report",
		filedOn: "2019-06-21",
		submittedAt: null,
		periodStart: "2018-04-01",
		periodEnd: "2019-03-31",
		amendsSourceDocumentId: null,
		sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100PEND",
	};

	it("puts pending first, then new documents oldest first; no-CSV ones need no download", () => {
		const plan = edinetDownloadPlan({
			pending: [pending],
			found: listed,
			knownDocIds: ["S100SY20"],
			maxDownloads: 8,
		});
		expect(
			plan.map((entry) => [entry.metadata.sourceDocumentId, entry.action, entry.listedOn]),
		).toEqual([
			["S100PEND", "download", null],
			["S100SY21", "download", "2021-06-25"],
			["S100SY22", "download", "2022-06-24"],
			["S100SY23", "download", "2023-06-23"],
			["S100SY24", "download", "2024-06-21"],
			["S100SYA4", "download", "2024-09-10"],
			["S100SY25", "download", "2025-06-20"],
			["S100SYB5", "not-available", "2025-07-01"],
		]);
	});

	it("defers what exceeds the download cap", () => {
		const plan = edinetDownloadPlan({
			pending: [],
			found: listed,
			knownDocIds: [],
			maxDownloads: 3,
		});
		expect(plan.map((entry) => entry.action)).toEqual([
			"download",
			"download",
			"download",
			"deferred",
			"deferred",
			"deferred",
			"deferred",
			"not-available",
		]);
	});
});

describe("decodeUtf16Le", () => {
	it("drops the byte-order mark and refuses odd lengths and lone surrogates", () => {
		expect(expectOk(decodeUtf16Le(utf16("要素ID")))).toBe("要素ID");
		expect(expectOk(decodeUtf16Le(utf16("abc", false)))).toBe("abc");
		expect(expectErr(decodeUtf16Le(new Uint8Array([0xff, 0xfe, 0x41])))).toBe("ENCODING");
		expect(expectErr(decodeUtf16Le(new Uint8Array([0x00, 0xd8, 0x41, 0x00])))).toBe("ENCODING");
	});
});

describe("forEachTsvRow", () => {
	const rows = (text: string) => {
		const out: string[][] = [];
		forEachTsvRow(text, (fields) => {
			out.push([...fields]);
			return true;
		});
		return out;
	};

	it("splits quoted fields on tabs and CRLF / LF / CR, keeping quoted breaks and quotes", () => {
		expect(rows('"a"\t"b"\r\n"c\td"\t"e\nf ""g"""\n"h"\r"i"')).toEqual([
			["a", "b"],
			["c\td", 'e\nf "g"'],
			["h"],
			["i"],
		]);
	});

	it("skips blank lines, keeps empty quoted fields and text after a closing quote", () => {
		expect(rows('\r\n"a"\t""\n\n"b"x\tplain\n')).toEqual([
			["a", ""],
			["bx", "plain"],
		]);
	});

	it("stops when the visitor says so", () => {
		let seen = 0;
		forEachTsvRow('"a"\n"b"\n"c"\n', () => {
			seen += 1;
			return false;
		});
		expect(seen).toBe(1);
	});
});

describe("edinetContext", () => {
	it("takes the four year contexts, separate with the member suffix, nothing else", () => {
		expect(edinetContext("CurrentYearDuration")).toEqual({
			context: "CurrentYearDuration",
			scope: "consolidated",
		});
		expect(edinetContext("Prior1YearInstant_NonConsolidatedMember")).toEqual({
			context: "Prior1YearInstant",
			scope: "separate",
		});
		for (const other of [
			"CurrentYearDuration_jpcrp030000-asr_E99991-000MachineryReportableSegmentMember",
			"InterimDuration",
			"Prior2YearDuration",
			"FilingDateInstant",
			"_NonConsolidatedMember",
		]) {
			expect(edinetContext(other)).toBeNull();
		}
	});
});

describe("parseEdinetCsv", () => {
	const dei = (element: string, value: string) =>
		quoted([element, "x", "FilingDateInstant", "提出日時点", "その他", "時点", "－", "－", value]);
	const fact = (concept: string, context: string, value: string, unit = "JPY") =>
		quoted([concept, "x", context, "当期", "連結", "期間", unit, "円", value]);

	it("dates facts from the DEI, separates scopes and skips nil, odd units and other contexts", () => {
		const text = [
			HEADER,
			fact("jppfs_cor:NetSales", "CurrentYearDuration", "100"),
			dei("jpdei_cor:AccountingStandardsDEI", "Japan GAAP"),
			dei("jpdei_cor:CurrentFiscalYearStartDateDEI", "2024-04-01"),
			dei("jpdei_cor:CurrentFiscalYearEndDateDEI", "2025-03-31"),
			fact("jppfs_cor:NetSales", "CurrentYearDuration_NonConsolidatedMember", "60"),
			fact("jppfs_cor:Assets", "CurrentYearInstant", "500"),
			fact("jppfs_cor:NetSales", "Prior1YearDuration", "90"),
			fact("jppfs_cor:GrossProfit", "CurrentYearDuration", "－"),
			fact("jppfs_cor:GrossProfit", "CurrentYearDuration", "007"),
			fact("jppfs_cor:OperatingIncome", "CurrentYearDuration", "5", ""),
			fact("jppfs_cor:NetSales", "InterimDuration", "50"),
			fact("jpcrp_cor:NumberOfEmployees", "CurrentYearInstant", "12", "pure"),
		].join("\r\n");
		const report = expectOk(parseEdinetCsv(text, EDINET_CONCEPTS));
		expect(report.accountingStandard).toBe("JGAAP");
		expect(report.fiscalYears).toEqual({
			currentStart: "2024-04-01",
			currentEnd: "2025-03-31",
			previousStart: null,
			previousEnd: null,
		});
		expect(report.facts).toEqual([
			{
				concept: "jppfs_cor:NetSales",
				unit: "JPY",
				valueDecimal: "100",
				scope: "consolidated",
				periodType: "duration",
				periodStart: "2024-04-01",
				periodEnd: "2025-03-31",
			},
			{
				concept: "jppfs_cor:NetSales",
				unit: "JPY",
				valueDecimal: "60",
				scope: "separate",
				periodType: "duration",
				periodStart: "2024-04-01",
				periodEnd: "2025-03-31",
			},
			{
				concept: "jppfs_cor:Assets",
				unit: "JPY",
				valueDecimal: "500",
				scope: "consolidated",
				periodType: "instant",
				periodStart: null,
				periodEnd: "2025-03-31",
			},
		]);
	});

	it("maps the accounting standards and fails without the header", () => {
		for (const [text, standard] of [
			["IFRS", "IFRS"],
			["US GAAP", "US-GAAP"],
			["Japan GAAP", "JGAAP"],
			["Other", null],
		] as const) {
			const csv = `${HEADER}\n${dei("jpdei_cor:AccountingStandardsDEI", text)}\n`;
			expect(expectOk(parseEdinetCsv(csv, EDINET_CONCEPTS)).accountingStandard).toBe(standard);
		}
		expect(
			expectErr(
				parseEdinetCsv(fact("jppfs_cor:NetSales", "CurrentYearDuration", "1"), EDINET_CONCEPTS),
			),
		).toBe("MISSING_HEADER");
		expect(expectErr(parseEdinetCsv("", EDINET_CONCEPTS))).toBe("MISSING_HEADER");
	});
});

describe("selectEdinetReportEntry", () => {
	it("picks the jpcrp CSV under XBRL_TO_CSV/, the first in order when several", () => {
		expect(
			selectEdinetReportEntry([
				"XBRL_TO_CSV/jpaud-aar-cn-001_E1.csv",
				"XBRL_TO_CSV/jpcrp030000-asr-001_E1_02.csv",
				"XBRL_TO_CSV/jpcrp030000-asr-001_E1_01.csv",
				"XBRL_TO_CSV/sub/jpcrp-x.csv",
				"jpcrp-root.csv",
				"XBRL_TO_CSV/jpcrp-notes.txt",
			]),
		).toBe("XBRL_TO_CSV/jpcrp030000-asr-001_E1_01.csv");
		expect(selectEdinetReportEntry(["XBRL_TO_CSV/jpaud.csv"])).toBeNull();
	});
});

describe("extractEdinetReport", () => {
	it("reads the fixture report: annual facts in canonical order, the nil skipped", () => {
		const report = expectOk(
			extractEdinetReport(equityFixtureBytes("edinet-S100SY25.synthetic.zip"), EDINET_CONCEPTS),
		);
		expect(report.accountingStandard).toBe("JGAAP");
		expect(report.facts).toHaveLength(30);
		const sales = report.facts.filter((f) => f.concept === "jppfs_cor:NetSales");
		expect(sales.map((f) => [f.scope, f.periodEnd, f.valueDecimal])).toEqual([
			["consolidated", "2024-03-31", "703000000000"],
			["separate", "2025-03-31", "407000000000"],
			["consolidated", "2025-03-31", "740000000000"],
		]);
		expect(
			report.facts.some((f) => f.concept === "jppfs_cor:GrossProfit" && f.scope === "separate"),
		).toBe(false);
		const capex = report.facts.find(
			(f) =>
				f.concept === "jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF" &&
				f.periodEnd === "2025-03-31",
		);
		expect(capex?.valueDecimal).toBe("-37000000000");
	});

	it("reads an LF-terminated amendment", () => {
		const report = expectOk(
			extractEdinetReport(equityFixtureBytes("edinet-S100SYA4.synthetic.zip"), EDINET_CONCEPTS),
		);
		const sales = report.facts.find(
			(f) =>
				f.concept === "jppfs_cor:NetSales" &&
				f.periodEnd === "2024-03-31" &&
				f.scope === "consolidated",
		);
		expect(sales?.valueDecimal).toBe("703000000000");
	});

	it("fails what is not a readable report", () => {
		expect(
			expectErr(extractEdinetReport(new TextEncoder().encode('{"metadata":{}}'), EDINET_CONCEPTS)),
		).toBe("NOT_A_ZIP");
		const auditOnly = buildTestZip([
			{ name: "XBRL_TO_CSV/jpaud-x.csv", bytes: utf16(HEADER), method: 0 },
		]);
		expect(expectErr(extractEdinetReport(auditOnly, EDINET_CONCEPTS))).toBe("NO_REPORT_ENTRY");
		const noHeader = buildTestZip([
			{ name: "XBRL_TO_CSV/jpcrp-x.csv", bytes: utf16('"a"\t"b"'), method: 8 },
		]);
		expect(expectErr(extractEdinetReport(noHeader, EDINET_CONCEPTS))).toBe("MISSING_HEADER");
		const odd = buildTestZip([
			{ name: "XBRL_TO_CSV/jpcrp-x.csv", bytes: new Uint8Array([0xff, 0xfe, 0x22]), method: 0 },
		]);
		expect(expectErr(extractEdinetReport(odd, EDINET_CONCEPTS))).toBe("ENCODING");
	});
});

describe("createEdinetSource", () => {
	const listUrl = (date: string) => edinetDocumentListUrl(date, KEY);
	const docUrl = (docId: string) => edinetDocumentUrl(docId, KEY);
	const answers = (overrides: [string, FakeAnswer][] = []) =>
		new Map<string, FakeAnswer>([
			...DATES.map((date): [string, FakeAnswer] => [
				listUrl(date),
				{ text: equityFixtureText(`edinet-documents-${date}.synthetic.json`) },
			]),
			...DOCS.map((docId): [string, FakeAnswer] => [
				docUrl(docId),
				{ bytes: equityFixtureBytes(`edinet-${docId}.synthetic.zip`) },
			]),
			...overrides,
		]);
	const build = (map: Map<string, FakeAnswer>, apiKey: string | null = KEY) => {
		const fake = fakeFetcher(map);
		const time = movableClock();
		const source = createEdinetSource({
			fetcher: fake.fetcher,
			binaryFetcher: fake.fetcher,
			apiKey,
			clock: time.clock,
		});
		return { ...fake, time, source };
	};

	it("fails unconfigured without a request", async () => {
		const { source, requests } = build(answers(), null);
		const { query, grants } = queryFor(edinetTarget({ scanDays: DATES }));
		expect(expectErr(await source.sync(query))).toEqual({
			code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			upstreamStatus: null,
			requests: 0,
		});
		expect(requests).toEqual([]);
		expect(grants()).toBe(0);
	});

	it("lists the dates, downloads new reports and reports the rest", async () => {
		const { source, requests } = build(answers());
		const { query, grants } = queryFor(edinetTarget({ scanDays: DATES }));
		const data = expectOk(await source.sync(query));
		expect(data.identity).toEqual({
			sourceCompanyId: "E99991",
			name: "シンセティック工業株式会社",
			fiscalYearEnd: "03-31",
		});
		expect(data.scannedDays).toEqual(DATES);
		expect(data.more).toBe(false);
		expect(data.filings.map((f) => [f.sourceDocumentId, f.factsStatus, f.facts.length])).toEqual([
			["S100SYB5", "not-available", 0],
			["S100SY25", "extracted", 30],
			["S100SYA4", "extracted", 30],
			["S100SY24", "extracted", 30],
			["S100SY23", "extracted", 30],
			["S100SY22", "extracted", 30],
			["S100SY21", "extracted", 30],
			["S100SY20", "extracted", 30],
		]);
		expect(data.requests).toBe(15);
		expect(grants()).toBe(15);
		expect(requests.slice(0, 1)).toEqual([
			{
				url: listUrl("2020-06-26"),
				kind: "text",
				maxBytes: EDINET_LIST_MAX_BYTES,
				accept: "application/json",
				allowedHosts: ["api.edinet-fsa.go.jp"],
				userAgent: null,
			},
		]);
		expect(requests[8]).toMatchObject({
			url: docUrl("S100SY20"),
			kind: "bytes",
			maxBytes: EDINET_ZIP_MAX_BYTES,
		});
	});

	it("shares a date's list across jobs for a day (cache), then lists it again", async () => {
		const { source, requests, time } = build(answers());
		const days = ["2025-06-20", "2025-07-01"];
		expectOk(await source.sync(queryFor(edinetTarget({ scanDays: days })).query));
		expect(requests.filter((r) => r.kind === "text")).toHaveLength(2);
		const other = edinetTarget({ scanDays: days, secCode: "88880" });
		const second = expectOk(await source.sync(queryFor(other).query));
		// Only the other company's two report downloads (404: not available): no list request.
		expect(second.requests).toBe(2);
		expect(requests.filter((r) => r.kind === "text")).toHaveLength(2);
		time.advance(EDINET_DAY_CACHE_TTL_MS);
		expectOk(
			await source.sync(
				queryFor(edinetTarget({ scanDays: days, knownDocIds: ["S100SY25"] })).query,
			),
		);
		expect(requests.filter((r) => r.kind === "text")).toHaveLength(4);
	});

	it("defers beyond eight downloads and offers pending filings first with their stored metadata", async () => {
		const { source } = build(answers());
		const pending: EquityPendingFiling = {
			sourceDocumentId: "S100SY25",
			form: "securities-report",
			filedOn: "2025-06-20",
			submittedAt: null,
			periodStart: null,
			periodEnd: "2025-03-31",
			amendsSourceDocumentId: null,
			sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100SY25",
		};
		const data = expectOk(
			await source.sync(
				queryFor(
					edinetTarget({
						scanDays: ["2025-06-20"],
						knownDocIds: ["S100SY25"],
						pendingFilings: [pending],
					}),
				).query,
			),
		);
		expect(data.filings).toHaveLength(1);
		expect(data.filings[0]).toMatchObject({ ...pending, factsStatus: "extracted" });
	});

	it("reports a document EDINET has no CSV for (404, or 404 in a JSON body) as not available", async () => {
		for (const answer of [
			httpError(404),
			{
				text: '{"metadata":{"status":"404","message":"Not Found"}}',
				contentType: "application/json",
			},
		]) {
			const { source } = build(answers([[docUrl("S100SY25"), answer]]));
			const data = expectOk(
				await source.sync(queryFor(edinetTarget({ scanDays: ["2025-06-20"] })).query),
			);
			expect(data.filings.map((f) => [f.sourceDocumentId, f.factsStatus])).toEqual([
				["S100SY25", "not-available"],
			]);
		}
	});

	it.each([
		[401, "FINANCIAL_ACCESS_DENIED"],
		[403, "FINANCIAL_ACCESS_DENIED"],
		[404, "FINANCIAL_SOURCE_FAILED"],
		[429, "FINANCIAL_RATE_LIMITED"],
		[500, "FINANCIAL_SOURCE_FAILED"],
	])("fails the job when a list answers HTTP %i (%s), keeping the status", async (status, code) => {
		const { source, requests } = build(answers([[listUrl("2021-06-25"), httpError(status)]]));
		const failure = expectErr(await source.sync(queryFor(edinetTarget({ scanDays: DATES })).query));
		expect(failure).toEqual({ code, upstreamStatus: status, requests: 2 });
		expect(requests).toHaveLength(2);
	});

	it("fails on a metadata error status, a gateway 401 JSON body and malformed answers", async () => {
		const status = build(
			answers([
				[listUrl("2025-06-20"), { text: '{"metadata":{"status":"400","message":"Bad Request"}}' }],
			]),
		);
		expect(
			expectErr(
				await status.source.sync(queryFor(edinetTarget({ scanDays: ["2025-06-20"] })).query),
			),
		).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: 400,
			requests: 1,
		});
		const gateway = build(
			answers([[docUrl("S100SY25"), { text: '{"StatusCode":401,"message":"Access denied"}' }]]),
		);
		expect(
			expectErr(
				await gateway.source.sync(queryFor(edinetTarget({ scanDays: ["2025-06-20"] })).query),
			),
		).toEqual({
			code: "FINANCIAL_ACCESS_DENIED",
			upstreamStatus: 401,
			requests: 2,
		});
		const garbage = build(answers([[docUrl("S100SY25"), { text: "<html>maintenance</html>" }]]));
		expect(
			expectErr(
				await garbage.source.sync(queryFor(edinetTarget({ scanDays: ["2025-06-20"] })).query),
			).code,
		).toBe("FINANCIAL_PARSE_FAILED");
		const noReport = build(
			answers([
				[
					docUrl("S100SY25"),
					{ bytes: buildTestZip([{ name: "XBRL_TO_CSV/jpaud.csv", text: "x", method: 0 }]) },
				],
			]),
		);
		expect(
			expectErr(
				await noReport.source.sync(queryFor(edinetTarget({ scanDays: ["2025-06-20"] })).query),
			).code,
		).toBe("FINANCIAL_PARSE_FAILED");
		const badList = build(answers([[listUrl("2025-06-20"), { text: "{" }]]));
		expect(
			expectErr(
				await badList.source.sync(queryFor(edinetTarget({ scanDays: ["2025-06-20"] })).query),
			).code,
		).toBe("FINANCIAL_PARSE_FAILED");
	});

	it("names the claim's filer when the scan finds nothing, and nothing when it has none", async () => {
		const { source } = build(answers());
		const known = expectOk(
			await source.sync(
				queryFor(edinetTarget({ scanDays: ["2023-06-23"], secCode: "77770", edinetCode: "E77777" }))
					.query,
			),
		);
		expect(known.identity).toEqual({ sourceCompanyId: "E77777", name: null, fiscalYearEnd: null });
		expect(known.filings).toEqual([]);
		const unknown = expectOk(
			await source.sync(
				queryFor(edinetTarget({ scanDays: ["2023-06-23"], secCode: "77770" })).query,
			),
		);
		expect(unknown.identity).toBeNull();
	});

	it("never puts the key anywhere but the query parameter", () => {
		expect(listUrl("2025-06-20")).toBe(
			"https://api.edinet-fsa.go.jp/api/v2/documents.json?date=2025-06-20&type=2&Subscription-Key=test-edinet-key-0001",
		);
		expect(edinetDocumentUrl("S100SY25", "a&b=c")).toBe(
			"https://api.edinet-fsa.go.jp/api/v2/documents/S100SY25?type=5&Subscription-Key=a%26b%3Dc",
		);
	});

	it("stops sending when the pacing gate says stop", async () => {
		const { source, requests } = build(answers());
		const { query } = queryFor(edinetTarget({ scanDays: DATES }), [true, false]);
		expect(expectErr(await source.sync(query))).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: null,
			requests: 1,
		});
		expect(requests).toHaveLength(1);
	});
});
