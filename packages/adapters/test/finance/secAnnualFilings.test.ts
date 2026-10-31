/**
 * SEC annual filings for the financial statement sync (ADR-0048 §4, §6),
 * over the synthetic filer in examples/fixtures/equity-sync/.
 */
import type { EquityFilingResult } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	createSecAnnualFilingsSource,
	indexSecCompanyFacts,
	parseSecSubmissions,
	SEC_COMPANY_FACTS_MAX_BYTES,
	SEC_SUBMISSIONS_MAX_BYTES,
	secFilingUrl,
	secNeedsCompanyFacts,
	secSyncResult,
	secValueDecimal,
} from "../../src/finance/secAnnualFilings.ts";
import { SEC_TICKER_DIRECTORY_URL } from "../../src/finance/secFinancials.ts";
import {
	equityFixtureJson,
	equityFixtureText,
	type FakeAnswer,
	fakeFetcher,
	httpError,
	movableClock,
	queryFor,
	SEC_CONCEPTS,
	secTarget,
} from "./equitySyncSupport.ts";
import { expectErr, expectOk } from "./support.ts";

const CIK = "0009999981";
const SUBMISSIONS_NAME = `sec-submissions-CIK${CIK}.synthetic.json`;
const FACTS_NAME = `sec-companyfacts-CIK${CIK}.synthetic.json`;
const SUBMISSIONS_URL = `https://data.sec.gov/submissions/CIK${CIK}.json`;
const FACTS_URL = `https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK}.json`;
const USER_AGENT = "Synthetic Research Workspace owner@synthetic-wire.org";

const submissions = expectOk(parseSecSubmissions(equityFixtureJson(SUBMISSIONS_NAME)));
const facts = expectOk(indexSecCompanyFacts(equityFixtureJson(FACTS_NAME), SEC_CONCEPTS));

const ANNUAL_ACCESSIONS = [
	"0009999981-26-000005",
	"0009999981-25-000110",
	"0009999981-24-000108",
	"0009999981-23-000106",
	"0009999981-22-000104",
	"0009999981-21-000107",
	"0009999981-20-000105",
];

function filing(filings: readonly EquityFilingResult[], accession: string): EquityFilingResult {
	const found = filings.find((entry) => entry.sourceDocumentId === accession);
	if (found === undefined) throw new Error(`no filing ${accession}`);
	return found;
}

function valuesOf(
	result: EquityFilingResult,
	concept: string,
	periodEnd: string,
	unit = "USD",
): string[] {
	return result.facts
		.filter(
			(fact) => fact.concept === concept && fact.periodEnd === periodEnd && fact.unit === unit,
		)
		.map((fact) => fact.valueDecimal);
}

const REVENUE = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";

describe("secValueDecimal", () => {
	it("keeps digits and plain decimals, skips exponent forms", () => {
		expect(secValueDecimal(391035000000)).toBe("391035000000");
		expect(secValueDecimal(-1234.5)).toBe("-1234.5");
		expect(secValueDecimal(-0)).toBe("0");
		expect(secValueDecimal(1.5e-7)).toBeNull();
		expect(secValueDecimal(1e21)).toBeNull();
		expect(secValueDecimal(Number.NaN)).toBeNull();
	});
});

