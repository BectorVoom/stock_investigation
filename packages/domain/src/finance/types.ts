/** ISO 4217 code, e.g. "JPY" or "USD". */
export type CurrencyCode = string;

export type Market = "JP" | "US";

export interface Money {
	readonly amount: number;
	readonly currency: CurrencyCode;
}

export type AccountingStandard = "US-GAAP" | "IFRS" | "JGAAP" | "OTHER";

export type FiscalPeriod = "FY" | "Q1" | "Q2" | "Q3" | "Q4" | "TTM";

export interface ReportingPeriod {
	readonly fiscalYear: number;
	readonly fiscalPeriod: FiscalPeriod;
	/** Inclusive ISO dates (YYYY-MM-DD). */
	readonly periodStart: string;
	readonly periodEnd: string;
}

export type ActualOrEstimate = "actual" | "estimate";

export type AdjustmentBasis = "split-adjusted" | "unadjusted";

export function isSameReportingPeriod(a: ReportingPeriod, b: ReportingPeriod): boolean {
	return (
		a.fiscalYear === b.fiscalYear &&
		a.fiscalPeriod === b.fiscalPeriod &&
		a.periodStart === b.periodStart &&
		a.periodEnd === b.periodEnd
	);
}
