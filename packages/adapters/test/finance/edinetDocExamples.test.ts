/**
 * The examples in docs/external-apis/apis/edinet.md, fed through the EDINET
 * code the TypeScript runner uses (conventions §4). The list goes through
 * `parseEdinetDocumentList`, the annual-report row through it and
 * `edinetIndexDocument`, the error bodies through `edinetErrorStatus`. The
 * decoded XBRL-to-CSV report is packed back the way EDINET ships it — UTF-16LE
 * with a byte-order mark, CRLF lines, inside a ZIP under `XBRL_TO_CSV/` beside
 * an audit report — and its BYTES go through `extractEdinetReport` and through
 * the `edinet-index` source and then the whole EDINET source, served by a
 * scripted network at the URLs they build.
 */
import type { EquityPendingFiling } from "@research/contracts";
import type { EquityExtractedFact } from "@research/domain";
import { describe, expect, it } from "vitest";
import { extractEdinetReport } from "../../src/finance/edinetCsv.ts";
import {
	edinetDocumentListUrl,
	edinetDocumentUrl,
	edinetErrorStatus,
	edinetViewerUrl,
	parseEdinetDocumentList,
} from "../../src/finance/edinetDocuments.ts";
import { createEdinetIndexSource, edinetIndexDocument } from "../../src/finance/edinetIndex.ts";
import { createEdinetSource } from "../../src/finance/edinetSync.ts";
import { docExampleJson, docExampleText } from "../docExamples.ts";
import { buildTestZip } from "../zipTestUtils.ts";
import {
	EDINET_CONCEPTS,
	edinetTarget,
	type FakeAnswer,
	fakeFetcher,
	queryFor,
} from "./equitySyncSupport.ts";
import { expectErr, expectOk } from "./support.ts";

const KEY = "doc-example-edinet-key";
const DOC_ID = "S1000001";
const LIST_DATE = "2023-06-12";

/** The CSV as EDINET writes it: UTF-16LE with a byte-order mark, CRLF line ends. */
function utf16LeWithBom(text: string): Uint8Array {
	const crlf = text.replace(/\n/g, "\r\n");
	const bytes = new Uint8Array(2 + crlf.length * 2);
	bytes[0] = 0xff;
	bytes[1] = 0xfe;
	for (let index = 0; index < crlf.length; index += 1) {
		const unit = crlf.charCodeAt(index);
		bytes[2 + index * 2] = unit & 0xff;
		bytes[3 + index * 2] = unit >> 8;
	}
	return bytes;
}

function reportArchive(): Uint8Array {
	const csv = utf16LeWithBom(`${docExampleText("edinet", "edinet-xbrl-to-csv-report")}\n`);
	const audit = utf16LeWithBom(
		'"要素ID"\t"項目名"\t"コンテキストID"\t"相対年度"\t"連結・個別"\t"期間・時点"\t"ユニットID"\t"単位"\t"値"\n',
	);
	return buildTestZip([
		{
			name: "XBRL_TO_CSV/jpaud-aar-cn-001_E10001-000_2023-03-31_01_2023-06-12.csv",
			bytes: audit,
			method: 8,
		},
		{
			name: "XBRL_TO_CSV/jpcrp030000-asr-001_E10001-000_2023-03-31_01_2023-06-12.csv",
			bytes: csv,
			method: 8,
		},
	]);
}

function fact(
	concept: string,
	valueDecimal: string,
	period: Pick<EquityExtractedFact, "periodType" | "periodStart" | "periodEnd">,
	scope: EquityExtractedFact["scope"] = "consolidated",
): EquityExtractedFact {
	return { concept, unit: "JPY", valueDecimal, scope, ...period };
}

const CURRENT = {
	periodType: "duration",
	periodStart: "2022-04-01",
	periodEnd: "2023-03-31",
} as const;
const PRIOR = {
	periodType: "duration",
	periodStart: "2021-04-01",
	periodEnd: "2022-03-31",
} as const;
const CURRENT_END = { periodType: "instant", periodStart: null, periodEnd: "2023-03-31" } as const;
const PRIOR_END = { periodType: "instant", periodStart: null, periodEnd: "2022-03-31" } as const;

/** The annual facts the report example yields, in canonical order. */
const EXPECTED_FACTS: readonly EquityExtractedFact[] = [
	fact("jppfs_cor:Assets", "2310000000", PRIOR_END),
	fact("jppfs_cor:Assets", "2400000000", CURRENT_END),
	fact("jppfs_cor:NetSales", "1180000000", PRIOR),
	fact("jppfs_cor:NetSales", "1250000000", CURRENT),
	fact("jppfs_cor:NetSales", "830000000", CURRENT, "separate"),
	fact("jppfs_cor:OrdinaryIncome", "152000000", CURRENT),
	fact("jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF", "-61000000", CURRENT),
];

