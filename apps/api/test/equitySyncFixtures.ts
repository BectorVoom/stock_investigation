/**
 * Builders for `financial-synced` completions in the API tests (ADR-0048).
 * Synthetic but shaped like what the runners send: a US 10-K reports the
 * income and cash-flow statements of three fiscal years and the balance
 * sheet of two; a Japanese 有価証券報告書 reports the current and prior year
 * (consolidated, plus some separate facts). Every value is a deterministic
 * function of (metric, fiscal year), so a test knows the expected figure.
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
	form: "10-K" | "10-K/A" | "securities-report" | "amended-securities-report";
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

const JP_CONCEPTS: Partial<Record<EquityMetricCode, string>> = {
	revenue: "jppfs_cor:NetSales",
	"gross-profit": "jppfs_cor:GrossProfit",
	"operating-income": "jppfs_cor:OperatingIncome",
	"ordinary-income": "jppfs_cor:OrdinaryIncome",
	"profit-attributable-to-owners": "jppfs_cor:ProfitLossAttributableToOwnersOfParent",
	"total-assets": "jppfs_cor:Assets",
	"total-liabilities": "jppfs_cor:Liabilities",
	"total-equity": "jppfs_cor:NetAssets",
	"cash-and-cash-equivalents": "jppfs_cor:CashAndCashEquivalents",
	"net-cash-from-operating-activities": "jppfs_cor:NetCashProvidedByUsedInOperatingActivities",
	"net-cash-from-investing-activities": "jppfs_cor:NetCashProvidedByUsedInInvestingActivities",
	"net-cash-from-financing-activities": "jppfs_cor:NetCashProvidedByUsedInFinancingActivities",
	"capital-expenditures": "jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF",
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

function negate(value: string): string {
	return value.startsWith("-") ? value.slice(1) : value === "0" ? value : `-${value}`;
}

function yearFacts(
	concepts: Partial<Record<EquityMetricCode, string>>,
	unit: string,
	fiscalYear: number,
	period: { start: string; end: string },
	options: {
		instants: boolean;
		scope: "consolidated" | "separate";
		capexSign: 1 | -1;
		override?: Partial<Record<EquityMetricCode, string>>;
	},
): Fact[] {
	const facts: Fact[] = [];
	for (const [metric, concept] of Object.entries(concepts) as [EquityMetricCode, string][]) {
		const instant = INSTANT_METRICS.includes(metric);
		if (instant && !options.instants) continue;
		let value = options.override?.[metric] ?? expectedValue(metric, fiscalYear);
		if (metric === "capital-expenditures" && options.capexSign === -1) value = negate(value);
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
					capexSign: 1,
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

/** An EDINET docID for fiscal year `fiscalYear` (`seq` keeps amendments apart). */
export function docId(fiscalYear: number, seq = 0): string {
	return `S100${String(fiscalYear % 100).padStart(2, "0")}${String.fromCharCode(65 + seq)}0`;
}

/**
 * A 有価証券報告書 for the year ending 31 March `fiscalYear`, filed 27 June:
 * current and prior year, consolidated, plus the separate revenue (which
 * must never displace the consolidated one).
 */
export function securitiesReport(
	fiscalYear: number,
	options: {
		amendment?: { seq: number; filedOn: string };
		override?: Partial<Record<EquityMetricCode, string>>;
		standard?: "JGAAP" | "IFRS";
		factsStatus?: FilingInput["factsStatus"];
		filedOn?: string;
	} = {},
): FilingInput {
	const status = options.factsStatus ?? "extracted";
	const facts: Fact[] = [];
	if (status === "extracted") {
		for (const year of [fiscalYear, fiscalYear - 1]) {
			facts.push(
				...yearFacts(JP_CONCEPTS, "JPY", year, jpPeriod(year), {
					instants: true,
					scope: "consolidated",
					capexSign: -1,
					...(year === fiscalYear && options.override !== undefined
						? { override: options.override }
						: {}),
				}),
			);
			facts.push({
				concept: "jppfs_cor:NetSales",
				unit: "JPY",
				valueDecimal: "1",
				periodType: "duration",
				periodStart: jpPeriod(year).start,
				periodEnd: jpPeriod(year).end,
				scope: "separate",
			});
		}
	}
	const id = docId(fiscalYear, options.amendment?.seq ?? 0);
	const filedOn = options.amendment?.filedOn ?? options.filedOn ?? `${fiscalYear}-06-27`;
	return {
		sourceDocumentId: id,
		form: options.amendment === undefined ? "securities-report" : "amended-securities-report",
		filedOn,
		submittedAt: `${filedOn}T15:00:00+09:00`,
		periodStart: jpPeriod(fiscalYear).start,
		periodEnd: jpPeriod(fiscalYear).end,
		amendsSourceDocumentId: options.amendment === undefined ? null : docId(fiscalYear, 0),
		sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${id}`,
		accountingStandard: status === "extracted" ? (options.standard ?? "JGAAP") : null,
		factsStatus: status,
		facts,
	};
}

/** A `financial-synced` completion body. */
export function syncedCompletion(
	lease: { readonly leaseGeneration: number; readonly companyId: string },
	provider: "sec" | "edinet",
	filings: readonly FilingInput[],
	options: {
		identity?: {
			sourceCompanyId: string;
			name: string | null;
			fiscalYearEnd: string | null;
		} | null;
		scannedDays?: readonly string[];
		more?: boolean;
		fetchedAt?: string;
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
					: { sourceCompanyId: "E02367", name: "任天堂株式会社", fiscalYearEnd: "03-31" }
				: options.identity,
		scannedDays: [...(options.scannedDays ?? [])],
		filings: [...filings],
		more: options.more ?? false,
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
