/**
 * Synthetic, format-faithful inputs for the financial statement sync
 * (ADR-0048, ADR-0053): an SEC filer (submissions + company facts JSON, its
 * newest 10-K's primary document), a foreign private issuer filing 20-F
 * under IFRS (ADR-0058 §5, with its 20-F's primary document) and an EDINET filer (date lists +
 * XBRL-to-CSV ZIPs with 事業の内容), plus the two E2E completion files the
 * fixture financial source serves to both runners' E2E harnesses.
 *
 *     node scripts/vectors/finance/equitySyncFixtures.ts    # rewrite examples/fixtures/equity-sync/
 *
 * Every file is built here from a few yearly formulas, so the set is
 * reproducible and consistent: the E2E completions are what the real
 * TypeScript extraction (`secSyncResult`, `extractEdinetReport`) makes of
 * these inputs. The companies, codes and figures are invented; the shapes
 * follow SEC's and EDINET's published formats. Tests compare the committed
 * files with a fresh build (ZIPs by entry content, since deflate bytes may
 * differ between zlib versions).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EquityBusinessDescription, EquityPendingFiling } from "@research/contracts";
import { equityConceptsOfProvider, isoDateOfDayNumber, isoDayNumber } from "@research/domain";
import { extractEdinetReport } from "../../../packages/adapters/src/finance/edinetCsv.ts";
import {
	type EdinetAnnualRow,
	edinetDownloadPlan,
	edinetViewerUrl,
	parseEdinetDocumentList,
} from "../../../packages/adapters/src/finance/edinetDocuments.ts";
import {
	businessDescriptionOf,
	compareFilingsNewestFirst,
	newerBusinessDescription,
} from "../../../packages/adapters/src/finance/equitySync.ts";
import {
	indexSecCompanyFacts,
	parseSecSubmissions,
	secAnnualReportDescription,
	secAnnualReportSource,
	secNewestAnnualReport,
	secSyncResult,
} from "../../../packages/adapters/src/finance/secAnnualFilings.ts";
import { buildTestZip } from "../../../packages/adapters/test/zipTestUtils.ts";

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

/* ---------- EDINET: シンセティック工業株式会社, fiscal year ending 31 March ---------- */

export const EDINET_FIXTURE_CODE = "E99991";
export const EDINET_FIXTURE_SEC_CODE = "99990";
const EDINET_NAME = "シンセティック工業株式会社";

function jpYear(year: number) {
	const n = year - 2019;
	const sales = 500 * B + 40 * B * n;
	const assets = 900 * B + 50 * B * n;
	const liabilities = (assets * 40) / 100;
	return {
		"jppfs_cor:NetSales": sales,
		"jppfs_cor:GrossProfit": (sales * 30) / 100,
		"jppfs_cor:OperatingIncome": (sales * 12) / 100,
		"jppfs_cor:OrdinaryIncome": (sales * 13) / 100,
		"jppfs_cor:ProfitLossAttributableToOwnersOfParent": (sales * 9) / 100,
		"jppfs_cor:NetCashProvidedByUsedInOperatingActivities": (sales * 14) / 100,
		"jppfs_cor:NetCashProvidedByUsedInInvestingActivities": -(sales * 6) / 100,
		"jppfs_cor:NetCashProvidedByUsedInFinancingActivities": -(sales * 5) / 100,
		"jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF": -(sales * 5) / 100,
		"jppfs_cor:Assets": assets,
		"jppfs_cor:Liabilities": liabilities,
		"jppfs_cor:NetAssets": assets - liabilities,
		"jppfs_cor:CashAndCashEquivalents": 150 * B + 10 * B * n,
	};
}
type JpConcept = keyof ReturnType<typeof jpYear>;
const JP_DURATIONS: readonly JpConcept[] = [
	"jppfs_cor:NetSales",
	"jppfs_cor:GrossProfit",
	"jppfs_cor:OperatingIncome",
	"jppfs_cor:OrdinaryIncome",
	"jppfs_cor:ProfitLossAttributableToOwnersOfParent",
	"jppfs_cor:NetCashProvidedByUsedInOperatingActivities",
	"jppfs_cor:NetCashProvidedByUsedInInvestingActivities",
	"jppfs_cor:NetCashProvidedByUsedInFinancingActivities",
	"jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF",
];
const JP_INSTANTS: readonly JpConcept[] = [
	"jppfs_cor:Assets",
	"jppfs_cor:Liabilities",
	"jppfs_cor:NetAssets",
	"jppfs_cor:CashAndCashEquivalents",
];
/** The amendment of the FY2024 report restated its net sales; the FY2025 report's comparative agrees. */
const RESTATED_JP_SALES_2024 = jpYear(2024)["jppfs_cor:NetSales"] + 3 * B;

