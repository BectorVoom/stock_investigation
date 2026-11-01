import type { MarketFrequency, MarketObservationTuple, MarketSeries } from "@research/contracts";
import { MARKET_LIMITS } from "@research/contracts";
import {
	autoInterval,
	type ChartBar,
	type ChartInterval,
	type ChartNativeFrequency,
	type ChartPoint,
	type ChartPreset,
	type ChartStats,
	clampWindow,
	type DayWindow,
	dayNumberToIso,
	isoToDayNumber,
	type MarketChange,
	movingAverage,
	panWindow,
	presetWindow,
	resampleSeries,
	visibleSlice,
	windowStats,
	zoomWindow,
} from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import {
	buildDetailChartModel,
	ChartLegend,
	type DetailChartType,
	type DetailMaOverlayInput,
	type DetailScale,
	type DetailValueMode,
	ensureTwoBarWindow,
	logScaleBlocked,
	plotWidthForSize,
	seriesColor,
	unionBarDays,
	unionOverview,
} from "@research/ui-registry";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	Index,
	type JSX,
	Show,
} from "solid-js";
import {
	BUTTON,
	BUTTON_PRIMARY,
	CHANGE_TONES,
	DisclosureSummary,
	INPUT,
	LABEL,
} from "../components/ui.tsx";
import { SingleSeriesFooter } from "../home/HomeFrame.tsx";
import { homeModelMessages } from "../home/homeModel.messages.ts";
import {
	changeDirection,
	formatChange,
	formatPctValue,
	formatSignedDelta,
	formatValue,
	type HomeModelText,
	latestPoint,
} from "../home/homeModel.ts";
import { ensureHomeIconLibraries } from "../home/shoelace.ts";
import type { SlSelectElement } from "../home/sl-elements.d.ts";
import { commonMessages } from "../i18n/common.messages.ts";
import { chartReadoutMessages, chartViewerMessages } from "./chartViewer.messages.tsx";
import { CANDLE_TONES, DetailChart } from "./DetailChart.tsx";
import { Navigator } from "./Navigator.tsx";
import { captureFocusReturn, type FocusReturn, focusReturnTarget } from "./openChart.ts";
import { buildReadoutParts, type ReadoutParts } from "./readout.ts";

// The viewer's selects and checkboxes draw Shoelace icons. Point the icon
// libraries at the shipped SVGs (no `data:` fetch, which `connect-src 'self'`
// blocks) wherever the viewer appears — Home and the Notebook already do,
// the Stocks page's inline Chart tab did not. Idempotent; this chunk loads
// only when a viewer is about to render.
ensureHomeIconLibraries();

/**
 * The detailed chart viewer (ADR-0025): a large modal sheet over the current
 * page where one widget's series can be analyzed — or the same content
 * inline in a page region (`InlineChartViewer`, ADR-0049 §4). Range presets
 * plus exact From/To dates, interval/scale/values controls, moving averages
 * for a single series, the main chart with crosshair, an overview
 * navigator, a statistics table and a data-table twin with provenance.
 * Nothing here is saved; every derivation runs through `createMemo` and
 * resampling is memoized per (series, interval). Entry points (phase 3)
 * pass the widget's series in. A Chart type control (ADR-0056 §6) draws one
 * series with bars as candlesticks; a volume panel (§7) follows the bars.
 */

/** The range presets in button order; their names are in `chartViewerMessages`. */
const PRESETS: readonly ChartPreset[] = [
	"1d",
	"1w",
	"1m",
	"3m",
	"6m",
	"ytd",
	"1y",
	"3y",
	"5y",
	"max",
];

const INTERVALS: readonly ChartInterval[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

const INTERVAL_RANK: { readonly [I in ChartInterval]: number } = {
	daily: 0,
	weekly: 1,
	monthly: 2,
	quarterly: 3,
	yearly: 4,
};

const MA_PERIODS = [20, 50, 200] as const;

type IntervalChoice = ChartInterval | "auto";

function nativeRank(frequency: MarketFrequency): number {
	if (frequency === "weekly") return 1;
	if (frequency === "monthly") return 2;
	if (frequency === "quarterly") return 3;
	if (frequency === "annual") return 4;
	return 0;
}

function toNativeFrequency(frequency: MarketFrequency): ChartNativeFrequency {
	if (frequency === "weekly") return "weekly";
	if (frequency === "monthly") return "monthly";
	if (frequency === "quarterly") return "quarterly";
	if (frequency === "annual") return "annual";
	if (frequency === "unknown") return "unknown";
	return "daily";
}

/** Wire tuples to chart points, with the day's bar when the provider gave one (ADR-0056). */
function toChartPoints(observations: readonly MarketObservationTuple[]): ChartPoint[] {
	return observations.map(([observedOn, value, bar]) =>
		bar === undefined
			? { observedOn, value }
			: { observedOn, value, bar: { open: bar[0], high: bar[1], low: bar[2], volume: bar[3] } },
	);
}

/** Held-data extent over every series' observations (invalid dates are skipped). */
function extentOf(series: readonly MarketSeries[]): DayWindow | null {
	let low: number | null = null;
	let high: number | null = null;
	for (const entry of series) {
		for (const [observedOn] of entry.observations) {
			const day = isoToDayNumber(observedOn);
			if (!day.ok) continue;
			low = low === null ? day.value : Math.min(low, day.value);
			high = high === null ? day.value : Math.max(high, day.value);
		}
	}
	if (low === null || high === null) return null;
	return { from: low, to: high };
}

/**
 * The visible bar whose bucket holds `day`: the first bar dated on or after
 * it (binary search over the ascending visible `days`), while `day` lies in
 * the window. A bar of a weekly or coarser interval is dated at its bucket's
 * last day, so a mid-week crosshair day kept across an Auto Daily→Weekly
 * switch lands on its week's bar instead of vanishing. Null when the day
 * left the window (a pan moved past it) or follows the last visible bar.
 */
export function barIndexForDay(
	days: readonly number[],
	day: number,
	window: DayWindow,
): number | null {
	const from = Math.min(Math.trunc(window.from), Math.trunc(window.to));
	const to = Math.max(Math.trunc(window.from), Math.trunc(window.to));
	if (day < from || day > to) return null;
	let low = 0;
	let high = days.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const value = days[mid];
		if (value !== undefined && value < day) low = mid + 1;
		else high = mid;
	}
	return low < days.length ? low : null;
}

