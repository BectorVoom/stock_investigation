import { describe, expect, it } from "vitest";
import {
	compareReportedPositions,
	createSec13FSource,
	extractInformationTableXml,
	parseInformationTable,
	secFilingTextUrl,
	secSubmissionsUrl,
	selectRecent13FFilings,
} from "../../src/finance/sec13f.ts";
import { createSecClient } from "../../src/finance/secClient.ts";
import {
	createScriptedFetcher,
	fixedClock,
	fixtureText,
	SEC_USER_AGENT,
} from "../tools/support.ts";

const SUBMISSIONS = fixtureText("sec/submissions-CIK0009999993.synthetic.json");
const FILING_Q1 = fixtureText("sec/13f-0009999993-26-000001.synthetic.txt");
const FILING_Q2 = fixtureText("sec/13f-0009999993-26-000004.synthetic.txt");

const SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0009999993.json";
const Q1_URL =
	"https://www.sec.gov/Archives/edgar/data/9999993/000999999326000001/0009999993-26-000001.txt";
const Q2_URL =
	"https://www.sec.gov/Archives/edgar/data/9999993/000999999326000004/0009999993-26-000004.txt";

function sourceWith(pages: Parameters<typeof createScriptedFetcher>[0]) {
	const fetcher = createScriptedFetcher(pages);
	const client = createSecClient({
		fetcher,
		clock: fixedClock(),
		userAgent: SEC_USER_AGENT,
		sleep: async () => {},
	});
	return { fetcher, source: createSec13FSource({ client }) };
}

function submissionsWith(rows: readonly (readonly [string, string, string, string])[]) {
	return JSON.stringify({
		name: "Synthetic Old Manager LLC",
		filings: {
			recent: {
				accessionNumber: rows.map((row) => row[0]),
				filingDate: rows.map((row) => row[1]),
				reportDate: rows.map((row) => row[2]),
				form: rows.map((row) => row[3]),
			},
		},
	});
}

function submissionText(infoTableXml: string): string {
	return `<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>13F-HR\n<TEXT>\n<XML>\n<edgarSubmission/>\n</XML>\n</TEXT>\n</DOCUMENT>\n<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<TEXT>\n<XML>\n${infoTableXml}\n</XML>\n</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>`;
}

function row(
	name: string,
	cusip: string,
	value: number | string,
	shares: number | string,
	extra = "",
): string {
	return `<infoTable><nameOfIssuer>${name}</nameOfIssuer><cusip>${cusip}</cusip><value>${value}</value><shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>${extra}</infoTable>`;
}

describe("13F: URL construction", () => {
	it("builds the documented EDGAR addresses", () => {
		expect(secSubmissionsUrl("0009999993")).toBe(SUBMISSIONS_URL);
		expect(secFilingTextUrl("0009999993", "0009999993-26-000004")).toBe(Q2_URL);
	});
});

describe("13F: choosing filings", () => {
	it("takes the two latest report periods filed as 13F-HR, ignoring amendments and other forms", () => {
		const selected = selectRecent13FFilings(JSON.parse(SUBMISSIONS));
		expect(selected).toEqual({
			ok: true,
			value: {
				managerName: "Synthetic Capital Management LP",
				filings: [
					{
						accessionNumber: "0009999993-26-000004",
						reportPeriodEnd: "2026-06-30",
						filedAt: "2026-08-14",
					},
					{
						accessionNumber: "0009999993-26-000001",
						reportPeriodEnd: "2026-03-31",
						filedAt: "2026-05-15",
					},
				],
			},
		});
	});

	it("orders by report period, not by position in the list, and keeps one filing per period", () => {
		const selected = selectRecent13FFilings(
			JSON.parse(
				submissionsWith([
					["0000000001-25-000001", "2025-02-14", "2024-12-31", "13F-HR"],
					["0000000001-25-000009", "2025-11-14", "2025-09-30", "13F-HR"],
					["0000000001-25-000008", "2025-11-10", "2025-09-30", "13F-HR"],
					["0000000001-25-000005", "2025-08-14", "2025-06-30", "13F-HR"],
					["bad-accession", "2026-02-14", "2025-12-31", "13F-HR"],
					["0000000001-26-000002", "not-a-date", "2025-12-31", "13F-HR"],
					["0000000001-26-000003", "2026-02-14", "2025-12-31", "13F-NT"],
				]),
			),
		);
		expect(selected.ok && selected.value.filings.map((filing) => filing.accessionNumber)).toEqual([
			"0000000001-25-000009",
			"0000000001-25-000005",
		]);
	});

	it("rejects a document that is not a submissions index", () => {
		for (const value of [
			null,
			{},
			{ name: "x", filings: {} },
			{ name: "", filings: { recent: {} } },
		]) {
			expect(selectRecent13FFilings(value)).toMatchObject({
				ok: false,
				error: { code: "UNEXPECTED_RESPONSE" },
			});
		}
	});
});

