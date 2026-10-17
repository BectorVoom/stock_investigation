import { DATASET_LIMITS, type DatasetCell, type WidgetCore } from "@research/contracts";
import { type GuardedDataset, guardDataset, type PresentedLabels } from "../datasetGuard.ts";
import type { SourceMap } from "../parts/SourceLinks.tsx";

type ChartWidget = Extract<WidgetCore, { readonly type: "chart" }>;
type ChartPoint = ChartWidget["series"][number]["points"][number];

/** A point as a dataset cell, provenance included (ADR-0026): the same markers and citations as Chat. */
function cellOf(point: ChartPoint): DatasetCell {
	return {
		v: point.y,
		...(point.basis === undefined ? {} : { basis: point.basis }),
		...(point.sourceId === undefined ? {} : { sourceId: point.sourceId }),
		...(point.asOf === undefined ? {} : { asOf: point.asOf }),
	};
}

/**
 * Placeholder creation time for the rebuilt dataset. The dataset schema
 * requires `createdAt`, but a `chart` widget carries no date of its own and
 * the value is never shown — it only keeps the guard's input valid.
 */
const CHART_DATASET_CREATED_AT = "2026-10-17T00:00:00Z";

interface RowKey {
	readonly label: string;
	readonly occurrence: number;
}

/** Stable string for a row key: the label plus its occurrence index in its series. */
function rowKeyText(key: RowKey): string {
	return JSON.stringify([key.label, key.occurrence]);
}

/**
 * The single row-building rule for `chart` widgets: key each point by
 * (label, occurrence index of that label within its series) — so repeated
 * labels in one series are separate rows and the k-th "Q1" of one series
 * aligns with the k-th "Q1" of another — then merge the series' key sequences
 * so every series' own order is kept (stable: on a tie, earlier series first,
 * then earlier position). A series without a key gets null, never 0.
 */
function orderedRowKeys(
	series: readonly { readonly points: readonly { readonly x: string }[] }[],
): readonly RowKey[] {
	const decoded = new Map<string, RowKey>();
	const firstSeen = new Map<string, { readonly seriesIndex: number; readonly position: number }>();
	const sequences: readonly string[][] = series.map((entry, seriesIndex) => {
		const seen = new Map<string, number>();
		return entry.points.map((point, position) => {
			const occurrence = seen.get(point.x) ?? 0;
			seen.set(point.x, occurrence + 1);
			const key: RowKey = { label: point.x, occurrence };
			const text = rowKeyText(key);
			if (!decoded.has(text)) {
				decoded.set(text, key);
				firstSeen.set(text, { seriesIndex, position });
			}
			return text;
		});
	});
	// Order constraints: each series' keys in its own order.
	const successors = new Map<string, Set<string>>();
	const indegree = new Map<string, number>();
	for (const key of decoded.keys()) {
		successors.set(key, new Set());
		indegree.set(key, 0);
	}
	for (const sequence of sequences) {
		for (let index = 0; index + 1 < sequence.length; index += 1) {
			const from = sequence[index];
			const to = sequence[index + 1];
			if (from === undefined || to === undefined || from === to) continue;
			const next = successors.get(from);
			if (next === undefined || next.has(to)) continue;
			next.add(to);
			indegree.set(to, (indegree.get(to) ?? 0) + 1);
		}
	}
	const rankOf = (key: string): { readonly seriesIndex: number; readonly position: number } =>
		firstSeen.get(key) ?? { seriesIndex: Number.MAX_SAFE_INTEGER, position: 0 };
	const available = [...decoded.keys()].filter((key) => (indegree.get(key) ?? 0) === 0);
	const order: string[] = [];
	const remaining = new Set(decoded.keys());
	while (available.length > 0) {
		let best = 0;
		for (let index = 1; index < available.length; index += 1) {
			const candidate = available[index];
			const current = available[best];
			if (candidate === undefined || current === undefined) continue;
			const rankCandidate = rankOf(candidate);
			const rankCurrent = rankOf(current);
			if (
				rankCandidate.seriesIndex < rankCurrent.seriesIndex ||
				(rankCandidate.seriesIndex === rankCurrent.seriesIndex &&
					rankCandidate.position < rankCurrent.position)
			) {
				best = index;
			}
		}
		const key = available.splice(best, 1)[0];
		if (key === undefined) break;
		remaining.delete(key);
		order.push(key);
		for (const next of successors.get(key) ?? []) {
			const degree = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, degree);
			if (degree === 0) available.push(next);
		}
	}
	// A hand-edited widget can order two labels in opposite ways in two series;
	// no order keeps both. Append the leftovers in first-seen order so the result stays deterministic.
	const leftovers = [...remaining].sort((left, right) => {
		const rankLeft = rankOf(left);
		const rankRight = rankOf(right);
		return rankLeft.seriesIndex - rankRight.seriesIndex || rankLeft.position - rankRight.position;
	});
	return [...order, ...leftovers].map((key) => {
		const decodedKey = decoded.get(key);
		if (decodedKey === undefined) throw new Error("chart row key is missing");
		return decodedKey;
	});
}

