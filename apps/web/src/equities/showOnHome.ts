import type { EquityCompanyView, EquityStatementKind } from "@research/contracts";
import type { EquityMetricCode } from "@research/domain";
import type { ApiClient } from "../api/client.ts";
import { type ShowOnHomeOutcome, showWidgetOnHome } from "../widgets/showOnHome.ts";
import { financialHistoryWidget, financialStatementWidget } from "../widgets/widgetModel.ts";
import { companyWidgetTitle } from "./FinancialWidgetDialog.tsx";

export type { ShowOnHomeOutcome };

/**
 * Appends a Financial statement widget for `company` to Home (ADR-0045 §8,
 * the Equities page's "Add to Home"); a Home already showing that company's
 * statement is left as it is.
 */
export function showStatementOnHome(
	api: ApiClient,
	company: EquityCompanyView,
	statement: EquityStatementKind,
	years: number,
): Promise<ShowOnHomeOutcome> {
	return showWidgetOnHome(
		api,
		(widget) =>
			widget.type === "financial-statement" &&
			widget.companyId === company.companyId &&
			widget.statement === statement,
		() =>
			financialStatementWidget(company.companyId, statement, years, companyWidgetTitle(company)),
	);
}

/** Appends a Financial history widget of one metric; one already on Home is left as it is. */
export function showHistoryOnHome(
	api: ApiClient,
	company: EquityCompanyView,
	metric: EquityMetricCode,
	years: number,
): Promise<ShowOnHomeOutcome> {
	return showWidgetOnHome(
		api,
		(widget) =>
			widget.type === "financial-history" &&
			widget.companyId === company.companyId &&
			widget.metric === metric,
		() => financialHistoryWidget(company.companyId, metric, years, companyWidgetTitle(company)),
	);
}