describe("parseSecSubmissions", () => {
	it("reads identity and keeps only the 10-K / 10-K/A rows", () => {
		expect(submissions.name).toBe("Synthetic Devices Inc.");
		expect(submissions.fiscalYearEnd).toBe("09-30");
		expect(submissions.annualRows.map((row) => [row.accession, row.form])).toEqual([
			["0009999981-26-000005", "10-K/A"],
			["0009999981-25-000110", "10-K"],
			["0009999981-24-000108", "10-K"],
		]);
	});

	it("refuses parallel arrays of different lengths and a missing recent block", () => {
		const document = JSON.parse(equityFixtureText(SUBMISSIONS_NAME));
		document.filings.recent.form.pop();
		expect(expectErr(parseSecSubmissions(document))).toBe("PARSE_FAILED");
		expect(expectErr(parseSecSubmissions({ name: "x", filings: {} }))).toBe("PARSE_FAILED");
	});

	it("drops a fiscal year end that is not a month and day, and a blank name", () => {
		const document = JSON.parse(equityFixtureText(SUBMISSIONS_NAME));
		document.fiscalYearEnd = "1340";
		document.name = "  ";
		const parsed = expectOk(parseSecSubmissions(document));
		expect(parsed.fiscalYearEnd).toBeNull();
		expect(parsed.name).toBeNull();
	});
});

describe("indexSecCompanyFacts", () => {
	it("indexes annual-form accessions only, counting entries whose value is not exact", () => {
		expect([...facts.keys()].sort()).toEqual(["0009999981-19-000101", ...ANNUAL_ACCESSIONS].sort());
		const fy2022 = facts.get("0009999981-22-000104");
		// 12 concepts × their periods, plus the 1.5e-7 entry that becomes no fact.
		expect(fy2022?.entryCount).toBe((fy2022?.facts.length ?? 0) + 1);
		expect(facts.get("0009999981-26-000005")?.form).toBe("10-K/A");
	});

	it("ignores concepts the claim does not name and fails a document without facts", () => {
		const index = expectOk(indexSecCompanyFacts(equityFixtureJson(FACTS_NAME), [REVENUE]));
		for (const record of index.values()) {
			expect(new Set(record.facts.map((fact) => fact.concept))).toEqual(new Set([REVENUE]));
		}
		expect(expectErr(indexSecCompanyFacts({ entityName: "x" }, SEC_CONCEPTS))).toBe("PARSE_FAILED");
		expect(expectOk(indexSecCompanyFacts({ facts: { "ifrs-full": {} } }, SEC_CONCEPTS)).size).toBe(
			0,
		);
	});
});