export interface EdinetFixtureDocument {
	readonly docId: string;
	readonly docTypeCode: "120" | "130";
	readonly fiscalYear: number;
	readonly submitted: string;
	readonly parentDocId: string | null;
	readonly lineEnding: "\r\n" | "\n";
}

export const EDINET_FIXTURE_DOCUMENTS: readonly EdinetFixtureDocument[] = [
	{
		docId: "S100SY20",
		docTypeCode: "120",
		fiscalYear: 2020,
		submitted: "2020-06-26 15:00",
		parentDocId: null,
		lineEnding: "\r\n",
	},
	{
		docId: "S100SY21",
		docTypeCode: "120",
		fiscalYear: 2021,
		submitted: "2021-06-25 15:00",
		parentDocId: null,
		lineEnding: "\r\n",
	},
	{
		docId: "S100SY22",
		docTypeCode: "120",
		fiscalYear: 2022,
		submitted: "2022-06-24 15:00",
		parentDocId: null,
		lineEnding: "\r\n",
	},
	{
		docId: "S100SY23",
		docTypeCode: "120",
		fiscalYear: 2023,
		submitted: "2023-06-23 15:00",
		parentDocId: null,
		lineEnding: "\r\n",
	},
	{
		docId: "S100SY24",
		docTypeCode: "120",
		fiscalYear: 2024,
		submitted: "2024-06-21 15:00",
		parentDocId: null,
		lineEnding: "\r\n",
	},
	{
		docId: "S100SYA4",
		docTypeCode: "130",
		fiscalYear: 2024,
		submitted: "2024-09-10 10:30",
		parentDocId: "S100SY24",
		lineEnding: "\n",
	},
	{
		docId: "S100SY25",
		docTypeCode: "120",
		fiscalYear: 2025,
		submitted: "2025-06-20 15:00",
		parentDocId: null,
		lineEnding: "\r\n",
	},
];

/** A text-only amendment listed without CSV (csvFlag "0"): not available, never downloaded. */
export const EDINET_FIXTURE_NO_CSV_DOC = "S100SYB5";
export const EDINET_FIXTURE_NO_CSV_DATE = "2025-07-01";

function jpValue(concept: JpConcept, year: number, document: EdinetFixtureDocument): number {
	if (concept === "jppfs_cor:NetSales" && year === 2024) {
		const restated =
			(document.docTypeCode === "130" && document.fiscalYear === 2024) ||
			document.fiscalYear === 2025;
		if (restated) return RESTATED_JP_SALES_2024;
	}
	return jpYear(year)[concept];
}

const jpStart = (year: number) => `${year - 1}-04-01`;
const jpEnd = (year: number) => `${year}-03-31`;

const CSV_HEADER = [
	"要素ID",
	"項目名",
	"コンテキストID",
	"相対年度",
	"連結・個別",
	"期間・時点",
	"ユニットID",
	"単位",
	"値",
];

function csvLine(fields: readonly string[]): string {
	return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join("\t");
}

/**
 * The 事業の内容 text block of a fixture report (ADR-0053): the 2020 report
 * has none (a report without the block is "not-found"); the others name
 * their year, so the newest report's text is recognisable. Lines keep the
 * report's line ending; one is indented with an ideographic space, as
 * filings often are.
 */
