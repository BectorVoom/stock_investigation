import { For, type JSX, Show } from "solid-js";
import { countUnsourcedNumbers, type GuardedDataset } from "../datasetGuard.ts";
import { formatAxisTick } from "../format.ts";
import { DatasetTable } from "../parts/DatasetTable.tsx";
import { SourceList, type SourceMap } from "../parts/SourceLinks.tsx";
import { DataUnavailable, EmptyState } from "../parts/states.tsx";
import {
	CHART_INK,
	FONT_SIZE,
	nearestIndex,
	type PlotArea,
	type Scale,
	VIEW_HEIGHT,
	VIEW_WIDTH,
	type WithheldSeries,
	type XTick,
} from "./chartMath.ts";

/**
 * SVG chrome shared by every chart: surface, hairline grid, one y axis, axis
 * titles with units, and a crosshair that snaps to the nearest data position.
 * Marks are passed as children. All text is SVG text nodes; nothing is styled
 * with a `style` attribute (CSP `style-src 'self'`).
 */
export function ChartFrame(props: {
	readonly ariaLabel: string;
	readonly plot: PlotArea;
	readonly xAxisTitle: string;
	readonly yAxisTitle: string;
	readonly yTicks: readonly number[];
	readonly yScale: Scale;
	readonly xTicks: readonly XTick[];
	/** Pixel x of each dataset row (null when the row is not plotted), for the crosshair. */
	readonly rowXs: readonly (number | null)[];
	readonly hoveredRow: number | null;
	readonly onHoverRow: (rowIndex: number | null) => void;
	readonly children: JSX.Element;
}): JSX.Element {
	const crosshairX = () =>
		props.hoveredRow === null ? null : (props.rowXs[props.hoveredRow] ?? null);
	const handlePointerMove = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
		const bounds = event.currentTarget.getBoundingClientRect();
		if (bounds.width === 0) return;
		const viewX = ((event.clientX - bounds.left) / bounds.width) * VIEW_WIDTH;
		props.onHoverRow(nearestIndex(props.rowXs, viewX));
	};

	return (
		<svg
			role="img"
			aria-label={props.ariaLabel}
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
			class="h-auto w-full"
			font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
			font-size={String(FONT_SIZE)}
			onPointerMove={handlePointerMove}
			onPointerLeave={() => props.onHoverRow(null)}
		>
			<title>{props.ariaLabel}</title>
			<rect x="0" y="0" width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={CHART_INK.surface} />
			<g data-chart-part="y-axis">
				<For each={props.yTicks}>
					{(tick) => (
						<>
							<line
								x1={props.plot.left}
								x2={props.plot.right}
								y1={props.yScale(tick)}
								y2={props.yScale(tick)}
								stroke={tick === 0 ? CHART_INK.axis : CHART_INK.grid}
								stroke-width="1"
							/>
							<text
								x={props.plot.left - 6}
								y={props.yScale(tick)}
								dy="0.32em"
								text-anchor="end"
								fill={CHART_INK.secondary}
							>
								{formatAxisTick(tick)}
							</text>
						</>
					)}
				</For>
				<text
					transform={`rotate(-90 14 ${(props.plot.top + props.plot.bottom) / 2})`}
					x="14"
					y={(props.plot.top + props.plot.bottom) / 2}
					text-anchor="middle"
					fill={CHART_INK.secondary}
					data-axis-title="y"
				>
					{props.yAxisTitle}
				</text>
			</g>
			<g data-chart-part="x-axis">
				<line
					x1={props.plot.left}
					x2={props.plot.right}
					y1={props.plot.bottom}
					y2={props.plot.bottom}
					stroke={CHART_INK.axis}
					stroke-width="1"
				/>
				<For each={props.xTicks}>
					{(tick) => (
						<text
							x={tick.x}
							y={props.plot.bottom + 18}
							text-anchor="middle"
							fill={CHART_INK.secondary}
						>
							{tick.label}
						</text>
					)}
				</For>
				<text
					x={(props.plot.left + props.plot.right) / 2}
					y={VIEW_HEIGHT - 12}
					text-anchor="middle"
					fill={CHART_INK.secondary}
					data-axis-title="x"
				>
					{props.xAxisTitle}
				</text>
			</g>
			<Show when={crosshairX()}>
				{(x) => (
					<line
						data-chart-part="crosshair"
						x1={x()}
						x2={x()}
						y1={props.plot.top}
						y2={props.plot.bottom}
						stroke={CHART_INK.secondary}
						stroke-width="1"
					/>
				)}
			</Show>
			<g data-chart-part="marks">{props.children}</g>
		</svg>
	);
}

export interface LegendItem {
	readonly label: string;
	readonly color: string;
}

