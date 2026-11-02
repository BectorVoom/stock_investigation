/**
 * Synthetic, format-faithful inputs for the financial statement sync
 * (ADR-0048, ADR-0053): an SEC filer (submissions + company facts JSON, its
 * newest 10-K's primary document) and a foreign private issuer filing 20-F
 * under IFRS (ADR-0058 §5, with its 20-F's primary document), plus the two
 * E2E completion files the fixture financial source serves to both
 * runners' E2E harnesses: SEC's from these inputs, J-Quants' (ADR-0059)
 * from a live earnings-summary answer captured on 2026-11-02
 * (`packages/adapters/test/finance/fixtures/jquants-fins-summary-code-7974.json`).
 *
 *     node scripts/vectors/finance/equitySyncFixtures.ts    # rewrite examples/fixtures/equity-sync/
 *
 * Every file is built here from a few yearly formulas, so the set is
 * reproducible and consistent: the E2E completions are what the real
 * TypeScript extraction (`secSyncResult`, `jquantsSummariesToSync`) makes
 * of these inputs. The SEC companies, codes and figures are invented; the
 * shapes follow SEC's published formats. Tests compare the committed files
 * with a fresh build.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { equityConceptsOfProvider } from "@research/domain";
import { jquantsSummariesToSync } from "../../../packages/adapters/src/finance/jquantsFinancials.ts";
import {
	indexSecCompanyFacts,
	parseSecSubmissions,
	secAnnualReportDescription,
	secAnnualReportSource,
	secNewestAnnualReport,
	secSyncResult,
} from "../../../packages/adapters/src/finance/secAnnualFilings.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const EQUITY_SYNC_FIXTURE_DIR = join(
	here,
	"..",
	"..",
	"..",
	"examples",
	"fixtures",
	"equity-sync",
);

/* ---------- JSON layout: one line per flat object (an entry, a row) ---------- */

function isFlat(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((item) => typeof item !== "object" || item === null)
	);
}