describe("secSyncResult (first sync, full check)", () => {
	const result = secSyncResult({
		request: {
			provider: "sec",
			cik: CIK,
			knownAccessions: [],
			pendingFilings: [],
			filedSince: "2020-10-31",
			fullCheck: true,
		},
		cik: CIK,
		submissions,
		facts,
	});

	it("lists every annual filing since filedSince, newest first, with identity", () => {
		expect(result.identity).toEqual({
			sourceCompanyId: CIK,
			name: "Synthetic Devices Inc.",
			fiscalYearEnd: "09-30",
		});
		expect(result.filings.map((entry) => entry.sourceDocumentId)).toEqual(ANNUAL_ACCESSIONS);
		expect(result.more).toBe(false);
		for (const entry of result.filings) {
			expect(entry.factsStatus).toBe("extracted");
			expect(entry.accountingStandard).toBe("US-GAAP");
		}
	});

	it("takes metadata from submissions when it lists the filing, else from the facts", () => {
		const amendment = filing(result.filings, "0009999981-26-000005");
		expect(amendment).toMatchObject({
			form: "10-K/A",
			filedOn: "2026-01-15",
			submittedAt: "2026-01-15T16:12:09.000Z",
			periodEnd: "2025-09-30",
			periodStart: null,
			amendsSourceDocumentId: null,
			sourceUrl:
				"https://www.sec.gov/Archives/edgar/data/9999981/000999998126000005/synd-20250930a.htm",
		});
		expect(filing(result.filings, "0009999981-22-000104")).toMatchObject({
			form: "10-K",
			filedOn: "2022-11-04",
			submittedAt: null,
			periodEnd: "2022-09-30",
			sourceUrl: "https://www.sec.gov/Archives/edgar/data/9999981/000999998122000104/",
		});
	});

	it("drops interim durations and instants that are not a year end of the filing", () => {
		const fy2025 = filing(result.filings, "0009999981-25-000110");
		for (const fact of fy2025.facts) {
			if (fact.periodType === "duration") expect(fact.periodStart?.endsWith("-10-01")).toBe(true);
			else expect(["2024-09-30", "2025-09-30"]).toContain(fact.periodEnd);
		}
		expect(valuesOf(fy2025, REVENUE, "2023-09-30")).toEqual(["256200000000"]);
		expect(valuesOf(fy2025, "us-gaap:Assets", "2025-03-31")).toEqual([]);
		// Equity at the start of the oldest year (2022-09-30) is not a year end of this filing,
		// and the equity statement's 2023-09-30 balance is not one of its balance-sheet columns.
		expect(valuesOf(fy2025, "us-gaap:StockholdersEquity", "2022-09-30")).toEqual([]);
		expect(valuesOf(fy2025, "us-gaap:StockholdersEquity", "2023-09-30")).toEqual([]);
		expect(valuesOf(fy2025, "us-gaap:StockholdersEquity", "2024-09-30")).toHaveLength(1);
	});

	it("keeps a fact once per filing that reported it, and a restatement as its own filing's fact", () => {
		const fy2023 = filing(result.filings, "0009999981-23-000106");
		const fy2024 = filing(result.filings, "0009999981-24-000108");
		const fy2025 = filing(result.filings, "0009999981-25-000110");
		expect(valuesOf(fy2023, REVENUE, "2023-09-30")).toEqual(["255000000000"]);
		expect(valuesOf(fy2024, REVENUE, "2023-09-30")).toEqual(["256200000000"]);
		expect(valuesOf(fy2025, REVENUE, "2023-09-30")).toEqual(["256200000000"]);
		const amendment = filing(result.filings, "0009999981-26-000005");
		expect(valuesOf(amendment, "us-gaap:NetIncomeLoss", "2025-09-30")).toEqual(["56200000000"]);
		expect(valuesOf(fy2025, "us-gaap:NetIncomeLoss", "2025-09-30")).toEqual(["57000000000"]);
	});

	it("removes an exact repeat, skips exponent values and keeps a second currency apart", () => {
		const fy2024 = filing(result.filings, "0009999981-24-000108");
		expect(valuesOf(fy2024, "us-gaap:Assets", "2024-09-30")).toEqual(["440000000000"]);
		const fy2022 = filing(result.filings, "0009999981-22-000104");
		expect(
			valuesOf(fy2022, "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment", "2022-09-30"),
		).toEqual(["9600000000"]);
		const fy2021 = filing(result.filings, "0009999981-21-000107");
		expect(valuesOf(fy2021, "us-gaap:GrossProfit", "2019-09-30", "EUR")).toEqual(["70000000000"]);
		expect(valuesOf(fy2021, "us-gaap:GrossProfit", "2019-09-30")).toEqual(["81900000000"]);
	});
});