/** Identity is never colour-alone: a legend names every series next to its mark. */
export function ChartLegend(props: {
	readonly items: readonly LegendItem[];
	readonly mark: "line" | "block";
}): JSX.Element {
	return (
		<ul aria-label="Legend" class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-800">
			<For each={props.items}>
				{(item) => (
					<li class="flex items-center gap-1.5">
						<svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
							<Show
								when={props.mark === "line"}
								fallback={<rect x="3" y="0" width="10" height="10" rx="2" fill={item.color} />}
							>
								<line
									x1="1"
									x2="15"
									y1="5"
									y2="5"
									stroke={item.color}
									stroke-width="2"
									stroke-linecap="round"
								/>
							</Show>
						</svg>
						<span>{item.label}</span>
					</li>
				)}
			</For>
		</ul>
	);
}

function plural(count: number, singular: string, pluralForm: string): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Marks look alike whatever a number is based on, so a chart says in words how
 * many of its values are not sourced measurements (hard gate 6). Null when all are sourced.
 */
function basisNote(data: GuardedDataset, valueColumnKeys: readonly string[]): string | null {
	const counts = countUnsourcedNumbers(data, valueColumnKeys);
	const parts = [
		counts.assumption > 0 ? plural(counts.assumption, "assumption", "assumptions") : null,
		counts.derived > 0 ? plural(counts.derived, "derived value", "derived values") : null,
		counts.unstated > 0
			? plural(counts.unstated, "value with no stated basis", "values with no stated basis")
			: null,
	].filter((part): part is string => part !== null);
	if (parts.length === 0) return null;
	return `Not sourced measurements: ${parts.join(", ")}. Each is marked in the data table.`;
}

/**
 * Everything around the plot: heading, missing/empty states, the count of
 * points that could not be plotted, the data-table twin, and provenance.
 */
export function ChartShell(props: {
	readonly title: string;
	readonly datasetRef: string;
	readonly data: GuardedDataset | undefined;
	readonly sourceIds: readonly string[];
	readonly sources: SourceMap;
	readonly plottedCount: number;
	readonly unavailableCount: number;
	/** Keys the chart was asked to plot that the dataset does not declare. */
	readonly missingColumns: readonly string[];
	/** Series the display rules refuse to plot, with the reason shown to the reader. */
	readonly withheldSeries: readonly WithheldSeries[];
	readonly tableColumnKeys: readonly string[];
	/** The columns whose numbers are drawn as marks (not the axis column). */
	readonly valueColumnKeys: readonly string[];
	readonly legend: JSX.Element;
	readonly readout: string | null;
	readonly children: JSX.Element;
}): JSX.Element {
	return (
		<figure class="m-0">
			<h3 class="text-sm font-semibold text-slate-900">{props.title}</h3>
			<Show when={props.data} fallback={<DataUnavailable datasetRef={props.datasetRef} />}>
				{(data) => (
					<>
						<For each={props.withheldSeries}>
							{(series) => (
								<p data-withheld-series={series.label} class="text-xs text-amber-900">
									Series "{series.label}" — {series.reason}.
								</p>
							)}
						</For>
						<Show when={props.missingColumns.length > 0}>
							<output data-state="missing-columns" class="block text-xs text-amber-900">
								Not in the dataset, so not plotted: {props.missingColumns.join(", ")}.
							</output>
						</Show>
						<Show
							when={props.plottedCount > 0}
							fallback={
								<EmptyState>
									{data().dataset.rows.length === 0
										? "No data — this dataset has no rows."
										: "No plottable data — every requested value is unavailable."}
								</EmptyState>
							}
						>
							{props.children}
							{props.legend}
							<p data-chart-part="readout" class="mt-1 min-h-4 text-xs text-slate-700">
								{props.readout ??
									"Point at the chart to read values; the data table below lists every value."}
							</p>
						</Show>
						<Show when={props.unavailableCount > 0}>
							<p
								data-unavailable-count={props.unavailableCount}
								class="mt-1 text-xs text-amber-900"
							>
								{props.unavailableCount} {props.unavailableCount === 1 ? "point" : "points"}{" "}
								unavailable — not plotted (never drawn as 0). See the data table for the reasons.
							</p>
						</Show>
						<Show when={basisNote(data(), props.valueColumnKeys)}>
							{(note) => (
								<p data-chart-basis-note="true" class="mt-1 text-xs text-slate-800">
									{note()}
								</p>
							)}
						</Show>
						<details class="mt-1 text-xs">
							<summary class="cursor-pointer text-slate-700">Data table: {props.title}</summary>
							<DatasetTable
								data={data()}
								caption={`Values plotted in "${props.title}"`}
								sources={props.sources}
								columnKeys={props.tableColumnKeys}
							/>
						</details>
					</>
				)}
			</Show>
			<SourceList sourceIds={props.sourceIds} sources={props.sources} />
		</figure>
	);
}
