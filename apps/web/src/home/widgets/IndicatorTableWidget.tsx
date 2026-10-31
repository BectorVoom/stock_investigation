import type { MarketSeries, MarketWidgetCore } from "@research/contracts";
import type { MarketPoint } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createMemo, For, type JSX, Show } from "solid-js";
import { ChartOpener } from "../../chartViewer/ChartOpener.tsx";
import { chartViewerMessages } from "../../chartViewer/chartViewer.messages.tsx";
import { CHANGE_TONES } from "../../components/ui.tsx";
import { commonMessages } from "../../i18n/common.messages.ts";
import { WidgetProvenance } from "../HomeFrame.tsx";
import { homeModelMessages } from "../homeModel.messages.ts";
import {
	buildSparkline,
	changeErrorText,
	formatChange,
	formatValue,
	type IndicatorTrendPreset,
	indicatorTrendPreset,
	presetPoints,
	seriesMissingReason,
	staleFailureReason,
	summarizeSeries,
	toPoints,
	unavailableText,
} from "../homeModel.ts";
import { MaterialDetails } from "./MaterialDetails.tsx";
import { marketWidgetMessages } from "./marketWidgets.messages.ts";
import { Sparkline } from "./Sparkline.tsx";
import { createSeriesViewer } from "./StockTableWidget.tsx";

/**
 * One row per series (economic indicators): Indicator · Latest value ·
 * As of · Previous · Change · 1-year change · Trend · Source. The latest and
 * previous values carry their unit beside the number, like the stock table:
 * a separate Unit column read as part of the "Latest" header. The row header
 * is the series name, with the symbol in monospace as secondary text; for a
 * series with observations it is a native button named "Open chart: " plus
 * the visible name and symbol, exactly like a Stock table row, that opens
 * the detailed chart viewer (ADR-0025, lazy chunk; mounted after the table,
 * since a dialog inside `<tbody>` would break it) for that row's series.
 *
 * The Trend column (ADR-0044 §1) draws the row's history from the stored
 * observations the page already holds: the Metric widget's decorative
 * sparkline (`aria-hidden`; green when the range ends above its start, red
 * below, dotted start line) with the range it covers beside it in the chart
 * viewer's own preset wording ("1Y", "5Y", "Max"). The range follows the
 * series' native frequency (`indicatorTrendPreset`: daily and weekly 1 year,
 * monthly 5 years, coarser the whole history) and the viewer opens at the
 * same preset over the same points (`presetPoints`), so the two never
 * disagree. The line and the range name are `aria-hidden`; a screen reader
 * hears the direction over the range ("up over 5 years"). A row with fewer
 * than two points in its range shows the range and no line, and a row
 * without values a dash read as "unavailable" — never a blank cell. The
 * Trend column shows only from the `@2xl` container width (42rem) up, i.e.
 * in a Large frame: a Medium frame (about 36rem) already fills its width
 * with the seven value columns, and an eighth pushed Source out of view.
 *
 * Per-cell "unavailable (reason)" — never blank, never 0. A series whose
 * last refresh failed still shows its stored values with an amber "last
 * refresh failed (reason)" note row beneath it.
 */
export function IndicatorTableWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "indicator-table" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const viewer = createSeriesViewer(props.seriesById);
	return (
		<div class="@container">
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm">
					<caption class="caption-top pb-1 text-left text-xs text-slate-600">
						{m().indicatorCaption(props.widget.title)}
					</caption>
					<thead>
						<tr class="whitespace-nowrap border-b border-slate-200 text-xs text-slate-700">
							<th scope="col" class="py-1 pr-3 font-semibold">
								{m().indicator}
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								{m().latest}
							</th>
							<th scope="col" class="py-1 pr-3 font-semibold">
								{m().asOf}
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								{m().previous}
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								{m().change}
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								{m().yearChange}
							</th>
							<th scope="col" class={`py-1 pr-3 font-semibold ${TREND_COLUMN}`}>
								{m().trend}
							</th>
							<th scope="col" class="py-1 font-semibold">
								{m().source}
							</th>
						</tr>
					</thead>
					<tbody>
						<For each={props.widget.seriesIds}>
							{(seriesId) => (
								<IndicatorRow
									series={props.seriesById().get(seriesId) ?? null}
									onOpen={(button, preset) => viewer.open(seriesId, button, preset)}
								/>
							)}
						</For>
					</tbody>
				</table>
			</div>
			<viewer.View />
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</div>
	);
}

