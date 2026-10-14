/**
 * Shared vocabulary of the widget grid. Everything in `core/` is pure
 * TypeScript: no DOM, no framework, no npm package — it runs unchanged in a
 * browser, in Node and in a Worker.
 */

/** The three fixed widget sizes (Apple HIG Widgets: fixed sizes on a grid of equal cells). */
export type WidgetSize = "small" | "medium" | "large";

/**
 * What the grid, the frame, the drag engine and the agent layer need to know
 * about one widget. A host's own widget type extends this structurally (extra
 * fields are the widget's configuration and stay opaque to this package).
 */
export interface WidgetBase {
	/** Unique within one grid. */
	readonly widgetId: string;
	/** Key of the host's widget type (its registry entry). */
	readonly type: string;
	readonly title: string;
	readonly size: WidgetSize;
}

/** Expected failures are values, never exceptions. */
export type Result<T, E> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });
export const err = <E>(error: E): { readonly ok: false; readonly error: E } => ({
	ok: false,
	error,
});