export function edinetBusinessText(document: EdinetFixtureDocument): string | null {
	if (document.fiscalYear === 2020) return null;
	const lines = [
		"３【事業の内容】",
		`　当社グループは、当社、連結子会社${document.fiscalYear - 2008}社及び持分法適用関連会社3社で構成され、産業機械及び計測機器の製造・販売を主な事業としています（${document.fiscalYear}年3月31日現在）。`,
		"当社グループの事業内容及び当社と関係会社の当該事業に係る位置付けは、次のとおりです。",
		"",
		"（1）機械事業",
		"当社が工作機械及び搬送装置を製造し、国内外の販売子会社を通じて販売しています。",
		"（2）計測事業",
		"連結子会社シンセティック計測株式会社が計測機器を製造し、当社が販売しています。",
		"[事業系統図]",
	];
	return lines.join(document.lineEnding);
}

/** The main report CSV text of one fixture document (before UTF-16 encoding). */
export function edinetReportCsv(document: EdinetFixtureDocument): string {
	const year = document.fiscalYear;
	const rows: string[][] = [CSV_HEADER];
	const dei = (element: string, label: string, value: string) =>
		rows.push([
			element,
			label,
			"FilingDateInstant",
			"提出日時点",
			"その他",
			"時点",
			"－",
			"－",
			value,
		]);
	dei("jpdei_cor:EDINETCodeDEI", "ＥＤＩＮＥＴコード、ＤＥＩ", EDINET_FIXTURE_CODE);
	dei("jpdei_cor:AccountingStandardsDEI", "会計基準、ＤＥＩ", "Japan GAAP");
	dei("jpdei_cor:CurrentFiscalYearStartDateDEI", "当事業年度開始日、ＤＥＩ", jpStart(year));
	dei("jpdei_cor:CurrentFiscalYearEndDateDEI", "当事業年度終了日、ＤＥＩ", jpEnd(year));
	dei("jpdei_cor:PreviousFiscalYearStartDateDEI", "前事業年度開始日、ＤＥＩ", jpStart(year - 1));
	dei("jpdei_cor:PreviousFiscalYearEndDateDEI", "前事業年度終了日、ＤＥＩ", jpEnd(year - 1));
	rows.push([
		"jpcrp_cor:BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock",
		"経営方針、経営環境及び対処すべき課題等 [テキストブロック]",
		"FilingDateInstant",
		"提出日時点",
		"その他",
		"時点",
		"－",
		"－",
		'当社グループは「つくる\t楽しさ」を\n事業の基本としています。\r\n"中期計画"の二年目です。',
	]);
	const business = edinetBusinessText(document);
	if (business !== null) {
		rows.push([
			"jpcrp_cor:DescriptionOfBusinessTextBlock",
			"事業の内容 [テキストブロック]",
			"FilingDateInstant",
			"提出日時点",
			"その他",
			"時点",
			"－",
			"－",
			business,
		]);
	}
	rows.push([
		"jpcrp_cor:NumberOfEmployees",
		"従業員数",
		"CurrentYearInstant",
		"当期末",
		"連結",
		"時点",
		"pure",
		"人",
		"12345",
	]);
	for (const concept of JP_DURATIONS) {
		for (const [context, relative, y] of [
			["CurrentYearDuration", "当期", year],
			["Prior1YearDuration", "前期", year - 1],
		] as const) {
			rows.push([
				concept,
				concept,
				context,
				relative,
				"連結",
				"期間",
				"JPY",
				"円",
				String(jpValue(concept, y, document)),
			]);
		}
	}
	for (const concept of JP_INSTANTS) {
		for (const [context, relative, y] of [
			["CurrentYearInstant", "当期末", year],
			["Prior1YearInstant", "前期末", year - 1],
		] as const) {
			rows.push([
				concept,
				concept,
				context,
				relative,
				"連結",
				"時点",
				"JPY",
				"円",
				String(jpValue(concept, y, document)),
			]);
		}
	}
	// The separate (個別) statements: a few lines, one nil.
	const separate = (concept: string, context: string, value: string) =>
		rows.push([
			concept,
			concept,
			`${context}_NonConsolidatedMember`,
			"当期",
			"個別",
			context.endsWith("Instant") ? "時点" : "期間",
			"JPY",
			"円",
			value,
		]);
	const sales = jpValue("jppfs_cor:NetSales", year, document);
	separate("jppfs_cor:NetSales", "CurrentYearDuration", String((sales * 55) / 100));
	separate("jppfs_cor:OrdinaryIncome", "CurrentYearDuration", String((sales * 7) / 100));
	separate("jppfs_cor:ProfitLoss", "CurrentYearDuration", String((sales * 5) / 100));
	separate(
		"jppfs_cor:Assets",
		"CurrentYearInstant",
		String((jpYear(year)["jppfs_cor:Assets"] * 50) / 100),
	);
	separate("jppfs_cor:GrossProfit", "Prior1YearDuration", "－");
	// Contexts a sync never takes: a segment, an interim period.
	rows.push([
		"jppfs_cor:NetSales",
		"売上高",
		"CurrentYearDuration_jpcrp030000-asr_E99991-000MachineryReportableSegmentMember",
		"当期",
		"連結",
		"期間",
		"JPY",
		"円",
		String((sales * 60) / 100),
	]);
	rows.push([
		"jppfs_cor:NetSales",
		"売上高",
		"InterimDuration",
		"中間期",
		"連結",
		"期間",
		"JPY",
		"円",
		String(sales / 2),
	]);
	return `${rows.map(csvLine).join(document.lineEnding)}${document.lineEnding}`;
}

