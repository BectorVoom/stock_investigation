import type { MarketFrequency, MarketSeries } from "@research/contracts";
import { MARKET_LIMITS } from "@research/contracts";
import {
	autoInterval,
	type ChartBar,
	type ChartInterval,
	type ChartNativeFrequency,
	type ChartPreset,
	type ChartStats,
	clampWindow,
	type DayWindow,
	dayNumberToIso,
	isoToDayNumber,
	type MarketChange,
	panWindow,
	presetWindow,
	resampleSeries,
	visibleSlice,
	windowStats,
	zoomWindow,
} from "@research/domain";
import {
	buildDetailChartModel,
	ChartLegend,
	type DetailScale,
	type DetailValueMode,
	seriesColor,
} from "@research/ui-registry";
import {
	type Accessor,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onMount,
	Show,
} from "solid-js";
import { BUTTON, BUTTON_PRIMARY, DisclosureSummary, INPUT, LABEL } from "../components/ui.tsx";
import { SingleSeriesFooter } from "../home/HomeFrame.tsx";
import {
	formatChange,
	formatPctValue,
	formatSignedDelta,
	formatValue,
	latestPoint,
} from "../home/homeModel.ts";
import "../home/shoelace.ts";
import type { SlSelectElement } from "../home/sl-elements.d.ts";
import { DetailChart } from "./DetailChart.tsx";
import { Navigator } from "./Navigator.tsx";
import { buildReadoutText } from "./readout.ts";

/**
 * The detailed chart viewer (ADR-0025): a large modal sheet over the current
 * page where one widget's series can be analyzed. Range presets plus exact
 * From/To dates, interval/scale/values controls, moving averages for a single
 * series, the main chart with crosshair, an overview navigator, a statistics
 * table and a data-table twin with provenance. Nothing here is saved; every
 * derivation runs through `createMemo` and resampling is memoized per
 * (series, interval). Entry points (phase 3) pass the widget's series in.
 */

const PRESETS: readonly { readonly preset: ChartPreset; readonly label: string }[] = [
	{ preset: "1w", label: "1W" },
	{ preset: "1m", label: "1M" },
	{ preset: "3m", label: "3M" },
	{ preset: "6m", label: "6M" },
	{ preset: "ytd", label: "YTD" },
	{ preset: "1y", label: "1Y" },
	{ preset: "3y", label: "3Y" },
	{ preset: "5y", label: "5Y" },
	{ preset: "max", label: "Max" },
];

const INTERVALS: readonly { readonly value: ChartInterval; readonly label: string }[] = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
	{ value: "quarterly", label: "Quarterly" },
	{ value: "yearly", label: "Yearly" },
];

const INTERVAL_LABELS: { readonly [I in ChartInterval]: string } = {
	daily: "Daily",
	weekly: "Weekly",
	monthly: "Monthly",
	quarterly: "Quarterly",
	yearly: "Yearly",
};

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

