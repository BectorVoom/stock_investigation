import type { MessagesOf } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import { createMemo, For, type JSX, Show } from "solid-js";
import { cellReasonMessages } from "../cellReasons.messages.ts";
import { cellReasonText, countUnsourcedNumbers, type GuardedDataset } from "../datasetGuard.ts";
import { formatAxisTick } from "../format.ts";
import { CitationScope, SourceList } from "../parts/citations.tsx";
import { cellSourceIdsInOrder, DatasetTable } from "../parts/DatasetTable.tsx";
import type { SourceMap } from "../parts/SourceLinks.tsx";
import { DataUnavailable, EmptyState } from "../parts/states.tsx";
import {
	CHART_INK,
	FONT_SIZE,
	fitAxisTitle,
	nearestIndex,
	type PlotArea,
	type Scale,
	VIEW_HEIGHT,
	VIEW_WIDTH,
	type WithheldSeries,
	type XTick,
} from "./chartMath.ts";
import { chartMessages } from "./charts.messages.ts";

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
	const yTitle = createMemo(() =>
		fitAxisTitle(props.yAxisTitle, props.plot.bottom - props.plot.top),
	);
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
					font-size={String(yTitle().fontSize)}
					data-axis-title="y"
				>
					<Show when={yTitle().truncated}>
						<title>{props.yAxisTitle}</title>
					</Show>
					{yTitle().text}
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

type ChartText = MessagesOf<typeof chartMessages>;

/**
 * "<y title> by <x title>. " for a chart's accessible name, leaving out what
 * is missing (a Notebook chart may have no axis titles; a registry chart
 * always has both). `text` is the current language's chart words (English
 * when omitted).
 */