describe("secSyncResult (incremental)", () => {
	const base = {
		provider: "sec" as const,
		cik: CIK,
		knownAccessions: ANNUAL_ACCESSIONS,
		pendingFilings: [],
		filedSince: "2020-10-31",
		fullCheck: false,
	};

	it("needs no company facts when nothing is new or pending", () => {
		expect(secNeedsCompanyFacts(base, submissions)).toBe(false);
		expect(secSyncResult({ request: base, cik: CIK, submissions, facts: null }).filings).toEqual(
			[],
		);
	});

	it("reads only the new filing and echoes a pending filing's stored metadata", () => {
		const pending = {
			sourceDocumentId: "0009999981-25-000110",
			form: "10-K" as const,
			filedOn: "2025-11-05",
			submittedAt: null,
			periodStart: null,
			periodEnd: "2025-09-30",
			amendsSourceDocumentId: null,
			sourceUrl: "https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/",
		};
		const request = {
			...base,
			knownAccessions: ANNUAL_ACCESSIONS.filter((a) => a !== "0009999981-26-000005"),
			pendingFilings: [pending],
		};
		expect(secNeedsCompanyFacts(request, submissions)).toBe(true);
		const result = secSyncResult({ request, cik: CIK, submissions, facts });
		expect(result.filings.map((entry) => entry.sourceDocumentId)).toEqual([
			"0009999981-26-000005",
			"0009999981-25-000110",
		]);
		const echoed = filing(result.filings, "0009999981-25-000110");
		expect({ ...echoed, facts: [], factsStatus: "x", accountingStandard: null }).toEqual({
			...pending,
			facts: [],
			factsStatus: "x",
			accountingStandard: null,
		});
		expect(echoed.factsStatus).toBe("extracted");
	});

	it("reports a filing company facts do not list yet as not available", () => {
		const request = { ...base, knownAccessions: [] };
		const result = secSyncResult({ request, cik: CIK, submissions, facts: new Map() });
		expect(result.filings.map((entry) => [entry.sourceDocumentId, entry.factsStatus])).toEqual([
			["0009999981-26-000005", "not-available"],
			["0009999981-25-000110", "not-available"],
			["0009999981-24-000108", "not-available"],
		]);
		for (const entry of result.filings) {
			expect(entry.facts).toEqual([]);
			expect(entry.accountingStandard).toBeNull();
		}
	});

	it("cuts whole filings, newest first, and says more", () => {
		const request = { ...base, knownAccessions: [], fullCheck: true };
		const byCount = secSyncResult(
			{ request, cik: CIK, submissions, facts },
			{ maxFilings: 2, maxFacts: 3000 },
		);
		expect(byCount.filings.map((entry) => entry.sourceDocumentId)).toEqual(
			ANNUAL_ACCESSIONS.slice(0, 2),
		);
		expect(byCount.more).toBe(true);
		const byFacts = secSyncResult(
			{ request, cik: CIK, submissions, facts },
			{ maxFilings: 60, maxFacts: 70 },
		);
		expect(byFacts.filings).toHaveLength(2);
		expect(byFacts.more).toBe(true);
		const tooBig = secSyncResult(
			{ request, cik: CIK, submissions, facts },
			{ maxFilings: 60, maxFacts: 10 },
		);
		expect(tooBig.filings).toHaveLength(7);
		expect(tooBig.filings.every((entry) => entry.factsStatus === "not-available")).toBe(true);
		expect(tooBig.more).toBe(false);
	});
});

