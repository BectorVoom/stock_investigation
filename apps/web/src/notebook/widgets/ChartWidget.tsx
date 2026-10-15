import type { WidgetCore } from "@research/contracts";
import { seriesColor } from "@research/ui-registry";
import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";

type ChartWidget = Extract<WidgetCore, { readonly type: "chart" }>;

const WIDTH = 300;
const HEIGHT = 120;
const PAD = 8;
/** At most this many value labels are drawn on a large chart. */
const MAX_VALUE_LABELS = 12;

function extent(widget: ChartWidget): { readonly min: number; readonly max: number } {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const series of widget.series) {
		for (const point of series.points) {
			if (point.y < min) min = point.y;
			if (point.y > max) max = point.y;
		}
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
	if (min === max) return { min: min - 1, max: max + 1 };
	return { min, max };
}

function xAt(index: number, count: number): number {
	if (count <= 1) return WIDTH / 2;
	return PAD + (index * (WIDTH - PAD * 2)) / (count - 1);
}

function yAt(value: number, min: number, max: number): number {
	return HEIGHT - PAD - ((value - min) / (max - min)) * (HEIGHT - PAD * 2);
}

function colorAt(index: number): string {
	return seriesColor(index);
}

function summaryText(widget: ChartWidget): string {
	const total = widget.series.reduce((count, series) => count + series.points.length, 0);
	const names = widget.series
		.map((series) => `${series.name} (${series.points.length} points)`)
		.join("; ");
	return `${widget.chartType === "bar" ? "Bar" : "Line"} chart: ${widget.series.length} series, ${total} points. ${names}${widget.unit.trim().length > 0 ? ` Unit: ${widget.unit}.` : ""}`;
}

interface MarkLabel {
	readonly x: number;
	readonly y: number;
	readonly text: string;
}

/**
 * Inline SVG chart (no new dependency). Small: compact sparkline-style, no
 * axes. Medium: axes with first/last labels and the unit. Large: axes, a
 * legend and value labels on hover/focus. Every size ships a text summary
 * (`role="img"`) and a data-table twin, so nothing is pointer-only.
 *
 * The hover readout follows the pointer across the plot (pointer events
 * only); the value labels are CSS-only (`group-hover` / `group-focus-within`
 * over a focusable plot), so keyboard users reach the same values without a
 * handler on every mark, and the data table lists every value regardless.
 */
