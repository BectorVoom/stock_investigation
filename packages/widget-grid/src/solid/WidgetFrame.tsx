import { createUniqueId, type JSX, Show } from "solid-js";
import type { WidgetBase } from "../core/types.ts";

export interface WidgetFrameProps<W extends WidgetBase = WidgetBase> {
	readonly widget: W;
	readonly actions?: JSX.Element;
	readonly children: JSX.Element;
	/**
	 * Hides the title visually (ADR-0021): it stays the accessible name of the
	 * frame and its body, the header shrinks to the host's actions and the body starts at the top of the frame. The
	 * frame carries `data-widget-title-hidden`.
	 */
	readonly titleHidden?: boolean;
}

/**
 * One widget on the grid: a native `article` frame that fills its grid cell
 * exactly. The header is a single clean strip holding only the title and
 * the host's actions slot (the whole strip is the drag handle; there is no
 * grip glyph, ADR-0063); the body below it scrolls inside the frame when
 * taller and is keyboard-focusable (labelled by the widget title). With
 * `titleHidden` the header is instead an overlay pinned to the top edge
 * (see styles.css), the
 * body starts at the top of the frame, and the frame's top padding is a
 * full-width drag strip: holding the top of a widget picks it up.
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
			<Show when={props.titleHidden === true}>
				{/* The top edge as a drag handle (pointer only: the menu's Move
				    earlier / later is the keyboard path), over the empty padding,
				    never over the content. */}
				<div
					aria-hidden="true"
					class="wg-drag-strip"
					data-widget-drag-handle={props.widget.widgetId}
				/>
			</Show>
			<div class="wg-header" data-widget-drag-handle={props.widget.widgetId}>
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
