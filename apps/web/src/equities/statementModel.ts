import type {
	EquityFilingView,
	EquityMetricCell,
	EquityStatementResponse,
} from "@research/contracts";
import type { EquityMetricCode } from "@research/domain";

/**
 * Pure shaping of a statement answer for its table (ADR-0045 §8): columns
 * are fiscal years oldest → newest, each with its period end; rows are the
 * statement's metrics in registry order with one cell per year.
 */

export interface StatementColumn {
	readonly fiscalYear: number;
	/** The year's period end as the values state it; null when no value of the year names one. */
	readonly periodEnd: string | null;
}

export interface StatementRow {
	readonly metric: EquityMetricCode;
	/** One per column, in column order; null where the answer has no cell for that year. */
	readonly cells: readonly (EquityMetricCell | null)[];
}

export interface StatementTableModel {
	readonly columns: readonly StatementColumn[];
	readonly rows: readonly StatementRow[];
	/** The one currency of every value, null when the values use more than one, "" when none has a value. */
	readonly currency: string | null;
	readonly anyDerived: boolean;
	readonly anyRevised: boolean;
	readonly filingsById: ReadonlyMap<string, EquityFilingView>;
	/** The newest column's period end, for the "latest fiscal year ended" line. */
	readonly newestPeriodEnd: string | null;
}

/** True for a value more than one filing reported differently (ADR-0045 §5). */
export function isRevised(cell: EquityMetricCell): boolean {
	return cell.valueDecimal !== null && cell.reportedValueCount > 1;
}

/**
 * The one currency of a set of cells: "" when none holds a value, null when
 * they differ (each value then names its own currency).
 */
export function sharedCurrency(cells: Iterable<EquityMetricCell | null>): string | null {
	let found = "";
	for (const cell of cells) {
		const currency = cell?.currency ?? null;
		if (currency === null) continue;
		if (found === "") found = currency;
		else if (found !== currency) return null;
	}
	return found;
}

export function statementTableModel(response: EquityStatementResponse): StatementTableModel {
	const periodEnds = new Map<number, string>();
	const rows = response.rows.map((row): StatementRow => {
		const byYear = new Map<number, EquityMetricCell>();
		for (const cell of row.cells) {
			byYear.set(cell.fiscalYear, cell);
			if (cell.periodEnd !== null && !periodEnds.has(cell.fiscalYear)) {
				periodEnds.set(cell.fiscalYear, cell.periodEnd);
			}
		}
		return {
			metric: row.metric,
			cells: response.fiscalYears.map((year) => byYear.get(year) ?? null),
		};
	});
	const columns = response.fiscalYears.map(
		(fiscalYear): StatementColumn => ({
			fiscalYear,
			periodEnd: periodEnds.get(fiscalYear) ?? null,
		}),
	);
	const allCells = rows.flatMap((row) => row.cells);
	return {
		columns,
		rows,
		currency: sharedCurrency(allCells),
		anyDerived: allCells.some((cell) => cell?.derived === true && cell.valueDecimal !== null),
		anyRevised: allCells.some((cell) => cell !== null && isRevised(cell)),
		filingsById: new Map(response.filings.map((filing) => [filing.filingId, filing] as const)),
		newestPeriodEnd: columns.at(-1)?.periodEnd ?? null,
	};
}

/**
 * Which fiscal-year columns a width shows (ADR-0045 §8: fewer years on a
 * narrow frame): the newest two always, then two more at each container
 * step. Index 0 is the oldest of `count` columns. Whole class names, so the
 * stylesheet build finds them; a hidden column is hidden from assistive
 * technology too, like the Watchlist prices columns.
 */
const COLUMN_STEPS = [
	"",
	"",
	"hidden @md:table-cell",
	"hidden @md:table-cell",
	"hidden @2xl:table-cell",
	"hidden @2xl:table-cell",
	"hidden @4xl:table-cell",
	"hidden @4xl:table-cell",
	"hidden @6xl:table-cell",
] as const;

export function yearColumnClass(index: number, count: number): string {
	const fromNewest = count - 1 - index;
	return COLUMN_STEPS[Math.min(fromNewest, COLUMN_STEPS.length - 1)] ?? "";
}
