import type { DayWindow } from "@research/domain";
import {
	CHART_INK,
	type DetailChartModel,
	type DetailValueMode,
	formatAxisTick,
	isValueLabelHidden,
} from "@research/ui-registry";
import { createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { createFrameScheduler } from "./frame.ts";
import { buildReadoutText, READOUT_HINT } from "./readout.ts";

/**
 * The main chart of the viewer (ADR-0025 interaction): a time-proportional
 * SVG whose viewBox equals the container's measured CSS pixel size
 * (ResizeObserver), so text never scales. The box takes its height from flex
 * (minimum 16rem) and the SVG is absolutely positioned to fill it exactly,
 * so measuring the box never resizes it: no resize feedback loop, and the
 * render model (built from the same measured size one level up) always
 * agrees with the viewBox. Value axis on the right; crosshair with date and
 * value labels plus a readout line; wheel zooms around the pointer, drag
 * pans, double-click resets, and the keyboard covers bars, pan, zoom and
 * reset. Pointer and wheel updates are coalesced to one per animation frame.
 * No inline `style` attributes (CSP `style-src 'self'`): colours arrive via
 * `fill`/`stroke` bound to the palette, the halo via `paint-order`.
 */
export function DetailChart(props: {
	readonly model: DetailChartModel;
	readonly window: DayWindow;
	readonly crosshair: number | null;
	readonly onCrosshair: (index: number | null) => void;
	readonly onZoom: (anchorDay: number, factor: number) => void;
	readonly onPan: (deltaDays: number) => void;
	readonly onReset: () => void;
	readonly onSize: (width: number, height: number) => void;
	/** Measured CSS pixel size of the chart box (the single source of truth:
	 * the viewBox and the render model are both built from it). */
	readonly size: { readonly width: number; readonly height: number };
	readonly readout: string;
	readonly units: readonly string[];
	readonly label: string;
	readonly mode: DetailValueMode;
}): JSX.Element {
	const instructionsId = createUniqueId();
	// createUniqueId may emit characters (`:`) that break `url(#id)`
	// references, so the clip id is sanitised to URL-safe characters.
	const clipId = `cv-clip-${createUniqueId().replace(/[^A-Za-z0-9_-]/g, "")}`;
	const frame = createFrameScheduler();
	// A queued frame must never fire after unmount (a range change can retire
	// this chart before its callback runs).
	onCleanup(() => frame.cancel());
	const [announced, setAnnounced] = createSignal("");
	let container: HTMLDivElement | undefined;
	let svg: SVGSVGElement | undefined;

	const spanDays = (): number =>
		Math.max(
			0,
			Math.max(Math.trunc(props.window.from), Math.trunc(props.window.to)) -
				Math.min(Math.trunc(props.window.from), Math.trunc(props.window.to)),
		);

	/** Pointer x (client px) to viewBox x; the zero-rect fallback keeps tests honest. */
	const toViewX = (clientX: number, rectWidth: number): number => {
		const viewWidth = props.size.width;
		if (!(rectWidth > 0)) return clientX;
		return (clientX / rectWidth) * viewWidth;
	};

	/** ViewBox x to integer day number. */
	const dayAtViewX = (viewX: number): number => {
		const plot = props.model.plot;
		const plotWidth = plot.right - plot.left;
		if (!(plotWidth > 0)) return Math.round((props.window.from + props.window.to) / 2);
		const from = Math.min(Math.trunc(props.window.from), Math.trunc(props.window.to));
		const fraction = (viewX - plot.left) / plotWidth;
		return Math.round(from + fraction * spanDays());
	};

	const announce = (index: number): void => {
		setAnnounced(buildReadoutText(props.model, index, props.units));
	};

	const moveCrosshair = (delta: number): void => {
		const count = props.model.dayAt.length;
		if (count === 0) return;
		const current = props.crosshair;
		const next =
			current === null
				? delta > 0
					? 0
					: count - 1
				: Math.min(count - 1, Math.max(0, current + delta));
		props.onCrosshair(next);
		announce(next);
	};

	const onKeyDown = (event: KeyboardEvent & { readonly currentTarget: SVGSVGElement }): void => {
		const count = props.model.dayAt.length;
		const tenth = Math.max(1, Math.round(spanDays() / 10));
		const crossDay = (): number => {
			const current = props.crosshair;
			const day = current === null ? null : (props.model.dayAt[current] ?? null);
			return day ?? Math.round((props.window.from + props.window.to) / 2);
		};
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault();
			const sign = event.key === "ArrowRight" ? 1 : -1;
			if (event.shiftKey) props.onPan(sign * tenth);
			else moveCrosshair(sign);
		} else if (event.key === "+" || event.key === "=") {
			event.preventDefault();
			props.onZoom(crossDay(), 0.8);
		} else if (event.key === "-" || event.key === "_") {
			event.preventDefault();
			props.onZoom(crossDay(), 1.25);
		} else if (event.key === "Home") {
			event.preventDefault();
			if (count > 0) {
				props.onCrosshair(0);
				announce(0);
			}
		} else if (event.key === "End") {
			event.preventDefault();
			if (count > 0) {
				props.onCrosshair(count - 1);
				announce(count - 1);
			}
		} else if (event.key === "0") {
			event.preventDefault();
			props.onReset();
		}
	};

	// A press that moves less than 4 px is a plain click, never a drag.
	let dragStartX: number | null = null;
	let lastPanX = 0;
	// Accumulated pan debt in days: every move adds its exact distance and a
	// single scheduled flush applies the truncated total, so three moves in
	// one frame pan by their sum instead of only the latest delta.
	let panDebt = 0;
	let downX = 0;

	const endDrag = (): void => {
		dragStartX = null;
		// Apply the whole days of any debt a queued flush has not consumed
		// yet (a later flush then finds nothing left); fractions still reset.
		const delta = Math.trunc(panDebt);
		panDebt = 0;
		if (delta !== 0) props.onPan(delta);
	};

	const flushPan = (): void => {
		const delta = Math.trunc(panDebt);
		panDebt -= delta;
		if (delta !== 0) props.onPan(delta);
	};

	const onPointerDown = (event: PointerEvent & { readonly currentTarget: SVGSVGElement }): void => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		if (!Number.isFinite(event.clientX)) return;
		dragStartX = event.clientX;
		lastPanX = event.clientX;
		downX = event.clientX;
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// No pointer capture in some engines; the drag still tracks.
		}
	};

	const onPointerMove = (event: PointerEvent & { readonly currentTarget: SVGSVGElement }): void => {
		if (!Number.isFinite(event.clientX)) return;
		const bounds = event.currentTarget.getBoundingClientRect();
		const viewX = toViewX(event.clientX - bounds.left, bounds.width);
		const start = dragStartX;
		if (start === null || event.buttons === 0) {
			frame.schedule(() => props.onCrosshair(props.model.nearestBar(viewX)));
			return;
		}
		if (Math.abs(event.clientX - downX) < 4 && Math.abs(event.clientX - start) < 4) return;
		const dx = event.clientX - lastPanX;
		lastPanX = event.clientX;
		const dayPerPx = bounds.width > 0 ? spanDays() / bounds.width : 0;
		panDebt += -dx * dayPerPx;
		frame.schedule(flushPan);
	};

	const onPointerUp = (): void => {
		endDrag();
	};

	const onPointerLeave = (
		event: PointerEvent & { readonly currentTarget: SVGSVGElement },
	): void => {
		if (dragStartX !== null) {
			endDrag();
			return;
		}
		if (event.buttons !== 0) return;
		frame.schedule(() => props.onCrosshair(null));
	};

	const onWheelNative = (event: WheelEvent): void => {
		if (event.deltaY === 0) return;
		// The zoom stays inside the chart: the page never scrolls from here.
		event.preventDefault();
		const target = svg;
		const bounds = target?.getBoundingClientRect();
		// Some engines never report pointer coordinates on wheel events; the
		// zoom then goes around the centre instead of refusing to work.
		const hasPointer = Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
		const clientX = hasPointer ? event.clientX - (bounds?.left ?? 0) : Number.NaN;
		frame.schedule(() => {
			const middle = Math.round((props.window.from + props.window.to) / 2);
			const anchor = Number.isFinite(clientX)
				? dayAtViewX(toViewX(clientX, bounds?.width ?? 0))
				: middle;
			props.onZoom(anchor, event.deltaY > 0 ? 1.15 : 1 / 1.15);
		});
	};

	onMount(() => {
		const viewed = svg;
		if (viewed !== undefined) {
			viewed.addEventListener("wheel", onWheelNative, { passive: false });
			onCleanup(() => viewed.removeEventListener("wheel", onWheelNative));
		}
		const box = container;
		if (box === undefined) return;
		// The box gets its height from flex (a definite size), while the SVG
		// fills it (`h-full`), so measuring here never changes the box and
		// there is no resize feedback loop. Reports only on real change, so
		// the parent model and this viewBox stay in lockstep.
		const report = (): void => {
			const rect = box.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				const width = Math.round(rect.width);
				const height = Math.round(rect.height);
				if (width !== props.size.width || height !== props.size.height) {
					props.onSize(width, height);
				}
			}
		};
		report();
		if (typeof ResizeObserver === "function") {
			const observer = new ResizeObserver(report);
			observer.observe(box);
			onCleanup(() => observer.disconnect());
		}
	});

	/**
	 * Value-axis collision rule (ADR-0025 fix round 4): a y tick label hides
	 * behind a last-value tag or the crosshair value label when their
	 * centres are closer than one label height. The grid line stays; only
	 * the text goes, so the axis still bounds the data.
	 */
	const tagYs = (): readonly number[] => props.model.lastValueTags.map((tag) => tag.y);
	const crosshairValueY = (): number | null => {
		if (props.crosshair === null) return null;
		for (const entry of props.model.seriesValues) {
			const value = entry.values[props.crosshair] ?? null;
			if (value !== null && Number.isFinite(value)) return props.model.yFor(value);
		}
		return null;
	};
	const yTickHidden = (tick: number): boolean =>
		isValueLabelHidden(props.model.yFor(tick), tagYs(), crosshairValueY());

	return (
		// Flex column filling the chart section: the readout takes its line
		// and the box below takes the remaining flex height (a definite size
		// the SVG fills exactly).
		<div class="flex min-h-0 flex-1 flex-col">
			<p data-chart-part="readout" class="min-h-6 text-xs text-slate-700">
				{props.readout === "" ? READOUT_HINT : props.readout}
			</p>
			<div
				ref={(element) => {
					container = element;
				}}
				class="chart-viewer-main w-full"
			>
				{/* biome-ignore lint/a11y/useSemanticElements: ADR-0025 mandates role="group" with an interactive-chart roledescription on the focusable chart */}
				<svg
					ref={(element) => {
						svg = element;
					}}
					role="group"
					tabindex={0}
					aria-roledescription="interactive chart"
					aria-describedby={instructionsId}
					aria-label={props.label}
					viewBox={`0 0 ${props.size.width} ${props.size.height}`}
					class="chart-viewer-gesture absolute inset-0 block h-full w-full"
					font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
					font-size="12"
					onKeyDown={onKeyDown}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onPointerLeave={onPointerLeave}
					onDblClick={() => props.onReset()}
				>
					<rect
						x="0"
						y="0"
						width={props.size.width}
						height={props.size.height}
						fill={CHART_INK.surface}
					/>
					<clipPath id={clipId}>
						<rect
							x={props.model.plot.left}
							y={props.model.plot.top}
							width={Math.max(0, props.model.plot.right - props.model.plot.left)}
							height={Math.max(0, props.model.plot.bottom - props.model.plot.top)}
						/>
					</clipPath>
					<g data-chart-part="y-axis">
						<For each={props.model.yTicks}>
							{(tick, index) => (
								<>
									<line
										x1={props.model.plot.left}
										x2={props.model.plot.right}
										y1={props.model.yFor(tick)}
										y2={props.model.yFor(tick)}
										stroke={tick === 0 ? CHART_INK.axis : CHART_INK.grid}
										stroke-width="1"
									/>
									<Show when={!yTickHidden(tick)}>
										<text
											x={props.model.plot.right + 6}
											y={props.model.yFor(tick)}
											dy="0.32em"
											text-anchor="start"
											fill={CHART_INK.secondary}
										>
											{props.model.yTickLabels[index()] ?? ""}
										</text>
									</Show>
								</>
							)}
						</For>
					</g>
					<g data-chart-part="x-axis">
						<line
							x1={props.model.plot.left}
							x2={props.model.plot.right}
							y1={props.model.plot.bottom}
							y2={props.model.plot.bottom}
							stroke={CHART_INK.axis}
							stroke-width="1"
						/>
						<For each={props.model.xTicks}>
							{(tick) => (
								<text
									x={tick.x}
									y={props.model.plot.bottom + 18}
									text-anchor="middle"
									fill={CHART_INK.secondary}
								>
									{tick.label}
								</text>
							)}
						</For>
					</g>
					<g data-chart-part="marks" clip-path={`url(#${clipId})`}>
						<For each={props.model.maPaths}>
							{(entry) => (
								<path
									d={entry.d}
									fill="none"
									stroke={entry.color}
									stroke-width="1.5"
									stroke-dasharray="4 3"
									stroke-linejoin="round"
									stroke-linecap="round"
								/>
							)}
						</For>
						<For each={props.model.seriesPaths}>
							{(entry) => (
								<path
									d={entry.d}
									fill="none"
									stroke={entry.color}
									stroke-width="2"
									stroke-linejoin="round"
									stroke-linecap="round"
								/>
							)}
						</For>
					</g>
					<g data-chart-part="last-values">
						<For each={props.model.lastMarkers}>
							{(marker) => (
								<circle
									cx={props.model.xForDay(marker.day)}
									cy={marker.y}
									r={3}
									fill={marker.color}
								/>
							)}
						</For>
						<For each={props.model.lastValueTags}>
							{(tag) => (
								<g data-chart-part="last-value-tag">
									<rect
										x={tag.x}
										y={tag.y - tag.height / 2}
										width={tag.width}
										height={tag.height}
										rx="3"
										fill={tag.color}
									/>
									<text
										x={tag.x + 4}
										y={tag.y}
										dy="0.32em"
										text-anchor="start"
										fill={CHART_INK.tagText}
									>
										{tag.text}
									</text>
								</g>
							)}
						</For>
					</g>
					<Show when={props.crosshair !== null}>
						<Crosshair
							model={props.model}
							index={props.crosshair ?? 0}
							units={props.units}
							mode={props.mode}
						/>
					</Show>
				</svg>
			</div>
			<p id={instructionsId} class="sr-only">
				Interactive chart. Left and right arrows move the readout one bar; holding Shift with the
				arrows pans the window; plus and minus zoom; Home and End jump to the first and last bar;
				zero resets the window.
			</p>
			<p class="sr-only" aria-live="polite">
				{announced()}
			</p>
		</div>
	);
}

