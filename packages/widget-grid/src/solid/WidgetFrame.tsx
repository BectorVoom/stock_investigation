import { createUniqueId, type JSX, Show } from "solid-js";
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
	/**
	 * Hides the title visually (ADR-0021): it stays the accessible name of the
	 * frame and its body, the header shrinks to its controls (grip, select
	 * toggle, actions) and the body starts at the top of the frame. The
	 * frame carries `data-widget-title-hidden`.
	 */
	readonly titleHidden?: boolean;
}

/** Interactive controls a header click must never select through. */
const SELECT_GUARD_SELECTOR =
	'button,a,input,select,textarea,summary,[role="menu"],[role="menuitem"]';

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
	const selectName = () => `Select “${props.widget.title}”`;

	const onHeaderClick = (event: MouseEvent): void => {
		const select = props.onSelectChange;
		if (select === undefined) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		// A click that landed on a control (the select toggle, the host's
		// menu button, a link…) is that control's, never a selection.
		if (target.closest(SELECT_GUARD_SELECTOR) !== null) return;
		const mode = event.shiftKey || event.ctrlKey || event.metaKey ? "toggle" : "replace";
		select(props.widget.widgetId, mode);
	};

	return (
		<article
			aria-labelledby={titleId}
			data-widget-id={props.widget.widgetId}
			data-widget-type={props.widget.type}
			data-widget-size={props.widget.size}
			data-widget-selected={props.selected === true ? "" : undefined}
			data-widget-title-hidden={props.titleHidden === true ? "" : undefined}
			class="wg-frame"
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the header strip is the drag handle; its click selects only when the host offers onSelectChange, and the same selection is always keyboard-reachable through the select toggle button. */}
			<div
				class="wg-header"
				data-widget-drag-handle={props.widget.widgetId}
				onClick={props.onSelectChange === undefined ? undefined : onHeaderClick}
			>
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
				<Show when={props.onSelectChange !== undefined}>
					<button
						type="button"
						class="wg-select-toggle"
						aria-pressed={props.selected === true}
						aria-label={selectName()}
						title={selectName()}
						onClick={(event) => {
							event.stopPropagation();
							props.onSelectChange?.(props.widget.widgetId, "toggle");
						}}
					>
						<svg
							aria-hidden="true"
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<circle cx="8" cy="8" r="6.5" />
							<path d="M5.4 8.2 7.2 10 10.7 6.1" />
						</svg>
					</button>
				</Show>
				<span class="wg-header-actions">{props.actions}</span>
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: the scrollable widget body is a named group (labelled by the widget title), not a form — fieldset does not apply. */}
			<div tabindex="0" role="group" aria-labelledby={titleId} class="wg-body">
				{props.children}
			</div>
		</article>
	);
}
