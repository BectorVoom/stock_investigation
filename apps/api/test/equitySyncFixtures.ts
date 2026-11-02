/**
 * Builders for `financial-synced` completions in the API tests (ADR-0048).
 * Synthetic but shaped like what the runners send: a US 10-K reports the
 * income and cash-flow statements of three fiscal years and the balance
 * sheet of two; a Japanese J-Quants full-year earnings summary (ADR-0059 §2)
 * states its own fiscal year only (consolidated items, plus a
 * non-consolidated `NC…` item as scope separate). Every value is a
 * deterministic function of (metric, fiscal year), so a test knows the
 * expected figure. Figures of real companies come from the captured
 * J-Quants answers (`JQUANTS_JT_*`).
 */
import type { EquityMetricCode } from "@research/domain";
import { USAGE } from "./helpers.ts";

type Fact = {
	concept: string;
	unit: string;
	valueDecimal: string;
	periodType: "duration" | "instant";
	periodStart: string | null;
	periodEnd: string;
	scope: "consolidated" | "separate";
};

export type FilingInput = {
	sourceDocumentId: string;
	form: "10-K" | "10-K/A" | "earnings-report" | "amended-earnings-report";
	filedOn: string;
	submittedAt: string | null;
	periodStart: string | null;
	periodEnd: string;
	amendsSourceDocumentId: string | null;
	sourceUrl: string;
	accountingStandard: "US-GAAP" | "JGAAP" | "IFRS" | null;
	factsStatus: "extracted" | "not-available" | "deferred";
	facts: Fact[];
};

/** The metrics a builder reports, with the concept each provider uses and its sign as reported. */
const US_CONCEPTS: Partial<Record<EquityMetricCode, string>> = {
	revenue: "us-gaap:Revenues",
	"gross-profit": "us-gaap:GrossProfit",
	"operating-income": "us-gaap:OperatingIncomeLoss",
	"profit-attributable-to-owners": "us-gaap:NetIncomeLoss",
	"total-assets": "us-gaap:Assets",
	"total-liabilities": "us-gaap:Liabilities",
	"total-equity": "us-gaap:StockholdersEquity",
	"cash-and-cash-equivalents": "us-gaap:CashAndCashEquivalentsAtCarryingValue",
	"net-cash-from-operating-activities": "us-gaap:NetCashProvidedByUsedInOperatingActivities",
	"net-cash-from-investing-activities": "us-gaap:NetCashProvidedByUsedInInvestingActivities",
	"net-cash-from-financing-activities": "us-gaap:NetCashProvidedByUsedInFinancingActivities",
	"capital-expenditures": "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
};

/** J-Quants' summary items (ADR-0059 §2): no gross profit, liabilities or capital expenditures. */
const JQUANTS_CONCEPTS: Partial<Record<EquityMetricCode, string>> = {
	revenue: "jquants:Sales",
	"operating-income": "jquants:OP",
	"ordinary-income": "jquants:OdP",
	"profit-attributable-to-owners": "jquants:NP",
	"total-assets": "jquants:TA",
	"total-equity": "jquants:Eq",
	"cash-and-cash-equivalents": "jquants:CashEq",
	"net-cash-from-operating-activities": "jquants:CFO",
	"net-cash-from-investing-activities": "jquants:CFI",
	"net-cash-from-financing-activities": "jquants:CFF",
};

const INSTANT_METRICS: readonly EquityMetricCode[] = [
	"total-assets",
	"total-liabilities",
	"total-equity",
	"cash-and-cash-equivalents",
];

const METRIC_INDEX: Partial<Record<EquityMetricCode, number>> = {
	revenue: 1,
	"gross-profit": 2,
	"operating-income": 3,
	"ordinary-income": 4,
	"profit-attributable-to-owners": 5,
	"total-assets": 6,
	"total-liabilities": 7,
	"total-equity": 8,
	"cash-and-cash-equivalents": 9,
	"net-cash-from-operating-activities": 10,
	"net-cash-from-investing-activities": 11,
	"net-cash-from-financing-activities": 12,
	"capital-expenditures": 13,
};