function utf16LeWithBom(text: string): Uint8Array {
	const body = Buffer.from(text, "utf16le");
	const bytes = new Uint8Array(body.byteLength + 2);
	bytes[0] = 0xff;
	bytes[1] = 0xfe;
	bytes.set(body, 2);
	return bytes;
}

function fileDate(document: EdinetFixtureDocument): string {
	return document.submitted.slice(0, 10);
}

export function edinetReportEntryName(document: EdinetFixtureDocument): string {
	const serial = document.docTypeCode === "130" ? "02" : "01";
	return `XBRL_TO_CSV/jpcrp030000-asr-001_${EDINET_FIXTURE_CODE}-000_${jpEnd(document.fiscalYear)}_${serial}_${fileDate(document)}.csv`;
}

/** The entries of one fixture ZIP: the audit report (stored), the main report (deflated). */
export function edinetZipEntries(
	document: EdinetFixtureDocument,
): readonly { readonly name: string; readonly bytes: Uint8Array; readonly method: 0 | 8 }[] {
	const audit = `${csvLine(CSV_HEADER)}\r\n${csvLine(["jpaud-aar-cn_cor:OpinionOfAuditorTextBlock", "監査意見", "FilingDateInstant", "提出日時点", "その他", "時点", "－", "－", "適正"])}\r\n`;
	return [
		{
			name: `XBRL_TO_CSV/jpaud-aar-cn-001_${EDINET_FIXTURE_CODE}-000_${jpEnd(document.fiscalYear)}_01_${fileDate(document)}.csv`,
			bytes: utf16LeWithBom(audit),
			method: 0,
		},
		{
			name: edinetReportEntryName(document),
			bytes: utf16LeWithBom(edinetReportCsv(document)),
			method: 8,
		},
	];
}

export function edinetZipFixture(document: EdinetFixtureDocument): Uint8Array {
	return buildTestZip(edinetZipEntries(document));
}

type ListRow = Record<string, string | number | null>;

