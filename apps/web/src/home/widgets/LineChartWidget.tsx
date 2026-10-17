import type { MarketRange, MarketSeries, MarketWidgetCore } from "@research/contracts";
import { selectRange } from "@research/domain";
import { ChartFrame, ChartLegend, SafeLink } from "@research/ui-registry";
import { type Accessor, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { ChartOpener } from "../../chartViewer/ChartOpener.tsx";
import { LazyChartViewer } from "../../chartViewer/LazyChartViewer.tsx";
import { initialPresetForRange } from "../../chartViewer/openChart.ts";
import { DisclosureSummary } from "../../components/ui.tsx";
import {
	buildHomeLineModel,
	formatValue,
	HOME_RANGE_LABELS,
	HOME_RANGES,
	staleFailureReason,
	toPoints,
	unavailableText,
} from "../homeModel.ts";
import type { SlSelectElement } from "../sl-elements.d.ts";
import "../shoelace.ts";
import { WidgetProvenance } from "../HomeFrame.tsx";

/**
 * One to four series that share one unit, over a range, with a legend and a
 * data-table twin. Built on the shared chart primitives (ChartFrame,
 * ChartLegend, palette, scales, ticks from `@research/ui-registry`); the
 * widget only derives the model (memoized, never re-parsed per render).
 * A range change saves the widget through `onSaveRange`. The select is
 * never disabled during a page's save: a change made then waits for the
 * save in flight (ADR-0024), and toggling an `sl-select`'s `disabled` while
 * closed runs a deferred hide that can land after the next open, leaving
 * the listbox open but invisible. Series with stored
 * observations stay plotted even when their last refresh failed, with an
 * amber "last refresh failed (reason)" note beside them. The plot area is a
 * native button named "Open chart: " plus the plot's own image name ("Line
 * chart: <title>. <unit> by date.") that opens the detailed chart viewer
 * (ADR-0025, lazy chunk) with all the widget's usable series; the viewer
 * stays open until closed, showing "unavailable" if a reload drops every
 * series; the Range select, legend
 * and data-table twin stay outside it, and the hover readout keeps working
 * (the button never starts a widget drag — buttons are in the drag engine's
 * no-drag list — and a completed drag swallows the release click).
 */
export function LineChartWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "line-chart" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
	readonly onSaveRange: (widget: MarketWidgetCore) => void;
}): JSX.Element {
	const resolved = createMemo(() =>
		props.widget.seriesIds.map((id) => props.seriesById().get(id) ?? null),
	);
	const usable = createMemo(() =>
		resolved().flatMap((series) =>
			series === null || series.observations.length === 0 ? [] : [series],
		),
	);
	const missing = createMemo(() =>
		resolved().flatMap((series, index) => {
			const id = props.widget.seriesIds[index];
			if (id === undefined) return [];
			return series === null || series.observations.length === 0 ? [id] : [];
		}),
	);
	const stale = createMemo(() => usable().filter((series) => staleFailureReason(series) !== null));
	const units = createMemo(() => [...new Set(usable().map((series) => series.unit))]);
	const unit = () => units()[0] ?? "";
	const mixedUnits = () => units().length > 1;
	const model = createMemo(() => {
		if (mixedUnits()) return null;
		return buildHomeLineModel(
			usable().map((series) => ({
				key: series.seriesId,
				label: series.title,
				points: toPoints(series.observations),
			})),
			props.widget.range,
		);
	});
	const [hoveredRow, setHoveredRow] = createSignal<number | null>(null);
	const [viewerOpen, setViewerOpen] = createSignal(false);
	let opener: HTMLElement | null = null;
	const readout = createMemo((): string | null => {
		const current = model();
		const rowIndex = hoveredRow();
		if (current === null || rowIndex === null) return null;
		const values = current.series.map((entry) => {
			const value = entry.values.get(rowIndex);
			return `${entry.label}: ${value === undefined ? "unavailable" : `${formatValue(value)} ${unit()}`}`;
		});
		return `${current.rowLabels[rowIndex] ?? "unavailable"} — ${values.join(" · ")}`;
	});

	const onRangeChange = (event: Event & { readonly currentTarget: SlSelectElement }) => {
		// H1: only the select's own change, not a bubbled nested event.
		if (event.target !== event.currentTarget) return;
		const value = event.currentTarget.value;
		const next = Array.isArray(value) ? value[0] : value;
		if (next === undefined || next === props.widget.range) return;
		const range = HOME_RANGES.find((entry) => entry === next);
		if (range !== undefined) props.onSaveRange({ ...props.widget, range });
	};

	return (
		<div class="space-y-1">
			<div class="flex flex-wrap items-center gap-2">
				<sl-select
					label="Range"
					value={props.widget.range}
					size="small"
					hoist
					on:sl-change={onRangeChange}
				>
					<For each={HOME_RANGES}>
						{(range) => <sl-option value={range}>{HOME_RANGE_LABELS[range]}</sl-option>}
					</For>
				</sl-select>
			</div>
			<Show when={!mixedUnits()} fallback={<MixedUnits units={units()} />}>
				<Show
					when={model()}
					fallback={
						<p class="text-sm text-amber-900">
							unavailable (
							{missing().length === props.widget.seriesIds.length
								? unavailableText("NO_DATA")
								: "no plottable points in this range"}
							)
						</p>
					}
				>
					{(current) => (
						<>
							<ChartOpener
								srPrefix="Open chart: "
								onOpen={(button) => {
									opener = button;
									setViewerOpen(true);
								}}
							>
								<ChartFrame
									ariaLabel={`Line chart: ${props.widget.title}. ${unit()} by date.`}
									plot={current().plot}
									xAxisTitle="Date"
									yAxisTitle={unit()}
									yTicks={current().yTicks}
									yScale={current().yScale}
									xTicks={current().xTicks}
									rowXs={current().rowXs}
									hoveredRow={hoveredRow()}
									onHoverRow={setHoveredRow}
								>
									<For each={current().series}>
										{(entry) => (
											<g data-series={entry.label}>
												<For each={entry.paths}>
													{(d) => (
														<path
															d={d}
															fill="none"
															stroke={entry.color}
															stroke-width="2"
															stroke-linejoin="round"
															stroke-linecap="round"
														/>
													)}
												</For>
												<Show when={entry.circles.length <= 200}>
													<For each={entry.circles}>
														{(circle) => (
															<circle cx={circle.x} cy={circle.y} r={2.5} fill={entry.color} />
														)}
													</For>
												</Show>
											</g>
										)}
									</For>
								</ChartFrame>
							</ChartOpener>
							<ChartLegend
								mark="line"
								items={current().series.map((entry) => ({
									label: entry.label,
									color: entry.color,
								}))}
							/>
							<p data-chart-part="readout" class="mt-1 min-h-4 text-xs text-slate-700">
								{readout() ??
									"Point at the chart to read values; the data table below lists every value."}
							</p>
							<DataTwin
								title={props.widget.title}
								model={current()}
								series={usable()}
								unit={unit()}
								range={props.widget.range}
							/>
						</>
					)}
				</Show>
			</Show>
			<Show when={stale().length > 0}>
				<ul aria-label="Stale series" class="space-y-0.5 text-xs text-amber-900">
					<For each={stale()}>
						{(entry) => (
							<li>
								{entry.title}: last refresh failed (
								{entry.unavailable?.reason ?? unavailableText("NO_DATA")})
							</li>
						)}
					</For>
				</ul>
			</Show>
			<Show when={missing().length > 0}>
				<ul aria-label="Unavailable series" class="space-y-0.5 text-xs text-amber-900">
					<For each={missing()}>
						{(id) => (
							<li>
								{props.seriesById().get(id)?.title ?? id}: unavailable (
								{props.seriesById().get(id)?.unavailable?.reason ?? unavailableText("NO_DATA")})
							</li>
						)}
					</For>
				</ul>
			</Show>
			{/*
			 * The viewer mounts only while open (ADR-0025): nothing is saved,
			 * and the opening preset follows the widget's current range.
			 */}
			<Show when={viewerOpen()}>
				<LazyChartViewer
					open
					title={props.widget.title}
					series={usable}
					initialPreset={initialPresetForRange(props.widget.range)}
					opener={opener}
					onClose={() => setViewerOpen(false)}
				/>
			</Show>
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</div>
	);
}