describe("13F: information table", () => {
	it("extracts the information table document from a complete submission", () => {
		const xml = extractInformationTableXml(FILING_Q1);
		expect(xml?.startsWith("<?xml")).toBe(true);
		expect(xml).toContain("<informationTable");
		expect(xml).not.toContain("edgarSubmission");
		expect(
			extractInformationTableXml(
				"<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>13F-HR\n<TEXT>x</TEXT>\n</DOCUMENT>",
			),
		).toBeNull();
		expect(extractInformationTableXml("")).toBeNull();
	});

	it("sums share rows per CUSIP and leaves out option rows (hand-computed)", () => {
		const table = parseInformationTable(extractInformationTableXml(FILING_Q1) ?? "");
		expect(table).toEqual({
			ok: true,
			value: {
				holdings: [
					{
						issuerName: "SYNTHETIC ALPHA CORP",
						cusip: "111111AA1",
						reportedShares: 1000,
						valueAsFiled: 50000,
					},
					// Two rows: 1,500 + 500 shares, 30,000 + 10,000 value.
					{
						issuerName: "SYNTHETIC BETA INC",
						cusip: "222222BB2",
						reportedShares: 2000,
						valueAsFiled: 40000,
					},
					{
						issuerName: "SYNTHETIC GAMMA LTD",
						cusip: "333333CC3",
						reportedShares: 700,
						valueAsFiled: 7000,
					},
					{
						issuerName: "SYNTHETIC DELTA CO",
						cusip: "444444DD4",
						reportedShares: 300,
						valueAsFiled: 3000,
					},
				],
				// The EPSILON call-option row.
				excludedRowCount: 1,
				unreadableRowCount: 0,
				incompleteCusips: [],
			},
		});
	});

	it("handles namespace prefixes, lower-case CUSIPs and principal amounts", () => {
		const table = parseInformationTable(extractInformationTableXml(FILING_Q2) ?? "");
		if (!table.ok) throw new Error("expected a table");
		expect(table.value.holdings.map((holding) => [holding.cusip, holding.reportedShares])).toEqual([
			["222222BB2", 2500],
			["111111AA1", 1000],
			["333333CC3", 400],
			["666666FF6", 900],
			// Only the 50 plain shares; the 200-share put row is excluded.
			["555555EE5", 50],
		]);
		// One PRN (notes) row and one put row.
		expect(table.value.excludedRowCount).toBe(2);
		expect(table.value.unreadableRowCount).toBe(0);
		expect(table.value.incompleteCusips).toEqual([]);
	});

	it("rejects XML that is not an information table, including one with external entities", () => {
		for (const xml of [
			"",
			"<notATable/>",
			"<informationTable><infoTable>",
			'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><informationTable><infoTable><nameOfIssuer>&e;</nameOfIssuer></infoTable></informationTable>',
		]) {
			expect(parseInformationTable(xml)).toMatchObject({
				ok: false,
				error: { code: "UNEXPECTED_RESPONSE" },
			});
		}
	});
});