function listRow(fields: {
	readonly seq: number;
	readonly docID: string;
	readonly edinetCode: string | null;
	readonly secCode: string | null;
	readonly filerName: string;
	readonly docTypeCode: string;
	readonly periodStart: string | null;
	readonly periodEnd: string | null;
	readonly submitDateTime: string;
	readonly docDescription: string;
	readonly parentDocID?: string | null;
	readonly withdrawalStatus?: string;
	readonly csvFlag?: string;
}): ListRow {
	return {
		seqNumber: fields.seq,
		docID: fields.docID,
		edinetCode: fields.edinetCode,
		secCode: fields.secCode,
		JCN: null,
		filerName: fields.filerName,
		fundCode: null,
		ordinanceCode: "010",
		formCode: fields.docTypeCode === "130" ? "030001" : "030000",
		docTypeCode: fields.docTypeCode,
		periodStart: fields.periodStart,
		periodEnd: fields.periodEnd,
		submitDateTime: fields.submitDateTime,
		docDescription: fields.docDescription,
		issuerEdinetCode: null,
		subjectEdinetCode: null,
		subsidiaryEdinetCode: null,
		currentReportReason: null,
		parentDocID: fields.parentDocID ?? null,
		opeDateTime: null,
		withdrawalStatus: fields.withdrawalStatus ?? "0",
		docInfoEditStatus: "0",
		disclosureStatus: "0",
		xbrlFlag: "1",
		pdfFlag: "1",
		attachDocFlag: "1",
		englishDocFlag: "0",
		csvFlag: fields.csvFlag ?? "1",
		legalStatus: "1",
	};
}

/** The fixture dates: each annual report's, the amendment's, and the no-CSV amendment's. */
export function edinetFixtureDates(): readonly string[] {
	return [
		...new Set([...EDINET_FIXTURE_DOCUMENTS.map(fileDate), EDINET_FIXTURE_NO_CSV_DATE]),
	].sort();
}

/** One date's `documents.json?type=2` answer. */
export function edinetDocumentListFixture(date: string): unknown {
	const rows: ListRow[] = [];
	let seq = 1;
	const ours = EDINET_FIXTURE_DOCUMENTS.filter((document) => fileDate(document) === date);
	// Another company's annual report and a fund's filing come first on every date.
	rows.push(
		listRow({
			seq: seq++,
			docID: `S1${date.slice(5, 7)}${date.slice(8, 10)}OT`,
			edinetCode: "E99992",
			secCode: "88880",
			filerName: "フィクスチャ商事株式会社",
			docTypeCode: "120",
			periodStart: `${Number(date.slice(0, 4)) - 1}-01-01`,
			periodEnd: `${Number(date.slice(0, 4)) - 1}-12-31`,
			submitDateTime: `${date} 09:00`,
			docDescription: "有価証券報告書－第50期",
		}),
		listRow({
			seq: seq++,
			docID: `S1${date.slice(5, 7)}${date.slice(8, 10)}FD`,
			edinetCode: "E99993",
			secCode: null,
			filerName: "フィクスチャ投信株式会社",
			docTypeCode: "030",
			periodStart: null,
			periodEnd: null,
			submitDateTime: `${date} 09:15`,
			docDescription: "有価証券届出書（内国投資信託受益証券）",
		}),
	);
	for (const document of ours) {
		const year = document.fiscalYear;
		if (document.docTypeCode === "120" && year === 2025) {
			// Filed by mistake, withdrawn, then filed again (the row below).
			rows.push(
				listRow({
					seq: seq++,
					docID: "S100SYW5",
					edinetCode: EDINET_FIXTURE_CODE,
					secCode: EDINET_FIXTURE_SEC_CODE,
					filerName: EDINET_NAME,
					docTypeCode: "120",
					periodStart: jpStart(year),
					periodEnd: jpEnd(year),
					submitDateTime: `${date} 09:30`,
					docDescription: `有価証券報告書－第${year - 1950}期`,
					withdrawalStatus: "1",
				}),
			);
		}
		rows.push(
			listRow({
				seq: seq++,
				docID: document.docId,
				edinetCode: EDINET_FIXTURE_CODE,
				secCode: EDINET_FIXTURE_SEC_CODE,
				filerName: EDINET_NAME,
				docTypeCode: document.docTypeCode,
				// Spec §3-1-2-2 *3: the list states a period only for 有価証券報告書 (and 半期報告書).
				periodStart: document.docTypeCode === "130" ? null : jpStart(year),
				periodEnd: document.docTypeCode === "130" ? null : jpEnd(year),
				submitDateTime: document.submitted,
				docDescription:
					document.docTypeCode === "130"
						? `訂正有価証券報告書－第${year - 1950}期`
						: `有価証券報告書－第${year - 1950}期`,
				parentDocID: document.parentDocId,
			}),
		);
		if (document.docTypeCode === "120") {
			// The same company's internal control report the same day: not an annual report.
			rows.push(
				listRow({
					seq: seq++,
					docID: `S100IC${String(year).slice(2)}`,
					edinetCode: EDINET_FIXTURE_CODE,
					secCode: EDINET_FIXTURE_SEC_CODE,
					filerName: EDINET_NAME,
					docTypeCode: "235",
					periodStart: jpStart(year),
					periodEnd: jpEnd(year),
					submitDateTime: document.submitted,
					docDescription: `内部統制報告書－第${year - 1950}期`,
				}),
			);
		}
	}
	if (date === EDINET_FIXTURE_NO_CSV_DATE) {
		rows.push(
			listRow({
				seq: seq++,
				docID: EDINET_FIXTURE_NO_CSV_DOC,
				edinetCode: EDINET_FIXTURE_CODE,
				secCode: EDINET_FIXTURE_SEC_CODE,
				filerName: EDINET_NAME,
				docTypeCode: "130",
				periodStart: null,
				periodEnd: null,
				submitDateTime: `${date} 11:00`,
				docDescription: "訂正有価証券報告書－第75期",
				parentDocID: "S100SY25",
				csvFlag: "0",
			}),
		);
	}
	return {
		_fixture:
			"SYNTHETIC. Generated by scripts/vectors/finance/equitySyncFixtures.ts in the documented shape of https://api.edinet-fsa.go.jp/api/v2/documents.json?type=2. The filers and documents are invented; this is not EDINET data.",
		metadata: {
			title: "提出された書類を把握するためのAPI",
			parameter: { date, type: "2" },
			resultset: { count: rows.length },
			processDateTime: `${date} 23:59`,
			status: "200",
			message: "OK",
		},
		results: rows,
	};
}

