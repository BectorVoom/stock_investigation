import type { ChatMessage, WorkspaceView } from "@research/contracts";
import {
	NOTEBOOK_LIMITS,
	NOTEBOOK_WIDGET_TYPE_META,
	type NotebookWidget,
	type NotebookWidgetCore,
	type NotebookWidgetSize,
} from "@research/contracts";
import { applyWidgetLayoutEdit } from "@research/widget-grid/core";

type WorkspaceComponent = WorkspaceView["state"]["components"][number];
type WorkspaceDataset = WorkspaceView["datasets"][number];

/** A fresh widget id (`nb-` + random), unique within one notebook. */
export function newNotebookWidgetId(): string {
	return `nb-${crypto.randomUUID()}`;
}

function truncateText(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

function titleFromText(text: string, fallback: string): string {
	const words = text
		.split(/\s+/)
		.filter((word) => word.length > 0)
		.slice(0, 8);
	const joined = words.join(" ").trim();
	if (joined.length === 0) return fallback;
	return truncateText(joined, NOTEBOOK_LIMITS.maxTitleChars);
}

/** The component's own title prop when it has one (tables, charts, lists). */
function componentTitle(component: WorkspaceComponent): string | null {
	const props = component.props as { readonly title?: unknown };
	return typeof props.title === "string" && props.title.trim().length > 0
		? truncateText(props.title.trim(), NOTEBOOK_LIMITS.maxTitleChars)
		: null;
}

function datasetById(view: WorkspaceView, datasetRef: string): WorkspaceDataset | null {
	const found = view.datasets.find((dataset) => dataset.datasetId === datasetRef);
	return found ?? null;
}

function cellToNotebookCell(value: unknown): string | number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") return truncateText(value, NOTEBOOK_LIMITS.maxCellChars);
	return null;
}

function datasetCellValue(
	cell: { readonly v: string | number | null } | undefined,
): string | number | null {
	if (cell === undefined) return null;
	return cellToNotebookCell(cell.v);
}

/**
 * A table widget carrying a copy of the dataset's rows, bounded by
 * NOTEBOOK_LIMITS (truncated, never a failure on a large dataset).
 */
function tableFromDataset(
	component: WorkspaceComponent,
	dataset: WorkspaceDataset,
	widgetId: string,
): NotebookWidgetCore {
	const columns = dataset.columns
		.slice(0, NOTEBOOK_LIMITS.maxTableColumns)
		.map((column) => truncateText(column.label, NOTEBOOK_LIMITS.maxCellChars));
	const keys = dataset.columns
		.slice(0, NOTEBOOK_LIMITS.maxTableColumns)
		.map((column) => column.key);
	const rows = dataset.rows
		.slice(0, NOTEBOOK_LIMITS.maxTableRows)
		.map((row) => keys.map((key) => datasetCellValue(row[key])));
	return {
		widgetId,
		type: "table",
		title: componentTitle(component) ?? dataset.title.slice(0, NOTEBOOK_LIMITS.maxTitleChars),
		size: NOTEBOOK_WIDGET_TYPE_META.table.defaultSize,
		columns: columns.length > 0 ? columns : ["Value"],
		rows,
	};
}

interface ChartSeriesInput {
	readonly key: string;
	readonly label: string;
}

function pointsFromDataset(
	dataset: WorkspaceDataset,
	xKey: string,
	series: readonly ChartSeriesInput[],
): { readonly name: string; readonly points: { readonly x: string; readonly y: number }[] }[] {
	return series
		.slice(0, NOTEBOOK_LIMITS.maxChartSeries)
		.map((entry) => {
			const points: { readonly x: string; readonly y: number }[] = [];
			for (const row of dataset.rows) {
				if (points.length >= NOTEBOOK_LIMITS.maxChartPoints) break;
				const xCell = row[xKey]?.v;
				const yCell = row[entry.key]?.v;
				if (typeof yCell !== "number" || !Number.isFinite(yCell)) continue;
				const x =
					typeof xCell === "string"
						? truncateText(xCell, NOTEBOOK_LIMITS.maxPointLabelChars)
						: typeof xCell === "number"
							? truncateText(String(xCell), NOTEBOOK_LIMITS.maxPointLabelChars)
							: null;
				if (x === null || x.trim().length === 0) continue;
				points.push({ x, y: yCell });
			}
			return {
				name: truncateText(entry.label, NOTEBOOK_LIMITS.maxTitleChars),
				points,
			};
		})
		.filter((entry) => entry.points.length > 0);
}

