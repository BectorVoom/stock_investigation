import { For, type JSX, onCleanup } from "solid-js";
import type { WidgetBase } from "../core/types.ts";
import { createWidgetDrag, type WidgetDragDrop } from "./widgetDrag.ts";

export type { WidgetDragDrop };

export interface WidgetGridProps<W extends WidgetBase = WidgetBase> {
	readonly widgets: readonly W[];
	/** The host's own condition for starting a drag (for example `!busy()`). */
	readonly canDrag: boolean;
	/**
	 * Called once per committed drop with the reorder to save. May return a
	 * promise: until it settles no new drag starts and the previewed order
	 * stays on screen, afterwards the preview `order` values are cleared.
	 */
	readonly onReorder: (drop: WidgetDragDrop) => unknown;
	/** Renders one widget (usually a `WidgetFrame` with the host's body). */
	readonly children: (widget: W) => JSX.Element;
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
		canStart: () => !savingPreview && props.canDrag,
		extraIgnoreSelector: "sl-dialog,sl-select,sl-input,sl-option",
		onDrop: (drop) => {
			savingPreview = true;
			let result: unknown;
			try {
				result = props.onReorder(drop);
			} catch {
				savingPreview = false;
				controller.clearPreview();
				return;
			}
			if (result !== undefined && typeof (result as Promise<unknown>).then === "function") {
				void (result as Promise<unknown>).then(
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
			class="wg-grid"
			ref={(element) => {
				gridEl = element;
			}}
			onPointerDown={(event) => controller.onPointerDown(event as PointerEvent)}
		>
			<For each={props.widgets}>{(widget) => props.children(widget)}</For>
		</div>
	);
}