describe("secSyncResult (a 10-K's equity statement reaching back three years)", () => {
	const EQUITY_CIK = "0009999982";
	const FY2023 = "0009999982-24-000010";
	const FY2024 = "0009999982-25-000010";
	const PART_III = "0009999982-25-000031";
	const TOTAL = "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest";
	const PARENT = "us-gaap:StockholdersEquity";
	const equitySubmissions = expectOk(
		parseSecSubmissions(equityFixtureJson(`sec-submissions-CIK${EQUITY_CIK}.synthetic.json`)),
	);
	const equityFacts = expectOk(
		indexSecCompanyFacts(
			equityFixtureJson(`sec-companyfacts-CIK${EQUITY_CIK}.synthetic.json`),
			SEC_CONCEPTS,
		),
	);
	const request = {
		provider: "sec" as const,
		cik: EQUITY_CIK,
		knownAccessions: [],
		pendingFilings: [],
		filedSince: "2020-01-01",
		fullCheck: true,
	};
	const result = secSyncResult({
		request,
		cik: EQUITY_CIK,
		submissions: equitySubmissions,
		facts: equityFacts,
	});

	it("keeps instants only at each 10-K's two balance-sheet year ends", () => {
		const fy2024 = filing(result.filings, FY2024);
		const fy2023 = filing(result.filings, FY2023);
		const instantEnds = (entry: EquityFilingResult) =>
			[
				...new Set(entry.facts.filter((f) => f.periodType === "instant").map((f) => f.periodEnd)),
			].sort();
		expect(instantEnds(fy2024)).toEqual(["2023-12-31", "2024-12-31"]);
		expect(instantEnds(fy2023)).toEqual(["2022-12-31", "2023-12-31"]);
		// FY2022 equity comes only from the FY2023 10-K's balance sheet, both concepts as filed.
		expect(valuesOf(fy2024, PARENT, "2022-12-31")).toEqual([]);
		expect(valuesOf(fy2024, TOTAL, "2022-12-31")).toEqual([]);
		expect(valuesOf(fy2023, TOTAL, "2022-12-31")).toHaveLength(1);
		// Three income-statement years stay.
		expect(fy2024.facts.filter((f) => f.periodType === "duration").map((f) => f.periodEnd)).toEqual(
			["2022-12-31", "2023-12-31", "2024-12-31"],
		);
	});

	it("never stores a 10-K/A without a report date or facts, and does not read facts for it alone", () => {
		expect(
			equitySubmissions.annualRows.map((row) => [row.accession, row.reportDate]),
		).toContainEqual([PART_III, ""]);
		expect(result.filings.map((f) => f.sourceDocumentId)).toEqual([FY2024, FY2023]);
		const incremental = { ...request, fullCheck: false, knownAccessions: [FY2023, FY2024] };
		expect(secNeedsCompanyFacts(incremental, equitySubmissions)).toBe(false);
		// A new 10-K with a report date still triggers the read.
		expect(
			secNeedsCompanyFacts({ ...incremental, knownAccessions: [FY2023] }, equitySubmissions),
		).toBe(true);
		expect(
			secSyncResult({
				request: incremental,
				cik: EQUITY_CIK,
				submissions: equitySubmissions,
				facts: equityFacts,
			}).filings,
		).toEqual([]);
	});
});

describe("secFilingUrl", () => {
	it("links a plain primary document, else the folder", () => {
		expect(secFilingUrl(CIK, "0009999981-24-000108", "a b.htm")).toBe(
			"https://www.sec.gov/Archives/edgar/data/9999981/000999998124000108/",
		);
		expect(secFilingUrl(CIK, "0009999981-24-000108", "xsl/form.xml")).toBe(
			"https://www.sec.gov/Archives/edgar/data/9999981/000999998124000108/",
		);
	});
});

