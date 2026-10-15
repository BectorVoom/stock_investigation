import type { WidgetBase } from "@research/widget-grid";
import { type Accessor, createMemo } from "solid-js";

/**
 * One widget as the grid sees it: a stable object per `widgetId` whose
 * fields read the current widget (Home and the Notebook alike, ADR-0024).
 */
export interface WidgetGridEntry<W extends WidgetBase> extends WidgetBase {
	readonly widget: W;
}

/**
 * Grid entries that keep their identity per `widgetId` while the widget
 * changes. The grid's `<For>` is keyed by reference and every saved edit
 * replaces the widget object (a new revision), so without this an autosave
 * would re-create the frame — closing an open in-place text editor and
 * dropping its caret and undo history. Reorders move the same entries;
 * removed ids are forgotten. Must be called inside a reactive owner.
 */
export function createWidgetGridEntries<W extends WidgetBase>(
	widgets: Accessor<readonly W[]>,
): Accessor<readonly WidgetGridEntry<W>[]> {
	const byId = createMemo(
		() => new Map(widgets().map((widget) => [widget.widgetId, widget] as const)),
	);
	const entries = new Map<string, WidgetGridEntry<W>>();

	const entryFor = (first: W): WidgetGridEntry<W> => {
		const id = first.widgetId;
		// The last widget seen keeps a removed entry readable while `<For>`
		// disposes it.
		let last = first;
		const current = (): W => {
			const widget = byId().get(id);
			if (widget !== undefined) last = widget;
			return last;
		};
		return {
			widgetId: id,
			get type() {
				return current().type;
			},
			get title() {
				return current().title;
			},
			get size() {
				return current().size;
			},
			get widget() {
				return current();
			},
		};
	};

	return createMemo(() => {
		const list = widgets().map((widget) => {
			const existing = entries.get(widget.widgetId);
			if (existing !== undefined) return existing;
			const created = entryFor(widget);
			entries.set(widget.widgetId, created);
			return created;
		});
		const live = new Set(list.map((entry) => entry.widgetId));
		for (const id of entries.keys()) if (!live.has(id)) entries.delete(id);
		return list;
	});
}