function researchFallback(component: WorkspaceComponent, widgetId: string): NotebookWidgetCore {
	return {
		widgetId,
		type: "research",
		title: componentTitle(component) ?? component.componentType,
		size: NOTEBOOK_WIDGET_TYPE_META.research.defaultSize,
		componentId: component.componentId,
	};
}

/**
 * A self-contained widget from a canvas component: tables and charts become
 * `table` / `chart` widgets carrying a copy of their dataset rows (so they
 * stay editable); every other component becomes a `research` widget that
 * renders the component itself. Null when the component cannot be saved
 * (its dataset is not in `view`).
 */
export function widgetFromComponent(
	component: WorkspaceComponent,
	view: WorkspaceView,
): NotebookWidgetCore | null {
	const widgetId = newNotebookWidgetId();
	const props = component.props as {
		readonly datasetRef?: unknown;
		readonly title?: unknown;
		readonly xKey?: unknown;
		readonly categoryKey?: unknown;
		readonly dateKey?: unknown;
		readonly closeKey?: unknown;
		readonly series?: unknown;
		readonly yUnit?: unknown;
		readonly priceUnit?: unknown;
	};
	const title = componentTitle(component) ?? component.componentType;

	switch (component.componentType) {
		case "data-table":
		case "financial-table": {
			if (typeof props.datasetRef !== "string") return null;
			const dataset = datasetById(view, props.datasetRef);
			if (dataset === null) return null;
			return tableFromDataset(component, dataset, widgetId);
		}
		case "line-chart":
		case "bar-chart": {
			if (typeof props.datasetRef !== "string") return null;
			const dataset = datasetById(view, props.datasetRef);
			if (dataset === null) return null;
			const xKey =
				typeof props.xKey === "string"
					? props.xKey
					: typeof props.categoryKey === "string"
						? props.categoryKey
						: null;
			if (xKey === null || !Array.isArray(props.series))
				return researchFallback(component, widgetId);
			const series = (props.series as readonly unknown[]).flatMap((entry): ChartSeriesInput[] => {
				if (typeof entry !== "object" || entry === null) return [];
				const record = entry as { readonly key?: unknown; readonly label?: unknown };
				return typeof record.key === "string" && typeof record.label === "string"
					? [{ key: record.key, label: record.label }]
					: [];
			});
			if (series.length === 0) return researchFallback(component, widgetId);
			const converted = pointsFromDataset(dataset, xKey, series);
			if (converted.length === 0) return researchFallback(component, widgetId);
			const unit =
				typeof props.yUnit === "string" ? props.yUnit.slice(0, NOTEBOOK_LIMITS.maxUnitChars) : "";
			return {
				widgetId,
				type: "chart",
				title,
				size: NOTEBOOK_WIDGET_TYPE_META.chart.defaultSize,
				chartType: component.componentType === "bar-chart" ? "bar" : "line",
				unit,
				series: converted,
			};
		}
		case "candlestick-chart": {
			if (typeof props.datasetRef !== "string") return null;
			const dataset = datasetById(view, props.datasetRef);
			if (dataset === null) return null;
			if (typeof props.dateKey !== "string" || typeof props.closeKey !== "string") {
				return researchFallback(component, widgetId);
			}
			const closeColumn = dataset.columns.find((column) => column.key === props.closeKey);
			const converted = pointsFromDataset(dataset, props.dateKey, [
				{ key: props.closeKey, label: closeColumn?.label ?? "Close" },
			]);
			if (converted.length === 0) return researchFallback(component, widgetId);
			const unit =
				typeof props.priceUnit === "string"
					? props.priceUnit.slice(0, NOTEBOOK_LIMITS.maxUnitChars)
					: "";
			return {
				widgetId,
				type: "chart",
				title,
				size: NOTEBOOK_WIDGET_TYPE_META.chart.defaultSize,
				chartType: "line",
				unit,
				series: converted,
			};
		}
		default:
			return researchFallback(component, widgetId);
	}
}

