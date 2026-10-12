import { err, ok, type Result } from "../result.ts";
import {
	type AccountingStandard,
	isSameReportingPeriod,
	type Money,
	type ReportingPeriod,
} from "./types.ts";

export type NetMarginError =
	| "NON_FINITE"
	| "NON_POSITIVE_REVENUE"
	| "CURRENCY_MISMATCH"
	| "PERIOD_MISMATCH"
	| "ACCOUNTING_STANDARD_MISMATCH"
	| "CONTINUING_OPERATIONS_POLICY_MISMATCH";

export type ContinuingOperationsPolicy = "total" | "continuing-only";

export interface IncomeFigure {
	readonly amount: Money;
	readonly period: ReportingPeriod;
	readonly accountingStandard: AccountingStandard;
	readonly continuingOperationsPolicy: ContinuingOperationsPolicy;
}

export interface NetProfitMargin {
	/** Ratio, e.g. 0.12 for 12%. May be negative when the issuer reports a net loss. */
	readonly marginRatio: number;
	readonly formula: "net income / revenue";
	readonly currency: string;
	readonly period: ReportingPeriod;
	readonly accountingStandard: AccountingStandard;
	readonly continuingOperationsPolicy: ContinuingOperationsPolicy;
}

/** Net income / revenue for the same reporting period, currency and accounting basis. */
export function computeNetProfitMargin(
	netIncome: IncomeFigure,
	revenue: IncomeFigure,
): Result<NetProfitMargin, NetMarginError> {
	if (!Number.isFinite(netIncome.amount.amount) || !Number.isFinite(revenue.amount.amount)) {
		return err("NON_FINITE");
	}
	if (netIncome.amount.currency !== revenue.amount.currency) return err("CURRENCY_MISMATCH");
	if (!isSameReportingPeriod(netIncome.period, revenue.period)) return err("PERIOD_MISMATCH");
	if (netIncome.accountingStandard !== revenue.accountingStandard) {
		return err("ACCOUNTING_STANDARD_MISMATCH");
	}
	if (netIncome.continuingOperationsPolicy !== revenue.continuingOperationsPolicy) {
		return err("CONTINUING_OPERATIONS_POLICY_MISMATCH");
	}
	if (revenue.amount.amount <= 0) return err("NON_POSITIVE_REVENUE");
	const marginRatio = netIncome.amount.amount / revenue.amount.amount;
	if (!Number.isFinite(marginRatio)) return err("NON_FINITE");
	return ok({
		marginRatio,
		formula: "net income / revenue",
		currency: revenue.amount.currency,
		period: revenue.period,
		accountingStandard: revenue.accountingStandard,
		continuingOperationsPolicy: revenue.continuingOperationsPolicy,
	});
}
