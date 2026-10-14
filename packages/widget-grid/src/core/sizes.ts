import type { WidgetSize } from "./types.ts";

/**
 * The sizing system: three fixed sizes on a grid of equal cells with a fixed
 * row height (Apple HIG Widgets: fixed sizes, "make each size distinct").
 *
 * The numbers here are the single source of truth. `solid/styles.css` states
 * the same grid in CSS (it cannot import TypeScript), and
 * `test/solid/stylesMetrics.test.ts` fails when the two disagree.
 */

/** Every size, smallest first. */
export const WIDGET_SIZES: readonly WidgetSize[] = ["small", "medium", "large"];

export interface WidgetGridMetrics {
	/** Columns below the wide breakpoint. */
	readonly narrowColumns: number;
	/** Columns at and above the wide breakpoint. */
	readonly wideColumns: number;
	/** Viewport width (rem) at which the grid switches to `wideColumns`. */
	readonly wideMinWidthRem: number;
	/** Fixed height of one grid row (rem). */
	readonly rowHeightRem: number;
	/** Gap between cells, both axes (rem). */
	readonly gapRem: number;
}

export const WIDGET_GRID_METRICS: WidgetGridMetrics = {
	narrowColumns: 2,
	wideColumns: 4,
	wideMinWidthRem: 64,
	rowHeightRem: 17,
	gapRem: 1,
};

/** How many grid cells one widget covers. */
export interface WidgetCellSpan {
	readonly columns: number;
	readonly rows: number;
}

export interface WidgetSizeSpan {
	/** Below the wide breakpoint (`narrowColumns` columns). */
	readonly narrow: WidgetCellSpan;
	/** At and above the wide breakpoint (`wideColumns` columns). */
	readonly wide: WidgetCellSpan;
}

/**
 * Small is one cell; Medium is 2 × 2; Large is the full width × 2 at the wide
 * breakpoint and 2 × 2 below it.
 */
export const WIDGET_SIZE_SPANS: { readonly [S in WidgetSize]: WidgetSizeSpan } = {
	small: { narrow: { columns: 1, rows: 1 }, wide: { columns: 1, rows: 1 } },
	medium: { narrow: { columns: 2, rows: 2 }, wide: { columns: 2, rows: 2 } },
	large: { narrow: { columns: 2, rows: 2 }, wide: { columns: 4, rows: 2 } },
};

/** The shape of each size in words, for size pickers and agent descriptions. */
export const WIDGET_SIZE_SHAPES: { readonly [S in WidgetSize]: string } = {
	small: "1 × 1",
	medium: "2 × 2",
	large: "full width × 2",
};

export function isWidgetSize(value: unknown): value is WidgetSize {
	return value === "small" || value === "medium" || value === "large";
}

/** Height of a widget of `rows` rows (rem): the rows plus the gaps between them. */
export function widgetHeightRem(
	rows: number,
	metrics: WidgetGridMetrics = WIDGET_GRID_METRICS,
): number {
	return rows * metrics.rowHeightRem + Math.max(0, rows - 1) * metrics.gapRem;
}
