import type { MarketSeries, MarketWidgetCore } from "@research/contracts";
import { selectRange } from "@research/domain";
import { seriesColor } from "@research/ui-registry";
import { type Accessor, createMemo, createSignal, type JSX, Show } from "solid-js";
import { ChartOpener } from "../../chartViewer/ChartOpener.tsx";
import { LazyChartViewer } from "../../chartViewer/LazyChartViewer.tsx";
import { TwelveDataSessionNote, WidgetProvenance } from "../HomeFrame.tsx";
import {
	changeErrorText,
	formatChange,
	formatValue,
	sparklinePath,
	staleFailureReason,
	summarizeSeries,
	toPoints,
	unavailableText,
} from "../homeModel.ts";

/**
 * One series: latest value with its unit, change vs the previous observation,
 * one-year change, and a sparkline of the last 3 months (`aria-hidden` —
 * the same numbers are in the text), under the series name (frames show no
 * title, so the body says what it measures). The unit is shown once, next to the
 * value; change lines carry no unit ("▲ +0.33 (+2.19%)", "▲ +0.50 pp" for
 * percent-unit series). A series whose last refresh failed still shows its
 * stored values with an amber "last refresh failed (reason)" note; only a
 * series with no observations is "unavailable (reason)". The value block
 * (value, change lines, sparkline) is a native button whose name is "Open
 * chart: <series title>, " followed by the visible values, and it opens the
 * detailed chart viewer (ADR-0025, lazy chunk) at the 1y preset; a series
 * with no observations has no button. Once open, the viewer stays open until
 * closed: a reload that drops the observations shows its "unavailable"
 * state instead of unmounting it with focus lost.
 */
export function MetricWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "market-metric" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const series = () => props.seriesById().get(props.widget.seriesId) ?? null;
	// One object per press, keyed below: a press while the download failure
	// shows mounts a fresh viewer, which imports again.
	const [viewerRequest, setViewerRequest] = createSignal<{
		readonly opener: HTMLElement;
	} | null>(null);
	// The viewer's one series, live through the accessor: empty while the
	// series holds no observations (the open viewer then says so).
	const viewerSeries = createMemo(() => {
		const entry = series();
		return entry === null || entry.observations.length === 0 ? [] : [entry];
	});
	return (
		<>
			{/* Frames carry no visible title, so the body names its series:
			    the provider's title once refreshed, else the series id. */}
			<p class="text-xs font-medium text-slate-700" data-field="metric-series">
				{series()?.title ?? props.widget.seriesId}
			</p>
			<Show
				when={series()}
				fallback={<p class="text-sm text-amber-900">unavailable ({unavailableText("NO_DATA")})</p>}
			>
				{(entry) => (
					<MetricBody series={entry()} onOpen={(button) => setViewerRequest({ opener: button })} />
				)}
			</Show>
			<Show when={viewerRequest()} keyed>
				{(request) => (
					<LazyChartViewer
						open
						title={series()?.title ?? props.widget.seriesId}
						series={viewerSeries}
						initialPreset="1y"
						opener={request.opener}
						onClose={() => setViewerRequest(null)}
					/>
				)}
			</Show>
			<TwelveDataSessionNote seriesIds={[props.widget.seriesId]} byId={props.seriesById} />
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</>
	);
}

function MetricBody(props: {
	readonly series: MarketSeries;
	readonly onOpen: (button: HTMLButtonElement) => void;
}): JSX.Element {
	const summary = createMemo(() => summarizeSeries(props.series));
	const sparkPoints = createMemo(() => selectRange(toPoints(props.series.observations), "3m"));
	const spark = createMemo(() => sparklinePath(sparkPoints(), 96, 28));
	const latest = () => summary().latest;
	const stale = () => staleFailureReason(props.series);
	const missingReason = () => props.series.unavailable?.reason ?? unavailableText("NO_DATA");
	return (
		<>
			<Show
				when={latest()}
				fallback={<p class="text-sm text-amber-900">unavailable ({missingReason()})</p>}
			>
				{(point) => (
					// Phrasing content only inside the button: block spans, not
					// div/p, and the visible values form its accessible name.
					<ChartOpener
						srPrefix={`Open chart: ${props.series.title}, `}
						openerKey={props.series.seriesId}
						onOpen={props.onOpen}
					>
						<span class="block space-y-1">
							<span class="block text-base font-semibold tabular-nums text-slate-900">
								{formatValue(point().value)}{" "}
								<span class="text-xs font-normal text-slate-600">{props.series.unit}</span>
							</span>
							<ChangeLine label="Change" change={summary().change} unit={props.series.unit} />
							<ChangeLine
								label="1-year change"
								change={summary().yearChange}
								unit={props.series.unit}
							/>
							<Show when={spark() !== ""}>
								<svg
									role="img"
									aria-hidden="true"
									width="96"
									height="28"
									viewBox="0 0 96 28"
									class="mt-1 block"
								>
									<path d={spark()} fill="none" stroke={seriesColor(0)} stroke-width="1.5" />
								</svg>
							</Show>
						</span>
					</ChartOpener>
				)}
			</Show>
			<Show when={stale()}>
				{(reason) => <p class="mt-1 text-xs text-amber-900">last refresh failed ({reason()})</p>}
			</Show>
		</>
	);
}

function ChangeLine(props: {
	readonly label: string;
	readonly change:
		| ReturnType<typeof summarizeSeries>["change"]
		| ReturnType<typeof summarizeSeries>["yearChange"];
	readonly unit: string;
}): JSX.Element {
	const formatted = createMemo(() =>
		props.change.ok ? formatChange(props.change.value, props.unit) : null,
	);
	const errorText = () =>
		props.change.ok ? null : `unavailable (${changeErrorText(props.change.error)})`;
	return (
		<span class="block text-xs tabular-nums text-slate-700">
			{props.label}:{" "}
			<Show when={formatted()} fallback={<span class="italic">{errorText()}</span>}>
				{(line) => (
					<>
						{line().text} <span class="sr-only">({line().word})</span>
					</>
				)}
			</Show>
		</span>
	);
}
