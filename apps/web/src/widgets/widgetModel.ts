import { chartWidgetCitedIds, type WidgetCore, type WidgetSize } from "@research/contracts";
import {
	applyWidgetLayoutEdit,
	type WidgetBase,
	type WidgetLayoutEdit,
} from "@research/widget-grid/core";

/**
 * Pure widget edits shared by Home and the Notebook (ADR-0024): fresh ids,
 * starter widgets, deep copies and the order / size / remove transitions.
 * Generic over the page's widget type, so a Notebook widget keeps its
 * metadata and a Home widget stays a plain core.
 */

/** A fresh widget id (`w-` + random), unique on its page. */
export function newWidgetId(): string {
	return `w-${crypto.randomUUID()}`;
}

/** The content types that are added as a starter and then edited in place or in the editor. */
export type StarterWidgetType = "text" | "metric" | "chart" | "table";

export function isStarterWidgetType(type: string): type is StarterWidgetType {
	return type === "text" || type === "metric" || type === "chart" || type === "table";
}

/** A new widget of a content type, ready to be edited. */
export function starterWidget(
	type: StarterWidgetType,
	widgetId: string = newWidgetId(),
): WidgetCore {
	switch (type) {
		case "text":
			return { widgetId, type, title: "New note", size: "small", text: "New note" };
		case "metric":
			return {
				widgetId,
				type,
				title: "New metric",
				size: "small",
				value: null,
				unit: "",
				change: null,
				caption: "",
				asOf: null,
			};
		case "chart":
			return {
				widgetId,
				type,
				title: "New chart",
				size: "small",
				chartType: "line",
				unit: "",
				series: [
					{
						name: "Series 1",
						points: [
							{ x: "A", y: 1 },
							{ x: "B", y: 2 },
						],
					},
				],
			};
		case "table":
			return {
				widgetId,
				type,
				title: "New table",
				size: "small",
				columns: ["Label", "Value"],
				rows: [["Example", 1]],
			};
	}
}

/**
 * A copy of `widget` under a fresh id. Takes a page widget or a bare core
 * (the clipboard stores cores): only core fields are read, so stored
 * metadata never leaks into the copy, and nested arrays are copied.
 */
export function duplicateWidget(widget: WidgetCore, widgetId: string = newWidgetId()): WidgetCore {
	const base = { widgetId, title: widget.title, size: widget.size };
	switch (widget.type) {
		case "text":
			return { ...base, type: "text", text: widget.text };
		case "metric":
			return {
				...base,
				type: "metric",
				value: widget.value,
				unit: widget.unit,
				change: widget.change,
				caption: widget.caption,
				asOf: widget.asOf,
			};
		case "chart":
			return {
				...base,
				type: "chart",
				chartType: widget.chartType,
				unit: widget.unit,
				series: widget.series.map((entry) => ({
					name: entry.name,
					points: entry.points.map((point) => ({ ...point })),
				})),
				...(widget.xLabel === undefined ? {} : { xLabel: widget.xLabel }),
				...(widget.yLabel === undefined ? {} : { yLabel: widget.yLabel }),
				...(widget.xKind === undefined ? {} : { xKind: widget.xKind }),
				...(widget.sourceIds === undefined ? {} : { sourceIds: [...widget.sourceIds] }),
				...(widget.sources === undefined
					? {}
					: { sources: widget.sources.map((source) => ({ ...source })) }),
			};
		case "table":
			return {
				...base,
				type: "table",
				columns: [...widget.columns],
				rows: widget.rows.map((row) => [...row]),
			};
		case "research":
			return { ...base, type: "research", componentId: widget.componentId };
		case "market-metric":
			return { ...base, type: "market-metric", seriesId: widget.seriesId };
		case "line-chart":
			return { ...base, type: "line-chart", seriesIds: [...widget.seriesIds], range: widget.range };
		case "stock-table":
			return { ...base, type: "stock-table", seriesIds: [...widget.seriesIds] };
		case "indicator-table":
			return { ...base, type: "indicator-table", seriesIds: [...widget.seriesIds] };
		case "earnings-calendar":
			return { ...base, type: "earnings-calendar", daysAhead: widget.daysAhead };
	}
}