describe("createSecAnnualFilingsSource", () => {
	const pages = (overrides: [string, FakeAnswer][] = []) =>
		new Map<string, FakeAnswer>([
			[SUBMISSIONS_URL, { text: equityFixtureText(SUBMISSIONS_NAME) }],
			[FACTS_URL, { text: equityFixtureText(FACTS_NAME) }],
			[
				SEC_TICKER_DIRECTORY_URL,
				{
					text: JSON.stringify({
						fields: ["cik", "name", "ticker", "exchange"],
						data: [[9999981, "Synthetic Devices Inc.", "SYND", "Nasdaq"]],
					}),
				},
			],
			...overrides,
		]);
	const source = (answers: Map<string, FakeAnswer>, userAgent: string | null = USER_AGENT) => {
		const fake = fakeFetcher(answers);
		const time = movableClock();
		return {
			...fake,
			source: createSecAnnualFilingsSource({
				fetcher: fake.fetcher,
				clock: time.clock,
				userAgent,
				sleep: async () => {},
			}),
		};
	};

	it("fails unconfigured without a request", async () => {
		const { source: sec, requests } = source(pages(), null);
		const { query, grants } = queryFor(secTarget());
		const failure = expectErr(await sec.sync(query));
		expect(failure).toEqual({
			code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			upstreamStatus: null,
			requests: 0,
		});
		expect(requests).toEqual([]);
		expect(grants()).toBe(0);
	});

	it("resolves the CIK once, then reads submissions and company facts", async () => {
		const { source: sec, requests } = source(pages());
		const first = queryFor(secTarget({ cik: null, fullCheck: true }));
		const data = expectOk(await sec.sync(first.query));
		expect(data.identity?.sourceCompanyId).toBe(CIK);
		expect(data.filings).toHaveLength(7);
		expect(data.requests).toBe(3);
		expect(first.grants()).toBe(3);
		expect(requests.map((request) => [request.url, request.maxBytes, request.userAgent])).toEqual([
			[SEC_TICKER_DIRECTORY_URL, 8_000_000, USER_AGENT],
			[SUBMISSIONS_URL, SEC_SUBMISSIONS_MAX_BYTES, USER_AGENT],
			[FACTS_URL, SEC_COMPANY_FACTS_MAX_BYTES, USER_AGENT],
		]);
		// The ticker list is cached: a second unresolved company costs no list request.
		const second = queryFor(secTarget({ cik: null, knownAccessions: ANNUAL_ACCESSIONS }));
		expect(expectOk(await sec.sync(second.query)).requests).toBe(1);
	});

	it("reads only submissions when nothing is new", async () => {
		const { source: sec, requests } = source(pages());
		const { query } = queryFor(secTarget({ knownAccessions: ANNUAL_ACCESSIONS }));
		const data = expectOk(await sec.sync(query));
		expect(data).toMatchObject({ filings: [], more: false, scannedDays: [], requests: 1 });
		expect(requests.map((request) => request.url)).toEqual([SUBMISSIONS_URL]);
	});

	it("fails a ticker SEC does not list", async () => {
		const { source: sec } = source(pages());
		const { query } = queryFor(secTarget({ cik: null }, "NOPE"));
		expect(expectErr(await sec.sync(query))).toEqual({
			code: "FINANCIAL_COMPANY_NOT_FOUND",
			upstreamStatus: null,
			requests: 1,
		});
	});

	it.each([
		[401, "FINANCIAL_ACCESS_DENIED"],
		[403, "FINANCIAL_ACCESS_DENIED"],
		[404, "FINANCIAL_SOURCE_FAILED"],
		[429, "FINANCIAL_RATE_LIMITED"],
		[500, "FINANCIAL_SOURCE_FAILED"],
		[503, "FINANCIAL_SOURCE_FAILED"],
	])("maps submissions HTTP %i to %s with the status", async (status, code) => {
		const { source: sec } = source(pages([[SUBMISSIONS_URL, httpError(status)]]));
		const { query } = queryFor(secTarget());
		expect(expectErr(await sec.sync(query))).toEqual({ code, upstreamStatus: status, requests: 1 });
	});

	it("treats missing company facts as not available yet", async () => {
		const { source: sec } = source(pages([[FACTS_URL, httpError(404)]]));
		const { query } = queryFor(secTarget());
		const data = expectOk(await sec.sync(query));
		expect(data.filings.map((entry) => entry.factsStatus)).toEqual([
			"not-available",
			"not-available",
			"not-available",
		]);
	});

	it("fails malformed JSON as a parse failure and a timeout as a source failure", async () => {
		const malformed = source(pages([[FACTS_URL, { text: "{not json" }]]));
		expect(expectErr(await malformed.source.sync(queryFor(secTarget()).query)).code).toBe(
			"FINANCIAL_PARSE_FAILED",
		);
		const timeout = source(
			pages([[SUBMISSIONS_URL, { error: { code: "TIMEOUT", detail: "timed out" } }]]),
		);
		expect(expectErr(await timeout.source.sync(queryFor(secTarget()).query))).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: null,
			requests: 1,
		});
	});

	it("sends nothing more once the pacing gate says stop", async () => {
		const { source: sec, requests } = source(pages());
		const { query } = queryFor(secTarget(), [false]);
		expect(expectErr(await sec.sync(query)).code).toBe("FINANCIAL_SOURCE_FAILED");
		expect(requests).toEqual([]);
	});
});
