import { isWidgetSize } from "./sizes.ts";
import { err, ok, type Result, type WidgetBase, type WidgetSize } from "./types.ts";

/**
 * Pure layout edits for a widget grid: the package's counterpart of
 * `applyDashboardEdit` in the domain package. The domain cannot import this
 * package and this package must not import the domain, so the two
 * implementations are deliberately duplicated; the Lean model's dashboard
 * vectors are replayed against both in the conformance tests, so neither can
 * drift from the proved model or from the other.
 *
 * Semantics mirror `applyDashboardEdit`: `add` appends, `remove` deletes one
 * widget, `move` swaps with the neighbour, `reorder` lands the widget at
 * `toIndex` of the result while the others keep their relative order (one
 * pass), `replace` swaps the widget under the same id at the same position.
 * `resize` changes one `size` and touches nothing else. `add` with `toIndex`
 * is exactly "append, then reorder to `toIndex`" and is implemented as that
 * composition. Never mutates its input.
 */

export interface WidgetLayoutLimits {
	readonly maxWidgets: number;
}

export const DEFAULT_WIDGET_LAYOUT_LIMITS: WidgetLayoutLimits = { maxWidgets: 24 };

export type WidgetLayoutEdit<W extends WidgetBase> =
	| { readonly kind: "add"; readonly widget: W; readonly toIndex?: number }
	| { readonly kind: "remove"; readonly widgetId: string }
	| { readonly kind: "move"; readonly widgetId: string; readonly direction: "earlier" | "later" }
	| { readonly kind: "reorder"; readonly widgetId: string; readonly toIndex: number }
	| { readonly kind: "resize"; readonly widgetId: string; readonly size: WidgetSize }
	| { readonly kind: "replace"; readonly widget: W };

export type WidgetLayoutError =
	| "DUPLICATE_WIDGET_ID"
	| "WIDGET_NOT_FOUND"
	| "MOVE_AT_END"
	| "POSITION_OUT_OF_RANGE"
	| "TOO_MANY_WIDGETS"
	| "INVALID_WIDGET";

function invalidWidget(widget: WidgetBase): boolean {
	return widget.widgetId.length === 0 || !isWidgetSize(widget.size);
}

function appendWidget<W extends WidgetBase>(
	widgets: readonly W[],
	widget: W,
	limits: WidgetLayoutLimits,
): Result<readonly W[], WidgetLayoutError> {
	if (invalidWidget(widget)) return err("INVALID_WIDGET");
	if (widgets.some((candidate) => candidate.widgetId === widget.widgetId)) {
		return err("DUPLICATE_WIDGET_ID");
	}
	const next = [...widgets, widget];
	if (next.length > limits.maxWidgets) return err("TOO_MANY_WIDGETS");
	return ok(next);
}

function reorderWidgets<W extends WidgetBase>(
	widgets: readonly W[],
	widgetId: string,
	toIndex: number,
): Result<readonly W[], WidgetLayoutError> {
	if (widgetId.length === 0) return err("INVALID_WIDGET");
	const index = widgets.findIndex((widget) => widget.widgetId === widgetId);
	if (index === -1) return err("WIDGET_NOT_FOUND");
	if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex > widgets.length - 1) {
		return err("POSITION_OUT_OF_RANGE");
	}
	const moved = widgets[index];
	if (moved === undefined) return err("WIDGET_NOT_FOUND");
	// One pass over the result positions: the moved widget lands at
	// `toIndex` of the result, every other widget keeps its order.
	const next: W[] = new Array<W>(widgets.length);
	let source = 0;
	for (let target = 0; target < next.length; target += 1) {
		if (target === toIndex) {
			next[target] = moved;
			continue;
		}
		if (source === index) source += 1;
		const widget = widgets[source];
		if (widget === undefined) return err("WIDGET_NOT_FOUND");
		next[target] = widget;
		source += 1;
	}
	return ok(next);
}

/**
 * Pure widget-grid transition. Enforces id uniqueness and the widget limit;
 * `move` at an end is a typed error. Generic over the widget type so a host's
 * own widgets go in and widgets of the same type come out.
 */
export function applyWidgetLayoutEdit<W extends WidgetBase>(
	widgets: readonly W[],
	edit: WidgetLayoutEdit<W>,
	limits: WidgetLayoutLimits = DEFAULT_WIDGET_LAYOUT_LIMITS,
): Result<readonly W[], WidgetLayoutError> {
	switch (edit.kind) {
		case "add": {
			const appended = appendWidget(widgets, edit.widget, limits);
			if (!appended.ok || edit.toIndex === undefined) return appended;
			// `add` at a position is append followed by reorder: a valid
			// `toIndex` is any position of the result, `0..widgets.length`.
			return reorderWidgets(appended.value, edit.widget.widgetId, edit.toIndex);
		}
		case "remove": {
			if (edit.widgetId.length === 0) return err("INVALID_WIDGET");
			if (!widgets.some((widget) => widget.widgetId === edit.widgetId)) {
				return err("WIDGET_NOT_FOUND");
			}
			return ok(widgets.filter((widget) => widget.widgetId !== edit.widgetId));
		}
		case "move": {
			if (edit.widgetId.length === 0) return err("INVALID_WIDGET");
			const index = widgets.findIndex((widget) => widget.widgetId === edit.widgetId);
			if (index === -1) return err("WIDGET_NOT_FOUND");
			const target = edit.direction === "earlier" ? index - 1 : index + 1;
			if (target < 0 || target >= widgets.length) return err("MOVE_AT_END");
			const next = [...widgets];
			const current = next[index];
			const other = next[target];
			if (current === undefined || other === undefined) return err("WIDGET_NOT_FOUND");
			next[index] = other;
			next[target] = current;
			return ok(next);
		}
		case "reorder": {
			return reorderWidgets(widgets, edit.widgetId, edit.toIndex);
		}
		case "resize": {
			if (edit.widgetId.length === 0 || !isWidgetSize(edit.size)) {
				return err("INVALID_WIDGET");
			}
			const index = widgets.findIndex((widget) => widget.widgetId === edit.widgetId);
			if (index === -1) return err("WIDGET_NOT_FOUND");
			return ok(
				widgets.map((widget) =>
					widget.widgetId === edit.widgetId ? { ...widget, size: edit.size } : widget,
				),
			);
		}
		case "replace": {
			if (invalidWidget(edit.widget)) return err("INVALID_WIDGET");
			const index = widgets.findIndex((widget) => widget.widgetId === edit.widget.widgetId);
			if (index === -1) return err("WIDGET_NOT_FOUND");
			return ok(widgets.map((widget, position) => (position === index ? edit.widget : widget)));
		}
	}
}