/**
 * The layout package checks widget counts against a bound; the page's own
 * capacity rule (the session's save) decides the real limit, so the layout
 * edits here only need one that never binds.
 */
const LAYOUT_LIMITS = { maxWidgets: Number.MAX_SAFE_INTEGER };

/** One layout edit; an edit the package refuses (an end, an unknown id) leaves the list as it was. */
function layoutEdit<W extends WidgetBase>(
	widgets: readonly W[],
	edit: WidgetLayoutEdit<W>,
): readonly W[] {
	const result = applyWidgetLayoutEdit(widgets, edit, LAYOUT_LIMITS);
	return result.ok ? result.value : widgets;
}

/** Moves one widget a step earlier or later (unchanged at an end). */
export function moveWidget<W extends WidgetBase>(
	widgets: readonly W[],
	widgetId: string,
	direction: "earlier" | "later",
): readonly W[] {
	return layoutEdit(widgets, { kind: "move", widgetId, direction });
}

/** Puts one widget at `toIndex`; the others keep their order. */
export function reorderWidgets<W extends WidgetBase>(
	widgets: readonly W[],
	widgetId: string,
	toIndex: number,
): readonly W[] {
	return layoutEdit(widgets, { kind: "reorder", widgetId, toIndex });
}

export function resizeWidget<W extends WidgetBase>(
	widgets: readonly W[],
	widgetId: string,
	size: WidgetSize,
): readonly W[] {
	return layoutEdit(widgets, { kind: "resize", widgetId, size });
}

/** Removes every named widget (unknown ids are ignored). */
export function removeWidgets<W extends WidgetBase>(
	widgets: readonly W[],
	widgetIds: readonly string[],
): readonly W[] {
	const removed = new Set(widgetIds);
	return widgets.filter((widget) => !removed.has(widget.widgetId));
}

type ChartWidgetCore = Extract<WidgetCore, { readonly type: "chart" }>;

/**
 * ADR-0026: an edited chart keeps a point's provenance (basis, source, as-of)
 * only while the point is unchanged — the same series name, the same label
 * (its n-th occurrence in that series) and the same value. An edited or new
 * point has none, so it is marked "basis not stated" rather than borrowing a
 * citation. The chart's own `sourceIds` stay; copies no longer cited go.
 */
export function carryChartProvenance(
	previous: ChartWidgetCore,
	edited: readonly {
		readonly name: string;
		readonly points: readonly { readonly x: string; readonly y: number }[];
	}[],
): Pick<ChartWidgetCore, "series" | "sourceIds" | "sources"> {
	const keyOf = (x: string, occurrence: number) => `${occurrence}\u0000${x}`;
	const before = new Map(
		previous.series.map((entry) => {
			const seen = new Map<string, number>();
			const points = new Map<string, ChartWidgetCore["series"][number]["points"][number]>();
			for (const point of entry.points) {
				const occurrence = seen.get(point.x) ?? 0;
				seen.set(point.x, occurrence + 1);
				points.set(keyOf(point.x, occurrence), point);
			}
			return [entry.name, points] as const;
		}),
	);
	const series = edited.map((entry) => {
		const old = before.get(entry.name);
		const seen = new Map<string, number>();
		return {
			name: entry.name,
			points: entry.points.map((point) => {
				const occurrence = seen.get(point.x) ?? 0;
				seen.set(point.x, occurrence + 1);
				const kept = old?.get(keyOf(point.x, occurrence));
				return kept !== undefined && kept.y === point.y ? { ...kept } : { x: point.x, y: point.y };
			}),
		};
	});
	const cited = new Set(chartWidgetCitedIds({ sourceIds: previous.sourceIds, series }));
	const sources = (previous.sources ?? []).filter((source) => cited.has(source.evidenceId));
	return {
		series,
		...(previous.sourceIds === undefined ? {} : { sourceIds: [...previous.sourceIds] }),
		...(sources.length === 0 ? {} : { sources }),
	};
}