/**
 * The normalized value every builder reports for a metric in a fiscal year
 * (investing and financing outflows negative; capital expenditures positive).
 */
export function expectedValue(metric: EquityMetricCode, fiscalYear: number): string {
	const index = METRIC_INDEX[metric] ?? 0;
	const amount = (fiscalYear - 2000) * 1_000_000 + index * 1_000;
	const negative =
		metric === "net-cash-from-investing-activities" ||
		metric === "net-cash-from-financing-activities";
	return negative ? `-${amount}` : String(amount);
}

/** Free cash flow as the API derives it from the builders' values. */
export function expectedFreeCashFlow(fiscalYear: number): string {
	return String(
		Number(expectedValue("net-cash-from-operating-activities", fiscalYear)) -
			Number(expectedValue("capital-expenditures", fiscalYear)),
	);
}

function yearFacts(
	concepts: Partial<Record<EquityMetricCode, string>>,
	unit: string,
	fiscalYear: number,
	period: { start: string; end: string },
	options: {
		instants: boolean;
		scope: "consolidated" | "separate";
		override?: Partial<Record<EquityMetricCode, string>>;
	},
): Fact[] {
	const facts: Fact[] = [];
	for (const [metric, concept] of Object.entries(concepts) as [EquityMetricCode, string][]) {
		const instant = INSTANT_METRICS.includes(metric);
		if (instant && !options.instants) continue;
		const value = options.override?.[metric] ?? expectedValue(metric, fiscalYear);
		facts.push({
			concept,
			unit,
			valueDecimal: value,
			periodType: instant ? "instant" : "duration",
			periodStart: instant ? null : period.start,
			periodEnd: period.end,
			scope: options.scope,
		});
	}
	return facts;
}

const usPeriod = (fiscalYear: number) => ({
	start: `${fiscalYear - 1}-10-01`,
	end: `${fiscalYear}-09-30`,
});

/** A US accession of fiscal year `fiscalYear` (`seq` keeps amendments apart). */
export function accession(fiscalYear: number, seq = 1): string {
	return `0000320193-${String(fiscalYear % 100).padStart(2, "0")}-${String(seq).padStart(6, "0")}`;
}

/**
 * A 10-K for the year ending 30 September `fiscalYear`, filed 1 November:
 * durations of the year and the two before it, instants of the year and
 * the one before. `override` replaces values of the current year.
 */
export function tenK(
	fiscalYear: number,
	options: {
		form?: "10-K" | "10-K/A";
		seq?: number;
		filedOn?: string;
		override?: Partial<Record<EquityMetricCode, string>>;
		factsStatus?: FilingInput["factsStatus"];
	} = {},
): FilingInput {
	const status = options.factsStatus ?? "extracted";
	const facts: Fact[] = [];
	if (status === "extracted") {
		for (let year = fiscalYear; year > fiscalYear - 3; year -= 1) {
			facts.push(
				...yearFacts(US_CONCEPTS, "USD", year, usPeriod(year), {
					instants: year > fiscalYear - 2,
					scope: "consolidated",
					...(year === fiscalYear && options.override !== undefined
						? { override: options.override }
						: {}),
				}),
			);
		}
	}
	const id = accession(fiscalYear, options.seq);
	return {
		sourceDocumentId: id,
		form: options.form ?? "10-K",
		filedOn: options.filedOn ?? `${fiscalYear}-11-01`,
		submittedAt: `${options.filedOn ?? `${fiscalYear}-11-01`}T06:01:36.000Z`,
		periodStart: usPeriod(fiscalYear).start,
		periodEnd: usPeriod(fiscalYear).end,
		amendsSourceDocumentId: null,
		sourceUrl: `https://www.sec.gov/Archives/edgar/data/320193/${id.replaceAll("-", "")}/aapl-${fiscalYear}0930.htm`,
		accountingStandard: status === "extracted" ? "US-GAAP" : null,
		factsStatus: status,
		facts,
	};
}