export function axesPhrase(
	yAxisTitle: string,
	xAxisTitle: string,
	text: ChartText = chartMessages.en,
): string {
	const y = yAxisTitle.trim();
	const x = xAxisTitle.trim();
	if (y.length > 0 && x.length > 0) return text.axesBoth(y, x);
	if (y.length > 0) return text.axesYOnly(y);
	if (x.length > 0) return text.axesXOnly(x);
	return "";
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
	const m = useMessages(chartMessages);
	return (
		<ul aria-label={m().legend} class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-800">
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

/**
 * Marks look alike whatever a number is based on, so a chart says in words how
 * many of its values are not sourced measurements (hard gate 6). Null when all are sourced.
 */
function basisNote(
	data: GuardedDataset,
	valueColumnKeys: readonly string[],
	text: ChartText,
): string | null {
	const counts = countUnsourcedNumbers(data, valueColumnKeys);
	const parts = [
		counts.assumption > 0 ? text.assumptions(counts.assumption) : null,
		counts.derived > 0 ? text.derivedValues(counts.derived) : null,
		counts.unstated > 0 ? text.unstatedValues(counts.unstated) : null,
	].filter((part): part is string => part !== null);
	if (parts.length === 0) return null;
	return text.basisNote(parts);
}

/**
 * The notices every chart shows around its plot: withheld series, missing
 * columns, the empty state, and the unavailable count. Shared by the
 * registry `ChartShell` and the Notebook `chart` widget so the same
 * condition reads the same way on both pages.
 */
export function ChartNotices(props: {
	/** Series the display rules refuse to plot, with the reason shown to the reader. */
	readonly withheldSeries: readonly WithheldSeries[];
	/** Keys the chart was asked to plot that the dataset does not declare. */
	readonly missingColumns: readonly string[];
	readonly plottedCount: number;
	readonly unavailableCount: number;
	/** Shown when nothing is plotted (no rows vs rows but no values). */
	readonly emptyMessage: string;
	readonly children: JSX.Element;
}): JSX.Element {
	const m = useMessages(chartMessages);
	const reasons = useMessages(cellReasonMessages);
	return (
		<>
			<For each={props.withheldSeries}>
				{(series) => (
					<p data-withheld-series={series.label} class="text-xs text-amber-900">
						{m().withheldSeries(series.label, cellReasonText(series.reason, reasons()))}
					</p>
				)}
			</For>
			<Show when={props.missingColumns.length > 0}>
				<output data-state="missing-columns" class="block text-xs text-amber-900">
					{m().missingColumns(props.missingColumns)}
				</output>
			</Show>
			<Show when={props.plottedCount > 0} fallback={<EmptyState>{props.emptyMessage}</EmptyState>}>
				{props.children}
			</Show>
			<Show when={props.unavailableCount > 0}>
				<p data-unavailable-count={props.unavailableCount} class="mt-1 text-xs text-amber-900">
					{m().unavailablePoints(props.unavailableCount)}
				</p>
			</Show>
		</>
	);
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
	/** Identifies the component owning this chart, for citation numbering. */
	readonly citationScopeKey: string;
	readonly plottedCount: number;
	readonly unavailableCount: number;
	/** Keys the chart was asked to plot that the dataset does not declare. */
	readonly missingColumns: readonly string[];
	/** Series the display rules refuse to plot, with the reason shown to the reader. */
	readonly withheldSeries: readonly WithheldSeries[];
	readonly tableColumnKeys: readonly string[];
	/** The columns whose numbers are drawn as marks (not the axis column). */
	readonly valueColumnKeys: readonly string[];
	/**
	 * Legacy legend/readout slots for renderers that still provide them
	 * (candlestick). Line and bar charts render `LinePlot` / `BarPlot` as
	 * `children`, which already include the legend and readout, so these
	 * stay absent there and nothing is drawn twice.
	 */
	readonly legend?: JSX.Element;
	readonly readout?: string | null;
	/**
	 * True for a Notebook / Home `chart` widget: no widget shows a title
	 * (ADR-0024); its frame's accessible name is the title.
	 */
	readonly headingHidden?: boolean;
	readonly children: JSX.Element;
}): JSX.Element {
	const m = useMessages(chartMessages);
	// The data-table twin's cells cite too, so their ids number before the
	// component's own sources.
	const sourceIdsInOrder = createMemo(() => [
		...cellSourceIdsInOrder(props.data),
		...props.sourceIds,
	]);
	return (
		<CitationScope sourceIdsInOrder={sourceIdsInOrder()}>
			<figure class="m-0">
				<Show when={props.headingHidden !== true}>
					<h3 class="text-sm font-semibold text-slate-900">{props.title}</h3>
				</Show>
				<Show when={props.data} fallback={<DataUnavailable datasetRef={props.datasetRef} />}>
					{(data) => (
						<>
							<ChartNotices
								withheldSeries={props.withheldSeries}
								missingColumns={props.missingColumns}
								plottedCount={props.plottedCount}
								unavailableCount={props.unavailableCount}
								emptyMessage={data().dataset.rows.length === 0 ? m().noRows : m().noPlottableValues}
							>
								{props.children}
								<Show when={props.legend !== undefined}>{props.legend}</Show>
								<Show when={props.readout !== undefined}>
									<p data-chart-part="readout" class="mt-1 min-h-4 text-xs text-slate-700">
										{props.readout ?? m().readoutHint}
									</p>
								</Show>
							</ChartNotices>
							<Show when={basisNote(data(), props.valueColumnKeys, m())}>
								{(note) => (
									<p data-chart-basis-note="true" class="mt-1 text-xs text-slate-800">
										{note()}
									</p>
								)}
							</Show>
							<details class="mt-1 text-xs">
								<summary class="cursor-pointer py-1 text-slate-700">
									{m().dataTableSummary(props.title)}
								</summary>
								<DatasetTable
									data={data()}
									caption={m().dataTableCaption(props.title)}
									sources={props.sources}
									columnKeys={props.tableColumnKeys}
									citationGroupKey={`${props.citationScopeKey}::table`}
								/>
							</details>
						</>
					)}
				</Show>
				<SourceList sourceIds={props.sourceIds} sources={props.sources} />
			</figure>
		</CitationScope>
	);
}