/**
 * Widens `window`'s right end to the bar whose bucket holds the crosshair
 * `day` (fix round 8): a bar of a weekly or coarser interval is dated at its
 * bucket's last observation, so a zoom that ends the window on the
 * crosshair day and switches Auto Daily→Weekly would leave that week's bar
 * after the window's end — hidden, with the crosshair gone and the next
 * zoom anchored on an invisible day. Clamped to the extent; the window is
 * returned unchanged when the day lies outside it or its bar is visible.
 */
export function includeAnchorBar(
	window: DayWindow,
	union: readonly number[],
	day: number,
	extent: DayWindow,
): DayWindow {
	const from = Math.min(window.from, window.to);
	const to = Math.max(window.from, window.to);
	if (!Number.isFinite(day) || day < Math.trunc(from) || day > Math.trunc(to)) return window;
	let low = 0;
	let high = union.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const value = union[mid];
		if (value !== undefined && value < day) low = mid + 1;
		else high = mid;
	}
	const bar = union[low];
	if (bar === undefined || bar <= Math.trunc(to)) return window;
	const widened = Math.min(bar, Math.trunc(Math.max(extent.from, extent.to)));
	return widened > to ? { from, to: widened } : window;
}

/** Resampled bars at one interval plus their union days (memoized per interval). */
interface IntervalData {
	readonly entries: readonly { readonly entry: MarketSeries; readonly bars: readonly ChartBar[] }[];
	readonly union: readonly number[];
	/** The smallest day gap between two neighbouring bars of one series (0 when none). */
	readonly minGap: number;
}

/** The smallest positive day gap between neighbouring bars within any one series, or 0. */
function smallestBarGap(barLists: readonly (readonly ChartBar[])[]): number {
	let gap: number | null = null;
	for (const bars of barLists) {
		for (let index = 1; index < bars.length; index += 1) {
			const previous = bars[index - 1];
			const current = bars[index];
			if (previous === undefined || current === undefined) continue;
			const step = current.day - previous.day;
			if (step > 0) gap = gap === null ? step : Math.min(gap, step);
		}
	}
	return gap ?? 0;
}

function isoOf(day: number): string {
	const iso = dayNumberToIso(day);
	return iso.ok ? iso.value : "";
}

/**
 * Change over the visible window, never colour alone (mark plus word), or
 * `unavailable` when no bar is visible.
 */
function describeChange(
	computed: ChartStats | null,
	unit: string,
	first: ChartBar | undefined,
	last: ChartBar | undefined,
	text: HomeModelText,
	unavailable: string,
): string {
	if (computed === null || first === undefined || last === undefined) {
		return unavailable;
	}
	const change: MarketChange = {
		previous: { observedOn: first.observedOn, value: computed.open },
		latest: { observedOn: last.observedOn, value: computed.close },
		absoluteChange: computed.change,
		percentChange: computed.percentChange,
	};
	const formatted = formatChange(change, unit, text);
	return `${formatted.text} ${formatted.word}`;
}

/** Stats-table percent cell: coloured by direction when it holds a value. */
function PercentCell(props: {
	readonly cell: { readonly text: string; readonly isValue: boolean };
	readonly change: number;
}): JSX.Element {
	return (
		<td
			class={`py-1 pr-3 text-right tabular-nums${props.cell.isValue ? ` ${CHANGE_TONES[changeDirection(props.change)]}` : ""}`}
		>
			{props.cell.text}
		</td>
	);
}

/**
 * The candlestick legend (ADR-0056 §6): Up and Down blocks in the candle
 * colours, then the moving averages as lines — `ChartLegend` draws one mark
 * kind per list, and this legend mixes two.
 */
function CandleLegend(props: {
	readonly averages: readonly { readonly label: string; readonly color: string }[];
}): JSX.Element {
	const m = useMessages(chartViewerMessages);
	const blocks = (): readonly { readonly label: string; readonly tone: string }[] => [
		{ label: m().legendUp, tone: CANDLE_TONES.up.fill },
		{ label: m().legendDown, tone: CANDLE_TONES.down.fill },
	];
	return (
		<ul
			aria-label={m().legend}
			data-chart-part="candle-legend"
			class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-800"
		>
			<For each={blocks()}>
				{(item) => (
					<li class="flex items-center gap-1.5">
						<svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
							<rect x="5" y="0" width="6" height="10" rx="1" class={item.tone} />
						</svg>
						<span>{item.label}</span>
					</li>
				)}
			</For>
			<For each={props.averages}>
				{(item) => (
					<li class="flex items-center gap-1.5">
						<svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
							<line
								x1="1"
								x2="15"
								y1="5"
								y2="5"
								stroke={item.color}
								stroke-width="2"
								stroke-dasharray="4 3"
							/>
						</svg>
						<span>{item.label}</span>
					</li>
				)}
			</For>
		</ul>
	);
}

interface SeriesStats {
	readonly entry: MarketSeries;
	readonly computed: ChartStats | null;
	readonly first: ChartBar | undefined;
	readonly last: ChartBar | undefined;
}

/**
 * One interval option with a reactive disabled state: the `For` loop over the
 * constant `INTERVALS` renders each item once and never re-runs, so the
 * coarse-native check must live in its own component to follow a series
 * change (daily data replaced by monthly disables Daily with its reason).
 */
function IntervalOption(props: {
	readonly value: ChartInterval;
	readonly rank: number;
	readonly coarsest: Accessor<{ readonly rank: number; readonly word: MarketFrequency }>;
}): JSX.Element {
	const m = useMessages(chartViewerMessages);
	const blocked = createMemo(() => props.rank < props.coarsest().rank);
	const text = createMemo(() => {
		const label = m().interval(props.value);
		return blocked() ? m().intervalBlocked(label, m().frequency(props.coarsest().word)) : label;
	});
	return (
		<sl-option value={props.value} disabled={blocked() ? true : undefined}>
			{text()}
		</sl-option>
	);
}

/** What the viewer's content needs, whether it shows in the dialog or inline. */
export interface ChartViewerContentProps {
	/** Names the chart: the dialog's label or the inline heading, the plot and its data table. */
	readonly title: string;
	readonly series: Accessor<readonly MarketSeries[]>;
	readonly initialPreset: ChartPreset;
	/**
	 * The chart type the viewer opens in (ADR-0056 §6): the Stocks page's
	 * Chart tab asks for candlestick, a widget's dialog opens in line like
	 * the widget. Candlestick is used only while it is offered; default line.
	 */
	readonly initialChartType?: DetailChartType;
}