describe("13F: quarter-over-quarter comparison", () => {
	it("retrieves both filings and classifies each position (hand-written expectations)", async () => {
		const { fetcher, source } = sourceWith({
			[SUBMISSIONS_URL]: { text: SUBMISSIONS },
			[Q2_URL]: { text: FILING_Q2 },
			[Q1_URL]: { text: FILING_Q1 },
		});
		const result = await source.latestHoldings("9999993");
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(fetcher.urls()).toEqual([SUBMISSIONS_URL, Q2_URL, Q1_URL]);
		const report = result.value;
		expect(report.manager).toEqual({ cik: "0009999993", name: "Synthetic Capital Management LP" });
		expect(report.current).toMatchObject({
			form: "13F-HR",
			accessionNumber: "0009999993-26-000004",
			reportPeriodEnd: "2026-06-30",
			filedAt: "2026-08-14",
			filingUrl: Q2_URL,
			valueUnitAsFiled: "usd",
		});
		expect(report.previous).toMatchObject({
			reportPeriodEnd: "2026-03-31",
			filedAt: "2026-05-15",
			filingUrl: Q1_URL,
		});
		// Largest reported value first; values are whole dollars (filed after 2023-01-03).
		expect(report.current.holdings).toEqual([
			{
				issuerName: "SYNTHETIC BETA INC",
				cusip: "222222BB2",
				reportedShares: 2500,
				reportedValueUsd: 55000,
			},
			{
				issuerName: "SYNTHETIC ALPHA CORP",
				cusip: "111111AA1",
				reportedShares: 1000,
				reportedValueUsd: 52000,
			},
			{
				issuerName: "SYNTHETIC ZETA SA",
				cusip: "666666FF6",
				reportedShares: 900,
				reportedValueUsd: 9000,
			},
			{
				issuerName: "SYNTHETIC GAMMA LTD",
				cusip: "333333CC3",
				reportedShares: 400,
				reportedValueUsd: 4400,
			},
			{
				issuerName: "SYNTHETIC EPSILON PLC",
				cusip: "555555EE5",
				reportedShares: 50,
				reportedValueUsd: 500,
			},
		]);

		const byCusip = new Map(report.changes.map((change) => [change.cusip, change]));
		expect(byCusip.size).toBe(6);
		// ALPHA: 1,000 -> 1,000
		expect(byCusip.get("111111AA1")).toMatchObject({
			previousReportedShares: 1000,
			currentReportedShares: 1000,
			change: "unchanged-reported-position",
		});
		// BETA: 2,000 -> 2,500
		expect(byCusip.get("222222BB2")).toMatchObject({
			previousReportedShares: 2000,
			currentReportedShares: 2500,
			change: "increase-in-reported-position",
		});
		// GAMMA: 700 -> 400
		expect(byCusip.get("333333CC3")).toMatchObject({
			previousReportedShares: 700,
			currentReportedShares: 400,
			change: "decrease-in-reported-position",
		});
		// DELTA: 300 -> absent
		expect(byCusip.get("444444DD4")).toMatchObject({
			issuerName: "SYNTHETIC DELTA CO",
			previousReportedShares: 300,
			currentReportedShares: null,
			change: "no-longer-reported",
		});
		// ZETA: absent -> 900
		expect(byCusip.get("666666FF6")).toMatchObject({
			previousReportedShares: null,
			currentReportedShares: 900,
			change: "newly-reported-holding",
		});
		// EPSILON: only a call option before (not a share holding) -> 50 shares
		expect(byCusip.get("555555EE5")).toMatchObject({
			previousReportedShares: null,
			currentReportedShares: 50,
			change: "newly-reported-holding",
		});
		// The notes position (PRN) is not a share holding in either quarter.
		expect(byCusip.has("777777GG7")).toBe(false);
	});

	it("converts values filed in thousands before 2023-01-03, and not from that date on", async () => {
		const table = `<informationTable>${row("SYNTHETIC ALPHA CORP", "111111AA1", 1234, 10)}</informationTable>`;
		const beforeUrl = secFilingTextUrl("0009999993", "0009999993-22-000007");
		const onUrl = secFilingTextUrl("0009999993", "0009999993-23-000001");
		const { source } = sourceWith({
			[SUBMISSIONS_URL]: {
				text: submissionsWith([
					// Filed on the first day of the amended form, for the quarter ended 2022-12-31.
					["0009999993-23-000001", "2023-01-03", "2022-12-31", "13F-HR"],
					["0009999993-22-000007", "2023-01-02", "2022-09-30", "13F-HR"],
				]),
			},
			[beforeUrl]: { text: submissionText(table) },
			[onUrl]: { text: submissionText(table) },
		});
		const result = await source.latestHoldings("0009999993");
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.current).toMatchObject({
			filedAt: "2023-01-03",
			valueUnitAsFiled: "usd",
			holdings: [{ reportedValueUsd: 1234 }],
		});
		// 1,234 thousand dollars.
		expect(result.value.previous).toMatchObject({
			filedAt: "2023-01-02",
			valueUnitAsFiled: "usd-thousands",
			holdings: [{ reportedValueUsd: 1_234_000 }],
		});
	});

	it("reports a single filing without inventing a comparison", async () => {
		const only = secFilingTextUrl("0009999993", "0009999993-26-000004");
		const { source } = sourceWith({
			[SUBMISSIONS_URL]: {
				text: submissionsWith([["0009999993-26-000004", "2026-08-14", "2026-06-30", "13F-HR"]]),
			},
			[only]: { text: FILING_Q2 },
		});
		const result = await source.latestHoldings("9999993");
		expect(result).toMatchObject({ ok: true, value: { previous: null, changes: [] } });
		expect(result.ok && result.value.comparisonUnavailableReason).toContain(
			"no previous 13F-HR filing",
		);
	});

	it("fails with typed errors and stops early", async () => {
		const invalid = sourceWith({});
		expect(await invalid.source.latestHoldings("abc")).toMatchObject({
			ok: false,
			error: { code: "INVALID_IDENTIFIER" },
		});
		expect(invalid.fetcher.calls).toHaveLength(0);

		const none = sourceWith({
			[SUBMISSIONS_URL]: {
				text: submissionsWith([["0009999993-26-000009", "2026-01-05", "", "SC 13G"]]),
			},
		});
		expect(await none.source.latestHoldings("9999993")).toMatchObject({
			ok: false,
			error: { code: "NO_DATA" },
		});
		expect(none.fetcher.urls()).toEqual([SUBMISSIONS_URL]);

		const noTable = sourceWith({
			[SUBMISSIONS_URL]: { text: SUBMISSIONS },
			[Q2_URL]: {
				text: "<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>13F-HR\n<TEXT>cover only</TEXT>\n</DOCUMENT>",
			},
		});
		expect(await noTable.source.latestHoldings("9999993")).toMatchObject({
			ok: false,
			error: { code: "UNEXPECTED_RESPONSE" },
		});

		const tooLarge = sourceWith({
			[SUBMISSIONS_URL]: { text: SUBMISSIONS },
			[Q2_URL]: { error: { code: "RESPONSE_TOO_LARGE", detail: "body exceeds 16000000 bytes" } },
		});
		expect(await tooLarge.source.latestHoldings("9999993")).toMatchObject({
			ok: false,
			error: { code: "RESPONSE_TOO_LARGE", retryable: false },
		});
	});
});