/** Readable, deterministic JSON: flat objects and arrays of scalars on one line. */
export function fixtureJson(value: unknown, indent = ""): string {
	if (Array.isArray(value)) {
		if (value.every((item) => typeof item !== "object" || item === null))
			return JSON.stringify(value);
		const inner = `${indent}\t`;
		return `[\n${value.map((item) => `${inner}${fixtureJson(item, inner)}`).join(",\n")}\n${indent}]`;
	}
	if (typeof value === "object" && value !== null) {
		if (isFlat(value)) {
			const fields = Object.entries(value).map(
				([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`,
			);
			return `{ ${fields.join(", ")} }`;
		}
		const inner = `${indent}\t`;
		const entries = Object.entries(value).map(
			([key, item]) => `${inner}${JSON.stringify(key)}: ${fixtureJson(item, inner)}`,
		);
		return `{\n${entries.join(",\n")}\n${indent}}`;
	}
	return JSON.stringify(value);
}

/* ---------- SEC: Synthetic Devices Inc., fiscal year ending 30 September ---------- */

export const SEC_FIXTURE_CIK = "0009999981";
const SEC_NAME = "Synthetic Devices Inc.";
/** What "today" the E2E completion is built for: the claim's filedSince is six years earlier. */
export const SEC_FIXTURE_FILED_SINCE = "2020-10-31";

const B = 1_000_000_000;
function usYear(year: number) {
	const n = year - 2018;
	const revenue = 180 * B + 15 * B * n;
	const assets = 320 * B + 20 * B * n;
	const liabilities = (assets * 60) / 100;
	return {
		RevenueFromContractWithCustomerExcludingAssessedTax: revenue,
		GrossProfit: (revenue * 42) / 100,
		OperatingIncomeLoss: (revenue * 25) / 100,
		NetIncomeLoss: (revenue * 20) / 100,
		NetCashProvidedByUsedInOperatingActivities: (revenue * 28) / 100,
		NetCashProvidedByUsedInInvestingActivities: -(revenue * 10) / 100,
		NetCashProvidedByUsedInFinancingActivities: -(revenue * 15) / 100,
		PaymentsToAcquirePropertyPlantAndEquipment: (revenue * 4) / 100,
		Assets: assets,
		Liabilities: liabilities,
		StockholdersEquity: assets - liabilities,
		CashAndCashEquivalentsAtCarryingValue: 30 * B + 2 * B * n,
	};
}
type UsConcept = keyof ReturnType<typeof usYear>;
const US_DURATIONS: readonly UsConcept[] = [
	"RevenueFromContractWithCustomerExcludingAssessedTax",
	"GrossProfit",
	"OperatingIncomeLoss",
	"NetIncomeLoss",
	"NetCashProvidedByUsedInOperatingActivities",
	"NetCashProvidedByUsedInInvestingActivities",
	"NetCashProvidedByUsedInFinancingActivities",
	"PaymentsToAcquirePropertyPlantAndEquipment",
];
const US_INSTANTS: readonly UsConcept[] = [
	"Assets",
	"Liabilities",
	"StockholdersEquity",
	"CashAndCashEquivalentsAtCarryingValue",
];

/** The FY2023 revenue the FY2024 report restated (the FY2023 report said less). */
const RESTATED_US_REVENUE_2023 =
	usYear(2023).RevenueFromContractWithCustomerExcludingAssessedTax + 1.2 * B;
/** The FY2025 net income the 10-K/A restated. */
const RESTATED_US_NET_INCOME_2025 = usYear(2025).NetIncomeLoss - 0.8 * B;

interface UsFiling {
	readonly accession: string;
	readonly form: "10-K" | "10-K/A" | "10-Q";
	readonly filed: string;
	readonly fiscalYear: number;
	readonly fp: string;
}

const US_ANNUAL: readonly UsFiling[] = [
	{
		accession: "0009999981-19-000101",
		form: "10-K",
		filed: "2019-11-01",
		fiscalYear: 2019,
		fp: "FY",
	},
	{
		accession: "0009999981-20-000105",
		form: "10-K",
		filed: "2020-11-06",
		fiscalYear: 2020,
		fp: "FY",
	},
	{
		accession: "0009999981-21-000107",
		form: "10-K",
		filed: "2021-11-05",
		fiscalYear: 2021,
		fp: "FY",
	},
	{
		accession: "0009999981-22-000104",
		form: "10-K",
		filed: "2022-11-04",
		fiscalYear: 2022,
		fp: "FY",
	},
	{
		accession: "0009999981-23-000106",
		form: "10-K",
		filed: "2023-11-03",
		fiscalYear: 2023,
		fp: "FY",
	},
	{
		accession: "0009999981-24-000108",
		form: "10-K",
		filed: "2024-11-04",
		fiscalYear: 2024,
		fp: "FY",
	},
	{
		accession: "0009999981-25-000110",
		form: "10-K",
		filed: "2025-11-05",
		fiscalYear: 2025,
		fp: "FY",
	},
	{
		accession: "0009999981-26-000005",
		form: "10-K/A",
		filed: "2026-01-15",
		fiscalYear: 2025,
		fp: "FY",
	},
];
const US_Q3_2025: UsFiling = {
	accession: "0009999981-25-000060",
	form: "10-Q",
	filed: "2025-08-01",
	fiscalYear: 2025,
	fp: "Q3",
};
const US_Q1_2026: UsFiling = {
	accession: "0009999981-26-000012",
	form: "10-Q",
	filed: "2026-02-04",
	fiscalYear: 2026,
	fp: "Q1",
};

const usStart = (year: number) => `${year - 1}-10-01`;
const usEnd = (year: number) => `${year}-09-30`;

type FactEntry = Record<string, string | number>;

function usValue(concept: UsConcept, year: number, filing: UsFiling): number {
	if (
		concept === "RevenueFromContractWithCustomerExcludingAssessedTax" &&
		year === 2023 &&
		filing.fiscalYear >= 2024
	) {
		return RESTATED_US_REVENUE_2023;
	}
	if (concept === "NetIncomeLoss" && year === 2025 && filing.form === "10-K/A") {
		return RESTATED_US_NET_INCOME_2025;
	}
	return usYear(year)[concept];
}

function usEntry(
	filing: UsFiling,
	start: string | null,
	end: string,
	val: number,
	frame?: string,
): FactEntry {
	return {
		...(start === null ? {} : { start }),
		end,
		val,
		accn: filing.accession,
		fy: filing.fiscalYear,
		fp: filing.fp,
		form: filing.form,
		filed: filing.filed,
		...(frame === undefined ? {} : { frame }),
	};
}

/** Every us-gaap entry, by concept and unit, as company facts lists them. */
function usFacts(): Map<string, Map<string, FactEntry[]>> {
	const facts = new Map<string, Map<string, FactEntry[]>>();
	const add = (concept: string, unit: string, entry: FactEntry): void => {
		const units = facts.get(concept) ?? new Map<string, FactEntry[]>();
		const list = units.get(unit) ?? [];
		list.push(entry);
		units.set(unit, list);
		facts.set(concept, units);
	};
	for (const filing of US_ANNUAL) {
		const year = filing.fiscalYear;
		// A 10-K's statements: three years of flows, two balance sheets, and
		// equity / cash at the start of the oldest year (not a year end of this filing).
		for (const concept of US_DURATIONS) {
			for (const y of [year - 2, year - 1, year]) {
				add(concept, "USD", usEntry(filing, usStart(y), usEnd(y), usValue(concept, y, filing)));
			}
		}
		for (const concept of US_INSTANTS) {
			const years =
				concept === "StockholdersEquity" || concept === "CashAndCashEquivalentsAtCarryingValue"
					? [year - 3, year - 2, year - 1, year]
					: [year - 1, year];
			for (const y of years)
				add(concept, "USD", usEntry(filing, null, usEnd(y), usValue(concept, y, filing)));
		}
		add(
			"EarningsPerShareDiluted",
			"USD/shares",
			usEntry(filing, usStart(year), usEnd(year), 6.11 + (year - 2019) / 4),
		);
	}
	const byAccession = (accession: string): UsFiling => {
		const filing = US_ANNUAL.find((f) => f.accession === accession);
		if (filing === undefined) throw new Error(accession);
		return filing;
	};
	const fy2025 = byAccession("0009999981-25-000110");
	const fy2024 = byAccession("0009999981-24-000108");
	const fy2022 = byAccession("0009999981-22-000104");
	const fy2021 = byAccession("0009999981-21-000107");
	// The fourth quarter alone inside a 10-K: not an annual duration.
	add(
		"RevenueFromContractWithCustomerExcludingAssessedTax",
		"USD",
		usEntry(fy2025, "2025-07-01", "2025-09-30", 74 * B),
	);
	// A balance at an interim date inside a 10-K: not a year end of the filing.
	add("Assets", "USD", usEntry(fy2025, null, "2025-03-31", 455 * B));
	// One fact listed twice for one accession (SEC lists it once per frame).
	add("Assets", "USD", usEntry(fy2024, null, usEnd(2024), usYear(2024).Assets, "CY2024Q3I"));
	// Values that are not exact decimal text once read as JSON numbers: skipped.
	add(
		"PaymentsToAcquirePropertyPlantAndEquipment",
		"USD",
		usEntry(fy2022, usStart(2022), usEnd(2022), 1.5e-7),
	);
	add(
		"PaymentsToAcquirePropertyPlantAndEquipment",
		"USD",
		usEntry(fy2021, usStart(2021), usEnd(2021), 1e21),
	);
	// A comparative also stated in a second currency.
	add("GrossProfit", "EUR", usEntry(fy2021, usStart(2019), usEnd(2019), 70 * B));
	// Quarterly reports: never annual facts.
	add(
		"RevenueFromContractWithCustomerExcludingAssessedTax",
		"USD",
		usEntry(US_Q3_2025, "2024-10-01", "2025-06-30", 211 * B),
	);
	add(
		"RevenueFromContractWithCustomerExcludingAssessedTax",
		"USD",
		usEntry(US_Q3_2025, "2025-04-01", "2025-06-30", 70 * B),
	);
	add("Assets", "USD", usEntry(US_Q3_2025, null, "2025-06-30", 458 * B));
	add(
		"RevenueFromContractWithCustomerExcludingAssessedTax",
		"USD",
		usEntry(US_Q1_2026, "2025-10-01", "2025-12-31", 77 * B),
	);
	return facts;
}

export function secCompanyFactsFixture(): unknown {
	const usGaap: Record<string, unknown> = {};
	for (const [concept, units] of usFacts()) {
		usGaap[concept] = {
			label: concept.replace(/([a-z])([A-Z])/g, "$1 $2"),
			description: "Synthetic.",
			units: Object.fromEntries(units),
		};
	}
	return {
		_fixture:
			"SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the documented shape of https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json. The filer and all figures are invented; this is not SEC data.",
		cik: Number(SEC_FIXTURE_CIK),
		entityName: SEC_NAME,
		facts: {
			dei: {
				EntityCommonStockSharesOutstanding: {
					label: "Entity Common Stock, Shares Outstanding",
					units: {
						shares: [
							{
								end: "2025-10-24",
								val: 15_000_000_000,
								accn: "0009999981-25-000110",
								fy: 2025,
								fp: "FY",
								form: "10-K",
								filed: "2025-11-05",
							},
						],
					},
				},
			},
			"us-gaap": usGaap,
		},
	};
}

export function secSubmissionsFixture(): unknown {
	const rows: {
		accessionNumber: string;
		filingDate: string;
		reportDate: string;
		acceptanceDateTime: string;
		form: string;
		primaryDocument: string;
	}[] = [
		{
			accessionNumber: "0009999981-26-000040",
			filingDate: "2026-08-03",
			reportDate: "2026-06-30",
			acceptanceDateTime: "2026-08-03T20:31:07.000Z",
			form: "10-Q",
			primaryDocument: "synd-20260630.htm",
		},
		{
			accessionNumber: "0009999981-26-000038",
			filingDate: "2026-07-30",
			reportDate: "2026-07-30",
			acceptanceDateTime: "2026-07-30T20:30:12.000Z",
			form: "8-K",
			primaryDocument: "synd-20260730.htm",
		},
		{
			accessionNumber: "0009999981-26-000025",
			filingDate: "2026-05-04",
			reportDate: "2026-03-31",
			acceptanceDateTime: "2026-05-04T20:30:55.000Z",
			form: "10-Q",
			primaryDocument: "synd-20260331.htm",
		},
		{
			accessionNumber: "0009999981-26-000012",
			filingDate: "2026-02-04",
			reportDate: "2025-12-31",
			acceptanceDateTime: "2026-02-04T21:02:44.000Z",
			form: "10-Q",
			primaryDocument: "synd-20251231.htm",
		},
		{
			accessionNumber: "0009999981-26-000005",
			filingDate: "2026-01-15",
			reportDate: "2025-09-30",
			acceptanceDateTime: "2026-01-15T16:12:09.000Z",
			form: "10-K/A",
			primaryDocument: "synd-20250930a.htm",
		},
		{
			accessionNumber: "0009999981-25-000111",
			filingDate: "2025-11-05",
			reportDate: "2025-11-05",
			acceptanceDateTime: "2025-11-05T21:10:30.000Z",
			form: "8-K",
			primaryDocument: "synd-20251105.htm",
		},
		{
			accessionNumber: "0009999981-25-000110",
			filingDate: "2025-11-05",
			reportDate: "2025-09-30",
			acceptanceDateTime: "2025-11-05T21:04:11.000Z",
			form: "10-K",
			primaryDocument: "synd-20250930.htm",
		},
		{
			accessionNumber: "0009999981-25-000060",
			filingDate: "2025-08-01",
			reportDate: "2025-06-30",
			acceptanceDateTime: "2025-08-01T20:30:01.000Z",
			form: "10-Q",
			primaryDocument: "synd-20250630.htm",
		},
		{
			accessionNumber: "0009999981-25-000052",
			filingDate: "2025-06-02",
			reportDate: "2025-05-29",
			acceptanceDateTime: "2025-06-02T18:30:00.000Z",
			form: "4",
			primaryDocument: "xslF345X05/wk-form4.xml",
		},
		{
			accessionNumber: "0009999981-24-000108",
			filingDate: "2024-11-04",
			reportDate: "2024-09-30",
			acceptanceDateTime: "2024-11-04T21:01:36.000Z",
			form: "10-K",
			primaryDocument: "synd-20240930.htm",
		},
	];
	const column = <K extends keyof (typeof rows)[number]>(key: K) => rows.map((row) => row[key]);
	return {
		_fixture:
			"SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the documented shape of https://data.sec.gov/submissions/CIK##########.json. The filer and its filings are invented; this is not SEC data.",
		cik: String(Number(SEC_FIXTURE_CIK)),
		entityType: "operating",
		sic: "3571",
		name: SEC_NAME,
		tickers: ["SYND"],
		exchanges: ["Nasdaq"],
		fiscalYearEnd: "0930",
		filings: {
			recent: {
				accessionNumber: column("accessionNumber"),
				filingDate: column("filingDate"),
				reportDate: column("reportDate"),
				acceptanceDateTime: column("acceptanceDateTime"),
				act: rows.map(() => "34"),
				form: column("form"),
				fileNumber: rows.map(() => "001-99981"),
				primaryDocument: column("primaryDocument"),
				primaryDocDescription: column("form"),
			},
			files: [
				{
					name: "CIK0009999981-submissions-001.json",
					filingCount: 412,
					filingFrom: "1999-01-04",
					filingTo: "2024-10-31",
				},
			],
		},
	};
}

/* ---------- SEC: the newest 10-K's primary document (ADR-0053) ---------- */

/** The newest original 10-K of Synthetic Devices Inc. and its primary document. */
export const SEC_FIXTURE_TEN_K = {
	accession: "0009999981-25-000110",
	primaryDocument: "synd-20250930.htm",
	fileName: "sec-10k-0009999981-25-000110.synthetic.htm",
	url: "https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm",
} as const;

/**
 * A small 10-K primary document in the shapes the section finder must
 * handle (ADR-0053 §3), as inline-XBRL filings lay them out: a cover page
 * naming "FORM 10-K", a table of contents whose "Item 1. Business" line
 * links into the body (a start heading with an empty body: "Item 1A" is the
 * next line), "Item 1. Business" in bold, a forward-looking
 * preamble before the first subheading, a running page header ("PART I",
 * "Item 1"), page footers and page numbers, `<hr>` page breaks, a table in
 * the body, list markers in their own blocks, then "Item 1A. Risk Factors"
 * and "Item 2. Properties".
 */
export function secTenKFixture(): string {
	const pageBreak = (page: number) =>
		`<p>Synthetic Devices Inc. | 2025 Form 10-K | ${page}</p>\n<p>${page}</p>\n<hr>\n<p>PART I</p>\n<p>Item 1</p>`;
	return `<!DOCTYPE html>
<!-- SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the layout of a 10-K primary document (inline XBRL HTML). The filer and its text are invented; this is not an SEC filing. -->
<html>
<head><title>synd-20250930</title></head>
<body>
<div>
<p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION</p>
<p><b>FORM 10-K</b></p>
<p>Synthetic Devices Inc.</p>
</div>
<hr>
<p><b>TABLE OF CONTENTS</b></p>
<p>Part I</p>
<p><a href="#item1">Item 1. Business</a></p>
<p><a href="#item1a">Item 1A. Risk Factors</a></p>
<p><a href="#item2">Item 2. Properties</a></p>
<p>2</p>
<hr>
<p>PART I</p>
<p id="item1"><b>Item 1. Business</b></p>
<p>This Annual Report on Form 10-K contains forward-looking statements, within the meaning of the Private Securities Litigation Reform Act of 1995, that involve risks and uncertainties; actual results may differ materially.</p>
<p><b>Company Background</b></p>
<p>Synthetic Devices Inc. designs, manufactures and sells laboratory instruments and the software that runs them, and provides related calibration and repair services.</p>
<p>The Company's fiscal year is the 52- or 53-week period that ends on the last Saturday of September. The Company was incorporated in Delaware in 1998.</p>
<p><b>Products</b></p>
<p>Spectrometers, chromatographs and sample handlers make up most of the Company's net sales; each line is sold with a three-year warranty.</p>
<table>
<tr><th>Product line</th><th>Share of net sales</th></tr>
<tr><td>Spectrometers</td><td>48%</td></tr>
<tr><td>Chromatographs</td><td>37%</td></tr>
</table>
${pageBreak(3)}
<p><b>Services</b></p>
<p>The Company offers the following services to owners of its instruments:</p>
<div>•</div>
<div>Calibration on site or at one of the Company's eleven service centres.</div>
<div>•</div>
<div>Repair of instruments sold within the last ten years.</div>
<p><b>Human Capital</b></p>
<p>As of September 27, 2025, the Company had approximately 9,400 full-time equivalent employees.</p>
<p>4</p>
<hr>
<p id="item1a"><b>Item 1A. Risk Factors</b></p>
<p>The Company's business, reputation, results of operations and financial condition can be affected by a number of factors.</p>
<p>5</p>
<hr>
<p id="item2"><b>Item 2. Properties</b></p>
<p>The Company's headquarters are in Springfield.</p>
</body>
</html>
`;
}

/* ---------- SEC: a filer whose 10-K equity statement reaches back three years ---------- */

/**
 * A second synthetic SEC filer for two review findings (ADR-0048 §4, §6):
 *
 * - Each 10-K's balance sheet states total equity including noncontrolling
 *   interest (`StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`)
 *   at its two year ends; its statement of stockholders' equity states the
 *   parent-only `StockholdersEquity` at four year ends (opening balances two
 *   and three years back). Only the two balance-sheet year ends of a filing
 *   may contribute instants, else the FY2024 10-K would become the latest
 *   filing of FY2022 equity and switch its concept.
 * - A 10-K/A (Part III only) whose submissions row has an empty report date
 *   and no XBRL facts: no period end can be stated for it, so it must not
 *   make every sync download the company facts.
 */
export const SEC_EQUITY_FIXTURE_CIK = "0009999982";
const SEC_EQUITY_NAME = "Synthetic Holdings Corp.";
export const SEC_EQUITY_FIXTURE_FILINGS = {
	fy2023: "0009999982-24-000010",
	fy2024: "0009999982-25-000010",
	partIII: "0009999982-25-000031",
} as const;

function equityFilerYear(year: number) {
	const n = year - 2019;
	const total = 50 * B + 4 * B * n;
	return { Revenues: 120 * B + 9 * B * n, total, parent: total - 6 * B };
}

export function secEquityCompanyFactsFixture(): unknown {
	const filings = [
		{ accession: SEC_EQUITY_FIXTURE_FILINGS.fy2023, year: 2023, filed: "2024-02-20" },
		{ accession: SEC_EQUITY_FIXTURE_FILINGS.fy2024, year: 2024, filed: "2025-02-19" },
	];
	const entry = (
		filing: (typeof filings)[number],
		start: string | null,
		end: string,
		val: number,
	): FactEntry => ({
		...(start === null ? {} : { start }),
		end,
		val,
		accn: filing.accession,
		fy: filing.year,
		fp: "FY",
		form: "10-K",
		filed: filing.filed,
	});
	const revenues: FactEntry[] = [];
	const total: FactEntry[] = [];
	const parent: FactEntry[] = [];
	for (const filing of filings) {
		const year = filing.year;
		for (const y of [year - 2, year - 1, year]) {
			revenues.push(entry(filing, `${y}-01-01`, `${y}-12-31`, equityFilerYear(y).Revenues));
		}
		for (const y of [year - 1, year]) {
			total.push(entry(filing, null, `${y}-12-31`, equityFilerYear(y).total));
		}
		for (const y of [year - 3, year - 2, year - 1, year]) {
			parent.push(entry(filing, null, `${y}-12-31`, equityFilerYear(y).parent));
		}
	}
	const concept = (name: string, entries: FactEntry[]) => ({
		label: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
		description: "Synthetic.",
		units: { USD: entries },
	});
	return {
		_fixture:
			"SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the documented shape of https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json. The filer and all figures are invented; this is not SEC data.",
		cik: Number(SEC_EQUITY_FIXTURE_CIK),
		entityName: SEC_EQUITY_NAME,
		facts: {
			"us-gaap": {
				Revenues: concept("Revenues", revenues),
				StockholdersEquity: concept("StockholdersEquity", parent),
				StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: concept(
					"StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
					total,
				),
			},
		},
	};
}

export function secEquitySubmissionsFixture(): unknown {
	const rows = [
		{
			accessionNumber: SEC_EQUITY_FIXTURE_FILINGS.partIII,
			filingDate: "2025-04-28",
			reportDate: "",
			acceptanceDateTime: "2025-04-28T20:15:02.000Z",
			form: "10-K/A",
			primaryDocument: "synh-20250428.htm",
		},
		{
			accessionNumber: SEC_EQUITY_FIXTURE_FILINGS.fy2024,
			filingDate: "2025-02-19",
			reportDate: "2024-12-31",
			acceptanceDateTime: "2025-02-19T21:05:40.000Z",
			form: "10-K",
			primaryDocument: "synh-20241231.htm",
		},
		{
			accessionNumber: SEC_EQUITY_FIXTURE_FILINGS.fy2023,
			filingDate: "2024-02-20",
			reportDate: "2023-12-31",
			acceptanceDateTime: "2024-02-20T21:03:18.000Z",
			form: "10-K",
			primaryDocument: "synh-20231231.htm",
		},
	];
	const column = <K extends keyof (typeof rows)[number]>(key: K) => rows.map((row) => row[key]);
	return {
		_fixture:
			"SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the documented shape of https://data.sec.gov/submissions/CIK##########.json. The filer and its filings are invented; this is not SEC data.",
		cik: String(Number(SEC_EQUITY_FIXTURE_CIK)),
		entityType: "operating",
		name: SEC_EQUITY_NAME,
		tickers: ["SYNH"],
		exchanges: ["NYSE"],
		fiscalYearEnd: "1231",
		filings: {
			recent: {
				accessionNumber: column("accessionNumber"),
				filingDate: column("filingDate"),
				reportDate: column("reportDate"),
				acceptanceDateTime: column("acceptanceDateTime"),
				form: column("form"),
				primaryDocument: column("primaryDocument"),
			},
			files: [],
		},
	};
}

/* ---------- SEC: a foreign private issuer filing 20-F under IFRS (ADR-0058 §5) ---------- */

/**
 * A third synthetic SEC filer, a foreign private issuer listed as an ADR
 * (Rio Tinto, BHP): annual reports on Form 20-F, statements under IFRS in
 * GBP (`ifrs-full` facts), fiscal year ending 31 December.
 *
 * - FY2022's 20-F still reported under US GAAP (`us-gaap` facts in USD):
 *   the issuer moved to IFRS for FY2023, so a filing's standard is the
 *   taxonomy of its own facts, not the issuer's.
 * - FY2023 and FY2024 20-Fs report `ifrs-full` facts: three years of flows,
 *   two balance sheets; total equity (`Equity`) and the owners' share.
 * - A 20-F/A amends FY2024 and restates its revenue.
 * - 6-K rows (interim reports of foreign issuers) are not annual reports.
 * - The FY2024 20-F's primary document holds Item 4.B "Business Overview"
 *   (`secTwentyFFixture`).
 */
export const SEC_FOREIGN_FIXTURE_CIK = "0009999983";
const SEC_FOREIGN_NAME = "Synthetic Mining plc";
export const SEC_FOREIGN_FIXTURE_FILINGS = {
	fy2022: "0009999983-23-000012",
	fy2023: "0009999983-24-000015",
	fy2024: "0009999983-25-000018",
	amendment: "0009999983-25-000044",
} as const;

interface ForeignFiling {
	readonly accession: string;
	readonly year: number;
	readonly filed: string;
	readonly form: "20-F" | "20-F/A";
	readonly taxonomy: "us-gaap" | "ifrs-full";
}

const FOREIGN_ANNUAL: readonly ForeignFiling[] = [
	{
		accession: SEC_FOREIGN_FIXTURE_FILINGS.fy2022,
		year: 2022,
		filed: "2023-03-03",
		form: "20-F",
		taxonomy: "us-gaap",
	},
	{
		accession: SEC_FOREIGN_FIXTURE_FILINGS.fy2023,
		year: 2023,
		filed: "2024-02-29",
		form: "20-F",
		taxonomy: "ifrs-full",
	},
	{
		accession: SEC_FOREIGN_FIXTURE_FILINGS.fy2024,
		year: 2024,
		filed: "2025-02-27",
		form: "20-F",
		taxonomy: "ifrs-full",
	},
	{
		accession: SEC_FOREIGN_FIXTURE_FILINGS.amendment,
		year: 2024,
		filed: "2025-06-30",
		form: "20-F/A",
		taxonomy: "ifrs-full",
	},
];

/** Yearly figures (GBP under IFRS, USD under US GAAP), invented. */
function foreignYear(year: number) {
	const n = year - 2019;
	return {
		revenue: 40 * B + 2 * B * n,
		operating: 12 * B + B * n,
		profit: 8 * B + 0.5 * B * n,
		assets: 90 * B + 3 * B * n,
		liabilities: 40 * B + B * n,
		equity: 50 * B + 2 * B * n,
		parentEquity: 46 * B + 2 * B * n,
		cash: 9 * B + 0.25 * B * n,
		operatingCash: 15 * B + B * n,
		investingCash: -7 * B - 0.5 * B * n,
		financingCash: -6 * B - 0.25 * B * n,
		capex: 6 * B + 0.5 * B * n,
	};
}

/** The 20-F/A restates FY2024 revenue. */
const RESTATED_FOREIGN_REVENUE_2024 = foreignYear(2024).revenue - 0.4 * B;

type ForeignFigure = keyof ReturnType<typeof foreignYear>;

/** Each taxonomy's concept for a figure (the reviewed mappings', ADR-0058 §5). */
const FOREIGN_CONCEPTS: {
	readonly [T in ForeignFiling["taxonomy"]]: { readonly [F in ForeignFigure]: string };
} = {
	"ifrs-full": {
		revenue: "Revenue",
		operating: "ProfitLossFromOperatingActivities",
		profit: "ProfitLossAttributableToOwnersOfParent",
		assets: "Assets",
		liabilities: "Liabilities",
		equity: "Equity",
		parentEquity: "EquityAttributableToOwnersOfParent",
		cash: "CashAndCashEquivalents",
		operatingCash: "CashFlowsFromUsedInOperatingActivities",
		investingCash: "CashFlowsFromUsedInInvestingActivities",
		financingCash: "CashFlowsFromUsedInFinancingActivities",
		capex: "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
	},
	"us-gaap": {
		revenue: "Revenues",
		operating: "OperatingIncomeLoss",
		profit: "NetIncomeLoss",
		assets: "Assets",
		liabilities: "Liabilities",
		equity: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
		parentEquity: "StockholdersEquity",
		cash: "CashAndCashEquivalentsAtCarryingValue",
		operatingCash: "NetCashProvidedByUsedInOperatingActivities",
		investingCash: "NetCashProvidedByUsedInInvestingActivities",
		financingCash: "NetCashProvidedByUsedInFinancingActivities",
		capex: "PaymentsToAcquirePropertyPlantAndEquipment",
	},
};

const FOREIGN_FLOWS: readonly ForeignFigure[] = [
	"revenue",
	"operating",
	"profit",
	"operatingCash",
	"investingCash",
	"financingCash",
	"capex",
];
const FOREIGN_BALANCES: readonly ForeignFigure[] = [
	"assets",
	"liabilities",
	"equity",
	"parentEquity",
	"cash",
];

export function secForeignCompanyFactsFixture(): unknown {
	const taxonomies: { [T in ForeignFiling["taxonomy"]]: Map<string, FactEntry[]> } = {
		"ifrs-full": new Map(),
		"us-gaap": new Map(),
	};
	const add = (filing: ForeignFiling, figure: ForeignFigure, entry: FactEntry): void => {
		const concept = FOREIGN_CONCEPTS[filing.taxonomy][figure];
		const list = taxonomies[filing.taxonomy].get(concept) ?? [];
		list.push(entry);
		taxonomies[filing.taxonomy].set(concept, list);
	};
	for (const filing of FOREIGN_ANNUAL) {
		const entry = (start: string | null, end: string, val: number): FactEntry => ({
			...(start === null ? {} : { start }),
			end,
			val,
			accn: filing.accession,
			fy: filing.year,
			fp: "FY",
			form: filing.form,
			filed: filing.filed,
		});
		for (const figure of FOREIGN_FLOWS) {
			for (const y of [filing.year - 2, filing.year - 1, filing.year]) {
				const value =
					figure === "revenue" && filing.form === "20-F/A" && y === 2024
						? RESTATED_FOREIGN_REVENUE_2024
						: foreignYear(y)[figure];
				add(filing, figure, entry(`${y}-01-01`, `${y}-12-31`, value));
			}
		}
		for (const figure of FOREIGN_BALANCES) {
			for (const y of [filing.year - 1, filing.year]) {
				add(filing, figure, entry(null, `${y}-12-31`, foreignYear(y)[figure]));
			}
		}
	}
	const unit = (taxonomy: ForeignFiling["taxonomy"]) => (taxonomy === "ifrs-full" ? "GBP" : "USD");
	const taxonomyJson = (taxonomy: ForeignFiling["taxonomy"]) =>
		Object.fromEntries(
			[...taxonomies[taxonomy]].map(([concept, entries]) => [
				concept,
				{
					label: concept.replace(/([a-z])([A-Z])/g, "$1 $2"),
					description: "Synthetic.",
					units: { [unit(taxonomy)]: entries },
				},
			]),
		);
	return {
		_fixture:
			"SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the documented shape of https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json for a 20-F filer reporting under IFRS (ifrs-full) since FY2023 and under US GAAP before. The filer and all figures are invented; this is not SEC data.",
		cik: Number(SEC_FOREIGN_FIXTURE_CIK),
		entityName: SEC_FOREIGN_NAME,
		facts: {
			"ifrs-full": taxonomyJson("ifrs-full"),
			"us-gaap": taxonomyJson("us-gaap"),
		},
	};
}

/** The FY2024 20-F of Synthetic Mining plc and its primary document. */
export const SEC_FOREIGN_FIXTURE_TWENTY_F = {
	accession: SEC_FOREIGN_FIXTURE_FILINGS.fy2024,
	primaryDocument: "synm-20241231x20f.htm",
	fileName: `sec-20f-${SEC_FOREIGN_FIXTURE_FILINGS.fy2024}.synthetic.htm`,
	url: "https://www.sec.gov/Archives/edgar/data/9999983/000999998325000018/synm-20241231x20f.htm",
} as const;

export function secForeignSubmissionsFixture(): unknown {
	const rows = [
		{
			accessionNumber: "0009999983-25-000051",
			filingDate: "2025-07-30",
			reportDate: "2025-06-30",
			acceptanceDateTime: "2025-07-30T06:01:12.000Z",
			form: "6-K",
			primaryDocument: "synm-20250730x6k.htm",
		},
		{
			accessionNumber: SEC_FOREIGN_FIXTURE_FILINGS.amendment,
			filingDate: "2025-06-30",
			reportDate: "2024-12-31",
			acceptanceDateTime: "2025-06-30T10:15:44.000Z",
			form: "20-F/A",
			primaryDocument: "synm-20241231x20fa.htm",
		},
		{
			accessionNumber: SEC_FOREIGN_FIXTURE_FILINGS.fy2024,
			filingDate: "2025-02-27",
			reportDate: "2024-12-31",
			acceptanceDateTime: "2025-02-27T11:02:31.000Z",
			form: "20-F",
			primaryDocument: SEC_FOREIGN_FIXTURE_TWENTY_F.primaryDocument,
		},
		{
			accessionNumber: SEC_FOREIGN_FIXTURE_FILINGS.fy2023,
			filingDate: "2024-02-29",
			reportDate: "2023-12-31",
			acceptanceDateTime: "2024-02-29T11:04:09.000Z",
			form: "20-F",
			primaryDocument: "synm-20231231x20f.htm",
		},
		{
			accessionNumber: SEC_FOREIGN_FIXTURE_FILINGS.fy2022,
			filingDate: "2023-03-03",
			reportDate: "2022-12-31",
			acceptanceDateTime: "2023-03-03T11:00:52.000Z",
			form: "20-F",
			primaryDocument: "synm-20221231x20f.htm",
		},
	];
	const column = <K extends keyof (typeof rows)[number]>(key: K) => rows.map((row) => row[key]);
	return {
		_fixture:
			"SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the documented shape of https://data.sec.gov/submissions/CIK##########.json for a foreign private issuer (20-F, 6-K). The filer and its filings are invented; this is not SEC data.",
		cik: String(Number(SEC_FOREIGN_FIXTURE_CIK)),
		entityType: "operating",
		name: SEC_FOREIGN_NAME,
		tickers: ["SYNM"],
		exchanges: ["NYSE"],
		fiscalYearEnd: "1231",
		filings: {
			recent: {
				accessionNumber: column("accessionNumber"),
				filingDate: column("filingDate"),
				reportDate: column("reportDate"),
				acceptanceDateTime: column("acceptanceDateTime"),
				form: column("form"),
				primaryDocument: column("primaryDocument"),
			},
			files: [],
		},
	};
}

/**
 * A small 20-F primary document in the layout of the Form 20-F instructions:
 * a cover page naming "FORM 20-F", a table of contents listing Item 4 and
 * its sub-items, then "Item 4. Information on the Company" with 4.A
 * (history, not description), "B. Business Overview" with a subheading,
 * page footers naming "Form 20-F", a running "Item 4" header, a
 * cross-reference note "incorporated herein by reference" (furniture), then
 * "C. Organizational Structure", "Item 4A. Unresolved Staff Comments" and
 * "Item 5".
 */
export function secTwentyFFixture(): string {
	return `<!DOCTYPE html>
<!-- SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the layout of a 20-F primary document (inline XBRL HTML). The filer and its text are invented; this is not an SEC filing. -->
<html>
<head><title>synm-20241231x20f</title></head>
<body>
<div>
<p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION</p>
<p><b>FORM 20-F</b></p>
<p>Synthetic Mining plc</p>
</div>
<hr>
<p><b>TABLE OF CONTENTS</b></p>
<p><a href="#item4">Item 4. Information on the Company</a></p>
<p><a href="#item4b">Item 4.B Business Overview</a></p>
<p><a href="#item4c">Item 4.C Organizational Structure</a></p>
<p><a href="#item5">Item 5. Operating and Financial Review and Prospects</a></p>
<hr>
<p>PART I</p>
<p id="item4"><b>Item 4. Information on the Company</b></p>
<p><b>A. History and Development of the Company</b></p>
<p>Synthetic Mining plc was incorporated in England and Wales in 1899; its American Depositary Shares have been listed on the New York Stock Exchange since 1990.</p>
<p id="item4b"><b>B. Business Overview</b></p>
<p><b>Our business</b></p>
<p>Synthetic Mining plc explores for, mines and processes iron ore, copper and aluminium, and sells them to steelmakers, smelters and manufacturers in Asia, Europe and the Americas.</p>
<p>Synthetic Mining plc | 2024 Form 20-F | 21</p>
<p>21</p>
<hr>
<p>Item 4</p>
<p>The Group operates 17 mines in six countries; iron ore from its Pilbara operations provides most of its revenue.</p>
<p>Further information on the Group's reserves is set out in the 2024 Annual Report, which is incorporated herein by reference.</p>
<p id="item4c"><b>C. Organizational Structure</b></p>
<p>The Group's principal subsidiaries are listed in Exhibit 8.1.</p>
<p><b>Item 4A. Unresolved Staff Comments</b></p>
<p>None.</p>
<p id="item5"><b>Item 5. Operating and Financial Review and Prospects</b></p>
<p>Revenue rose in 2024.</p>
</body>
</html>
`;
}

/* ---------- E2E completions (what the extraction makes of the inputs above) ---------- */

/** The claim concepts per provider (the registry's, as the API sends them). */
const SEC_CONCEPTS = equityConceptsOfProvider("sec");

function must<T>(
	result:
		| { readonly ok: true; readonly value: T }
		| { readonly ok: false; readonly error: unknown },
): T {
	if (!result.ok) throw new Error(`fixture build failed: ${JSON.stringify(result.error)}`);
	return result.value;
}

export function e2eSecCompletion(): unknown {
	const submissions = must(parseSecSubmissions(secSubmissionsFixture()));
	const result = secSyncResult({
		request: {
			provider: "sec",
			cik: SEC_FIXTURE_CIK,
			knownAccessions: [],
			pendingFilings: [],
			filedSince: SEC_FIXTURE_FILED_SINCE,
			fullCheck: true,
			describedDocumentId: null,
		},
		cik: SEC_FIXTURE_CIK,
		submissions,
		facts: must(indexSecCompanyFacts(secCompanyFactsFixture(), SEC_CONCEPTS)),
	});
	if (result.more) throw new Error("the SEC E2E fixture must fit one completion");
	const tenK = secNewestAnnualReport(submissions);
	if (tenK === null || tenK.accession !== SEC_FIXTURE_TEN_K.accession) {
		throw new Error("the SEC fixture's newest 10-K must be SEC_FIXTURE_TEN_K");
	}
	return {
		_fixture:
			"SYNTHETIC. The SEC financial-synced completion fields (identity, filings, description) that secSyncResult and secAnnualReportDescription make of examples/fixtures/equity-sync/sec-*.synthetic.* with fullCheck and no stored description. Served by the E2E fixture financial source (both runners) for any US company; see tests/e2e/equitySyncFixtures.ts.",
		identity: result.identity,
		filings: result.filings,
		description: secAnnualReportDescription(
			secAnnualReportSource(SEC_FIXTURE_CIK, tenK),
			secTenKFixture(),
		),
	};
}

/** The J-Quants E2E company: Nintendo (7974), whose live answer the fixture is. */
export const JQUANTS_FIXTURE_CODE = "79740";
/** J-Quants' `GET /v2/fins/summary?code=79740` answer, captured live on 2026-11-02 (trimmed fields). */
export const JQUANTS_FIXTURE_SUMMARY = fileURLToPath(
	new URL(
		"../../../packages/adapters/test/finance/fixtures/jquants-fins-summary-code-7974.json",
		import.meta.url,
	),
);

/** The records of the J-Quants fixture answer. */
export function jquantsFixtureRecords(): unknown[] {
	const page: unknown = JSON.parse(readFileSync(JQUANTS_FIXTURE_SUMMARY, "utf8"));
	if (typeof page !== "object" || page === null || !("data" in page) || !Array.isArray(page.data)) {
		throw new Error("the J-Quants fixture is not a page");
	}
	return page.data;
}

export function e2eJquantsCompletion(): unknown {
	const result = jquantsSummariesToSync(JQUANTS_FIXTURE_CODE, [], jquantsFixtureRecords());
	if (result.more || result.filings.length === 0) {
		throw new Error("the J-Quants E2E fixture must give filings that fit one completion");
	}
	return {
		_fixture:
			"LIVE ANSWER, 2026-11-02. The J-Quants financial-synced completion fields (identity, filings; no description, ADR-0059 §3) that jquantsSummariesToSync makes of J-Quants' earnings summaries of 79740 (packages/adapters/test/finance/fixtures/jquants-fins-summary-code-7974.json) with nothing stored. Served by the E2E fixture financial source (both runners) for any JP company; see tests/e2e/equitySyncFixtures.ts.",
		identity: result.identity,
		filings: result.filings,
		description: null,
	};
}

/* ---------- Files ---------- */

export interface FixtureFile {
	readonly name: string;
	readonly text: string;
}

export function equitySyncFixtureFiles(): readonly FixtureFile[] {
	const files: FixtureFile[] = [
		{
			name: `sec-submissions-CIK${SEC_FIXTURE_CIK}.synthetic.json`,
			text: `${fixtureJson(secSubmissionsFixture())}\n`,
		},
		{
			name: `sec-companyfacts-CIK${SEC_FIXTURE_CIK}.synthetic.json`,
			text: `${fixtureJson(secCompanyFactsFixture())}\n`,
		},
		{ name: SEC_FIXTURE_TEN_K.fileName, text: secTenKFixture() },
		{
			name: `sec-submissions-CIK${SEC_EQUITY_FIXTURE_CIK}.synthetic.json`,
			text: `${fixtureJson(secEquitySubmissionsFixture())}\n`,
		},
		{
			name: `sec-companyfacts-CIK${SEC_EQUITY_FIXTURE_CIK}.synthetic.json`,
			text: `${fixtureJson(secEquityCompanyFactsFixture())}\n`,
		},
		{
			name: `sec-submissions-CIK${SEC_FOREIGN_FIXTURE_CIK}.synthetic.json`,
			text: `${fixtureJson(secForeignSubmissionsFixture())}\n`,
		},
		{
			name: `sec-companyfacts-CIK${SEC_FOREIGN_FIXTURE_CIK}.synthetic.json`,
			text: `${fixtureJson(secForeignCompanyFactsFixture())}\n`,
		},
		{ name: SEC_FOREIGN_FIXTURE_TWENTY_F.fileName, text: secTwentyFFixture() },
	];
	files.push(
		{ name: "e2e-sec.json", text: `${JSON.stringify(e2eSecCompletion(), null, "\t")}\n` },
		{ name: "e2e-jquants.json", text: `${JSON.stringify(e2eJquantsCompletion(), null, "\t")}\n` },
	);
	return files;
}

async function main(): Promise<void> {
	await mkdir(EQUITY_SYNC_FIXTURE_DIR, { recursive: true });
	for (const file of equitySyncFixtureFiles()) {
		const path = join(EQUITY_SYNC_FIXTURE_DIR, file.name);
		await writeFile(path, file.text);
		console.log(`wrote ${path}`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