/**
 * A `chart` widget as a guarded dataset, so it draws through the same plot
 * code as a Chat chart preview (`LinePlot` / `BarPlot`). No DOM, no Solid:
 * `scripts/bench.ts` imports this file directly, the web app through the
 * package index.
 *
 * One x column (kind from `xKind`, absent = "text") plus one number column
 * per series (label = series name); rows follow the order-preserving merge
 * above. A series missing a row's key gets `{ v: null, reason }` (never 0),
 * so gaps are never bridged and never drawn as zero.
 */
export function chartWidgetToGuardedDataset(widget: ChartWidget): GuardedDataset {
	const unit = widget.unit.trim();
	const numberUnit = unit.length > 0 ? unit : "value";
	const xLabel = widget.xLabel?.trim() ?? "";
	const xColumnLabel =
		xLabel.length > 0 ? xLabel.slice(0, DATASET_LIMITS.maxColumnLabelChars) : "Label";
	const xKind = widget.xKind ?? "text";

	const keys = widget.series.map((_, index) => `s${index}`);
	const columns = [
		{ key: "x", label: xColumnLabel, kind: xKind },
		...widget.series.map((series, index) => ({
			key: `s${index}`,
			label: series.name.slice(0, DATASET_LIMITS.maxColumnLabelChars),
			kind: "number" as const,
			unit: numberUnit,
		})),
	];

	const rowOrder = orderedRowKeys(widget.series);
	const bySeries = widget.series.map((series) => {
		const seen = new Map<string, number>();
		const byKey = new Map<string, ChartPoint>();
		for (const point of series.points) {
			const occurrence = seen.get(point.x) ?? 0;
			seen.set(point.x, occurrence + 1);
			byKey.set(rowKeyText({ label: point.x, occurrence }), point);
		}
		return byKey;
	});

	const xValue = (label: string): string | number =>
		xKind === "number" && label.trim().length > 0 && Number.isFinite(Number(label))
			? Number(label)
			: label;

	const rows = rowOrder.map((key) => {
		const text = rowKeyText(key);
		const row: Record<string, DatasetCell> = { x: { v: xValue(key.label) } };
		for (const [seriesIndex, byKey] of bySeries.entries()) {
			const point = byKey.get(text);
			row[`s${seriesIndex}`] =
				point === undefined ? { v: null, reason: "no value for this label" } : cellOf(point);
		}
		return row;
	});

	const presented: PresentedLabels = new Map(
		keys.map((key, index) => {
			const name = widget.series[index]?.name;
			if (name === undefined) throw new Error("chart series is missing");
			return [key, [name]];
		}),
	);

	return guardDataset(
		{
			datasetId: widget.widgetId,
			title: widget.title,
			columns,
			rows,
			createdAt: CHART_DATASET_CREATED_AT,
		},
		presented,
	);
}

/** The x-axis title of a `chart` widget ("" when it has none); the plot builds the y title from `yLabel` and the unit. */
export function chartWidgetXAxisTitle(widget: ChartWidget): string {
	return widget.xLabel?.trim() ?? "";
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

/** The evidence copies a `chart` widget carries, keyed by id, for its citations and Sources list. */
export function chartWidgetSources(widget: ChartWidget): SourceMap {
	return new Map((widget.sources ?? []).map((source) => [source.evidenceId, source] as const));
}
