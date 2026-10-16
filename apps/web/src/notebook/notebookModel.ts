import type { ChatMessage, WorkspaceView } from "@research/contracts";
import { NOTEBOOK_LIMITS, WIDGET_TYPE_META, type WidgetCore } from "@research/contracts";
import { newWidgetId } from "../widgets/widgetModel.ts";

type WorkspaceComponent = WorkspaceView["state"]["components"][number];
type WorkspaceDataset = WorkspaceView["datasets"][number];

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
): WidgetCore {
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
		size: WIDGET_TYPE_META.table.defaultSize,
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

function researchFallback(component: WorkspaceComponent, widgetId: string): WidgetCore {
	return {
		widgetId,
		type: "research",
		title: componentTitle(component) ?? component.componentType,
		size: WIDGET_TYPE_META.research.defaultSize,
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
): WidgetCore | null {
	const widgetId = newWidgetId();
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
		readonly xLabel?: unknown;
		readonly yLabel?: unknown;
	};
	const title = componentTitle(component) ?? component.componentType;

	function axisLabel(value: unknown): string | undefined {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim().slice(0, NOTEBOOK_LIMITS.maxTitleChars);
		return trimmed.length > 0 ? trimmed : undefined;
	}

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
			const xLabel = axisLabel(props.xLabel);
			const yLabel = axisLabel(props.yLabel);
			return {
				widgetId,
				type: "chart",
				title,
				size: WIDGET_TYPE_META.chart.defaultSize,
				chartType: component.componentType === "bar-chart" ? "bar" : "line",
				unit,
				series: converted,
				...(xLabel === undefined ? {} : { xLabel }),
				...(yLabel === undefined ? {} : { yLabel }),
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
			const xLabel = axisLabel(props.xLabel);
			const closeLabel =
				typeof closeColumn?.label === "string" && closeColumn.label.trim().length > 0
					? closeColumn.label.trim().slice(0, NOTEBOOK_LIMITS.maxTitleChars)
					: "Close";
			return {
				widgetId,
				type: "chart",
				title,
				size: WIDGET_TYPE_META.chart.defaultSize,
				chartType: "line",
				unit,
				series: converted,
				...(xLabel === undefined ? {} : { xLabel }),
				yLabel: closeLabel,
			};
		}
		default:
			return researchFallback(component, widgetId);
	}
}

/** An editable text widget from an assistant answer (citation chips become `[n]` text). */
export function widgetFromAnswer(message: ChatMessage): WidgetCore {
	const text =
		message.text.trim().length > 0
			? truncateText(message.text.trim(), NOTEBOOK_LIMITS.maxTextChars)
			: "(empty answer)";
	return {
		widgetId: newWidgetId(),
		type: "text",
		title: titleFromText(message.text, "Answer"),
		size: WIDGET_TYPE_META.text.defaultSize,
		text,
	};
}
