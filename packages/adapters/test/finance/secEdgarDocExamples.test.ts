/**
 * The examples in docs/external-apis/apis/sec-edgar.md, fed through the SEC
 * parsers the TypeScript runner uses (conventions §4). The ticker directory
 * goes through `parseTickerDirectory` and `secDirectoryEntries` (the
 * directory's row-count floor is left out: the example keeps 15 rows); company
 * facts through `selectAnnualFinancials`; the submissions index and the
 * submission text file through the whole 13F source, served by a scripted
 * fetcher at the URLs the source builds.
 */
import { describe, expect, it } from "vitest";
import {
	createSec13FSource,
	extractInformationTableXml,
	parseInformationTable,
	secFilingTextUrl,
	secSubmissionsUrl,
	selectRecent13FFilings,
} from "../../src/finance/sec13f.ts";
import { createSecClient } from "../../src/finance/secClient.ts";
import { secDirectoryEntries } from "../../src/finance/secDirectory.ts";
import {
	parseTickerDirectory,
	secCompanyFactsUrl,
	selectAnnualFinancials,
} from "../../src/finance/secFinancials.ts";
import { docExampleJson, docExampleText } from "../docExamples.ts";
import { createScriptedFetcher } from "../tools/support.ts";
import { expectOk } from "./support.ts";

const USER_AGENT = "Doc Example research owner@example.com";
const MANAGER_CIK = "0009999993";

describe("SEC EDGAR document examples", () => {
	it("reads the ticker directory example by column name", () => {
		const body = docExampleJson("sec-edgar", "sec-edgar-company-tickers-exchange");
		const issuers = expectOk(parseTickerDirectory(body));
		expect(issuers.get("AAPL")).toEqual({
			cik: "0000320193",
			name: "Apple Inc.",
			ticker: "AAPL",
			secExchange: "Nasdaq",
		});
		expect(issuers.get("INBT")?.secExchange).toBeNull();
		const { entries } = expectOk(secDirectoryEntries(body));
		// OTC and exchange-less rows are dropped; Cboe and Texas SE rows are kept.
		expect(entries.map((entry) => entry.symbol)).not.toContain("CYATY");
		expect(entries.find((entry) => entry.symbol === "ET")?.listing).toBe("txse");
		expect(entries).toHaveLength(11);
	});

	it("selects the latest annual figures from the company facts example", () => {
		expect(secCompanyFactsUrl("0009999991")).toBe(
			"https://data.sec.gov/api/xbrl/companyfacts/CIK0009999991.json",
		);
		const selected = expectOk(
			selectAnnualFinancials(docExampleJson("sec-edgar", "sec-edgar-companyfacts")),
		);
		const revenue = expectOk(selected.revenue);
		expect(revenue.concept).toBe("us-gaap:Revenues");
		expect(revenue.amount).toBe(2_000_000_000);
		expect(revenue.period).toEqual({
			fiscalYear: 2025,
			fiscalPeriod: "FY",
			periodStart: "2024-07-01",
			periodEnd: "2025-06-30",
		});
		expect(expectOk(selected.epsDiluted).amount).toBe(2.5);
		expect(expectOk(selected.netProfitMargin).marginRatio).toBe(0.125);
	});

	it("picks the two latest 13F-HR report periods from the submissions example", () => {
		const recent = expectOk(
			selectRecent13FFilings(docExampleJson("sec-edgar", "sec-edgar-submissions")),
		);
		expect(recent.managerName).toBe("Synthetic Capital Management LP");
		// The 13F-HR/A for 2026-03-31 is ignored; the original 13F-HR is used.
		expect(recent.filings.map((filing) => filing.accessionNumber)).toEqual([
			"0009999993-26-000004",
			"0009999993-26-000001",
		]);
	});

	it("reads the information table of the submission text example", () => {
		const text = docExampleText("sec-edgar", "sec-edgar-13f-submission-text");
		const xml = extractInformationTableXml(text);
		if (xml === null) throw new Error("no information table in the example");
		const table = expectOk(parseInformationTable(xml));
		expect(table.unreadableRowCount).toBe(0);
		expect(table.holdings).toContainEqual({
			issuerName: "ADOBE INC",
			cusip: "00724F101",
			reportedShares: 22507,
			valueAsFiled: 7423,
		});
		expect(table.holdings.find((holding) => holding.cusip === "00206R102")?.issuerName).toBe(
			"AT&T INC",
		);
	});

	it("runs the 13F source over both examples at the URLs it builds", async () => {
		const submissionText = docExampleText("sec-edgar", "sec-edgar-13f-submission-text");
		const currentUrl = secFilingTextUrl(MANAGER_CIK, "0009999993-26-000004");
		expect(currentUrl).toBe(
			"https://www.sec.gov/Archives/edgar/data/9999993/000999999326000004/0009999993-26-000004.txt",
		);
		const fetcher = createScriptedFetcher({
			[secSubmissionsUrl(MANAGER_CIK)]: {
				text: JSON.stringify(docExampleJson("sec-edgar", "sec-edgar-submissions")),
			},
			[currentUrl]: { text: submissionText },
			[secFilingTextUrl(MANAGER_CIK, "0009999993-26-000001")]: { text: submissionText },
		});
		const client = createSecClient({
			fetcher,
			clock: { nowMs: () => 0, nowIso: () => "1970-01-01T00:00:00.000Z" },
			userAgent: USER_AGENT,
			sleep: () => Promise.resolve(),
		});
		const report = expectOk(await createSec13FSource({ client }).latestHoldings("9999993"));
		expect(report.current.reportPeriodEnd).toBe("2026-06-30");
		expect(report.current.valueUnitAsFiled).toBe("usd");
		expect(report.current.holdings[0]).toEqual({
			issuerName: "ADOBE INC",
			cusip: "00724F101",
			reportedShares: 22507,
			reportedValueUsd: 7423,
		});
		expect(fetcher.calls.every((call) => call.options.userAgent === USER_AGENT)).toBe(true);
	});
});
