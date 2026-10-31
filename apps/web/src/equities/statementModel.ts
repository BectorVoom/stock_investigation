import type {
	EquityFilingView,
	EquityMetricCell,
	EquityStatementResponse,
} from "@research/contracts";
import type { EquityMetricCode, EquityScope } from "@research/domain";
import { formatMillions, UNDER_ONE_MILLION } from "./financialFormat.ts";

/**
 * Pure shaping of a statement answer for its table (ADR-0048 §8): columns
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
	/** The scope of the row's values (see `valuesScope`). */
	readonly scope: ValuesScope;
}

/** The one scope of some values, "mixed" when they differ, null when none has a value. */
export type ValuesScope = EquityScope | "mixed" | null;

export interface StatementTableModel {
	readonly columns: readonly StatementColumn[];
	readonly rows: readonly StatementRow[];
	/** The one currency of every value, null when the values use more than one, "" when none has a value. */
	readonly currency: string | null;
	readonly anyDerived: boolean;
	readonly anyRevised: boolean;
	/** True when a row mixes scopes, so its separate values carry a mark. */
	readonly anySeparateMarked: boolean;
	/** True when a value shows "<1" (non-zero, under half a million). */
	readonly anyUnderOne: boolean;
	readonly filingsById: ReadonlyMap<string, EquityFilingView>;
	/** The newest column's period end, for the "latest fiscal year ended" line. */
	readonly newestPeriodEnd: string | null;
}

/** True for a value more than one filing reported differently (ADR-0048 §5). */
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

/**
 * The scope of the cells that hold a value. A filer reporting only separate
 * (parent-only) statements gives "separate"; a row that mixes both — a
 * company that began consolidating — gives "mixed", and its separate values
 * are marked so no reader takes them for consolidated ones.
 */
export function valuesScope(cells: Iterable<EquityMetricCell | null>): ValuesScope {
	let found: EquityScope | null = null;
	for (const cell of cells) {
		if (cell === null || cell.valueDecimal === null || cell.scope === null) continue;
		if (found === null) found = cell.scope;
		else if (found !== cell.scope) return "mixed";
	}
	return found;
}

/** True when the value is marked "separate" in its row (the row mixes scopes). */
export function isMarkedSeparate(cell: EquityMetricCell, rowScope: ValuesScope): boolean {
	return rowScope === "mixed" && cell.valueDecimal !== null && cell.scope === "separate";
}

/** True when the value shows "<1" millions: non-zero but under half a million. */
export function showsUnderOne(cell: EquityMetricCell): boolean {
	if (cell.valueDecimal === null) return false;
	return formatMillions(cell.valueDecimal)?.endsWith(UNDER_ONE_MILLION) === true;
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
		const cells = response.fiscalYears.map((year) => byYear.get(year) ?? null);
		return { metric: row.metric, cells, scope: valuesScope(cells) };
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
		anySeparateMarked: rows.some((row) =>
			row.cells.some((cell) => cell !== null && isMarkedSeparate(cell, row.scope)),
		),
		anyUnderOne: allCells.some((cell) => cell !== null && showsUnderOne(cell)),
		filingsById: new Map(response.filings.map((filing) => [filing.filingId, filing] as const)),
		newestPeriodEnd: columns.at(-1)?.periodEnd ?? null,
	};
}

/**
 * Which fiscal-year columns a width shows (ADR-0048 §8: fewer years on a
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