describe("13F: a filing with an unreadable row is incomplete (finding 16)", () => {
	const ALPHA = "111111AA1";
	const BETA = "222222BB2";
	const previousTable = `<informationTable>${row("SYNTHETIC ALPHA CORP", ALPHA, 3000, 300)}${row("SYNTHETIC BETA INC", BETA, 100, 10)}</informationTable>`;
	const cleanCurrentTable = `<informationTable>${row("SYNTHETIC ALPHA CORP", ALPHA, 3100, 310)}${row("SYNTHETIC BETA INC", BETA, 120, 12)}</informationTable>`;
	// ALPHA is still held, but its share count cannot be read.
	const brokenCurrentTable = `<informationTable>${row("SYNTHETIC ALPHA CORP", ALPHA, 3100, "N/A")}${row("SYNTHETIC BETA INC", BETA, 120, 12)}</informationTable>`;

	function comparing(currentTable: string, earlierTable: string) {
		return sourceWith({
			[SUBMISSIONS_URL]: { text: SUBMISSIONS },
			[Q2_URL]: { text: submissionText(currentTable) },
			[Q1_URL]: { text: submissionText(earlierTable) },
		}).source.latestHoldings("9999993");
	}

	it("omits a CUSIP with an unreadable row instead of reporting an understated total", () => {
		const table = parseInformationTable(
			`<informationTable>${row("SYNTHETIC ALPHA CORP", ALPHA, 1000, 100)}${row("SYNTHETIC ALPHA CORP", ALPHA, 500, "fifty")}${row("SYNTHETIC BETA INC", BETA, 100, 10)}${row("NO CUSIP AT ALL", "BAD", 1, 1)}</informationTable>`,
		);
		expect(table).toEqual({
			ok: true,
			value: {
				// ALPHA's readable row alone (100 shares) would understate the position.
				holdings: [
					{ issuerName: "SYNTHETIC BETA INC", cusip: BETA, reportedShares: 10, valueAsFiled: 100 },
				],
				excludedRowCount: 0,
				unreadableRowCount: 2,
				incompleteCusips: [ALPHA],
			},
		});
	});

	it("still treats an option or principal row as excluded, whatever its amount says", () => {
		const table = parseInformationTable(
			`<informationTable>${row("SYNTHETIC ALPHA CORP", ALPHA, 1000, 100)}${row("SYNTHETIC ALPHA CORP", ALPHA, 5, "n/a", "<putCall>Put</putCall>")}</informationTable>`,
		);
		expect(table).toMatchObject({
			ok: true,
			value: {
				holdings: [{ cusip: ALPHA, reportedShares: 100 }],
				excludedRowCount: 1,
				unreadableRowCount: 0,
				incompleteCusips: [],
			},
		});
	});

	it("classifies nothing when the current filing has an unreadable row", async () => {
		const result = await comparing(brokenCurrentTable, previousTable);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		// Before the fix ALPHA came out as "no-longer-reported".
		expect(result.value.changes).toEqual([]);
		expect(result.value.comparisonUnavailableReason).toContain("could not be read");
		expect(result.value.current.unreadableRowCount).toBe(1);
		expect(result.value.current.incompleteCusips).toEqual([ALPHA]);
		expect(result.value.current.holdings.map((holding) => holding.cusip)).toEqual([BETA]);
	});

	it("classifies nothing when the previous filing has an unreadable row", async () => {
		const brokenPrevious = `<informationTable>${row("SYNTHETIC ALPHA CORP", ALPHA, "?", 300)}${row("SYNTHETIC BETA INC", BETA, 100, 10)}</informationTable>`;
		const result = await comparing(cleanCurrentTable, brokenPrevious);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		// Before the fix ALPHA came out as "newly-reported-holding".
		expect(result.value.changes).toEqual([]);
		expect(result.value.comparisonUnavailableReason).toContain("could not be read");
		expect(result.value.previous?.incompleteCusips).toEqual([ALPHA]);
	});

	it("classifies normally when every row of both filings was read", async () => {
		const result = await comparing(cleanCurrentTable, previousTable);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.comparisonUnavailableReason).toBeNull();
		expect(result.value.changes.map((change) => [change.cusip, change.change])).toEqual([
			[ALPHA, "increase-in-reported-position"],
			[BETA, "increase-in-reported-position"],
		]);
	});
});

describe("13F: comparison of arbitrary holdings", () => {
	it("classifies only through reported share counts", () => {
		const holding = (cusip: string, reportedShares: number) => ({
			issuerName: `Issuer ${cusip}`,
			cusip,
			reportedShares,
			reportedValueUsd: 1,
		});
		const changes = compareReportedPositions(
			[holding("AAAAAAAA1", 10), holding("BBBBBBBB2", 10), holding("CCCCCCCC3", 10)],
			[holding("BBBBBBBB2", 11), holding("CCCCCCCC3", 9), holding("DDDDDDDD4", 1)],
		);
		expect(Object.fromEntries(changes.map((change) => [change.cusip, change.change]))).toEqual({
			AAAAAAAA1: "no-longer-reported",
			BBBBBBBB2: "increase-in-reported-position",
			CCCCCCCC3: "decrease-in-reported-position",
			DDDDDDDD4: "newly-reported-holding",
		});
	});
});