/* ---------- E2E completions (what the extraction makes of the inputs above) ---------- */

/** The claim concepts per provider (the registry's, as the API sends them). */
const SEC_CONCEPTS = equityConceptsOfProvider("sec");
const EDINET_CONCEPTS = equityConceptsOfProvider("edinet");

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

/**
 * Annual rows as the API names them in a claim's `indexedFilings` (ADR-0058
 * §4): oldest submission first, each with the row's metadata; an amendment
 * (130), whose row states no period (spec §3-1-2-2 *3), takes its
 * original's period from these rows, else it is left out (the API cannot
 * name a report without a period either).
 */
export function edinetIndexedFilings(rows: readonly EdinetAnnualRow[]): EquityPendingFiling[] {
	const byId = new Map(rows.map((row) => [row.docId, row]));
	const filings: EquityPendingFiling[] = [];
	const ordered = [...rows].sort(
		(a, b) =>
			(a.submitDateTime < b.submitDateTime ? -1 : a.submitDateTime > b.submitDateTime ? 1 : 0) ||
			(a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0),
	);
	for (const row of ordered) {
		const original = row.parentDocId === null ? undefined : byId.get(row.parentDocId);
		const originalEnd = original?.periodEnd ?? null;
		const period =
			row.periodEnd !== null
				? { periodStart: row.periodStart, periodEnd: row.periodEnd }
				: row.docTypeCode === "130" && originalEnd !== null
					? { periodStart: original?.periodStart ?? null, periodEnd: originalEnd }
					: null;
		if (period === null) continue;
		filings.push({
			sourceDocumentId: row.docId,
			form: row.docTypeCode === "120" ? "securities-report" : "amended-securities-report",
			filedOn: row.submitDateTime.slice(0, 10),
			submittedAt: `${row.submitDateTime.replace(" ", "T")}:00+09:00`,
			...period,
			amendsSourceDocumentId: row.parentDocId,
			sourceUrl: edinetViewerUrl(row.docId),
		});
	}
	return filings;
}

