import { createUniqueId, type JSX } from "solid-js";
import type { WidgetBase } from "../core/types.ts";

export interface WidgetFrameProps<W extends WidgetBase = WidgetBase> {
	readonly widget: W;
	readonly actions?: JSX.Element;
	readonly children: JSX.Element;
	/**
	 * Hides the title visually (ADR-0021): it stays the accessible name of the
	 * frame and its body, the header shrinks to its controls (grip and
	 * actions) and the body starts at the top of the frame. The
	 * frame carries `data-widget-title-hidden`.
	 */
	readonly titleHidden?: boolean;
}

/**
 * One widget on the grid: a native `article` frame that fills its grid cell
 * exactly. The header is a single clean strip holding only the grip glyph,
 * the title and the host's actions slot (the whole strip is the drag
 * handle); the body below it scrolls inside the frame when taller and is
 * keyboard-focusable (labelled by the widget title). With `titleHidden` the
 * header is instead an overlay pinned to the top edge (see styles.css) and
 * the body starts at the top of the frame.
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
			data-widget-title-hidden={props.titleHidden === true ? "" : undefined}
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
				<h3 id={titleId} class={props.titleHidden === true ? "wg-visually-hidden" : "wg-title"}>
					{props.widget.title}
				</h3>
				<span class="wg-header-actions">{props.actions}</span>
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: the scrollable widget body is a named group (labelled by the widget title), not a form — fieldset does not apply. */}
			<div tabindex="0" role="group" aria-labelledby={titleId} class="wg-body">
				{props.children}
			</div>
		</article>
	);
}
