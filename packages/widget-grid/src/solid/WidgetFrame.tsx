import { createUniqueId, type JSX } from "solid-js";
import type { WidgetBase } from "../core/types.ts";

export interface WidgetFrameProps<W extends WidgetBase = WidgetBase> {
	readonly widget: W;
	readonly actions?: JSX.Element;
	readonly children: JSX.Element;
	/** Whether the host has this widget selected (marked with `data-widget-selected`). */
	readonly selected?: boolean;
	/**
	 * Offers selection: a click on the header strip that is not a drag selects
	 * this widget alone (`"replace"`); with Shift, Ctrl or Meta it toggles it
	 * in a multiple selection (`"toggle"`). Omitted: the frame is not selectable.
	 */
	readonly onSelectChange?: (widgetId: string, mode: "replace" | "toggle") => void;
}

/**
 * One widget on the grid: a native `article` frame that fills its grid cell
 * exactly. The header is a single clean strip holding only the grip glyph,
 * the title and the host's actions slot (the whole strip is the drag
 * handle); the body below it scrolls inside the frame when taller and is
 * keyboard-focusable (labelled by the widget title).
 *
 * The `actions` slot and `children` stay live: both are read inside JSX on
 * every render, never copied to a variable.
 */
export function WidgetFrame<W extends WidgetBase>(props: WidgetFrameProps<W>): JSX.Element {
	const titleId = createUniqueId();
	return (
		<article
			aria-labelledby={titleId}
			data-widget-id={props.widget.widgetId}
			data-widget-type={props.widget.type}
			data-widget-size={props.widget.size}
			data-widget-selected={props.selected === true ? "" : undefined}
			class="wg-frame"
		>
			<div class="wg-header" data-widget-drag-handle={props.widget.widgetId}>
				<svg
					aria-hidden="true"
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="currentColor"
					class="wg-grip"
				>
					<path d="M7 2a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-3 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-3 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
				</svg>
				<h3 id={titleId} class="wg-title">
					{props.widget.title}
				</h3>
				{props.actions}
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: the scrollable widget body is a named group (labelled by the widget title), not a form — fieldset does not apply. */}
			<div tabindex="0" role="group" aria-labelledby={titleId} class="wg-body">
				{props.children}
			</div>
		</article>
	);
}