const jpPeriod = (fiscalYear: number) => ({
	start: `${fiscalYear - 1}-04-01`,
	end: `${fiscalYear}-03-31`,
});

/** A J-Quants disclosure number (`DiscNo`, 14 digits) for fiscal year `fiscalYear` (`seq` keeps corrections apart). */
export function discNo(fiscalYear: number, seq = 0): string {
	return `${fiscalYear}0508${String(seq).padStart(6, "0")}`;
}

/**
 * A J-Quants full-year earnings summary (決算短信) for the year ending 31
 * March `fiscalYear`, disclosed 8 May: the year's consolidated items plus
 * the non-consolidated sales (`NCSales`, scope separate, which must never
 * displace the consolidated one). A `correction` is a later summary of the
 * same year (`amended-earnings-report`, amending the one before it).
 */
export function earningsReport(
	fiscalYear: number,
	options: {
		correction?: { seq: number; filedOn: string };
		override?: Partial<Record<EquityMetricCode, string>>;
		standard?: "JGAAP" | "IFRS" | "US-GAAP" | null;
		code?: string;
	} = {},
): FilingInput {
	const facts: Fact[] = [
		...yearFacts(JQUANTS_CONCEPTS, "JPY", fiscalYear, jpPeriod(fiscalYear), {
			instants: true,
			scope: "consolidated",
			...(options.override === undefined ? {} : { override: options.override }),
		}),
		{
			concept: "jquants:Sales",
			unit: "JPY",
			valueDecimal: "1",
			periodType: "duration",
			periodStart: jpPeriod(fiscalYear).start,
			periodEnd: jpPeriod(fiscalYear).end,
			scope: "separate",
		},
	];
	const seq = options.correction?.seq ?? 0;
	const filedOn = options.correction?.filedOn ?? `${fiscalYear}-05-08`;
	return {
		sourceDocumentId: discNo(fiscalYear, seq),
		form: options.correction === undefined ? "earnings-report" : "amended-earnings-report",
		filedOn,
		submittedAt: `${filedOn}T06:30:00.000Z`,
		periodStart: jpPeriod(fiscalYear).start,
		periodEnd: jpPeriod(fiscalYear).end,
		amendsSourceDocumentId: seq === 0 ? null : discNo(fiscalYear, seq - 1),
		sourceUrl: `https://api.jquants.com/v2/fins/summary?code=${options.code ?? "79740"}&date=${filedOn}`,
		accountingStandard: options.standard === undefined ? "JGAAP" : options.standard,
		factsStatus: "extracted",
		facts,
	};
}

/** One stated J-Quants item of JT's FY2024 summaries (all durations but `TA`). */
function jtFact(item: string, valueDecimal: string, scope: Fact["scope"] = "consolidated"): Fact {
	const instant = item === "TA";
	return {
		concept: `jquants:${item}`,
		unit: "JPY",
		valueDecimal,
		periodType: instant ? "instant" : "duration",
		periodStart: instant ? null : "2024-01-01",
		periodEnd: "2024-12-31",
		scope,
	};
}

/**
 * JT's (2914, IFRS) FY2024 full-year summary as `GET /v2/fins/summary?code=2914`
 * answered it on 2026-11-02 (`DiscNo` 20250212569311, 2025-02-13 15:30 JST),
 * a subset of its stated items.
 */