function MixedUnits(props: { readonly units: readonly string[] }): JSX.Element {
	return (
		<p role="alert" class="text-sm text-red-900">
			This chart cannot be drawn: its series do not share one unit ({props.units.join(", ")}). Edit
			the widget so every series uses the same unit.
		</p>
	);
}

function DataTwin(props: {
	readonly title: string;
	readonly model: {
		readonly rowLabels: readonly (string | null)[];
		readonly series: readonly {
			readonly key: string;
			readonly label: string;
			readonly plottedCount: number;
		}[];
	};
	readonly series: readonly MarketSeries[];
	readonly unit: string;
	readonly range: MarketRange;
}): JSX.Element {
	const valuesBySeries = createMemo(() => {
		const ranged = new Map<string, ReadonlyMap<string, number>>();
		for (const entry of props.series) {
			ranged.set(
				entry.seriesId,
				new Map(
					selectRange(toPoints(entry.observations), props.range).map((point) => [
						point.observedOn,
						point.value,
					]),
				),
			);
		}
		return ranged;
	});
	return (
		<details class="group mt-1 text-xs">
			<DisclosureSummary>Data table: {props.title}</DisclosureSummary>
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-xs">
					<caption class="caption-top pb-1 text-left text-slate-600">
						Values plotted in "{props.title}" ({props.unit})
					</caption>
					<thead>
						<tr class="border-b border-slate-200">
							<th scope="col" class="py-1 pr-3 font-semibold">
								Date
							</th>
							<For each={props.model.series}>
								{(entry) => (
									<th scope="col" class="py-1 pr-3 text-right font-semibold">
										{entry.label}
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={props.model.rowLabels}>
							{(date) => (
								<tr class="border-b border-slate-200">
									<th scope="row" class="py-1 pr-3 font-medium">
										{date === null ? (
											<span class="italic">date not stated</span>
										) : (
											// D3: date only under the "Date" header, not "as of <date>".
											<time dateTime={date}>{date}</time>
										)}
									</th>
									<For each={props.model.series}>
										{(entry) => (
											<td class="py-1 pr-3 text-right tabular-nums">
												{(() => {
													const value =
														date === null ? undefined : valuesBySeries().get(entry.key)?.get(date);
													return value === undefined ? (
														<span class="italic text-amber-900">unavailable (no value)</span>
													) : (
														formatValue(value)
													);
												})()}
											</td>
										)}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>
			<p class="mt-1 text-2xs text-slate-600">
				Sources:{" "}
				<For each={props.series}>
					{(entry, index) => (
						<span>
							{index() > 0 ? "; " : ""}
							<SafeLink url={entry.sourceUrl}>{entry.publisher}</SafeLink>
						</span>
					)}
				</For>
			</p>
		</details>
	);
}
