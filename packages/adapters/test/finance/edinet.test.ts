/**
 * EDINET documents, XBRL-to-CSV reports and the EDINET sync source
 * (ADR-0048 §4, §6; downloads by the shared index, ADR-0058 §4), over the
 * synthetic filer in examples/fixtures/equity-sync/.
 */
import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityPendingFiling,
	equityBusinessDescriptionSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	decodeUtf16Le,
	EDINET_CSV_HEADER,
	edinetBusinessParagraphs,
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
	edinetIdentity,
	parseEdinetDocumentList,
} from "../../src/finance/edinetDocuments.ts";
import { createEdinetSource, EDINET_ZIP_MAX_BYTES } from "../../src/finance/edinetSync.ts";
import type { EquitySyncDescriptionUnread } from "../../src/finance/equitySync.ts";
import { buildTestZip } from "../zipTestUtils.ts";
import {
	EDINET_CONCEPTS,
	edinetTarget,
	equityFixtureBytes,
	equityFixtureJson,
	type FakeAnswer,
	fakeFetcher,
	httpError,
	knownFiling,
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

	it("reads the parent, the CSV flag and the nullable fields", () => {
		const [, amendment] = rowsOf("2024-09-10");
		expect(amendment).toEqual({
			docId: "S100SYA4",
			edinetCode: "E99991",
			secCode: "99990",
			filerName: "シンセティック工業株式会社",
			docTypeCode: "130",
			periodStart: null,
			periodEnd: null,
			submitDateTime: "2024-09-10 10:30",
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

/**
 * An indexed (or stored) filing of the synthetic filer as the API names it:
 * the list row's metadata, an amendment (130) with its original's period
 * (the API takes it from the index or the stored original).
 */
function indexedFiling(docId: string): EquityPendingFiling {
	const row = DATES.flatMap((date) => rowsOf(date)).find((entry) => entry.docId === docId);
	if (row === undefined) throw new Error(`no fixture row ${docId}`);
	const period =
		row.periodEnd !== null
			? { periodStart: row.periodStart, periodEnd: row.periodEnd }
			: knownFiling(row.parentDocId ?? "");
	return {
		sourceDocumentId: docId,
		form: row.docTypeCode === "120" ? "securities-report" : "amended-securities-report",
		filedOn: row.submitDateTime.slice(0, 10),
		submittedAt: `${row.submitDateTime.replace(" ", "T")}:00+09:00`,
		periodStart: period.periodStart,
		periodEnd: period.periodEnd,
		amendsSourceDocumentId: row.parentDocId,
		sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${docId}`,
	};
}

/** Every annual report of the synthetic filer the index lists, oldest first. */
const INDEXED_DOCS = [...DOCS.slice(0, 5), "S100SYA4", "S100SY25", "S100SYB5"].filter(
	(docId, index, all) => all.indexOf(docId) === index,
);

describe("edinetIdentity", () => {
	it("names the claim's filer code and the year end of the first original report", () => {
		expect(
			edinetIdentity("E99991", [indexedFiling("S100SYA4"), indexedFiling("S100SY25")]),
		).toEqual({ sourceCompanyId: "E99991", name: null, fiscalYearEnd: "03-31" });
		expect(edinetIdentity("E99991", [indexedFiling("S100SYA4")])).toEqual({
			sourceCompanyId: "E99991",
			name: null,
			fiscalYearEnd: null,
		});
		expect(edinetIdentity("E99991", [])).toEqual({
			sourceCompanyId: "E99991",
			name: null,
			fiscalYearEnd: null,
		});
		expect(edinetIdentity(null, [indexedFiling("S100SY25")])).toBeNull();
	});
});

describe("edinetDownloadPlan", () => {
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
	const indexed = INDEXED_DOCS.map(indexedFiling);

	it("puts pending first, then the indexed reports in claim order, skipping stored ones", () => {
		const plan = edinetDownloadPlan({
			pending: [pending],
			indexed,
			knownFilings: [knownFiling("S100SY20")],
			maxDownloads: 8,
		});
		expect(plan.map((entry) => [entry.metadata.sourceDocumentId, entry.action])).toEqual([
			["S100PEND", "download"],
			["S100SY21", "download"],
			["S100SY22", "download"],
			["S100SY23", "download"],
			["S100SY24", "download"],
			["S100SYA4", "download"],
			["S100SY25", "download"],
			["S100SYB5", "download"],
		]);
		// The claim's metadata travels unchanged.
		expect(plan[5]?.metadata).toEqual(indexedFiling("S100SYA4"));
	});

	it("names a document once, a pending one with its stored metadata", () => {
		const stored = { ...indexedFiling("S100SY25"), submittedAt: null };
		const plan = edinetDownloadPlan({
			pending: [stored, stored],
			indexed: [indexedFiling("S100SY25"), indexedFiling("S100SY24"), indexedFiling("S100SY24")],
			knownFilings: [],
			maxDownloads: 8,
		});
		expect(plan.map((entry) => entry.metadata)).toEqual([stored, indexedFiling("S100SY24")]);
	});

	it("defers what exceeds the download cap", () => {
		const plan = edinetDownloadPlan({ pending: [], indexed, knownFilings: [], maxDownloads: 3 });
		expect(plan.map((entry) => entry.action)).toEqual([
			"download",
			"download",
			"download",
			"deferred",
			"deferred",
			"deferred",
			"deferred",
			"deferred",
		]);
		expect(
			edinetDownloadPlan({ pending: [], indexed, knownFilings: [], maxDownloads: 0 }).every(
				(entry) => entry.action === "deferred",
			),
		).toBe(true);
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

	it("reads the first 事業の内容 text block at the filing date, keeping its line breaks (ADR-0053)", () => {
		const block = (context: string, value: string) =>
			quoted([
				"jpcrp_cor:DescriptionOfBusinessTextBlock",
				"事業の内容 [テキストブロック]",
				context,
				"提出日時点",
				"その他",
				"時点",
				"－",
				"－",
				value,
			]);
		const text = [
			HEADER,
			block("CurrentYearInstant", "別の時点"),
			block("FilingDateInstant", "３【事業の内容】\r\n当社は機械を製造しています。"),
			block("FilingDateInstant", "二つ目"),
		].join("\r\n");
		expect(expectOk(parseEdinetCsv(text, EDINET_CONCEPTS)).businessText).toBe(
			"３【事業の内容】\r\n当社は機械を製造しています。",
		);
		expect(expectOk(parseEdinetCsv(HEADER, EDINET_CONCEPTS)).businessText).toBeNull();
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

describe("edinetBusinessParagraphs", () => {
	it("makes each line a block: short headings, sentences as text, blank and spacing lines dropped", () => {
		const text = [
			"３【事業の内容】",
			"　当社グループは、産業機械の製造・販売を主な事業としています。",
			"",
			"（1）経営方針",
			"当社が製造し、国内外の販売子会社を通じて販売しています。",
			"[事業系統図]",
		].join("\r\n");
		expect(edinetBusinessParagraphs(text)).toEqual({
			paragraphs: [
				{ kind: "text", text: "当社グループは、産業機械の製造・販売を主な事業としています。" },
				{ kind: "heading", text: "（1）経営方針" },
				{ kind: "text", text: "当社が製造し、国内外の販売子会社を通じて販売しています。" },
			],
			truncated: false,
		});
		expect(edinetBusinessParagraphs("見出し\r本文です。\n次の文です。").paragraphs).toHaveLength(3);
	});

	it("gives nothing without a text block or without text in it", () => {
		const none = { paragraphs: [], truncated: false };
		expect(edinetBusinessParagraphs(null)).toEqual(none);
		expect(edinetBusinessParagraphs("")).toEqual(none);
		expect(edinetBusinessParagraphs("３【事業の内容】\n（1）機械事業")).toEqual(none);
	});

	it("leaves out the report's own item title", () => {
		const text = "\n３【事業の内容】\n当社グループは、家庭用ゲーム機を製造販売しています。";
		expect(edinetBusinessParagraphs(text).paragraphs).toEqual([
			{ kind: "text", text: "当社グループは、家庭用ゲーム機を製造販売しています。" },
		]);
		// Only as the first line: the same words later are the filing's own text.
		expect(edinetBusinessParagraphs("概要\n3【事業の内容】").paragraphs).toEqual([]);
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
		expect(report.business.paragraphs.slice(0, 1)).toEqual([
			{
				kind: "text",
				text: "当社グループは、当社、連結子会社17社及び持分法適用関連会社3社で構成され、産業機械及び計測機器の製造・販売を主な事業としています（2025年3月31日現在）。",
			},
		]);
		// The 2020 report has no 事業の内容 text block.
		const oldest = expectOk(
			extractEdinetReport(equityFixtureBytes("edinet-S100SY20.synthetic.zip"), EDINET_CONCEPTS),
		);
		expect(oldest.business).toEqual({ paragraphs: [], truncated: false });
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
	const docUrl = (docId: string) => edinetDocumentUrl(docId, KEY);
	const answers = (overrides: [string, FakeAnswer][] = []) =>
		new Map<string, FakeAnswer>([
			...DOCS.map((docId): [string, FakeAnswer] => [
				docUrl(docId),
				{ bytes: equityFixtureBytes(`edinet-${docId}.synthetic.zip`) },
			]),
			...overrides,
		]);
	const build = (map: Map<string, FakeAnswer>, apiKey: string | null = KEY) => {
		const fake = fakeFetcher(map);
		const source = createEdinetSource({ binaryFetcher: fake.fetcher, apiKey });
		return { ...fake, source };
	};
	const indexed = (docIds: readonly string[] = INDEXED_DOCS) => docIds.map(indexedFiling);

	it("fails unconfigured without a request", async () => {
		const { source, requests } = build(answers(), null);
		const { query, grants } = queryFor(edinetTarget({ indexedFilings: indexed() }));
		expect(expectErr(await source.sync(query))).toEqual({
			code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			upstreamStatus: null,
			requests: 0,
		});
		expect(requests).toEqual([]);
		expect(grants()).toBe(0);
	});

	it("downloads the indexed reports and reports each with its indexed metadata", async () => {
		const { source, requests } = build(answers());
		const { query, grants } = queryFor(
			edinetTarget({ edinetCode: "E99991", indexedFilings: indexed() }),
		);
		const data = expectOk(await source.sync(query));
		expect(data.identity).toEqual({
			sourceCompanyId: "E99991",
			name: null,
			fiscalYearEnd: "03-31",
		});
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
		const amendment = data.filings.find((f) => f.sourceDocumentId === "S100SYA4");
		expect(amendment).toMatchObject({ ...indexedFiling("S100SYA4"), accountingStandard: "JGAAP" });
		// One download per document, no date list: the edinet-index job lists the dates.
		expect(data.requests).toBe(8);
		expect(grants()).toBe(8);
		expect(requests.every((request) => request.kind === "bytes")).toBe(true);
		expect(requests[0]).toEqual({
			url: docUrl("S100SY20"),
			kind: "bytes",
			maxBytes: EDINET_ZIP_MAX_BYTES,
			accept: "application/octet-stream, application/zip, application/json",
			allowedHosts: ["api.edinet-fsa.go.jp"],
			userAgent: null,
		});
	});

	it("defers beyond eight downloads and offers pending filings first with their stored metadata", async () => {
		const { source, requests } = build(answers());
		const pending: EquityPendingFiling = { ...indexedFiling("S100SY25"), submittedAt: null };
		const unlisted: EquityPendingFiling = {
			...pending,
			sourceDocumentId: "S100PEND",
			sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100PEND",
		};
		const data = expectOk(
			await source.sync(
				queryFor(edinetTarget({ pendingFilings: [pending, unlisted], indexedFilings: indexed() }))
					.query,
			),
		);
		expect(requests.slice(0, 2).map((r) => r.url)).toEqual([
			docUrl("S100SY25"),
			docUrl("S100PEND"),
		]);
		expect(requests).toHaveLength(EQUITY_FINANCIAL_LIMITS.maxDocumentsPerJob);
		expect(data.filings.find((f) => f.sourceDocumentId === "S100SY25")).toMatchObject({
			...pending,
			factsStatus: "extracted",
		});
		// Eight downloads: two pending, six of the seven other indexed reports; the last one waits.
		expect(data.filings.find((f) => f.sourceDocumentId === "S100SYB5")).toMatchObject({
			factsStatus: "deferred",
			facts: [],
		});
	});

	it("skips an indexed report the claim already stores", async () => {
		const { source, requests } = build(answers());
		const data = expectOk(
			await source.sync(
				queryFor(
					edinetTarget({
						indexedFilings: indexed(["S100SY24", "S100SY25"]),
						knownFilings: [knownFiling("S100SY24")],
					}),
				).query,
			),
		);
		expect(requests.map((r) => r.url)).toEqual([docUrl("S100SY25")]);
		expect(data.filings.map((f) => f.sourceDocumentId)).toEqual(["S100SY25"]);
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
				await source.sync(queryFor(edinetTarget({ indexedFilings: indexed(["S100SY25"]) })).query),
			);
			expect(data.filings).toEqual([
				{
					...indexedFiling("S100SY25"),
					accountingStandard: null,
					factsStatus: "not-available",
					facts: [],
				},
			]);
			expect(data.unreadableDocuments).toEqual([]);
		}
	});

	it.each([
		[401, "FINANCIAL_ACCESS_DENIED"],
		[403, "FINANCIAL_ACCESS_DENIED"],
		[429, "FINANCIAL_RATE_LIMITED"],
		[500, "FINANCIAL_SOURCE_FAILED"],
	])("fails the job when a download answers HTTP %i (%s), keeping the status", async (status, code) => {
		const { source, requests } = build(answers([[docUrl("S100SY21"), httpError(status)]]));
		const failure = expectErr(
			await source.sync(queryFor(edinetTarget({ indexedFilings: indexed() })).query),
		);
		expect(failure).toEqual({ code, upstreamStatus: status, requests: 2 });
		expect(requests).toHaveLength(2);
	});

	it("fails on EDINET's error bodies with HTTP 200 and on a network failure", async () => {
		for (const [body, code, status] of [
			['{"StatusCode":401,"message":"Access denied"}', "FINANCIAL_ACCESS_DENIED", 401],
			['{"StatusCode":429,"message":"Too Many Requests"}', "FINANCIAL_RATE_LIMITED", 429],
			[
				'{"metadata":{"status":"500","message":"Internal Server Error"}}',
				"FINANCIAL_SOURCE_FAILED",
				500,
			],
		] as const) {
			const { source } = build(answers([[docUrl("S100SY25"), { text: body }]]));
			expect(
				expectErr(
					await source.sync(
						queryFor(edinetTarget({ indexedFilings: indexed(["S100SY25"]) })).query,
					),
				),
			).toEqual({ code, upstreamStatus: status, requests: 1 });
		}
		const { source } = build(
			answers([[docUrl("S100SY25"), { error: { code: "TIMEOUT", detail: "timed out" } }]]),
		);
		expect(
			expectErr(
				await source.sync(queryFor(edinetTarget({ indexedFilings: indexed(["S100SY25"]) })).query),
			),
		).toEqual({ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null, requests: 1 });
	});

	it.each([
		["neither a ZIP nor an error", { text: "<html>maintenance</html>" }, "NOT_A_ZIP"],
		["a malformed ZIP", { bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2]) }, "NOT_A_ZIP"],
		[
			"a ZIP without a jpcrp CSV",
			{ bytes: buildTestZip([{ name: "XBRL_TO_CSV/jpaud.csv", text: "x", method: 0 }]) },
			"NO_REPORT_ENTRY",
		],
		[
			"a CSV without the header",
			{
				bytes: buildTestZip([
					{
						name: "XBRL_TO_CSV/jpcrp030000-asr-001.csv",
						bytes: new Uint8Array([0xff, 0xfe, 0x22, 0x00, 0x61, 0x00, 0x22, 0x00]),
						method: 0,
					},
				]),
			},
			"MISSING_HEADER",
		],
	] as const)("reports a document that is %s as not available and goes on with the others", async (_label, answer, problem) => {
		const { source, requests } = build(answers([[docUrl("S100SY23"), answer]]));
		const data = expectOk(
			await source.sync(queryFor(edinetTarget({ indexedFilings: indexed() })).query),
		);
		const statuses = new Map(data.filings.map((f) => [f.sourceDocumentId, f.factsStatus]));
		expect(statuses.get("S100SY23")).toBe("not-available");
		expect(data.filings.find((f) => f.sourceDocumentId === "S100SY23")?.facts).toEqual([]);
		for (const docId of ["S100SY25", "S100SYA4", "S100SY24", "S100SY22", "S100SY21", "S100SY20"]) {
			expect(statuses.get(docId), docId).toBe("extracted");
		}
		expect(data.unreadableDocuments).toEqual([{ sourceDocumentId: "S100SY23", problem }]);
		// Every planned document was still requested.
		expect(requests).toHaveLength(8);
	});

	it("never puts the key anywhere but the query parameter", () => {
		expect(edinetDocumentListUrl("2025-06-20", KEY)).toBe(
			"https://api.edinet-fsa.go.jp/api/v2/documents.json?date=2025-06-20&type=2&Subscription-Key=test-edinet-key-0001",
		);
		expect(edinetDocumentUrl("S100SY25", "a&b=c")).toBe(
			"https://api.edinet-fsa.go.jp/api/v2/documents/S100SY25?type=5&Subscription-Key=a%26b%3Dc",
		);
	});

	describe("the business description (ADR-0053)", () => {
		const viewer = (docId: string) => `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${docId}`;
		const stored = (docId: string): EquityPendingFiling => {
			const year = 2020 + Number(docId.slice(-1));
			return {
				sourceDocumentId: docId,
				form: "securities-report",
				filedOn: `${year}-06-20`,
				submittedAt: null,
				periodStart: `${year - 1}-04-01`,
				periodEnd: `${year}-03-31`,
				amendsSourceDocumentId: null,
				sourceUrl: viewer(docId),
			};
		};
		const allKnown = DOCS.map(knownFiling);

		it("carries the newest annual report's 事業の内容 among those read, never an amendment's", async () => {
			const { source } = build(answers());
			const data = expectOk(
				await source.sync(queryFor(edinetTarget({ indexedFilings: indexed() })).query),
			);
			const description = equityBusinessDescriptionSchema.parse(data.description);
			expect(description.source).toEqual({
				sourceDocumentId: "S100SY25",
				form: "securities-report",
				filedOn: "2025-06-20",
				periodEnd: "2025-03-31",
				sourceUrl: viewer("S100SY25"),
			});
			expect(description.status).toBe("extracted");
			// The item title "３【事業の内容】" is left out: the text starts at once.
			expect(description.paragraphs[0]?.kind).toBe("text");
			// Reading only the amendment gives none.
			const amendmentOnly = expectOk(
				await source.sync(
					queryFor(
						edinetTarget({
							indexedFilings: indexed(["S100SYA4"]),
							knownFilings: [knownFiling("S100SY24")],
						}),
					).query,
				),
			);
			expect(amendmentOnly.filings.map((f) => f.sourceDocumentId)).toEqual(["S100SYA4"]);
			expect(amendmentOnly.description).toBeNull();
		});

		it("records a report without the text block as not found", async () => {
			const { source } = build(answers());
			const data = expectOk(
				await source.sync(queryFor(edinetTarget({ indexedFilings: indexed(["S100SY20"]) })).query),
			);
			expect(data.description).toEqual({
				source: {
					sourceDocumentId: "S100SY20",
					form: "securities-report",
					filedOn: "2020-06-26",
					periodEnd: "2020-03-31",
					sourceUrl: viewer("S100SY20"),
				},
				status: "not-found",
				paragraphs: [],
				truncated: false,
			});
		});

		it("downloads the claim's describeFiling for the description alone", async () => {
			const { source, requests } = build(answers());
			const filing = stored("S100SY23");
			const data = expectOk(
				await source.sync(
					queryFor(edinetTarget({ knownFilings: allKnown, describeFiling: filing })).query,
				),
			);
			expect(requests.map((r) => r.url)).toEqual([docUrl("S100SY23")]);
			expect(data).toMatchObject({ filings: [], requests: 1, unreadableDocuments: [] });
			expect(data.description?.source).toEqual({
				sourceDocumentId: "S100SY23",
				form: "securities-report",
				filedOn: filing.filedOn,
				periodEnd: filing.periodEnd,
				sourceUrl: filing.sourceUrl,
			});
			expect(data.description?.paragraphs[0]?.text).toContain("2023年3月31日現在");
		});

		it("does not download describeFiling again when the job reads it anyway, and keeps the newest", async () => {
			const { source, requests } = build(answers());
			const data = expectOk(
				await source.sync(
					queryFor(
						edinetTarget({
							indexedFilings: indexed(["S100SY25"]),
							describeFiling: stored("S100SY25"),
						}),
					).query,
				),
			);
			expect(requests.filter((r) => r.url === docUrl("S100SY25"))).toHaveLength(1);
			expect(data.description?.source.sourceDocumentId).toBe("S100SY25");
			// An older describeFiling beside a newer report this job reads: the newer one wins.
			const both = build(answers());
			const newest = expectOk(
				await both.source.sync(
					queryFor(
						edinetTarget({
							indexedFilings: indexed(["S100SY25"]),
							describeFiling: stored("S100SY22"),
						}),
					).query,
				),
			);
			expect(both.requests.map((r) => r.url)).toContain(docUrl("S100SY22"));
			expect(newest.description?.source.sourceDocumentId).toBe("S100SY25");
		});

		it("skips describeFiling when the download cap is reached or it is not an original report", async () => {
			const unlisted = (docId: string): EquityPendingFiling => ({
				...stored("S100SY21"),
				sourceDocumentId: docId,
			});
			const { source, requests } = build(answers());
			// One pending filing and seven of the eight indexed reports fill the eight downloads.
			const capped = expectOk(
				await source.sync(
					queryFor(
						edinetTarget({
							indexedFilings: indexed(),
							pendingFilings: [unlisted("S100SZ01")],
							describeFiling: stored("S100SY19"),
						}),
					).query,
				),
			);
			expect(EQUITY_FINANCIAL_LIMITS.maxDocumentsPerJob).toBe(8);
			expect(requests.some((r) => r.url === docUrl("S100SY19"))).toBe(false);
			expect(capped.description?.source.sourceDocumentId).toBe("S100SY25");

			const amendment = build(answers());
			const none = expectOk(
				await amendment.source.sync(
					queryFor(
						edinetTarget({
							knownFilings: allKnown,
							describeFiling: { ...stored("S100SYA4"), form: "amended-securities-report" },
						}),
					).query,
				),
			);
			expect(amendment.requests).toEqual([]);
			expect(none.description).toBeNull();
		});

		it.each<[string, FakeAnswer, EquitySyncDescriptionUnread]>([
			["HTTP 404", httpError(404), { code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: 404 }],
			["HTTP 500", httpError(500), { code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: 500 }],
			[
				"a timeout",
				{ error: { code: "TIMEOUT", detail: "timed out" } },
				{ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null },
			],
			[
				"an error body",
				{ text: '{"metadata":{"status":"429"}}' },
				{ code: "FINANCIAL_RATE_LIMITED", upstreamStatus: 429 },
			],
			[
				"neither a ZIP nor an error",
				{ text: "<html>" },
				{ code: "NOT_A_ZIP", upstreamStatus: null },
			],
			[
				"a ZIP without the report",
				{ bytes: buildTestZip([{ name: "a.txt", bytes: new Uint8Array(1), method: 0 }]) },
				{ code: "NO_REPORT_ENTRY", upstreamStatus: null },
			],
		])("completes without a description when describeFiling fails with %s", async (_, answer, unread) => {
			const { source } = build(answers([[docUrl("S100SY23"), answer]]));
			const data = expectOk(
				await source.sync(
					queryFor(edinetTarget({ knownFilings: allKnown, describeFiling: stored("S100SY23") }))
						.query,
				),
			);
			expect(data).toMatchObject({ requests: 1, description: null, unreadableDocuments: [] });
			// Not a failure, but logged by the runner (financial_sync_description_unread).
			expect(data.descriptionUnread).toEqual(unread);
		});

		it("fails as a stopped job when the gate or the signal stops the describeFiling download", async () => {
			const target = edinetTarget({ knownFilings: allKnown, describeFiling: stored("S100SY23") });
			const gate = build(answers());
			expect(expectErr(await gate.source.sync(queryFor(target, [false]).query))).toEqual({
				code: "FINANCIAL_SOURCE_FAILED",
				upstreamStatus: null,
				requests: 0,
			});
			expect(gate.requests).toEqual([]);

			const controller = new AbortController();
			controller.abort();
			const aborted = build(
				answers([
					[docUrl("S100SY23"), { error: { code: "TIMEOUT", detail: "aborted by the caller" } }],
				]),
			);
			const failure = expectErr(
				await aborted.source.sync({ ...queryFor(target).query, signal: controller.signal }),
			);
			expect(failure).toEqual({
				code: "FINANCIAL_SOURCE_FAILED",
				upstreamStatus: null,
				requests: 1,
			});
		});
	});

	it("stops sending when the pacing gate says stop", async () => {
		const { source, requests } = build(answers());
		const { query } = queryFor(edinetTarget({ indexedFilings: indexed() }), [true, false]);
		expect(expectErr(await source.sync(query))).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: null,
			requests: 1,
		});
		expect(requests).toHaveLength(1);
	});
});