function Crosshair(props: {
	readonly model: DetailChartModel;
	readonly index: number;
	readonly units: readonly string[];
	readonly mode: DetailValueMode;
}): JSX.Element {
	const day = (): number => props.model.dayAt[props.index] ?? 0;
	const iso = (): string => props.model.isoAt[props.index] ?? "";
	const x = (): number => props.model.xForDay(day());
	// An object, never a bare number: a legitimate zero value must still
	// render the horizontal crosshair and its label (`<Show>` hides falsy).
	const firstPoint = (): { readonly value: number } | null => {
		for (const entry of props.model.seriesValues) {
			const value = entry.values[props.index] ?? null;
			if (value !== null && Number.isFinite(value)) return { value };
		}
		return null;
	};
	/**
	 * Date-label placement: centred on the bar, but docked to the plot edge
	 * (with the matching anchor) when centring would clip it past the SVG
	 * boundary — the first and last bars. The crosshair line itself stays on
	 * the bar.
	 */
	const datePlace = (): { readonly x: number; readonly anchor: "start" | "middle" | "end" } => {
		const plot = props.model.plot;
		const centre = x();
		const half = (iso().length * 6 + 8) / 2;
		if (centre - half <= plot.left) return { x: plot.left, anchor: "start" };
		if (centre + half >= plot.right) return { x: plot.right, anchor: "end" };
		return { x: centre, anchor: "middle" };
	};
	const label = (value: number): string =>
		props.mode === "percent" ? `${formatAxisTick(value)}%` : formatAxisTick(value);
	return (
		<g data-chart-part="crosshair">
			<line
				x1={x()}
				x2={x()}
				y1={props.model.plot.top}
				y2={props.model.plot.bottom}
				stroke={CHART_INK.secondary}
				stroke-width="1"
			/>
			<Show when={firstPoint()}>
				{(point) => (
					<>
						<line
							x1={props.model.plot.left}
							x2={props.model.plot.right}
							y1={props.model.yFor(point().value)}
							y2={props.model.yFor(point().value)}
							stroke={CHART_INK.secondary}
							stroke-width="1"
						/>
						<text
							x={props.model.plot.right + 6}
							y={props.model.yFor(point().value)}
							dy="0.32em"
							text-anchor="start"
							fill={CHART_INK.primary}
							stroke={CHART_INK.surface}
							stroke-width="3"
							paint-order="stroke"
						>
							{label(point().value)}
						</text>
					</>
				)}
			</Show>
			<text
				x={datePlace().x}
				y={props.model.plot.bottom + 18}
				text-anchor={datePlace().anchor}
				fill={CHART_INK.primary}
				stroke={CHART_INK.surface}
				stroke-width="3"
				paint-order="stroke"
			>
				{iso()}
			</text>
		</g>
	);
}
