import type { Dataset, DatasetCell } from "@research/contracts";
import { formatNumber } from "./format.ts";
import { isUsMarginBuyLabel, US_MARGIN_BUY_WITHHELD_REASON } from "./positionLabels.ts";
import type { RenderContext } from "./registry.tsx";

/**
 * The single gate between stored datasets and anything that draws them. Every
 * renderer obtains its dataset through `resolveDataset`, and the shared table
 * and chart code only accept the `GuardedDataset` it returns, so a display rule
 * enforced here holds for every component type, present and future.
 */

export type DatasetColumn = Dataset["columns"][number];

export interface GuardedDataset {
	/** Cells of withheld columns are already replaced by a null value carrying the reason. */
	readonly dataset: Dataset;
	/** Column key -> why the column is not displayed. */
	readonly withheldColumns: ReadonlyMap<string, string>;
}

/** Column key -> other names a component presents that column under (e.g. chart series labels). */
export type PresentedLabels = ReadonlyMap<string, readonly string[]>;

const NO_PRESENTED_LABELS: PresentedLabels = new Map();

/**
 * FR-007 / DATA-006: no security-level US margin-buy balance exists, so a
 * column that is labelled as one (by the dataset, or by the component showing
 * it) is withheld in full. The server-side contract is the authoritative
 * guard; this is the last boundary before pixels.
 */
function withheldReason(column: DatasetColumn, presentedLabels: PresentedLabels): string | null {
	const names = [column.label, column.key, ...(presentedLabels.get(column.key) ?? [])];
	return names.some(isUsMarginBuyLabel) ? US_MARGIN_BUY_WITHHELD_REASON : null;
}

export function guardDataset(
	dataset: Dataset,
	presentedLabels: PresentedLabels = NO_PRESENTED_LABELS,
): GuardedDataset {
	const withheldColumns = new Map<string, string>();
	for (const column of dataset.columns) {
		const reason = withheldReason(column, presentedLabels);
		if (reason !== null) withheldColumns.set(column.key, reason);
	}
	if (withheldColumns.size === 0) return { dataset, withheldColumns };
	return {
		withheldColumns,
		dataset: {
			...dataset,
			rows: dataset.rows.map((row) => {
				const guarded: Record<string, DatasetCell> = { ...row };
				// The figure, its source and its as-of date are all dropped: nothing of the
				// withheld value reaches a renderer.
				for (const [key, reason] of withheldColumns) guarded[key] = { v: null, reason };
				return guarded;
			}),
		},
	};
}

/** Looks a dataset up in the render context; undefined when the workspace view does not carry it. */
export function resolveDataset(
	context: RenderContext,
	datasetRef: string,
	presentedLabels?: PresentedLabels,
): GuardedDataset | undefined {
	const dataset = context.datasets.get(datasetRef);
	return dataset === undefined ? undefined : guardDataset(dataset, presentedLabels);
}

export type CellDisplay =
	| { readonly available: true; readonly text: string }
	| { readonly available: false; readonly reason: string };

/**
 * What a cell shows. Anything that is not a real value of the column's kind is
 * unavailable with a reason: never blank, never 0, never a guess (DATA-011).
 */
export function cellDisplay(cell: DatasetCell | undefined, column: DatasetColumn): CellDisplay {
	if (cell === undefined) return { available: false, reason: "value not provided" };
	if (cell.v === null) return { available: false, reason: cell.reason ?? "reason not stated" };
	if (typeof cell.v === "number") {
		return Number.isFinite(cell.v)
			? { available: true, text: formatNumber(cell.v) }
			: { available: false, reason: "value is not a finite number" };
	}
	// Text in a number column can only be stale stored data (the contract now forbids it);
	// it is not shown as if it were a sourced figure.
	if (column.kind === "number") return { available: false, reason: "value is not numeric" };
	return { available: true, text: cell.v };
}

/**
 * What kind of figure a displayed number is (hard gate 6). "sourced" numbers
 * show their source and as-of date; the others carry a visible marker so an
 * assumption or a computed value is never mistaken for a sourced measurement.
 * "unstated" can only be stale stored data: the contract now rejects a bare number.
 */
export type CellBasis = "sourced" | "assumption" | "derived" | "unstated";

/** Null for anything that is not a displayed number (text, unavailable or missing cells). */
export function cellBasis(cell: DatasetCell | undefined): CellBasis | null {
	if (cell === undefined || typeof cell.v !== "number" || !Number.isFinite(cell.v)) return null;
	if (cell.basis !== undefined) return cell.basis;
	return cell.sourceId === undefined ? "unstated" : "sourced";
}

export const CELL_BASIS_MARKER: { readonly [B in Exclude<CellBasis, "sourced">]: string } = {
	assumption: "assumption",
	derived: "derived",
	unstated: "unsourced — basis not stated",
};

export type BasisCounts = { readonly [B in Exclude<CellBasis, "sourced">]: number };

/** How many numbers in the given columns are not sourced measurements, by kind. */
export function countUnsourcedNumbers(
	data: GuardedDataset,
	columnKeys: readonly string[],
): BasisCounts {
	const counts = { assumption: 0, derived: 0, unstated: 0 };
	for (const row of data.dataset.rows) {
		for (const key of new Set(columnKeys)) {
			const basis = cellBasis(row[key]);
			if (basis !== null && basis !== "sourced") counts[basis] += 1;
		}
	}
	return counts;
}
