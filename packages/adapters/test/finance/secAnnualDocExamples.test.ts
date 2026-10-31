/**
 * The financial-sync examples in docs/external-apis/apis/sec-edgar.md, fed
 * through the SEC annual-filings code the TypeScript runner uses
 * (conventions §4): the submissions index through `parseSecSubmissions`, the
 * company facts through `indexSecCompanyFacts`, both together through
 * `secSyncResult`, and through the whole source served by a scripted network
 * at the URLs it builds. The filer is the synthetic one of
 * examples/fixtures/equity-sync/ (not SEC data).
 */
import type { EquityFilingResult, SecSyncRequest } from "@research/contracts";
import type { EquityExtractedFact } from "@research/domain";
import { describe, expect, it } from "vitest";
import { secSubmissionsUrl } from "../../src/finance/sec13f.ts";
import {
	createSecAnnualFilingsSource,
	indexSecCompanyFacts,
	parseSecSubmissions,
	secSyncResult,
} from "../../src/finance/secAnnualFilings.ts";
import { secCompanyFactsUrl } from "../../src/finance/secFinancials.ts";
import { docExampleJson, docExampleText } from "../docExamples.ts";
import {
	fakeFetcher,
	movableClock,
	queryFor,
	SEC_CONCEPTS,
	secTarget,
} from "./equitySyncSupport.ts";
import { expectOk } from "./support.ts";

const CIK = "0009999981";
const USER_AGENT = "Doc Example research owner@example.com";
const FIRST_SYNC: SecSyncRequest = {
	provider: "sec",
	cik: CIK,
	knownAccessions: [],
	pendingFilings: [],
	filedSince: "2020-10-31",
	fullCheck: true,
};

function usd(
	concept: string,
	valueDecimal: string,
	periodEnd: string,
	periodStart: string | null = null,
): EquityExtractedFact {
	return {
		concept: `us-gaap:${concept}`,
		unit: "USD",
		valueDecimal,
		periodType: periodStart === null ? "instant" : "duration",
		periodStart,
		periodEnd,
		scope: "consolidated",
	};
}

const ARCHIVE = "https://www.sec.gov/Archives/edgar/data/9999981";

/** The completion's filings the two examples give on a first sync, newest first. */
const EXPECTED_FILINGS: readonly EquityFilingResult[] = [
	{
		sourceDocumentId: "0009999981-26-000005",
		form: "10-K/A",
		filedOn: "2026-01-15",
		submittedAt: "2026-01-15T16:12:09.000Z",
		periodStart: null,
		periodEnd: "2025-09-30",
		amendsSourceDocumentId: null,
		sourceUrl: `${ARCHIVE}/000999998126000005/synd-20250930a.htm`,
		accountingStandard: "US-GAAP",
		factsStatus: "extracted",
		facts: [
			usd("Assets", "460000000000", "2025-09-30"),
			usd("NetIncomeLoss", "56200000000", "2025-09-30", "2024-10-01"),
		],
	},
	{
		sourceDocumentId: "0009999981-25-000110",
		form: "10-K",
		filedOn: "2025-11-05",
		submittedAt: "2025-11-05T21:04:11.000Z",
		periodStart: null,
		periodEnd: "2025-09-30",
		amendsSourceDocumentId: null,
		sourceUrl: `${ARCHIVE}/000999998125000110/synd-20250930.htm`,
		accountingStandard: "US-GAAP",
		factsStatus: "extracted",
		// Three income years as filed; instants only at the two balance-sheet ends
		// (the interim 2025-03-31 and the opening balances 2022/2023 are dropped).
		facts: [
			usd("Assets", "440000000000", "2024-09-30"),
			usd("Assets", "460000000000", "2025-09-30"),
			usd("NetIncomeLoss", "51000000000", "2023-09-30", "2022-10-01"),
			usd("NetIncomeLoss", "54000000000", "2024-09-30", "2023-10-01"),
			usd("NetIncomeLoss", "57000000000", "2025-09-30", "2024-10-01"),
			usd("StockholdersEquity", "176000000000", "2024-09-30"),
			usd("StockholdersEquity", "184000000000", "2025-09-30"),
		],
	},
	{
		sourceDocumentId: "0009999981-24-000108",
		form: "10-K",
		filedOn: "2024-11-04",
		submittedAt: "2024-11-04T21:01:36.000Z",
		periodStart: null,
		periodEnd: "2024-09-30",
		amendsSourceDocumentId: null,
		sourceUrl: `${ARCHIVE}/000999998124000108/synd-20240930.htm`,
		accountingStandard: null,
		factsStatus: "not-available",
		facts: [],
	},
];