function toChartPoints(
	observations: readonly (readonly [string, number])[],
): { readonly observedOn: string; readonly value: number }[] {
	return observations.map(([observedOn, value]) => ({ observedOn, value }));
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

function isoOf(day: number): string {
	const iso = dayNumberToIso(day);
	return iso.ok ? iso.value : "";
}

/** Change over the visible window, never colour alone (mark plus word). */
function describeChange(
	computed: ChartStats | null,
	unit: string,
	first: ChartBar | undefined,
	last: ChartBar | undefined,
): string {
	if (computed === null || first === undefined || last === undefined) {
		return "unavailable (no visible bars)";
	}
	const change: MarketChange = {
		previous: { observedOn: first.observedOn, value: computed.open },
		latest: { observedOn: last.observedOn, value: computed.close },
		absoluteChange: computed.change,
		percentChange: computed.percentChange,
	};
	const formatted = formatChange(change, unit);
	return `${formatted.text} ${formatted.word}`;
}

interface SeriesStats {
	readonly entry: MarketSeries;
	readonly computed: ChartStats | null;
	readonly first: ChartBar | undefined;
	readonly last: ChartBar | undefined;
}

export function ChartViewer(props: {
	readonly open: boolean;
	readonly onClose: () => void;
	readonly title: string;
	readonly series: Accessor<readonly MarketSeries[]>;
	readonly initialPreset: ChartPreset;
}): JSX.Element {
	const fromId = createUniqueId();
	const toId = createUniqueId();

	const extent = createMemo(() => extentOf(props.series()));
	const openingWindow = createMemo(() => {
		const full = extent();
		if (full === null) return null;
		return presetWindow(props.initialPreset, full.from, full.to);
	});
	// A gesture or custom range replaces the window; null means "as opened".
	const [window, setWindow] = createSignal<DayWindow | null>(null);
	const activeWindow = createMemo(() => window() ?? openingWindow());
	const [pressedPreset, setPressedPreset] = createSignal<ChartPreset | null>(props.initialPreset);
	const [intervalChoice, setIntervalChoice] = createSignal<IntervalChoice>("auto");
	const [scale, setScale] = createSignal<DetailScale>("linear");
	const [mode, setMode] = createSignal<DetailValueMode>("value");
	const [maPeriods, setMaPeriods] = createSignal<readonly number[]>([]);
	const [crosshair, setCrosshair] = createSignal<number | null>(null);
	const [rangeError, setRangeError] = createSignal<string | null>(null);
	const [plotSize, setPlotSize] = createSignal({ width: 640, height: 320 });

	let opener: HTMLElement | null = null;
	onMount(() => {
		if (document.activeElement instanceof HTMLElement) opener = document.activeElement;
	});
	const handleClose = (): void => {
		props.onClose();
		if (opener !== null) opener.focus();
	};

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

	const resolvedInterval = createMemo<ChartInterval>(() => {
		const choice = intervalChoice();
		if (choice !== "auto") return choice;
		const maxBars = Math.max(1, Math.floor(plotSize().width / 3));
		return autoInterval(spanDays(), toNativeFrequency(coarsest().word), maxBars);
	});
	const autoLabel = createMemo(() => `Auto (${INTERVAL_LABELS[resolvedInterval()]})`);

	const resampled = createMemo(() =>
		props.series().map((entry) => ({
			entry,
			bars: resampleSeries(toChartPoints(entry.observations), resolvedInterval()),
		})),
	);

	// The window never narrows below two bars of the current interval.
	const minSpanDays = createMemo(() => {
		let gap: number | null = null;
		for (const { bars } of resampled()) {
			for (let index = 1; index < bars.length; index += 1) {
				const previous = bars[index - 1];
				const current = bars[index];
				if (previous === undefined || current === undefined) continue;
				const step = current.day - previous.day;
				if (step > 0) gap = gap === null ? step : Math.min(gap, step);
			}
		}
		return gap ?? 0;
	});

	const setClamped = (next: DayWindow): void => {
		const full = extent();
		if (full === null) return;
		setWindow(clampWindow(next, full, minSpanDays()));
	};

	const singleSeries = createMemo(() => props.series().length === 1);

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
			maPeriods: singleSeries() ? maPeriods() : [],
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
		return seen.size <= 1 ? (units()[0] ?? "") : "Mixed units — values share one axis";
	});

	const readout = createMemo(() => {
		const ready = view();
		const index = crosshair();
		if (ready === null || index === null) return "";
		return buildReadoutText(ready.model, index, units());
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

	// Log is disabled (with the reason) when any visible value is not positive.
	const logBlocked = createMemo(() => {
		const active = activeWindow();
		if (active === null) return false;
		for (const { bars } of resampled()) {
			const slice = visibleSlice(bars, active);
			for (let index = slice.start; index < slice.end; index += 1) {
				const bar = bars[index];
				if (bar !== undefined && !(bar.close > 0)) return true;
			}
		}
		return false;
	});

	const overview = createMemo(() => {
		let longest: readonly ChartBar[] = [];
		for (const { bars } of resampled()) {
			if (bars.length > longest.length) longest = bars;
		}
		return {
			days: longest.map((bar) => bar.day),
			values: longest.map((bar) => bar.close),
		};
	});

	const navigatorInput = createMemo(() => {
		const full = extent();
		const active = activeWindow();
		const data = overview();
		if (full === null || active === null || data.days.length === 0) return null;
		return { extent: full, window: active, days: data.days, values: data.values };
	});

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
		setWindow(presetWindow(preset, full.from, full.to));
		setPressedPreset(preset);
		setRangeError(null);
		setCrosshair(null);
	};

	const applyCustomRange = (fromText: string, toText: string): boolean => {
		const from = isoToDayNumber(fromText);
		const to = isoToDayNumber(toText);
		if (!from.ok || !to.ok) {
			setRangeError("Enter both dates as calendar days.");
			return false;
		}
		if (from.value > to.value) {
			setRangeError("The From date is after the To date; nothing changed.");
			return false;
		}
		const full = extent();
		if (full === null) return false;
		setWindow(clampWindow({ from: from.value, to: to.value }, full, minSpanDays()));
		setPressedPreset(null);
		setRangeError(null);
		setCrosshair(null);
		return true;
	};

	// Reset returns to the opening preset; gestures return to the pressed one.
	const resetToOpening = (): void => applyPreset(props.initialPreset);
	const resetToPressed = (): void => applyPreset(pressedPreset() ?? props.initialPreset);

	const clearPresetGesture = (): void => {
		setPressedPreset(null);
		setCrosshair(null);
	};

	const onZoom = (anchorDay: number, factor: number): void => {
		if (!Number.isFinite(anchorDay) || !Number.isFinite(factor)) return;
		const active = activeWindow();
		const full = extent();
		if (active === null || full === null) return;
		setWindow(zoomWindow(active, anchorDay, factor, full, minSpanDays()));
		clearPresetGesture();
	};

	const onPan = (deltaDays: number): void => {
		if (!Number.isFinite(deltaDays) || deltaDays === 0) return;
		const active = activeWindow();
		const full = extent();
		if (active === null || full === null) return;
		setWindow(panWindow(active, deltaDays, full));
		clearPresetGesture();
	};

	const onWindow = (next: DayWindow): void => {
		setClamped(next);
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

	const onScaleChange = (event: Event & { readonly currentTarget: SlSelectElement }): void => {
		const raw = event.currentTarget.value;
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (value === "linear" || value === "log") setScale(value);
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

	const twinRows = createMemo(() => {
		const ready = view();
		if (ready === null) return [];
		return ready.model.dayAt.map((day, index) => ({
			day,
			iso: ready.model.isoAt[index] ?? String(day),
			cells: ready.model.seriesValues.map((entry) => entry.values[index] ?? null),
		}));
	});

	const twinCell = (value: number | null): string => {
		if (value === null || !Number.isFinite(value)) return "unavailable (no bar)";
		if (mode() === "percent") return `${formatSignedDelta(value, value)}%`;
		return formatValue(value);
	};

	const percentCell = (percentChange: number | null, unit: string, open: number): string => {
		const text = formatPctValue(percentChange, unit);
		if (text !== null) return text;
		if (percentChange === null && open === 0) return "unavailable (zero base)";
		return "unavailable (percent of a percent)";
	};

	const modelFallback = (): string => {
		if (extent() === null) return "unavailable (this widget holds no observations)";
		if (scale() === "log" && logBlocked()) {
			return "Log scale needs values above zero in the visible window. Switch to Linear or zoom to a positive range.";
		}
		return "unavailable (no bars in the visible window)";
	};

	return (
		<Show when={props.open}>
			<sl-dialog
				class="chart-viewer"
				label={props.title}
				open
				on:sl-request-close={() => handleClose()}
			>
				<div class="space-y-3">
					<section aria-label="Series">
						<div class="space-y-1 text-sm">
							<For each={stats()}>
								{(row) => {
									const latest = latestPoint(row.entry);
									return (
										<p>
											<span class="font-semibold">{row.entry.title}</span>:{" "}
											{latest === null ? (
												<span>unavailable (no observations)</span>
											) : (
												<>
													<span class="tabular-nums">
														{formatValue(latest.value)} {row.entry.unit}
													</span>{" "}
													<span class="text-xs text-slate-600">
														as of <time dateTime={latest.observedOn}>{latest.observedOn}</time>
													</span>
												</>
											)}{" "}
											<span class="tabular-nums">
												{describeChange(row.computed, row.entry.unit, row.first, row.last)}
											</span>
										</p>
									);
								}}
							</For>
						</div>
					</section>
					<section aria-label="Time range">
						<fieldset class="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
							<legend class="sr-only">Presets</legend>
							<For each={PRESETS}>
								{({ preset, label }) => (
									<button
										type="button"
										class={`${pressedPreset() === preset ? BUTTON_PRIMARY : BUTTON} pointer-coarse:min-h-11`}
										aria-pressed={pressedPreset() === preset}
										onClick={() => applyPreset(preset)}
									>
										{label}
									</button>
								)}
							</For>
						</fieldset>
						<div class="mt-2 flex flex-wrap items-end gap-2">
							<div class="w-40">
								<label class={LABEL} for={fromId}>
									From
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
									To
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
								Reset
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
					<section aria-label="Display controls">
						<div class="flex flex-wrap items-end gap-2">
							<sl-select
								label="Interval"
								value={intervalChoice()}
								size="small"
								hoist
								on:sl-change={onIntervalChange}
							>
								<sl-option value="auto">{autoLabel()}</sl-option>
								<For each={INTERVALS}>
									{({ value, label }) => {
										const blocked = INTERVAL_RANK[value] < coarsest().rank;
										return (
											<sl-option value={value} disabled={blocked ? true : undefined}>
												{blocked ? `${label} — source is ${coarsest().word}` : label}
											</sl-option>
										);
									}}
								</For>
							</sl-select>
							<sl-select
								label="Scale"
								value={scale()}
								size="small"
								hoist
								on:sl-change={onScaleChange}
							>
								<sl-option value="linear">Linear</sl-option>
								<sl-option value="log" disabled={logBlocked() ? true : undefined}>
									{logBlocked() ? "Log — needs values above zero" : "Log"}
								</sl-option>
							</sl-select>
							<sl-select
								label="Values"
								value={mode()}
								size="small"
								hoist
								on:sl-change={onModeChange}
							>
								<sl-option value="value">Value</sl-option>
								<sl-option value="percent">% change</sl-option>
							</sl-select>
							<fieldset class="m-0 border-0 p-0">
								<legend class="block text-xs font-medium text-slate-700">Moving average</legend>
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
												MA {period}
											</button>
										)}
									</For>
								</div>
							</fieldset>
						</div>
						<Show when={!singleSeries()}>
							<p class="mt-1 text-xs text-slate-600">Moving averages need exactly one series.</p>
						</Show>
					</section>
					<Show when={view()} fallback={<p class="text-sm text-amber-900">{modelFallback()}</p>}>
						{(ready) => (
							<>
								<section aria-label="Chart">
									<p class="mb-1 text-xs text-slate-600">
										{unitCaption()} · {INTERVAL_LABELS[resolvedInterval()]} bars
									</p>
									<DetailChart
										model={ready().model}
										window={ready().window}
										crosshair={crosshair()}
										onCrosshair={setCrosshair}
										onZoom={onZoom}
										onPan={onPan}
										onReset={resetToPressed}
										onSize={(width, height) => setPlotSize({ width, height })}
										readout={readout()}
										units={units()}
										label={props.title}
										mode={mode()}
									/>
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
									<Show when={ready().model.zeroBaseKeys.length > 0}>
										<p class="mt-1 text-xs text-amber-900">
											unavailable (zero base): percent change cannot be computed from a zero value.
										</p>
									</Show>
								</section>
								<Show when={navigatorInput()}>
									{(input) => (
										<section aria-label="Overview">
											<Navigator
												days={input().days}
												values={input().values}
												window={input().window}
												extent={input().extent}
												minSpanDays={minSpanDays()}
												onWindow={onWindow}
												windowLabel={`Overview of all held data; visible window ${fromIso()} to ${toIso()}`}
											/>
										</section>
									)}
								</Show>
								<section aria-label="Statistics for the visible window">
									<div class="overflow-x-auto">
										<table class="w-full border-collapse text-left text-sm">
											<caption class="caption-top pb-1 text-left text-xs text-slate-600">
												Statistics for the visible window ({INTERVAL_LABELS[resolvedInterval()]}{" "}
												bars)
											</caption>
											<thead>
												<tr class="border-b border-slate-200">
													<th scope="col" class="py-1 pr-3 font-semibold">
														Series
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														Open
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														Close
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														Change
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														% change
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														High
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														Low
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														Average
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														Max drawdown
													</th>
													<th scope="col" class="py-1 pr-3 text-right font-semibold">
														Bars
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
																	unavailable (no visible bars)
																</td>
															) : (
																<>
																	<td class="py-1 pr-3 text-right tabular-nums">
																		{formatValue(row.computed.open)}
																	</td>
																	<td class="py-1 pr-3 text-right tabular-nums">
																		{formatValue(row.computed.close)}
																	</td>
																	<td class="py-1 pr-3 text-right tabular-nums">
																		{formatSignedDelta(row.computed.change, row.computed.close)}
																	</td>
																	<td class="py-1 pr-3 text-right tabular-nums">
																		{percentCell(
																			row.computed.percentChange,
																			row.entry.unit,
																			row.computed.open,
																		)}
																	</td>
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
																			? "unavailable (non-positive peak)"
																			: `${formatValue(row.computed.maxDrawdown)}%`}
																	</td>
																	<td class="py-1 pr-3 text-right tabular-nums">
																		{row.computed.bars}
																	</td>
																</>
															)}
														</tr>
													)}
												</For>
											</tbody>
										</table>
									</div>
								</section>
								<details class="group mt-1 text-xs">
									<DisclosureSummary>Data table: {props.title}</DisclosureSummary>
									<div class="overflow-x-auto">
										<table class="w-full border-collapse text-left text-xs">
											<caption class="caption-top pb-1 text-left text-slate-600">
												Values plotted in "{props.title}" ({unitCaption()};{" "}
												{INTERVAL_LABELS[resolvedInterval()]} bars)
											</caption>
											<thead>
												<tr class="border-b border-slate-200">
													<th scope="col" class="py-1 pr-3 font-semibold">
														Date
													</th>
													<For each={ready().model.seriesPaths}>
														{(entry) => (
															<th scope="col" class="py-1 pr-3 text-right font-semibold">
																{entry.label}
															</th>
														)}
													</For>
												</tr>
											</thead>
											<tbody>
												<For each={twinRows()}>
													{(row) => (
														<tr class="border-b border-slate-200">
															<th scope="row" class="py-1 pr-3 font-medium">
																<time dateTime={row.iso}>{row.iso}</time>
															</th>
															<For each={row.cells}>
																{(cell) => (
																	<td class="py-1 pr-3 text-right tabular-nums">
																		{twinCell(cell)}
																	</td>
																)}
															</For>
														</tr>
													)}
												</For>
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
											<p class="mt-1">This viewer shows the newest 800 held observations.</p>
										</Show>
									</div>
								</details>
							</>
						)}
					</Show>
					<div>
						<button
							type="button"
							class={`${BUTTON} pointer-coarse:min-h-11`}
							onClick={() => handleClose()}
						>
							Close
						</button>
					</div>
				</div>
			</sl-dialog>
		</Show>
	);
}
