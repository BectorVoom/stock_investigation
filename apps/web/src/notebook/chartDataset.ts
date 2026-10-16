import type { WidgetCore } from "@research/contracts";
import { type GuardedDataset, guardDataset, type PresentedLabels } from "@research/ui-registry";

type ChartWidget = Extract<WidgetCore, { readonly type: "chart" }>;

/**
 * A `chart` widget as a guarded dataset, so it draws through the same plot
 * code as a Chat chart preview (`LinePlot` / `BarPlot`).
 *
 * One text column for the x labels, one number column per series (label =
 * series name); rows are the union of x labels in first-seen order across
 * series. A series missing a label gets `{ v: null, reason }` (never 0), so
 * gaps are never bridged and never drawn as zero.
 */
export function chartWidgetToGuardedDataset(widget: ChartWidget): GuardedDataset {
	const unit = widget.unit.trim();
	const numberUnit = unit.length > 0 ? unit.slice(0, 40) : "value";
	const xLabel = widget.xLabel?.trim() ?? "";
	const xColumnLabel = xLabel.length > 0 ? xLabel.slice(0, 80) : "Label";

	const keys = widget.series.map((_, index) => `s${index}`);
	const columns = [
		{ key: "x", label: xColumnLabel, kind: "text" as const },
		...widget.series.map((series, index) => ({
			key: keys[index] ?? `s${index}`,
			label: series.name.slice(0, 80),
			kind: "number" as const,
			unit: numberUnit,
		})),
	];

	const labels: string[] = [];
	const seen = new Set<string>();
	for (const series of widget.series) {
		for (const point of series.points) {
			if (!seen.has(point.x)) {
				seen.add(point.x);
				labels.push(point.x);
			}
		}
	}

	const bySeries = widget.series.map((series) => {
		const byLabel = new Map<string, number>();
		for (const point of series.points) {
			if (!byLabel.has(point.x)) byLabel.set(point.x, point.y);
		}
		return byLabel;
	});

	const rows = labels.map((label) => {
		const row: Record<string, { readonly v: string | number | null; readonly reason?: string }> = {
			x: { v: label },
		};
		for (const [seriesIndex, byLabel] of bySeries.entries()) {
			const key = keys[seriesIndex] ?? `s${seriesIndex}`;
			const value = byLabel.get(label);
			row[key] =
				value === undefined ? { v: null, reason: "no value for this label" } : { v: value };
		}
		return row;
	});

	const presented: PresentedLabels = new Map(
		widget.series.map((series, index) => [keys[index] ?? `s${index}`, [series.name]]),
	);

	return guardDataset(
		{
			datasetId: widget.widgetId,
			title: widget.title,
			columns,
			rows,
			createdAt: "2026-10-17T00:00:00Z",
		},
		presented,
	);
}

/** Axis titles for a `chart` widget, matching the registry's format. */
export function chartWidgetAxisTitles(widget: ChartWidget): {
	readonly xAxisTitle: string;
	readonly yAxisTitle: string;
} {
	const xLabel = widget.xLabel?.trim() ?? "";
	const yLabel = widget.yLabel?.trim() ?? "";
	const unit = widget.unit.trim();
	if (yLabel.length > 0 && unit.length > 0) {
		return { xAxisTitle: xLabel, yAxisTitle: `${yLabel} (${unit})` };
	}
	return { xAxisTitle: xLabel, yAxisTitle: yLabel.length > 0 ? yLabel : unit };
}

/** Series specs for `LinePlot` / `BarPlot` from a `chart` widget. */
export function chartWidgetSeries(widget: ChartWidget): readonly {
	readonly key: string;
	readonly label: string;
}[] {
	return widget.series.map((series, index) => ({
		key: `s${index}`,
		label: series.name,
	}));
}
