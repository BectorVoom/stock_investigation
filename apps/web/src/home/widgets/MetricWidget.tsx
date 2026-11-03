import type { MarketSeries, MarketWidgetCore } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { type Accessor, createMemo, createSignal, type JSX, Show } from "solid-js";
import { ChartOpener } from "../../chartViewer/ChartOpener.tsx";
import { LazyChartViewer } from "../../chartViewer/LazyChartViewer.tsx";
import { CHANGE_TONES } from "../../components/ui.tsx";
import { commonMessages } from "../../i18n/common.messages.ts";
import { WidgetProvenance } from "../HomeFrame.tsx";
import { homeModelMessages } from "../homeModel.messages.ts";
import {
	type ChangeBasis,
	changeErrorText,
	displayUnit,
	formatChange,
	formatValue,
	presetPoints,
	seriesMissingReason,
	staleFailureReason,
	summarizeSeries,
	TREND_PRESET,
	toPoints,
	unavailableText,
} from "../homeModel.ts";
import { marketWidgetMessages } from "./marketWidgets.messages.ts";
import { TrendLine } from "./TrendLine.tsx";

/**
 * One series: latest value with its unit, 前月比 and 前年比 (against the
 * value a calendar month and a calendar year earlier, like the Indicator
 * table, so every series means the same period by them whether it is daily
 * or monthly; ADR-0069), and the series' trend line over the last year
 * (the Indicator table's Trend range, `TREND_PRESET`) with 「1年」 beside it,
 * under the series name (frames show no
 * title, so the body says what it measures). The as-of date is in the footer. The unit is shown once, next to the
 * value; change lines carry no unit ("▲ +0.33 (+2.19%)", "▲ +0.50 pp" for
 * percent-unit series). A series whose last refresh failed still shows its
 * stored values with an amber "last refresh failed (reason)" note; only a
 * series with no observations is "unavailable (reason)". The value block
 * (value, change lines, sparkline) is a native button whose name is "Open
 * chart: <series title>, " followed by the visible values, and it opens the
 * detailed chart viewer (ADR-0025, lazy chunk) at the trend line's 1y
 * preset, so the viewer opens on the dates the line covers; a series
 * with no observations has no button. Once open, the viewer stays open until
 * closed: a reload that drops the observations shows its "unavailable"
 * state instead of unmounting it with focus lost.
 */
export function MetricWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "market-metric" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
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
				fallback={
					<p class="text-sm text-amber-900">
						{common().unavailable(unavailableText("NO_DATA", modelText()))}
					</p>
				}
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
						initialPreset={TREND_PRESET}
						opener={request.opener}
						onClose={() => setViewerRequest(null)}
					/>
				)}
			</Show>
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</>
	);
}

/** Trend line box in CSS px; the inset keeps the 2 px stroke off the top and bottom edges. */
const SPARK_WIDTH = 128;
const SPARK_HEIGHT = 32;
const SPARK_INSET = 2;

function MetricBody(props: {
	readonly series: MarketSeries;
	readonly onOpen: (button: HTMLButtonElement) => void;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
	const summary = createMemo(() => summarizeSeries(props.series));
	const trendPoints = createMemo(() =>
		presetPoints(toPoints(props.series.observations), TREND_PRESET),
	);
	const latest = () => summary().latest;
	const stale = () => staleFailureReason(props.series, modelText());
	const missingReason = () => seriesMissingReason(props.series, modelText());
	return (
		<>
			<Show
				when={latest()}
				fallback={<p class="text-sm text-amber-900">{common().unavailable(missingReason())}</p>}
			>
				{(point) => (
					// Phrasing content only inside the button: block spans, not
					// div/p, and the visible values form its accessible name.
					<ChartOpener
						srPrefix={m().openChartOf(props.series.title)}
						openerKey={props.series.seriesId}
						onOpen={props.onOpen}
					>
						<span class="block space-y-1">
							<span class="block text-base font-semibold tabular-nums text-slate-900">
								{formatValue(point().value)}{" "}
								<span class="text-xs font-normal text-slate-600">
									{displayUnit(props.series.unit)}
								</span>
							</span>
							<ChangeLine
								label={m().monthChange}
								change={summary().monthChange}
								basis="month"
								unit={props.series.unit}
							/>
							<ChangeLine
								label={m().yearChange}
								change={summary().yearChange}
								basis="year"
								unit={props.series.unit}
							/>
							<TrendLine
								points={trendPoints()}
								showRange
								width={SPARK_WIDTH}
								height={SPARK_HEIGHT}
								inset={SPARK_INSET}
								class="mt-1"
							/>
						</span>
					</ChartOpener>
				)}
			</Show>
			<Show when={stale()}>
				{(reason) => <p class="mt-1 text-xs text-amber-900">{m().lastRefreshFailed(reason())}</p>}
			</Show>
		</>
	);
}

function ChangeLine(props: {
	readonly label: string;
	readonly change:
		| ReturnType<typeof summarizeSeries>["monthChange"]
		| ReturnType<typeof summarizeSeries>["yearChange"];
	readonly basis: ChangeBasis;
	readonly unit: string;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
	const formatted = createMemo(() =>
		props.change.ok ? formatChange(props.change.value, props.unit, modelText()) : null,
	);
	const errorText = () =>
		props.change.ok
			? null
			: common().unavailable(changeErrorText(props.change.error, modelText(), props.basis));
	return (
		<span class="block text-xs tabular-nums text-slate-700">
			{m().changeLabel(props.label)}
			<Show when={formatted()} fallback={<span class="italic">{errorText()}</span>}>
				{(line) => (
					<span class={CHANGE_TONES[line().direction]}>
						{line().text} <span class="sr-only">({line().word})</span>
					</span>
				)}
			</Show>
		</span>
	);
}