/** An editable text widget from an assistant answer (citation chips become `[n]` text). */
export function widgetFromAnswer(message: ChatMessage): NotebookWidgetCore {
	const text =
		message.text.trim().length > 0
			? truncateText(message.text.trim(), NOTEBOOK_LIMITS.maxTextChars)
			: "(empty answer)";
	return {
		widgetId: newNotebookWidgetId(),
		type: "text",
		title: titleFromText(message.text, "Answer"),
		size: NOTEBOOK_WIDGET_TYPE_META.text.defaultSize,
		text,
	};
}

/** A copy of `widget` under a fresh id (position: directly after the original). */
export function duplicateNotebookWidget(widget: NotebookWidget): NotebookWidgetCore {
	const widgetId = newNotebookWidgetId();
	switch (widget.type) {
		case "text":
			return { widgetId, type: "text", title: widget.title, size: widget.size, text: widget.text };
		case "metric":
			return {
				widgetId,
				type: "metric",
				title: widget.title,
				size: widget.size,
				value: widget.value,
				unit: widget.unit,
				change: widget.change,
				caption: widget.caption,
				asOf: widget.asOf,
			};
		case "chart":
			return {
				widgetId,
				type: "chart",
				title: widget.title,
				size: widget.size,
				chartType: widget.chartType,
				unit: widget.unit,
				series: widget.series.map((entry) => ({
					name: entry.name,
					points: entry.points.map((point) => ({ x: point.x, y: point.y })),
				})),
			};
		case "table":
			return {
				widgetId,
				type: "table",
				title: widget.title,
				size: widget.size,
				columns: [...widget.columns],
				rows: widget.rows.map((row) => [...row]),
			};
		case "research":
			return {
				widgetId,
				type: "research",
				title: widget.title,
				size: widget.size,
				componentId: widget.componentId,
			};
	}
}

const LAYOUT_LIMITS = { maxWidgets: NOTEBOOK_LIMITS.maxWidgets };

/** Pure order/size edits over notebook widgets (order-based, never free placement). */
export function moveNotebookWidget(
	widgets: readonly NotebookWidget[],
	widgetId: string,
	direction: "earlier" | "later",
): readonly NotebookWidget[] {
	const result = applyWidgetLayoutEdit(
		widgets,
		{ kind: "move", widgetId, direction },
		LAYOUT_LIMITS,
	);
	return result.ok ? (result.value as readonly NotebookWidget[]) : widgets;
}

export function reorderNotebookWidgets(
	widgets: readonly NotebookWidget[],
	widgetId: string,
	toIndex: number,
): readonly NotebookWidget[] {
	const result = applyWidgetLayoutEdit(
		widgets,
		{ kind: "reorder", widgetId, toIndex },
		LAYOUT_LIMITS,
	);
	return result.ok ? (result.value as readonly NotebookWidget[]) : widgets;
}

export function resizeNotebookWidget(
	widgets: readonly NotebookWidget[],
	widgetId: string,
	size: NotebookWidgetSize,
): readonly NotebookWidget[] {
	const result = applyWidgetLayoutEdit(widgets, { kind: "resize", widgetId, size }, LAYOUT_LIMITS);
	return result.ok ? (result.value as readonly NotebookWidget[]) : widgets;
}

export function removeNotebookWidgets(
	widgets: readonly NotebookWidget[],
	widgetIds: readonly string[],
): readonly NotebookWidget[] {
	let next: readonly NotebookWidget[] = widgets;
	for (const widgetId of widgetIds) {
		const result = applyWidgetLayoutEdit(next, { kind: "remove", widgetId }, LAYOUT_LIMITS);
		if (result.ok) next = result.value as readonly NotebookWidget[];
	}
	return next;
}