export function ChartWidget(props: { readonly widget: ChartWidget }): JSX.Element {
	const widget = () => props.widget;
	const size = () => props.widget.size;
	const [hovered, setHovered] = createSignal<string | null>(null);
	const { min, max } = extent(props.widget);
	const pointCount = () =>
		Math.max(...props.widget.series.map((series) => series.points.length), 0);

	const firstLabel = () => props.widget.series[0]?.points[0]?.x ?? "";
	const lastLabel = () => {
		const points = props.widget.series[0]?.points ?? [];
		return points[points.length - 1]?.x ?? "";
	};

	/** Every plotted mark with its view-box position, for the hover readout. */
	const marks = (): readonly { readonly x: number; readonly label: string }[] =>
		widget().series.flatMap((series) =>
			series.points.map((point, pointIndex) => ({
				x: xAt(pointIndex, series.points.length),
				label: `${series.name}: ${point.x} — ${point.y}`,
			})),
		);

	/** Thinned value labels for a large chart (at most MAX_VALUE_LABELS). */
	const valueLabels = (): readonly MarkLabel[] => {
		const labelled: MarkLabel[] = [];
		for (const series of widget().series) {
			const step = Math.max(1, Math.ceil(series.points.length / MAX_VALUE_LABELS));
			series.points.forEach((point, pointIndex) => {
				if (pointIndex % step !== 0) return;
				labelled.push({
					x: xAt(pointIndex, series.points.length),
					y: yAt(point.y, min, max),
					text: `${series.name}: ${point.y}`,
				});
			});
			if (labelled.length >= MAX_VALUE_LABELS) break;
		}
		return labelled.slice(0, MAX_VALUE_LABELS);
	};

	const onPlotMove = (event: PointerEvent & { readonly currentTarget: SVGSVGElement }): void => {
		const bounds = event.currentTarget.getBoundingClientRect();
		if (bounds.width === 0) return;
		const viewX = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
		let best: string | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const mark of marks()) {
			const distance = Math.abs(mark.x - viewX);
			if (distance < bestDistance) {
				best = mark.label;
				bestDistance = distance;
			}
		}
		setHovered(best);
	};

	return (
		<div data-widget-body="chart" data-chart-size={size()} class="group space-y-1">
			<svg
				role="img"
				aria-label={summaryText(widget())}
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				class="h-auto w-full"
				tabindex={size() === "large" ? "0" : undefined}
				onPointerMove={onPlotMove}
				onPointerLeave={() => setHovered(null)}
			>
				<title>{summaryText(widget())}</title>
				<Show when={size() !== "small"}>
					<line
						x1={PAD}
						x2={WIDTH - PAD}
						y1={HEIGHT - PAD}
						y2={HEIGHT - PAD}
						stroke="currentColor"
						class="text-slate-600"
						stroke-width="1"
					/>
				</Show>
				<For each={widget().series}>
					{(series, seriesIndex) => (
						<g>
							<Show
								when={widget().chartType === "line"}
								fallback={
									<For each={series.points}>
										{(point, pointIndex) => {
											const count = series.points.length;
											const width = Math.max(2, (WIDTH - PAD * 2) / Math.max(count, 1) - 2);
											const x = xAt(pointIndex(), count) - width / 2;
											const y = yAt(point.y, min, max);
											const baseline = yAt(Math.max(0, min), min, max);
											return (
												<rect
													x={x}
													y={Math.min(y, baseline)}
													width={width}
													height={Math.max(1, Math.abs(baseline - y))}
													fill={colorAt(seriesIndex())}
												>
													<title>{`${series.name}: ${point.x} — ${point.y}`}</title>
												</rect>
											);
										}}
									</For>
								}
							>
								<polyline
									points={series.points
										.map(
											(point, pointIndex) =>
												`${xAt(pointIndex, series.points.length)},${yAt(point.y, min, max)}`,
										)
										.join(" ")}
									fill="none"
									stroke={colorAt(seriesIndex())}
									stroke-width="2"
									stroke-linejoin="round"
									stroke-linecap="round"
								/>
							</Show>
						</g>
					)}
				</For>
				<Show when={size() === "large"}>
					<g>
						<For each={valueLabels()}>
							{(label) => (
								<text
									x={label.x}
									y={label.y - 6}
									text-anchor="middle"
									font-size="10"
									class="fill-slate-700 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
								>
									{label.text}
								</text>
							)}
						</For>
					</g>
				</Show>
			</svg>
			<Show when={size() !== "small"}>
				<div class="flex items-baseline justify-between gap-2 text-2xs text-slate-600">
					<span>{firstLabel()}</span>
					<Show when={widget().unit.trim().length > 0}>
						<span class="font-medium">Unit: {widget().unit}</span>
					</Show>
					<span>{lastLabel()}</span>
				</div>
			</Show>
			<Show when={size() === "large"}>
				<ul aria-label="Legend" class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-800">
					<For each={widget().series}>
						{(series, seriesIndex) => (
							<li class="flex items-center gap-1.5">
								<svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
									<line
										x1="1"
										x2="15"
										y1="5"
										y2="5"
										stroke={colorAt(seriesIndex())}
										stroke-width="2"
										stroke-linecap="round"
									/>
								</svg>
								<span>{series.name}</span>
							</li>
						)}
					</For>
				</ul>
				<p aria-live="polite" class="min-h-4 text-xs text-slate-700">
					{hovered() ??
						"Point at the chart to read values; the data table below lists every value."}
				</p>
			</Show>
			<details class="text-xs">
				<summary class="cursor-pointer text-slate-700">Data table: {widget().title}</summary>
				<table class="mt-1 w-full border-collapse text-xs text-slate-900">
					<caption class="text-left text-2xs text-slate-600">{`Values plotted in "${widget().title}"`}</caption>
					<thead>
						<tr>
							<th scope="col" class="border border-slate-200 px-2 py-1 text-left">
								Label
							</th>
							<For each={widget().series}>
								{(series) => (
									<th scope="col" class="border border-slate-200 px-2 py-1 text-right">
										{series.name}
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={widget().series[0]?.points ?? []}>
							{(point, rowIndex) => (
								<tr>
									<th scope="row" class="border border-slate-200 px-2 py-1 text-left font-normal">
										{point.x}
									</th>
									<For each={widget().series}>
										{(series) => (
											<td class="border border-slate-200 px-2 py-1 text-right tabular-nums">
												{series.points[rowIndex()]?.y ?? "—"}
											</td>
										)}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</details>
			<span class="sr-only">
				{summaryText(widget())} Points: {pointCount()} per longest series.
			</span>
		</div>
	);
}