/**
 * The Trend column's cells: hidden below the `@2xl` container width
 * (ADR-0044 §1). Measured in Chrome: a Medium frame's table is 582 px wide
 * and needed 697 px with the column, cutting off Source; Large frames have
 * the room.
 */
const TREND_COLUMN = "hidden @2xl:table-cell";

/** Every column of the table, for the cells that span a whole row. */
const COLUMN_COUNT = 8;

/** The Trend sparkline's box in CSS px: about a row's two lines tall. */
const TREND_WIDTH = 72;
const TREND_HEIGHT = 24;
const TREND_INSET = 2;

function IndicatorRow(props: {
	readonly series: MarketSeries | null;
	readonly onOpen: (button: HTMLButtonElement, preset: IndicatorTrendPreset) => void;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
	const ready = createMemo(() => {
		const entry = props.series;
		if (entry === null) return null;
		const summary = summarizeSeries(entry);
		if (summary.latest === null || entry.observations.length === 0) return null;
		return { entry, summary, latest: summary.latest };
	});
	const missingReason = () => seriesMissingReason(props.series, modelText());
	const stale = () =>
		props.series === null ? null : staleFailureReason(props.series, modelText());
	const preset = createMemo(() =>
		indicatorTrendPreset(props.series === null ? "unknown" : props.series.frequency),
	);
	const trendPoints = createMemo(() =>
		props.series === null ? [] : presetPoints(toPoints(props.series.observations), preset()),
	);
	// The viewer opens only for a series with observations (ADR-0025).
	const openable = () => (props.series?.observations.length ?? 0) > 0;
	return (
		<Show
			when={props.series}
			fallback={
				<tr class="border-b border-slate-200">
					<td colspan={COLUMN_COUNT} class="py-1 text-sm text-amber-900">
						{common().unavailable(unavailableText("NO_DATA", modelText()))}
					</td>
				</tr>
			}
		>
			{(entry) => (
				<>
					<tr class="border-b border-slate-200 align-top">
						<th scope="row" class="py-1 pr-3 font-medium">
							<Show when={openable()} fallback={<RowName series={entry()} />}>
								<ChartOpener
									srPrefix={m().openChart}
									openerKey={entry().seriesId}
									onOpen={(button) => props.onOpen(button, preset())}
								>
									<RowName series={entry()} />
								</ChartOpener>
							</Show>
						</th>
						<Show
							when={ready()}
							fallback={
								<td colspan="5" class="py-1 pr-3 text-sm text-amber-900">
									{common().unavailable(missingReason())}
								</td>
							}
						>
							{(good) => (
								<>
									<td class="py-1 pr-3 text-right tabular-nums">
										<ValueWithUnit
											value={formatValue(good().latest.value)}
											unit={good().entry.unit}
										/>
									</td>
									<td class="py-1 pr-3 text-xs">
										<time dateTime={good().latest.observedOn}>{good().latest.observedOn}</time>
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<PreviousCell change={good().summary.change} unit={good().entry.unit} />
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<FullChangeCell change={good().summary.change} unit={good().entry.unit} />
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<FullChangeCell change={good().summary.yearChange} unit={good().entry.unit} />
									</td>
								</>
							)}
						</Show>
						<TrendCell points={trendPoints()} preset={preset()} ready={ready() !== null} />
						{/* The source may wrap: in a Medium frame a long publisher name on
						    one line pushed the table past the frame's width. */}
						<td class="py-1 text-xs">
							<SafeLink url={entry().sourceUrl}>{entry().publisher}</SafeLink>
							<MaterialDetails series={entry()} />
						</td>
					</tr>
					<Show when={stale()}>
						{(reason) => (
							<tr class="border-b border-slate-200">
								<td colspan={COLUMN_COUNT} class="py-1 text-xs text-amber-900">
									{m().lastRefreshFailed(reason())}
								</td>
							</tr>
						)}
					</Show>
				</>
			)}
		</Show>
	);
}

/** The row header's text: the series name, then its symbol in monospace (phrasing content only). */
function RowName(props: { readonly series: MarketSeries }): JSX.Element {
	return (
		<>
			<span class="block">{props.series.title}</span>{" "}
			<span class="block font-mono text-2xs font-normal text-slate-600">{props.series.symbol}</span>
		</>
	);
}

/**
 * The Trend cell. With values: the sparkline over the row's range and the
 * range's name beside it; the line and the name are `aria-hidden`, and a
 * screen reader hears the direction over the range instead ("up over 5
 * years"), or that the range holds too few observations for a line. Without
 * values (the row's value cells say why): a dash, read as "unavailable" —
 * never a bare range name that suggests data, never a blank cell.
 */
function TrendCell(props: {
	readonly points: readonly MarketPoint[];
	readonly preset: IndicatorTrendPreset;
	/** False when the row has no values to show (no observations, no latest point). */
	readonly ready: boolean;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const viewerText = useMessages(chartViewerMessages);
	const line = createMemo(() =>
		props.ready ? buildSparkline(props.points, TREND_WIDTH, TREND_HEIGHT, TREND_INSET) : null,
	);
	const spokenTrend = () => {
		const current = line();
		return current === null
			? m().trendTooShort(props.preset)
			: m().trendDirection(current.direction, props.preset);
	};
	return (
		<td
			class={`py-1 pr-3 ${TREND_COLUMN}`}
			data-field="indicator-trend"
			data-trend-preset={props.preset}
		>
			<Show
				when={props.ready}
				fallback={
					<>
						<span aria-hidden="true" class="text-slate-600">
							—
						</span>
						<span class="sr-only">{m().readoutUnavailable}</span>
					</>
				}
			>
				<span class="flex items-center gap-2 whitespace-nowrap">
					<Sparkline
						line={line()}
						width={TREND_WIDTH}
						height={TREND_HEIGHT}
						class="block shrink-0"
					/>
					<span aria-hidden="true" class="text-2xs text-slate-600">
						{viewerText().preset(props.preset)}
					</span>
					<span class="sr-only">{spokenTrend()}</span>
				</span>
			</Show>
		</td>
	);
}

/** A number with its unit after it in smaller, secondary text. */
function ValueWithUnit(props: { readonly value: string; readonly unit: string }): JSX.Element {
	return (
		<>
			{props.value} <span class="text-xs text-slate-600">{props.unit}</span>
		</>
	);
}

/** The previous observation's value, with its unit. */
function PreviousCell(props: {
	readonly change: ReturnType<typeof summarizeSeries>["change"];
	readonly unit: string;
}): JSX.Element {
	// D1: the text is null only when the Result failed, never because of the
	// number — a previous value of 0 is "0", a real value, not an absence.
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
	const text = createMemo(() =>
		props.change.ok ? formatValue(props.change.value.previous.value) : null,
	);
	const problem = () => (props.change.ok ? "" : changeErrorText(props.change.error, modelText()));
	return (
		<Show when={text()} fallback={<span class="italic">{common().unavailable(problem())}</span>}>
			{(value) => <ValueWithUnit value={value()} unit={props.unit} />}
		</Show>
	);
}

function FullChangeCell(props: {
	readonly change:
		| ReturnType<typeof summarizeSeries>["change"]
		| ReturnType<typeof summarizeSeries>["yearChange"];
	readonly unit: string;
}): JSX.Element {
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
	const formatted = createMemo(() =>
		props.change.ok ? formatChange(props.change.value, props.unit, modelText()) : null,
	);
	const problem = () => (props.change.ok ? "" : changeErrorText(props.change.error, modelText()));
	return (
		<Show
			when={formatted()}
			fallback={<span class="italic">{common().unavailable(problem())}</span>}
		>
			{(line) => (
				<span class={CHANGE_TONES[line().direction]}>
					{line().text} <span class="sr-only">({line().word})</span>
				</span>
			)}
		</Show>
	);
}