export interface ChartViewerProps extends ChartViewerContentProps {
	readonly open: boolean;
	readonly onClose: () => void;
	/**
	 * The button that opened the viewer: focus returns here on close. Passed
	 * by the entry points from the click's `currentTarget`, because Safari
	 * and Firefox on macOS never focus a button on a mouse click, so
	 * `document.activeElement` would be `<body>`. If a reload replaced the
	 * button meanwhile, focus goes to the widget's new opener with the same
	 * `data-chart-opener` key, else to the widget's body (`focusReturnTarget`).
	 */
	readonly opener?: HTMLElement | null;
	/**
	 * Focus return captured once at the press (by `LazyChartViewer`): used
	 * as given instead of capturing `opener` again when the viewer mounts,
	 * because the chunk may arrive after a reload replaced that button, and
	 * a detached button no longer knows its widget.
	 */
	readonly focusReturn?: FocusReturn;
}

/**
 * The modal viewer (ADR-0025): the content in a large `sl-dialog`, with
 * its focus trap, Escape and the Close button returning focus to the
 * opener. The content's state lives as long as this component (it is
 * created at mount, outside the open/closed switch), as it always has.
 */
export function ChartViewer(props: ChartViewerProps): JSX.Element {
	const common = useMessages(commonMessages);
	const content = createViewerContent(props, { dataTable: true });

	// The opener is captured on each closed→open transition, not at mount:
	// the component may mount closed long before the user opens it. A focus
	// return captured at the press wins; else the entry point's button; the
	// focused element is only a fallback.
	let focusReturn: FocusReturn = captureFocusReturn(null);
	let wasOpen = false;
	createEffect(() => {
		const open = props.open;
		if (open && !wasOpen) {
			const passed = props.opener ?? null;
			focusReturn =
				props.focusReturn ??
				captureFocusReturn(
					passed ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
				);
		}
		wasOpen = open;
	});
	const handleClose = (): void => {
		const saved = focusReturn;
		props.onClose();
		focusReturnTarget(saved)?.focus();
	};

	return (
		<Show when={props.open}>
			<sl-dialog
				class="chart-viewer"
				label={props.title}
				open
				on:sl-request-close={() => handleClose()}
			>
				<div class="chart-viewer-scroll space-y-3">
					{content()}
					<div>
						<button
							type="button"
							class={`${BUTTON} pointer-coarse:min-h-11`}
							onClick={() => handleClose()}
						>
							{common().close}
						</button>
					</div>
				</div>
			</sl-dialog>
		</Show>
	);
}

export type InlineChartViewerProps = ChartViewerContentProps;

/**
 * The viewer inline in a page region (ADR-0049 §4, the Stocks page's Chart
 * tab): the same content with no dialog — no focus trap, no Escape-to-close
 * (Escape does nothing here) and no Close button. It shows no heading of
 * its own: the page above it already names the stock, so the title only
 * names the region for assistive technology. It has no data-table twin
 * either (removed at the owner's request, 2026-11-01): the statistics give
 * the visible window's numbers. Nothing it does is saved; its state lives
 * as long as it is mounted.
 */
export function InlineChartViewer(props: InlineChartViewerProps): JSX.Element {
	const content = createViewerContent(props, { dataTable: false });
	return (
		<section aria-label={props.title} class="chart-viewer-inline space-y-3">
			{content()}
		</section>
	);
}

/** What differs between the dialog's content and the inline viewer's. */
interface ViewerContentOptions {
	/** Whether the data-table twin (and the provenance under it) is shown. */
	readonly dataTable: boolean;
}

/**
 * The viewer's state and derivations, and a render function for its
 * content (series line, time range, display controls, chart, navigator,
 * statistics and, when asked for, the data-table twin) — shared by the
 * dialog and the inline viewer. Called once in a component body; the
 * render function may run again (the dialog renders it on each open) over
 * the same state.
 */
