import type { ChatMessage, DatasetCell, Evidence, WorkspaceView } from "@research/contracts";
import {
	barChartPropsSchema,
	chartWidgetCitedIds,
	lineChartPropsSchema,
	NOTEBOOK_LIMITS,
	WIDGET_TYPE_META,
	type WidgetCore,
	widgetCoreSchema,
} from "@research/contracts";
import {
	chartWidgetToGuardedDataset,
	guardDataset,
	presentedSeriesLabels,
} from "@research/ui-registry";
import { newWidgetId } from "../widgets/widgetModel.ts";

type WorkspaceComponent = WorkspaceView["state"]["components"][number];
type WorkspaceDataset = WorkspaceView["datasets"][number];
type ChartWidgetCore = Extract<WidgetCore, { readonly type: "chart" }>;
type ChartPoint = ChartWidgetCore["series"][number]["points"][number];

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
): { readonly name: string; readonly points: ChartPoint[] }[] {
	return series
		.slice(0, NOTEBOOK_LIMITS.maxChartSeries)
		.map((entry) => {
			const points: ChartPoint[] = [];
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
				const cell = row[entry.key];
				// The value's provenance travels with it (ADR-0026).
				points.push({
					x,
					y: yCell,
					...(cell?.basis === undefined ? {} : { basis: cell.basis }),
					...(cell?.sourceId === undefined ? {} : { sourceId: cell.sourceId }),
					...(cell?.asOf === undefined ? {} : { asOf: cell.asOf }),
				});
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

function axisLabel(value: string): string | undefined {
	const trimmed = value.trim().slice(0, NOTEBOOK_LIMITS.maxTitleChars);
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Raw x text of a dataset row: numbers stringify, null means no x. */
function xTextOf(cell: { readonly v: string | number | null } | undefined): string | null {
	if (cell === undefined || cell.v === null) return null;
	return typeof cell.v === "number" ? String(cell.v) : cell.v;
}

/** The same plotted number (or none) with the same basis, source and as-of date. */
function sameCell(source: DatasetCell | undefined, rebuilt: DatasetCell | undefined): boolean {
	const value = numberOrNull(source);
	if (value !== numberOrNull(rebuilt)) return false;
	// An empty cell's stated reason shows in the data table (hard gate 6);
	// the widget cannot carry it, so a reason makes the conversion lossy.
	if (value === null) return source?.reason === rebuilt?.reason;
	return (
		source?.basis === rebuilt?.basis &&
		source?.sourceId === rebuilt?.sourceId &&
		source?.asOf === rebuilt?.asOf
	);
}

/** A plottable number or null (never 0 for missing, never text). */
function numberOrNull(cell: { readonly v: string | number | null } | undefined): number | null {
	if (cell === undefined) return null;
	return typeof cell.v === "number" && Number.isFinite(cell.v) ? cell.v : null;
}

/**
 * A `chart` widget for the given line/bar component only when the conversion
 * is lossless; otherwise null (the caller falls back to `research`, which
 * renders through the registry and is identical by construction).
 *
 * Losslessness is decided by a round trip, not by a list of special cases:
 * the source dataset is guarded exactly as the registry renderer guards it,
 * converted, rebuilt with `chartWidgetToGuardedDataset`, and required to have
 * the same rows in the same order (x label text per row, and per series the
 * same number or null at every row), the same series in the same order, and
 * no withheld series. Pure, so unit tests cover the five Codex cases (gap in
 * the first series, a row empty in every series, repeated labels,
 * withheld-by-presentation, all-null first series).
 */
export function losslessChartWidget(args: {
	readonly dataset: WorkspaceDataset;
	readonly xKey: string;
	readonly series: readonly ChartSeriesInput[];
	readonly chartType: "line" | "bar";
	readonly title: string;
	readonly unit: string;
	readonly xLabel: string | undefined;
	readonly yLabel: string | undefined;
	/** The component's own citations. */
	readonly sourceIds: readonly string[];
	/** The conversation's evidence, where every cited record must be found. */
	readonly evidence: readonly Evidence[];
	readonly widgetId: string;
}): ChartWidgetCore | null {
	const guarded = guardDataset(args.dataset, presentedSeriesLabels(args.series));
	if (guarded.withheldColumns.size > 0) return null;
	if (args.series.length === 0 || args.series.length > NOTEBOOK_LIMITS.maxChartSeries) return null;
	// A capped unit would rename the y axis title, so it is not the same picture.
	if (args.unit.length > NOTEBOOK_LIMITS.maxUnitChars) return null;
	const converted = pointsFromDataset(guarded.dataset, args.xKey, args.series);
	// Dropped series (all null, e.g. an all-null first series) shift colour
	// slots: Chat colours by the series' slot in the props.
	if (converted.length !== args.series.length) return null;
	for (const [index, entry] of converted.entries()) {
		if (entry.name !== args.series[index]?.label) return null;
	}
	const sourceColumn = args.dataset.columns.find((column) => column.key === args.xKey);
	if (sourceColumn === undefined) return null;
	const xKind = sourceColumn.kind;
	const cited = chartWidgetCitedIds({ sourceIds: args.sourceIds, series: converted });
	const evidenceById = new Map(args.evidence.map((record) => [record.evidenceId, record] as const));
	const sources = cited.flatMap((id) => {
		const record = evidenceById.get(id);
		return record === undefined ? [] : [record];
	});
	// A citation whose record is not in the conversation would show as
	// "Source unavailable" in the Notebook but resolve in Chat.
	if (sources.length !== cited.length) return null;
	const draft: ChartWidgetCore = {
		widgetId: args.widgetId,
		type: "chart",
		title: args.title,
		size: WIDGET_TYPE_META.chart.defaultSize,
		chartType: args.chartType,
		unit: args.unit,
		series: converted,
		...(args.xLabel === undefined ? {} : { xLabel: args.xLabel }),
		...(args.yLabel === undefined ? {} : { yLabel: args.yLabel }),
		...(xKind === "text" ? {} : { xKind }),
		...(args.sourceIds.length === 0 ? {} : { sourceIds: [...args.sourceIds] }),
		...(sources.length === 0 ? {} : { sources }),
	};
	// The stored shape's own rules (trimmed names, limits, one copy per
	// citation): a candidate it refuses could not be saved.
	const parsed = widgetCoreSchema.safeParse(draft);
	if (!parsed.success || parsed.data.type !== "chart") return null;
	const candidate = parsed.data;
	const rebuilt = chartWidgetToGuardedDataset(candidate);
	if (rebuilt.withheldColumns.size > 0) return null;
	const sourceRows = guarded.dataset.rows;
	const rebuiltRows = rebuilt.dataset.rows;
	if (sourceRows.length !== rebuiltRows.length) return null;
	for (const [rowIndex, sourceRow] of sourceRows.entries()) {
		const rebuiltRow = rebuiltRows[rowIndex];
		if (rebuiltRow === undefined) return null;
		if (xTextOf(sourceRow[args.xKey]) !== xTextOf(rebuiltRow.x)) return null;
		for (const [seriesIndex, entry] of args.series.entries()) {
			if (!sameCell(sourceRow[entry.key], rebuiltRow[`s${seriesIndex}`])) return null;
		}
	}
	return candidate;
}

/** A line or bar chart's props as the registry parses them; null when it would refuse them. */
function chartPropsOf(component: WorkspaceComponent): {
	readonly chartType: "line" | "bar";
	readonly xKey: string;
	readonly series: readonly ChartSeriesInput[];
	readonly xLabel: string;
	readonly yLabel: string;
	readonly yUnit: string;
	readonly sourceIds: readonly string[];
} | null {
	if (component.componentType === "line-chart") {
		const parsed = lineChartPropsSchema.safeParse(component.props);
		return parsed.success ? { chartType: "line", ...parsed.data } : null;
	}
	const parsed = barChartPropsSchema.safeParse(component.props);
	return parsed.success
		? { chartType: "bar", xKey: parsed.data.categoryKey, ...parsed.data }
		: null;
}

/**
 * A self-contained widget from a canvas component: tables become `table`
 * widgets carrying a copy of their dataset rows (so they stay editable);
 * line/bar charts become `chart` widgets only when the conversion is lossless
 * (otherwise `research`, identical by construction); candlestick charts always
 * become `research` (their Chat picture is candles, a close-price line is not
 * the same graph); every other component becomes a `research` widget that
 * renders the component itself. Null when the component cannot be saved
 * (its dataset is not in `view`).
 */
export function widgetFromComponent(
	component: WorkspaceComponent,
	view: WorkspaceView,
): WidgetCore | null {
	const widgetId = newWidgetId();
	const props = component.props as { readonly datasetRef?: unknown };
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
			// Parsed with the schemas the registry renders from: props it would
			// refuse cannot be "the same graph", so they stay a research widget.
			const chart = chartPropsOf(component);
			if (chart === null) return researchFallback(component, widgetId);
			const converted = losslessChartWidget({
				dataset,
				xKey: chart.xKey,
				series: chart.series,
				chartType: chart.chartType,
				title,
				unit: chart.yUnit,
				xLabel: axisLabel(chart.xLabel),
				yLabel: axisLabel(chart.yLabel),
				sourceIds: chart.sourceIds,
				evidence: view.sources,
				widgetId,
			});
			return converted ?? researchFallback(component, widgetId);
		}
		case "candlestick-chart":
			// Its Chat picture is candles; a close-price line is not the same graph.
			return researchFallback(component, widgetId);
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
