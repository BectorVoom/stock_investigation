import { type Accessor, For, type JSX, onCleanup } from "solid-js";
import type { WidgetBase } from "../core/types.ts";
import { WIDGET_GRID_CLASS } from "./classNames.ts";
import { createWidgetDrag, type WidgetDragDrop } from "./widgetDrag.ts";

export type { WidgetDragDrop };

/** True for a value with a callable `then` (narrowed without a cast). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

export interface WidgetGridProps<W extends WidgetBase = WidgetBase> {
	readonly widgets: readonly W[];
	/**
	 * The host's own condition for starting a drag (for example `!busy()`).
	 * Defaults to `true` when omitted.
	 */
	readonly canDrag?: boolean;
	/**
	 * Extra selector for controls that never start a drag, appended to the
	 * drag engine's native list. Read lazily on every press, so the host's
	 * own elements stay out of the package.
	 */
	readonly ignoreDragFrom?: string;
	/**
	 * Called once per committed drop with the reorder to save. May return a
	 * promise: until it settles no new drag starts and the previewed order
	 * stays on screen, afterwards the preview `order` values are cleared.
	 * A synchronous throw propagates to the host after the preview is
	 * cleared; a rejected promise only clears the preview (the host owns
	 * its own failure handling).
	 */
	readonly onReorder: (drop: WidgetDragDrop) => unknown;
	/**
	 * Renders one widget (usually a `WidgetFrame` with the host's body).
	 * The position arrives as `<For>`'s index accessor, so a reorder
	 * updates every child's reported position without re-creating it.
	 */
	readonly children: (widget: W, index: Accessor<number>) => JSX.Element;
	/**
	 * What decides the column count. `"viewport"` (default): 4 columns from
	 * the wide breakpoint of the viewport, as on a full-width page.
	 * `"container"`: the grid's own width decides, so a grid inside a side
	 * panel lays out by the space it actually has.
	 */
	readonly columnsFrom?: "viewport" | "container";
	/**
	 * `"card"` (default): every frame shows its hairline. `"quiet"`: frames
	 * are separated by tone and space only; the boundary appears on hover,
	 * focus and selection.
	 */
	readonly variant?: "card" | "quiet";
}

/**
 * The widget grid: the `data-widget-grid` element, the drag controller and
 * the "keep the previewed order until the save settles" wiring. Props are
 * read lazily (never destructured); the `<For>` is keyed by widget
 * reference, and the children function is only re-run for widgets whose
 * reference changed.
 */
export function WidgetGrid<W extends WidgetBase>(props: WidgetGridProps<W>): JSX.Element {
	let gridEl: HTMLDivElement | undefined;
	/** True while a dropped preview is being saved (blocks a new drag). */
	let savingPreview = false;

	const controller = createWidgetDrag<W>({
		getGrid: () => gridEl,
		getWidgets: () => props.widgets,
		canStart: () => !savingPreview && (props.canDrag ?? true),
		get extraIgnoreSelector(): string | undefined {
			return props.ignoreDragFrom;
		},
		onDrop: (drop) => {
			savingPreview = true;
			let result: unknown;
			try {
				result = props.onReorder(drop);
			} catch (error) {
				savingPreview = false;
				controller.clearPreview();
				throw error;
			}
			if (isThenable(result)) {
				void result.then(
					() => {
						savingPreview = false;
						controller.clearPreview();
					},
					() => {
						savingPreview = false;
						controller.clearPreview();
					},
				);
			} else {
				savingPreview = false;
				controller.clearPreview();
			}
		},
	});

	onCleanup(() => {
		controller.dispose();
		savingPreview = false;
	});

	return (
		<div
			data-widget-grid
			data-widget-columns-from={props.columnsFrom ?? "viewport"}
			data-widget-variant={props.variant ?? "card"}
			class={WIDGET_GRID_CLASS}
			ref={(element) => {
				gridEl = element;
			}}
			onPointerDown={(event) => controller.onPointerDown(event)}
		>
			<For each={props.widgets}>{(widget, index) => props.children(widget, index)}</For>
		</div>
	);
}