describe("EDINET document examples", () => {
	it("reads the list example and keeps no row of it (a securities registration statement)", () => {
		expect(edinetDocumentListUrl("2023-04-03", "<EDINET_API_KEY>")).toBe(
			"https://api.edinet-fsa.go.jp/api/v2/documents.json?date=2023-04-03&type=2&Subscription-Key=%3CEDINET_API_KEY%3E",
		);
		expect(
			expectOk(parseEdinetDocumentList(docExampleJson("edinet", "edinet-documents-list"))),
		).toEqual([]);
	});

	it("keeps the annual-report row and turns it into the index document", () => {
		const row = docExampleJson("edinet", "edinet-documents-row-annual-report");
		const rows = expectOk(parseEdinetDocumentList({ metadata: { status: "200" }, results: [row] }));
		expect(rows).toEqual([
			{
				docId: DOC_ID,
				edinetCode: "E10001",
				secCode: "10000",
				filerName: "エディネット株式会社",
				docTypeCode: "120",
				periodStart: "2022-04-01",
				periodEnd: "2023-03-31",
				submitDateTime: "2023-06-12 12:34",
				parentDocId: null,
			},
		]);
		const [annual] = rows;
		expect(annual === undefined ? null : edinetIndexDocument(annual)).toEqual({
			docId: DOC_ID,
			secCode: "10000",
			edinetCode: "E10001",
			filerName: "エディネット株式会社",
			docTypeCode: "120",
			periodStart: "2022-04-01",
			periodEnd: "2023-03-31",
			submittedAt: "2023-06-12T12:34:00+09:00",
			parentDocId: null,
		});
	});

	it("extracts the annual facts of the decoded report from a ZIP as EDINET ships it", () => {
		expect(edinetDocumentUrl(DOC_ID, "<EDINET_API_KEY>")).toBe(
			"https://api.edinet-fsa.go.jp/api/v2/documents/S1000001?type=5&Subscription-Key=%3CEDINET_API_KEY%3E",
		);
		const report = expectOk(extractEdinetReport(reportArchive(), EDINET_CONCEPTS));
		expect(report.accountingStandard).toBe("JGAAP");
		// The segment context, the "-" bar and the text blocks are skipped.
		expect(report.facts).toEqual(EXPECTED_FACTS);
		// 事業の内容 is the business description (ADR-0053), line by line.
		expect(report.business).toEqual({
			paragraphs: [
				{
					kind: "text",
					text: "当社グループは、当社及び連結子会社5社で構成され、産業機械の製造・販売を主な事業としています。",
				},
				{ kind: "heading", text: "（1）機械事業" },
				{ kind: "text", text: "当社が製造し、販売子会社を通じて販売しています。" },
			],
			truncated: false,
		});
	});

	it("reads the status of every error body", () => {
		const notFound = docExampleJson("edinet", "edinet-error-not-found");
		expect(edinetErrorStatus(notFound)).toBe(404);
		expect(expectErr(parseEdinetDocumentList(notFound))).toEqual({ kind: "status", status: 404 });
		expect(edinetErrorStatus(docExampleJson("edinet", "edinet-error-invalid-key"))).toBe(401);
		expect(edinetErrorStatus(docExampleJson("edinet", "edinet-error-too-many-requests"))).toBe(429);
	});

	describe("through the whole source", () => {
		const listAnswer: FakeAnswer = {
			text: JSON.stringify({
				metadata: { status: "200" },
				results: [docExampleJson("edinet", "edinet-documents-row-annual-report")],
			}),
		};
		const run = async (document: FakeAnswer) => {
			const { fetcher, requests } = fakeFetcher(
				new Map([
					[edinetDocumentListUrl(LIST_DATE, KEY), listAnswer],
					[edinetDocumentUrl(DOC_ID, KEY), document],
				]),
			);
			// The edinet-index job lists the date for every company…
			const index = expectOk(
				await createEdinetIndexSource({ fetcher, apiKey: KEY }).list({
					days: [LIST_DATE],
					signal: new AbortController().signal,
					beforeRequest: async () => true,
				}),
			);
			const [listed] = index.days.flatMap((day) => day.documents);
			if (listed === undefined || listed.periodEnd === null) throw new Error("not indexed");
			// …and the API names the indexed report in the company's claim.
			const indexedFiling: EquityPendingFiling = {
				sourceDocumentId: listed.docId,
				form: "securities-report",
				filedOn: listed.submittedAt.slice(0, 10),
				submittedAt: listed.submittedAt,
				periodStart: listed.periodStart,
				periodEnd: listed.periodEnd,
				amendsSourceDocumentId: listed.parentDocId,
				sourceUrl: edinetViewerUrl(listed.docId),
			};
			const source = createEdinetSource({ binaryFetcher: fetcher, apiKey: KEY });
			const target = edinetTarget({
				secCode: listed.secCode,
				edinetCode: listed.edinetCode,
				indexedFilings: [indexedFiling],
			});
			const data = expectOk(await source.sync(queryFor(target).query));
			return { data, requests };
		};

		it("indexes the date, downloads the report and completes with its facts", async () => {
			const { data, requests } = await run({ bytes: reportArchive() });
			expect(requests.map((request) => request.kind)).toEqual(["text", "bytes"]);
			expect(data.identity).toEqual({
				sourceCompanyId: "E10001",
				name: null,
				fiscalYearEnd: "03-31",
			});
			expect(data.more).toBe(false);
			expect(data.filings).toHaveLength(1);
			expect(data.filings[0]?.factsStatus).toBe("extracted");
			expect(data.filings[0]?.accountingStandard).toBe("JGAAP");
			expect(data.filings[0]?.facts).toEqual(EXPECTED_FACTS);
		});

		it("reports the document not available when it answers the 404 error body", async () => {
			const { data } = await run({
				text: docExampleText("edinet", "edinet-error-not-found"),
				contentType: "application/json; charset=utf-8",
			});
			expect(data.filings.map((filing) => [filing.sourceDocumentId, filing.factsStatus])).toEqual([
				[DOC_ID, "not-available"],
			]);
		});
	});
});