describe("SEC EDGAR financial-sync document examples", () => {
	it("reads the identity and the annual rows of the submissions example", () => {
		expect(secSubmissionsUrl(CIK)).toBe("https://data.sec.gov/submissions/CIK0009999981.json");
		const submissions = expectOk(
			parseSecSubmissions(docExampleJson("sec-edgar", "sec-edgar-submissions-annual")),
		);
		expect(submissions.name).toBe("Synthetic Devices Inc.");
		expect(submissions.fiscalYearEnd).toBe("09-30");
		// The 10-Q is dropped; the annual rows stay in SEC's order.
		expect(submissions.annualRows.map((row) => [row.accession, row.form])).toEqual([
			["0009999981-26-000005", "10-K/A"],
			["0009999981-25-000110", "10-K"],
			["0009999981-24-000108", "10-K"],
		]);
	});

	it("indexes the company facts example by accession", () => {
		expect(secCompanyFactsUrl(CIK)).toBe(
			"https://data.sec.gov/api/xbrl/companyfacts/CIK0009999981.json",
		);
		const index = expectOk(
			indexSecCompanyFacts(
				docExampleJson("sec-edgar", "sec-edgar-companyfacts-annual"),
				SEC_CONCEPTS,
			),
		);
		expect([...index.keys()].sort()).toEqual(["0009999981-25-000110", "0009999981-26-000005"]);
		expect(index.get("0009999981-26-000005")?.form).toBe("10-K/A");
		expect(index.get("0009999981-25-000110")?.entryCount).toBe(10);
	});

	it("turns both examples into the completion of a first sync", () => {
		const submissions = expectOk(
			parseSecSubmissions(docExampleJson("sec-edgar", "sec-edgar-submissions-annual")),
		);
		const facts = expectOk(
			indexSecCompanyFacts(
				docExampleJson("sec-edgar", "sec-edgar-companyfacts-annual"),
				SEC_CONCEPTS,
			),
		);
		const result = secSyncResult({ request: FIRST_SYNC, cik: CIK, submissions, facts });
		expect(result.identity).toEqual({
			sourceCompanyId: CIK,
			name: "Synthetic Devices Inc.",
			fiscalYearEnd: "09-30",
		});
		expect(result.more).toBe(false);
		expect(result.filings).toEqual(EXPECTED_FILINGS);
	});

	it("sends two requests through the whole source and completes the same way", async () => {
		const { fetcher, requests } = fakeFetcher(
			new Map([
				[
					secSubmissionsUrl(CIK),
					{ text: docExampleText("sec-edgar", "sec-edgar-submissions-annual") },
				],
				[
					secCompanyFactsUrl(CIK),
					{ text: docExampleText("sec-edgar", "sec-edgar-companyfacts-annual") },
				],
			]),
		);
		const source = createSecAnnualFilingsSource({
			fetcher,
			clock: movableClock().clock,
			userAgent: USER_AGENT,
			sleep: async () => {},
		});
		const data = expectOk(await source.sync(queryFor(secTarget({ fullCheck: true })).query));
		expect(requests.map((request) => request.url)).toEqual([
			secSubmissionsUrl(CIK),
			secCompanyFactsUrl(CIK),
		]);
		expect(data.requests).toBe(2);
		expect(data.scannedDays).toEqual([]);
		expect(data.filings).toEqual(EXPECTED_FILINGS);
	});
});