export const JQUANTS_JT_ORIGINAL: FilingInput = {
	sourceDocumentId: "20250212569311",
	form: "earnings-report",
	filedOn: "2025-02-13",
	submittedAt: "2025-02-13T06:30:00.000Z",
	periodStart: "2024-01-01",
	periodEnd: "2024-12-31",
	amendsSourceDocumentId: null,
	sourceUrl: "https://api.jquants.com/v2/fins/summary?code=29140&date=2025-02-13",
	accountingStandard: "IFRS",
	factsStatus: "extracted",
	facts: [
		jtFact("Sales", "3149759000000"),
		jtFact("OP", "697203000000"),
		jtFact("NP", "463369000000"),
		jtFact("TA", "8281118000000"),
		jtFact("CFO", "630011000000"),
		jtFact("CFI", "-439766000000"),
		// `NCSales`: the non-consolidated sales, the plain item's concept with scope separate.
		jtFact("Sales", "530247000000", "separate"),
	],
};

/** Its correction (`DiscNo` 20250310590632, 2025-03-10): operating profit and NP restated. */
export const JQUANTS_JT_CORRECTION: FilingInput = {
	...JQUANTS_JT_ORIGINAL,
	sourceDocumentId: "20250310590632",
	form: "amended-earnings-report",
	filedOn: "2025-03-10",
	submittedAt: "2025-03-10T06:30:00.000Z",
	amendsSourceDocumentId: "20250212569311",
	sourceUrl: "https://api.jquants.com/v2/fins/summary?code=29140&date=2025-03-10",
	facts: [
		jtFact("Sales", "3149759000000"),
		jtFact("OP", "323461000000"),
		jtFact("NP", "179240000000"),
		jtFact("TA", "8370732000000"),
		jtFact("CFO", "630011000000"),
		jtFact("CFI", "-439766000000"),
	],
};

/**
 * The business description (ADR-0053) an SEC sync returns for a 10-K: two
 * paragraphs, or none when the report had no readable section. (J-Quants
 * has no business text, ADR-0059 §3.)
 */
export function businessDescription(
	filing: FilingInput,
	options: { status?: "extracted" | "not-found"; text?: string } = {},
) {
	const status = options.status ?? "extracted";
	return {
		source: {
			sourceDocumentId: filing.sourceDocumentId,
			form: "10-K" as const,
			filedOn: filing.filedOn,
			periodEnd: filing.periodEnd,
			sourceUrl: filing.sourceUrl,
		},
		status,
		paragraphs:
			status === "not-found"
				? []
				: [
						{ kind: "heading" as const, text: "Company Background" },
						{
							kind: "text" as const,
							text: options.text ?? `The Company designs smartphones (fiscal ${filing.periodEnd}).`,
						},
					],
		truncated: false,
	};
}

export type BusinessDescriptionInput = ReturnType<typeof businessDescription>;

/** A `financial-synced` completion body. */
export function syncedCompletion(
	lease: { readonly leaseGeneration: number; readonly companyId: string },
	provider: "sec" | "jquants",
	filings: readonly FilingInput[],
	options: {
		identity?: {
			sourceCompanyId: string;
			name: string | null;
			fiscalYearEnd: string | null;
		} | null;
		more?: boolean;
		fetchedAt?: string;
		description?: BusinessDescriptionInput | null;
	} = {},
) {
	return {
		outcome: "financial-synced",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		companyId: lease.companyId,
		provider,
		fetchedAt: options.fetchedAt ?? "2026-10-11T00:00:00.000Z",
		identity:
			options.identity === undefined
				? provider === "sec"
					? { sourceCompanyId: "0000320193", name: "Apple Inc.", fiscalYearEnd: "09-30" }
					: { sourceCompanyId: "79740", name: null, fiscalYearEnd: "03-31" }
				: options.identity,
		filings: [...filings],
		more: options.more ?? false,
		description: options.description ?? null,
	};
}

export function failedCompletion(
	lease: { readonly leaseGeneration: number },
	failureCode: string,
	options: { retryable?: boolean; upstreamStatus?: number } = {},
) {
	return {
		outcome: "failed",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		failureCode,
		retryable: options.retryable ?? false,
		...(options.upstreamStatus === undefined
			? {}
			: { failureUpstreamStatus: options.upstreamStatus }),
	};
}