function createViewerContent(
	props: ChartViewerContentProps,
	options: ViewerContentOptions,
): () => JSX.Element {
	const m = useMessages(chartViewerMessages);
	const readoutText = useMessages(chartReadoutMessages);
	const homeText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
	const fromId = createUniqueId();
	const toId = createUniqueId();

	const extent = createMemo(() => extentOf(props.series()));
	const openingWindow = createMemo(() => {
		const full = extent();
		if (full === null) return null;
		const window = presetWindow(props.initialPreset, full.from, full.to);
		// The extent holds validated finite days, so this is always ok; a
		// rejection would mean corrupt input, and there is no window to show.
		return window.ok ? window.value : null;
	});
	// A gesture or custom range replaces the window; null means "as opened".
	const [window, setWindow] = createSignal<DayWindow | null>(null);
	const activeWindow = createMemo(() => window() ?? openingWindow());
	const [pressedPreset, setPressedPreset] = createSignal<ChartPreset | null>(props.initialPreset);
	const [intervalChoice, setIntervalChoice] = createSignal<IntervalChoice>("auto");
	const [scale, setScale] = createSignal<DetailScale>("linear");
	const [mode, setMode] = createSignal<DetailValueMode>("value");
	const [maPeriods, setMaPeriods] = createSignal<readonly number[]>([]);
	// The user's chart type pick; null means "as opened" (`initialChartType`).
	const [chartTypeChoice, setChartTypeChoice] = createSignal<DetailChartType | null>(null);
	// The crosshair is kept as a day, not a bar index: a zoom or pan rebuilds
	// the model, and the same day maps to its new index (ADR-0025: +/- zoom
	// around the crosshair on every step, with the readout kept).
	const [crosshairDay, setCrosshairDay] = createSignal<number | null>(null);
	const [twinOpen, setTwinOpen] = createSignal(false);
	const [rangeError, setRangeError] = createSignal<string | null>(null);
	const [plotSize, setPlotSize] = createSignal({ width: 640, height: 320 });
	// True after an automatic Log→Linear fallback, until the next manual
	// scale pick: the status line below explains the switch.
	const [logAutoNote, setLogAutoNote] = createSignal(false);

	const spanDays = createMemo(() => {
		const active = activeWindow();
		if (active === null) return 0;
		return Math.max(0, Math.trunc(active.to) - Math.trunc(active.from));
	});

	// Intervals finer than the coarsest native frequency are disabled, with
	// the reason in the option text ("Daily — source is monthly").
	const coarsest = createMemo(() => {
		let rank = 0;
		let word: MarketFrequency = "daily";
		for (const entry of props.series()) {
			const entryRank = nativeRank(entry.frequency);
			if (entryRank > rank) {
				rank = entryRank;
				word = entry.frequency;
			}
		}
		return { rank, word };
	});

	// Auto budgets bars against the drawable plot width (container minus the
	// axis gutters), the same bounds the render model draws into — not the
	// wider SVG element.
	const plotBudget = createMemo(() =>
		Math.max(1, Math.floor(plotWidthForSize(plotSize().width) / 3)),
	);

	const resolvedInterval = createMemo<ChartInterval>(() => {
		const choice = intervalChoice();
		if (choice !== "auto") return choice;
		return autoInterval(spanDays(), toNativeFrequency(coarsest().word), plotBudget());
	});
	// Resampled bars and their union days, cached per interval for the
	// current series (ADR-0025 performance): resampling and the union merge
	// run once per (series, interval), and a window change only binary-searches.
	const intervalCache = createMemo(() => {
		const series = props.series();
		const cache = new Map<ChartInterval, IntervalData>();
		return (interval: ChartInterval): IntervalData => {
			const hit = cache.get(interval);
			if (hit !== undefined) return hit;
			const entries = series.map((entry) => ({
				entry,
				bars: resampleSeries(toChartPoints(entry.observations), interval),
			}));
			const barLists = entries.map(({ bars }) => bars);
			const data = { entries, union: unionBarDays(barLists), minGap: smallestBarGap(barLists) };
			cache.set(interval, data);
			return data;
		};
	});
	const intervalData = createMemo(() => intervalCache()(resolvedInterval()));
	const resampled = createMemo(() => intervalData().entries);

	const singleSeries = createMemo(() => props.series().length === 1);

	// Candlestick is offered for exactly one series holding at least one
	// provider bar (ADR-0056 §6), whatever the interval; otherwise its option
	// says why. Scans the observations once per series change.
	const barsHeld = createMemo(() => {
		const series = props.series();
		const only = series.length === 1 ? series[0] : undefined;
		return only?.observations.some((observation) => observation[2] !== undefined) === true;
	});
	const candlestickBlocked = createMemo((): "one-series" | "no-bars" | null => {
		if (!singleSeries()) return "one-series";
		return barsHeld() ? null : "no-bars";
	});
	// While Candlestick is not offered (the series changed, e.g. the Stocks
	// page moved to a stock without bars) the chart shows Line; the pick is
	// kept, so it returns when Candlestick is offered again.
	const chartType = createMemo((): DetailChartType => {
		const wanted = chartTypeChoice() ?? props.initialChartType ?? "line";
		return wanted === "candlestick" && candlestickBlocked() === null ? "candlestick" : "line";
	});

	// Moving averages cached per (series, interval, period) outside the
	// window-dependent model (ADR-0025 performance): a pan or zoom re-slices by
	// binary search and never recomputes these. Only the single-series case
	// carries overlays; the model ignores them otherwise.
	const maOverlays = createMemo((): readonly DetailMaOverlayInput[] => {
		if (!singleSeries() || maPeriods().length === 0) return [];
		const sampled = resampled();
		const first = sampled[0];
		if (first === undefined) return [];
		const closes = first.bars.map((bar) => bar.close);
		const days = first.bars.map((bar) => bar.day);
		const overlays: DetailMaOverlayInput[] = [];
		for (const period of maPeriods()) {
			const averaged = movingAverage(closes, period);
			if (!averaged.ok) continue;
			overlays.push({
				seriesKey: first.entry.seriesId,
				color: seriesColor(0),
				period,
				label: m().movingAverageShort(period),
				days,
				values: averaged.value,
			});
		}
		return overlays;
	});

	// The window never narrows below two bars of the current interval.
	const minSpanDays = createMemo(() => intervalData().minGap);

	// Every window transition lands here: clamped into the held data (at
	// least two bars of the interval the new window resolves to — not the
	// shown one, or 1D pressed while weekly bars show would keep a week), then
	// widened against real bar positions until it holds at least two bars of
	// the interval it will render at (a day-count minimum admits bar-less
	// weekends, and presets and interval switches bypass clamping).
	// A zoom passes the crosshair day as `anchorDay`: the window then also
	// widens to that day's bar at the interval it resolves to, repeated while
	// the widening moves Auto to a coarser interval (at most once per step).
	const commitWindow = (next: DayWindow, anchorDay: number | null = null): void => {
		const full = extent();
		if (full === null) return;
		let interval = resolveIntervalFor(next);
		const clamped = clampWindow(next, full, intervalCache()(interval).minGap);
		if (!clamped.ok) return;
		let candidate = clamped.value;
		if (anchorDay !== null) {
			for (let pass = 0; pass < INTERVALS.length; pass += 1) {
				const widened = includeAnchorBar(
					candidate,
					intervalCache()(interval).union,
					anchorDay,
					full,
				);
				if (widened === candidate) break;
				candidate = widened;
				interval = resolveIntervalFor(candidate);
			}
		}
		setWindow(ensureTwoBarWindow(candidate, intervalCache()(interval).union, full));
	};

	/** The interval a candidate window resolves at (explicit choice, or Auto for its span). */
	const resolveIntervalFor = (candidate: DayWindow): ChartInterval => {
		const choice = intervalChoice();
		if (choice !== "auto") return choice;
		const span = Math.max(
			0,
			Math.max(Math.trunc(candidate.from), Math.trunc(candidate.to)) -
				Math.min(Math.trunc(candidate.from), Math.trunc(candidate.to)),
		);
		return autoInterval(span, toNativeFrequency(coarsest().word), plotBudget());
	};

	// Interval switches and new data revalidate the stored window: a one-week
	// view moved from Daily to Yearly must grow to two yearly bars. Guarded by
	// equality, so the write converges instead of looping.
	createEffect(() => {
		const active = activeWindow();
		const full = extent();
		if (active === null || full === null) return;
		const fixed = ensureTwoBarWindow(active, intervalData().union, full);
		if (fixed.from !== active.from || fixed.to !== active.to) setWindow(fixed);
	});

	// An explicitly selected interval is revalidated against the current
	// native frequency: replacing daily data with monthly data drops a stale
	// Daily pick back to Auto.
	createEffect(() => {
		const choice = intervalChoice();
		if (choice !== "auto" && INTERVAL_RANK[choice] < coarsest().rank) {
			setIntervalChoice("auto");
		}
	});

	const model = createMemo(() => {
		const active = activeWindow();
		const sampled = resampled();
		if (active === null || sampled.length === 0) return null;
		return buildDetailChartModel({
			series: sampled.map(({ entry, bars }, slot) => ({
				key: entry.seriesId,
				label: entry.title,
				color: seriesColor(slot),
				bars,
			})),
			window: active,
			plotWidth: plotSize().width,
			plotHeight: plotSize().height,
			scale: scale(),
			mode: mode(),
			maPeriods: [],
			maOverlays: maOverlays(),
			chartType: chartType(),
			// The trading-day axis (ADR-0057): the union memoized per interval,
			// so a pan or zoom never re-merges the held bars.
			axisDays: intervalData().union,
		});
	});

	const view = createMemo(() => {
		const current = model();
		const active = activeWindow();
		if (current === null || active === null) return null;
		return { model: current, window: active };
	});

	const units = createMemo(() => props.series().map((entry) => entry.unit));
	const unitCaption = createMemo(() => {
		const seen = new Set(units());
		return seen.size <= 1 ? (units()[0] ?? "") : m().mixedUnits;
	});

	// The crosshair's bar index in the current model: the bar whose bucket
	// holds its day, or none once the day leaves the window (a pan moved past it).
	const crosshair = createMemo(() => {
		const day = crosshairDay();
		const ready = view();
		if (day === null || ready === null) return null;
		return barIndexForDay(ready.model.dayAt, day, ready.window);
	});
	const setCrosshair = (index: number | null): void => {
		const current = model();
		const day = index === null || current === null ? null : (current.dayAt[index] ?? null);
		setCrosshairDay(day);
	};

	const readout = createMemo((): ReadoutParts | null => {
		const ready = view();
		const index = crosshair();
		if (ready === null || index === null) return null;
		return buildReadoutParts(ready.model, index, units(), readoutText(), barsHeld());
	});

	const stats = createMemo<readonly SeriesStats[]>(() =>
		resampled().map(({ entry, bars }) => {
			const active = activeWindow();
			if (active === null) return { entry, computed: null, first: undefined, last: undefined };
			const slice = visibleSlice(bars, active);
			const visible = bars.slice(slice.start, slice.end);
			const computed = windowStats(visible);
			return {
				entry,
				computed: computed.ok ? computed.value : null,
				first: visible[0],
				last: visible[visible.length - 1],
			};
		}),
	);

	// Log is disabled (with the reason) when the effective display values —
	// after the window and the value mode, so percent mode's zero baseline
	// counts — include a value ≤ 0.
	const logBlocked = createMemo(() => {
		const active = activeWindow();
		if (active === null) return false;
		return logScaleBlocked({
			series: resampled().map(({ entry, bars }, slot) => ({
				key: entry.seriesId,
				label: entry.title,
				color: seriesColor(slot),
				bars,
			})),
			window: active,
			mode: mode(),
		});
	});

	// An already selected Log cannot survive a window or mode change that
	// hides non-positive values: fall back to Linear and say why in the
	// status line, instead of silently omitting observations.
	createEffect(() => {
		if (scale() === "log" && logBlocked()) {
			setScale("linear");
			setLogAutoNote(true);
		}
	});

	// The overview covers the complete held-data extent (every series' dates),
	// not just the longest resampled series, so older windows position
	// correctly against the navigator scale.
	const overview = createMemo(() => unionOverview(resampled().map(({ bars }) => bars)));

	// The navigator reads the overview (stable per interval), the window and
	// the extent as separate props, so a window change never hands it a new
	// overview and the overview line is not rebuilt (ADR-0025 performance).
	const navigatorReady = createMemo(
		() => extent() !== null && activeWindow() !== null && overview().days.length > 0,
	);

	const fromIso = createMemo(() => {
		const active = activeWindow();
		if (active === null) return "";
		return isoOf(Math.min(Math.trunc(active.from), Math.trunc(active.to)));
	});
	const toIso = createMemo(() => {
		const active = activeWindow();
		if (active === null) return "";
		return isoOf(Math.max(Math.trunc(active.from), Math.trunc(active.to)));
	});
	const extentIso = createMemo(() => {
		const full = extent();
		if (full === null) return { min: "", max: "" };
		return { min: isoOf(full.from), max: isoOf(full.to) };
	});

	const shows800Note = createMemo(() =>
		props
			.series()
			.some((entry) => entry.observations.length === MARKET_LIMITS.maxObservationsPerResponse),
	);

	const applyPreset = (preset: ChartPreset): void => {
		const full = extent();
		if (full === null) return;
		const window = presetWindow(preset, full.from, full.to);
		if (!window.ok) return;
		commitWindow(window.value);
		setPressedPreset(preset);
		setRangeError(null);
		setCrosshair(null);
	};

	const applyCustomRange = (fromText: string, toText: string): boolean => {
		const from = isoToDayNumber(fromText);
		const to = isoToDayNumber(toText);
		if (!from.ok || !to.ok) {
			setRangeError(m().bothDatesNeeded);
			return false;
		}
		if (from.value > to.value) {
			setRangeError(m().fromAfterTo);
			return false;
		}
		const full = extent();
		if (full === null) return false;
		commitWindow({ from: from.value, to: to.value });
		setPressedPreset(null);
		setRangeError(null);
		setCrosshair(null);
		return true;
	};

	// Reset returns to the opening preset; gestures return to the pressed one.
	const resetToOpening = (): void => applyPreset(props.initialPreset);
	const resetToPressed = (): void => applyPreset(pressedPreset() ?? props.initialPreset);

	// A gesture clears the pressed preset but keeps the crosshair day, so a
	// keyboard zoom keeps anchoring on it and the readout stays.
	const clearPresetGesture = (): void => {
		setPressedPreset(null);
	};

	const onZoom = (anchorDay: number, factor: number): void => {
		if (!Number.isFinite(anchorDay) || !Number.isFinite(factor)) return;
		const active = activeWindow();
		const full = extent();
		if (active === null || full === null) return;
		const zoomed = zoomWindow(active, anchorDay, factor, full, minSpanDays());
		if (!zoomed.ok) return;
		commitWindow(zoomed.value, crosshairDay());
		clearPresetGesture();
	};

	const onPan = (deltaDays: number): void => {
		if (!Number.isFinite(deltaDays) || deltaDays === 0) return;
		const active = activeWindow();
		const full = extent();
		if (active === null || full === null) return;
		const panned = panWindow(active, deltaDays, full);
		if (!panned.ok) return;
		commitWindow(panned.value);
		clearPresetGesture();
	};

	const onWindow = (next: DayWindow): void => {
		commitWindow(next);
		clearPresetGesture();
	};

	const onIntervalChange = (event: Event & { readonly currentTarget: SlSelectElement }): void => {
		const raw = event.currentTarget.value;
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (
			value === "auto" ||
			value === "daily" ||
			value === "weekly" ||
			value === "monthly" ||
			value === "quarterly" ||
			value === "yearly"
		) {
			setIntervalChoice(value);
			setCrosshair(null);
		}
	};

	const onChartTypeChange = (event: Event & { readonly currentTarget: SlSelectElement }): void => {
		const raw = event.currentTarget.value;
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (value === "line" || value === "candlestick") setChartTypeChoice(value);
	};

	const onScaleChange = (event: Event & { readonly currentTarget: SlSelectElement }): void => {
		const raw = event.currentTarget.value;
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (value === "linear" || value === "log") {
			setScale(value);
			setLogAutoNote(false);
		}
	};

	const onModeChange = (event: Event & { readonly currentTarget: SlSelectElement }): void => {
		const raw = event.currentTarget.value;
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (value === "value" || value === "percent") {
			setMode(value);
			setCrosshair(null);
		}
	};

	const toggleMa = (period: number): void => {
		setMaPeriods((current) =>
			current.includes(period) ? current.filter((entry) => entry !== period) : [...current, period],
		);
	};

	// Rows of the data-table twin, built only while its <details> is open:
	// a closed twin costs nothing per pan or zoom frame, and an open one is
	// rendered through <Index>, which updates rows in place instead of
	// rebuilding every row element per frame (ADR-0025 performance).
	const twinRows = createMemo(() => {
		const ready = view();
		if (ready === null || !twinOpen()) return [];
		const rawByKey = new Map(ready.model.rawValues.map((entry) => [entry.key, entry.values]));
		const bars = barsHeld() ? ready.model.barValues : null;
		return ready.model.dayAt.map((day, index) => ({
			day,
			iso: ready.model.isoAt[index] ?? String(day),
			cells: ready.model.seriesValues.map((entry, slot) => ({
				raw: rawByKey.get(entry.key)?.[index] ?? null,
				display: entry.values[index] ?? null,
				unit: units()[slot] ?? "",
			})),
			bar:
				bars === null
					? null
					: {
							open: bars.open[index] ?? null,
							high: bars.high[index] ?? null,
							low: bars.low[index] ?? null,
							volume: bars.volume[index] ?? null,
						},
		}));
	});

	// Data-table cells always show the raw value with its unit; in percent
	// mode the rebased percent rides along with percentage units, never the
	// original unit on a rebased number.
	const twinCell = (cell: {
		readonly raw: number | null;
		readonly display: number | null;
		readonly unit: string;
	}): string => {
		if (cell.raw === null || !Number.isFinite(cell.raw)) return common().unavailable(m().noBar);
		const suffix = cell.unit === "" ? "" : ` ${cell.unit}`;
		if (mode() !== "percent") return `${formatValue(cell.raw)}${suffix}`;
		if (cell.display === null || !Number.isFinite(cell.display)) {
			return m().withRebasedUnavailable(`${formatValue(cell.raw)}${suffix}`);
		}
		return `${formatValue(cell.raw)}${suffix} (${formatSignedDelta(cell.display, cell.display)}%)`;
	};

	/** An open/high/low cell of the data table: the raw price, or why there is none. */
	const priceCell = (value: number | null): string =>
		value === null || !Number.isFinite(value)
			? common().unavailable(m().noBar)
			: formatValue(value);
	const volumeCell = (value: number | null): string =>
		value === null ? common().unavailable(readoutText().volumeNotReported) : m().volumeFull(value);

	/** The percent cell's text, and whether it is a value (coloured) or a reason (neutral). */
	const percentCell = (
		percentChange: number | null,
		unit: string,
		open: number,
	): { readonly text: string; readonly isValue: boolean } => {
		const text = formatPctValue(percentChange, unit);
		if (text !== null) return { text, isValue: true };
		if (percentChange === null && open === 0) {
			return { text: common().unavailable(m().zeroBase), isValue: false };
		}
		return { text: common().unavailable(m().percentOfPercent), isValue: false };
	};

	const modelFallback = (): string => {
		if (extent() === null) return common().unavailable(m().noHeldObservations);
		if (scale() === "log" && logBlocked()) return m().logNeedsPositive;
		return common().unavailable(m().noBarsInWindow);
	};

	return () => (
		<>
			<section aria-label={m().seriesRegion}>
				<div class="space-y-1 text-sm">
					<For each={stats()}>
						{(row) => {
							const latest = latestPoint(row.entry);
							return (
								<p>
									<span class="font-semibold">{row.entry.title}</span>:{" "}
									{latest === null ? (
										<span>{common().unavailable(m().noObservations)}</span>
									) : (
										<>
											<span class="tabular-nums">
												{formatValue(latest.value)} {row.entry.unit}
											</span>{" "}
											<span class="text-xs text-slate-600">
												{m().asOf(<time dateTime={latest.observedOn}>{latest.observedOn}</time>)}
											</span>
										</>
									)}{" "}
									<span
										class={
											row.computed === null
												? "tabular-nums"
												: `tabular-nums ${CHANGE_TONES[changeDirection(row.computed.change)]}`
										}
									>
										{describeChange(
											row.computed,
											row.entry.unit,
											row.first,
											row.last,
											homeText(),
											common().unavailable(m().noVisibleBars),
										)}
									</span>
								</p>
							);
						}}
					</For>
				</div>
			</section>
			<section aria-label={m().timeRange}>
				<fieldset class="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
					<legend class="sr-only">{m().presets}</legend>
					<For each={PRESETS}>
						{(preset) => (
							<button
								type="button"
								class={`${pressedPreset() === preset ? BUTTON_PRIMARY : BUTTON} pointer-coarse:min-h-11`}
								aria-pressed={pressedPreset() === preset}
								onClick={() => applyPreset(preset)}
							>
								{m().preset(preset)}
							</button>
						)}
					</For>
				</fieldset>
				<div class="mt-2 flex flex-wrap items-end gap-2">
					<div class="w-40">
						<label class={LABEL} for={fromId}>
							{m().from}
						</label>
						<input
							id={fromId}
							type="date"
							class={`${INPUT} pointer-coarse:min-h-11`}
							value={fromIso()}
							min={extentIso().min}
							max={extentIso().max}
							onChange={(event) => {
								if (!applyCustomRange(event.currentTarget.value, toIso())) {
									event.currentTarget.value = fromIso();
								}
							}}
						/>
					</div>
					<div class="w-40">
						<label class={LABEL} for={toId}>
							{m().to}
						</label>
						<input
							id={toId}
							type="date"
							class={`${INPUT} pointer-coarse:min-h-11`}
							value={toIso()}
							min={extentIso().min}
							max={extentIso().max}
							onChange={(event) => {
								if (!applyCustomRange(fromIso(), event.currentTarget.value)) {
									event.currentTarget.value = toIso();
								}
							}}
						/>
					</div>
					<button
						type="button"
						class={`${BUTTON} pointer-coarse:min-h-11`}
						onClick={() => resetToOpening()}
					>
						{m().reset}
					</button>
				</div>
				<Show when={rangeError()}>
					{(message) => (
						<p role="alert" class="mt-1 text-sm text-red-900">
							{message()}
						</p>
					)}
				</Show>
			</section>
			<section aria-label={m().displayControls}>
				<div class="flex flex-wrap items-end gap-2">
					<sl-select
						attr:label={m().chartTypeLabel}
						data-field="chart-type"
						value={chartType()}
						size="small"
						hoist
						on:sl-change={onChartTypeChange}
					>
						<sl-option value="line">{m().line}</sl-option>
						{/* Fixed option text, chosen when rendered (Shoelace 2.20
						    reads an option's label on a slotchange, not on a text
						    edit): an offered and a blocked Candlestick are two
						    different elements, so `disabled` never flips on one. */}
						<Show
							when={candlestickBlocked()}
							fallback={<sl-option value="candlestick">{m().candlestick}</sl-option>}
						>
							{(reason) => (
								<sl-option value="candlestick" disabled>
									{reason() === "one-series" ? m().candlestickOneSeries : m().candlestickNoBars}
								</sl-option>
							)}
						</Show>
					</sl-select>
					<sl-select
						attr:label={m().intervalLabel}
						value={intervalChoice()}
						size="small"
						hoist
						on:sl-change={onIntervalChange}
					>
						{/* Fixed text: Shoelace 2.20's sl-select recomputes its
						    displayed label only on a selection change or a
						    slotchange, never when an option's text node is edited
						    in place — so the resolved interval is shown beside. */}
						<sl-option value="auto">{m().auto}</sl-option>
						<For each={INTERVALS}>
							{(value) => (
								<IntervalOption value={value} rank={INTERVAL_RANK[value]} coarsest={coarsest} />
							)}
						</For>
					</sl-select>
					<Show when={intervalChoice() === "auto"}>
						<span data-field="auto-interval" class="pb-1.5 text-xs text-slate-600">
							{m().autoResolved(m().interval(resolvedInterval()))}
						</span>
					</Show>
					<sl-select
						attr:label={m().scaleLabel}
						value={scale()}
						size="small"
						hoist
						on:sl-change={onScaleChange}
					>
						<sl-option value="linear">{m().linear}</sl-option>
						<sl-option value="log" disabled={logBlocked() ? true : undefined}>
							{logBlocked() ? m().logBlocked : m().log}
						</sl-option>
					</sl-select>
					<Show when={logAutoNote() && logBlocked() && scale() === "linear"}>
						<output class="w-full text-xs text-slate-600">{m().logSwitchedBack}</output>
					</Show>
					<sl-select
						attr:label={m().valuesLabel}
						value={mode()}
						size="small"
						hoist
						on:sl-change={onModeChange}
					>
						<sl-option value="value">{m().value}</sl-option>
						<sl-option value="percent">{m().percentChange}</sl-option>
					</sl-select>
					<fieldset class="m-0 border-0 p-0">
						<legend class="block text-xs font-medium text-slate-700">{m().movingAverage}</legend>
						<div class="flex gap-1">
							<For each={MA_PERIODS}>
								{(period) => (
									<button
										type="button"
										class={`${maPeriods().includes(period) ? BUTTON_PRIMARY : BUTTON} pointer-coarse:min-h-11`}
										aria-pressed={maPeriods().includes(period)}
										disabled={singleSeries() ? undefined : true}
										onClick={() => toggleMa(period)}
									>
										{m().movingAverageShort(period)}
									</button>
								)}
							</For>
						</div>
					</fieldset>
				</div>
				<Show when={!singleSeries()}>
					<p class="mt-1 text-xs text-slate-600">{m().movingAverageNeedsOne}</p>
				</Show>
			</section>
			<Show when={view()} fallback={<p class="text-sm text-amber-900">{modelFallback()}</p>}>
				{(ready) => (
					<>
						<section aria-label={m().chartRegion} class="chart-viewer-chart">
							<p class="mb-1 text-xs text-slate-600">
								{unitCaption()} · {m().intervalBars(resolvedInterval())}
							</p>
							<DetailChart
								model={ready().model}
								window={ready().window}
								crosshair={crosshair()}
								onCrosshair={setCrosshair}
								onZoom={onZoom}
								onPan={onPan}
								onReset={resetToPressed}
								onSize={(width, height) =>
									setPlotSize((previous) =>
										previous.width === width && previous.height === height
											? previous
											: { width, height },
									)
								}
								size={plotSize()}
								readout={readout()}
								units={units()}
								label={m().chartLabel(props.title, ready().model.chartType)}
								mode={mode()}
								withBars={barsHeld()}
								hasDataTable={options.dataTable}
							/>
							<Show
								when={ready().model.chartType === "candlestick"}
								fallback={
									<ChartLegend
										mark="line"
										items={[
											...ready().model.seriesPaths.map((entry) => ({
												label: entry.label,
												color: entry.color,
											})),
											...ready().model.maPaths.map((entry) => ({
												label: entry.label,
												color: entry.color,
											})),
										]}
									/>
								}
							>
								<CandleLegend
									averages={ready().model.maPaths.map((entry) => ({
										label: entry.label,
										color: entry.color,
									}))}
								/>
							</Show>
							<Show when={barsHeld() && ready().model.notFromBarsCount > 0}>
								<p data-field="close-only-bars" class="mt-1 text-xs text-slate-600">
									{m().notFromBarsNote}
								</p>
							</Show>
							<Show when={ready().model.zeroBaseKeys.length > 0}>
								<p class="mt-1 text-xs text-amber-900">{m().zeroBaseNote}</p>
							</Show>
						</section>
						<Show when={navigatorReady()}>
							<section aria-label={m().overviewRegion}>
								<Navigator
									days={overview().days}
									values={overview().values}
									window={ready().window}
									extent={extent() ?? ready().window}
									minSpanDays={minSpanDays()}
									onWindow={onWindow}
									windowLabel={m().overviewWindow(fromIso(), toIso())}
								/>
							</section>
						</Show>
						<section aria-label={m().statsRegion}>
							<div class="overflow-x-auto">
								<table class="w-full border-collapse text-left text-sm">
									<caption class="caption-top pb-1 text-left text-xs text-slate-600">
										{m().statsCaption(m().intervalBars(resolvedInterval()))}
									</caption>
									<thead>
										<tr class="border-b border-slate-200">
											<th scope="col" class="py-1 pr-3 font-semibold">
												{m().seriesColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().openColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().closeColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().changeColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().percentChangeColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().highColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().lowColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().averageColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().maxDrawdownColumn}
											</th>
											<th scope="col" class="py-1 pr-3 text-right font-semibold">
												{m().barsColumn}
											</th>
										</tr>
									</thead>
									<tbody>
										<For each={stats()}>
											{(row) => (
												<tr class="border-b border-slate-200">
													<th scope="row" class="py-1 pr-3 font-medium">
														{row.entry.title}
													</th>
													{row.computed === null ? (
														<td colspan={9} class="py-1 pr-3 text-right tabular-nums">
															{common().unavailable(m().noVisibleBars)}
														</td>
													) : (
														<>
															<td class="py-1 pr-3 text-right tabular-nums">
																{formatValue(row.computed.open)}
															</td>
															<td class="py-1 pr-3 text-right tabular-nums">
																{formatValue(row.computed.close)}
															</td>
															<td
																class={`py-1 pr-3 text-right tabular-nums ${CHANGE_TONES[changeDirection(row.computed.change)]}`}
															>
																{formatSignedDelta(row.computed.change, row.computed.close)}
															</td>
															<PercentCell
																cell={percentCell(
																	row.computed.percentChange,
																	row.entry.unit,
																	row.computed.open,
																)}
																change={row.computed.change}
															/>
															<td class="py-1 pr-3 text-right tabular-nums">
																{formatValue(row.computed.high.value)}{" "}
																<time dateTime={row.computed.high.observedOn}>
																	{row.computed.high.observedOn}
																</time>
															</td>
															<td class="py-1 pr-3 text-right tabular-nums">
																{formatValue(row.computed.low.value)}{" "}
																<time dateTime={row.computed.low.observedOn}>
																	{row.computed.low.observedOn}
																</time>
															</td>
															<td class="py-1 pr-3 text-right tabular-nums">
																{formatValue(row.computed.average)}
															</td>
															<td class="py-1 pr-3 text-right tabular-nums">
																{row.computed.maxDrawdown === null
																	? common().unavailable(m().nonPositivePeak)
																	: `${formatValue(row.computed.maxDrawdown)}%`}
															</td>
															<td class="py-1 pr-3 text-right tabular-nums">{row.computed.bars}</td>
														</>
													)}
												</tr>
											)}
										</For>
									</tbody>
								</table>
							</div>
						</section>
						<Show when={options.dataTable}>
							<details
								class="group mt-1 text-xs"
								onToggle={(event) => setTwinOpen(event.currentTarget.open)}
							>
								<DisclosureSummary>{m().dataTable(props.title)}</DisclosureSummary>
								<div class="overflow-x-auto">
									<table class="w-full border-collapse text-left text-xs">
										<caption class="caption-top pb-1 text-left text-slate-600">
											{m().dataTableCaption(
												props.title,
												unitCaption(),
												m().intervalBars(resolvedInterval()),
												mode() === "percent",
											)}
										</caption>
										<thead>
											<tr class="border-b border-slate-200">
												<th scope="col" class="py-1 pr-3 font-semibold">
													{m().dateColumn}
												</th>
												<Show
													when={barsHeld()}
													fallback={
														<For each={ready().model.seriesPaths}>
															{(entry) => (
																<th scope="col" class="py-1 pr-3 text-right font-semibold">
																	{entry.label}
																</th>
															)}
														</For>
													}
												>
													<For
														each={[
															m().openColumn,
															m().highColumn,
															m().lowColumn,
															m().closeColumn,
															m().volumeColumn,
														]}
													>
														{(name) => (
															<th scope="col" class="py-1 pr-3 text-right font-semibold">
																{name}
															</th>
														)}
													</For>
												</Show>
											</tr>
										</thead>
										<tbody>
											<Index each={twinRows()}>
												{(row) => (
													<tr class="border-b border-slate-200">
														<th scope="row" class="py-1 pr-3 font-medium">
															<time dateTime={row().iso}>{row().iso}</time>
														</th>
														<Show when={row().bar !== null}>
															<td class="py-1 pr-3 text-right tabular-nums">
																{priceCell(row().bar?.open ?? null)}
															</td>
															<td class="py-1 pr-3 text-right tabular-nums">
																{priceCell(row().bar?.high ?? null)}
															</td>
															<td class="py-1 pr-3 text-right tabular-nums">
																{priceCell(row().bar?.low ?? null)}
															</td>
														</Show>
														<Index each={row().cells}>
															{(cell) => (
																<td class="py-1 pr-3 text-right tabular-nums">
																	{twinCell(cell())}
																</td>
															)}
														</Index>
														<Show when={row().bar !== null}>
															<td class="py-1 pr-3 text-right tabular-nums">
																{volumeCell(row().bar?.volume ?? null)}
															</td>
														</Show>
													</tr>
												)}
											</Index>
										</tbody>
									</table>
								</div>
								<div class="mt-2 border-t border-slate-200 pt-1 text-2xs text-slate-600">
									<ul class="space-y-0.5">
										<For each={props.series()}>
											{(entry) => (
												<li>
													{entry.title}:{" "}
													<SingleSeriesFooter
														series={entry}
														asOf={entry.observations.at(-1)?.[0] ?? null}
													/>
												</li>
											)}
										</For>
									</ul>
									<Show when={shows800Note()}>
										<p class="mt-1">{m().newest800}</p>
									</Show>
								</div>
							</details>
						</Show>
					</>
				)}
			</Show>
		</>
	);
}
