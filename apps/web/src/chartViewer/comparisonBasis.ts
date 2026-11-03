import { type ChartInterval, inNextBucket } from "@research/domain";
import type { DetailChartModel } from "@research/ui-registry";

/*
 * What a chart readout's change is measured against (ADR-0069 §7). Apart
 * from `readout.ts` so its messages can name a basis without an import cycle.
 */

/** What the readout's changes are measured against (see `comparisonBasis`). */
export interface ReadoutComparison {
	/** The bar interval the model was drawn at. */
	readonly interval: ChartInterval;
	/** Per model series (aligned with `units`): whether its source is daily. */
	readonly dailySource: readonly boolean[];
}

/** A change's base: one whole period before, or the base bar's date. */
export type ComparisonBasis =
	| { readonly kind: "period"; readonly interval: ChartInterval }
	| { readonly kind: "date"; readonly iso: string };

/**
 * The base of series `slot`'s change at bar `index` against its bar at
 * `previousIndex`. Daily bars name 前日比 only for a daily source, whose
 * previous bar is its previous trading day (weekends and holidays are no
 * gap); coarser bars name their period only when the base lies in the
 * period right before (`inNextBucket`). Anything else names the base's date.
 */
export function comparisonBasis(
	model: DetailChartModel,
	comparison: ReadoutComparison,
	slot: number,
	previousIndex: number,
	index: number,
): ComparisonBasis {
	const { interval } = comparison;
	const previousDay = model.dayAt[previousIndex];
	const day = model.dayAt[index];
	const adjacent =
		interval === "daily"
			? comparison.dailySource[slot] === true
			: previousDay !== undefined && day !== undefined && inNextBucket(previousDay, day, interval);
	if (adjacent) return { kind: "period", interval };
	return { kind: "date", iso: model.isoAt[previousIndex] ?? "" };
}