export function e2eEdinetCompletion(): unknown {
	const listed = edinetFixtureDates()
		.filter((date) => date !== EDINET_FIXTURE_NO_CSV_DATE)
		.flatMap((date) => must(parseEdinetDocumentList(edinetDocumentListFixture(date))))
		.filter((row) => row.secCode === EDINET_FIXTURE_SEC_CODE);
	// The source's own plan over the reports the index names (ADR-0058 §4).
	const plan = edinetDownloadPlan({
		pending: [],
		indexed: edinetIndexedFilings(listed),
		knownFilings: [],
		maxDownloads: listed.length,
	});
	let description: EquityBusinessDescription | null = null;
	const filings = plan.map(({ metadata }) => {
		const document = EDINET_FIXTURE_DOCUMENTS.find(
			(entry) => entry.docId === metadata.sourceDocumentId,
		);
		if (document === undefined) throw new Error(`unexpected row ${metadata.sourceDocumentId}`);
		const report = must(extractEdinetReport(edinetZipFixture(document), EDINET_CONCEPTS));
		if (metadata.form === "securities-report") {
			description = newerBusinessDescription(
				description,
				businessDescriptionOf(
					{
						sourceDocumentId: metadata.sourceDocumentId,
						form: "securities-report",
						filedOn: metadata.filedOn,
						periodEnd: metadata.periodEnd,
						sourceUrl: metadata.sourceUrl,
					},
					report.business,
				),
			);
		}
		return {
			...metadata,
			accountingStandard: report.accountingStandard,
			factsStatus: "extracted" as const,
			facts: report.facts,
		};
	});
	// The filer as EDINET's rows name it (the E2E fixture keeps its name and year end).
	const first = listed[0];
	const original = listed.find((row) => row.docTypeCode === "120" && row.periodEnd !== null);
	if (first === undefined) throw new Error("the EDINET fixture lists no report");
	return {
		_fixture:
			"SYNTHETIC. The EDINET financial-synced completion fields (identity, filings, description) that the extraction makes of examples/fixtures/equity-sync/edinet-*.synthetic.* (six annual reports and one amendment; the description is the newest annual report's 事業の内容). Served by the E2E fixture financial source (both runners) for any JP company; see tests/e2e/equitySyncFixtures.ts.",
		identity: {
			sourceCompanyId: first.edinetCode,
			name: first.filerName,
			fiscalYearEnd: original?.periodEnd?.slice(5) ?? null,
		},
		filings: filings.sort(compareFilingsNewestFirst),
		description,
	};
}

/* ---------- Files ---------- */

export interface FixtureFile {
	readonly name: string;
	/** Text files; ZIPs carry bytes. */
	readonly text?: string;
	readonly bytes?: Uint8Array;
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
	for (const date of edinetFixtureDates()) {
		files.push({
			name: `edinet-documents-${date}.synthetic.json`,
			text: `${fixtureJson(edinetDocumentListFixture(date))}\n`,
		});
	}
	for (const document of EDINET_FIXTURE_DOCUMENTS) {
		files.push({
			name: `edinet-${document.docId}.synthetic.zip`,
			bytes: edinetZipFixture(document),
		});
	}
	files.push(
		{ name: "e2e-sec.json", text: `${JSON.stringify(e2eSecCompletion(), null, "\t")}\n` },
		{ name: "e2e-edinet.json", text: `${JSON.stringify(e2eEdinetCompletion(), null, "\t")}\n` },
	);
	return files;
}

/** Only `isoDayNumber` keeps this module's date helpers honest. */
export function assertFixtureDates(): void {
	for (const date of edinetFixtureDates()) {
		const day = isoDayNumber(date);
		if (day === null || isoDateOfDayNumber(day) !== date)
			throw new Error(`bad fixture date ${date}`);
		const weekday = (((day + 4) % 7) + 7) % 7;
		if (weekday === 0 || weekday === 6) throw new Error(`fixture date ${date} is a weekend`);
	}
}

async function main(): Promise<void> {
	assertFixtureDates();
	await mkdir(EQUITY_SYNC_FIXTURE_DIR, { recursive: true });
	for (const file of equitySyncFixtureFiles()) {
		const path = join(EQUITY_SYNC_FIXTURE_DIR, file.name);
		await writeFile(path, file.bytes ?? file.text ?? "");
		console.log(`wrote ${path}`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
