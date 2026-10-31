import type { EquityMetricCell, EquityStatementResponse } from "@research/contracts";
import {
	type EquityMetricCode,
	type EquityStatement,
	equityMetricDefinition,
} from "@research/domain";

/**
 * The Company tab's key figures (ADR-0049 §6): the newest fiscal year's
 * revenue, operating income, profit attributable to owners, total assets,
 * total equity, operating cash flow and free cash flow, read from the same
 * statement answers the Financial statements tab shows (5 years), so a stock
 * whose statements were opened costs no request more.
 */
export const KEY_FIGURE_METRICS = [
	"revenue",
	"operating-income",
	"profit-attributable-to-owners",
	"total-assets",
	"total-equity",
	"net-cash-from-operating-activities",
	"free-cash-flow",
] as const satisfies readonly EquityMetricCode[];

/** The statements the key figures come from, in strip order. */
export const KEY_FIGURE_STATEMENTS: readonly EquityStatement[] = [
	"income-statement",
	"balance-sheet",
	"cash-flow",
];

export interface KeyFigure {
	readonly metric: EquityMetricCode;
	readonly statement: EquityStatement;
	/** The statement's answer has arrived. */
	readonly loaded: boolean;
	/** The year's cell; null when the answer has no cell for the year (not reported). */
	readonly cell: EquityMetricCell | null;
}

/** The newest fiscal year any of the answers holds a column for; null when none has one. */
export function newestFiscalYear(
	answers: Iterable<EquityStatementResponse | undefined>,
): number | null {
	let newest: number | null = null;
	for (const answer of answers) {
		if (answer === undefined) continue;
		for (const year of answer.fiscalYears) {
			if (newest === null || year > newest) newest = year;
		}
	}
	return newest;
}

/** Each key figure's cell of `fiscalYear`, from the answer of its statement (absent until read). */
export function keyFigures(
	answers: ReadonlyMap<EquityStatement, EquityStatementResponse | undefined>,
	fiscalYear: number,
): readonly KeyFigure[] {
	return KEY_FIGURE_METRICS.map((metric) => {
		const statement = equityMetricDefinition(metric).statement;
		const answer = answers.get(statement);
		if (answer === undefined) return { metric, statement, loaded: false, cell: null };
		const row = answer.rows.find((entry) => entry.metric === metric);
		const cell = row?.cells.find((entry) => entry.fiscalYear === fiscalYear) ?? null;
		return { metric, statement, loaded: true, cell };
	});
}
