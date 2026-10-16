import { clampWindow, type DayWindow } from "@research/domain";
import { buildNavigatorModel, CHART_INK } from "@research/ui-registry";
import { createMemo, type JSX, onCleanup, Show } from "solid-js";
import { createFrameScheduler } from "./frame.ts";

/**
 * Client-x to viewBox-x under `preserveAspectRatio="xMidYMid meet"` (the
 * navigator's declared policy): a wider or taller element letterboxes the
 * 600 × 56 scene instead of stretching it, so the dead margins on each side
 * are removed before scaling. Pure over the measured rect for tests.
 */
export function navigatorViewX(
	clientX: number,
	bounds: { readonly left: number; readonly width: number; readonly height: number },
): number {
	if (!(bounds.width > 0) || !(bounds.height > 0)) return clientX;
	const scale = Math.min(bounds.width / 600, bounds.height / 56);
	if (!(scale > 0)) return clientX;
	const offsetX = bounds.left + (bounds.width - 600 * scale) / 2;
	return (clientX - offsetX) / scale;
}

/**
 * The overview under the main chart (ADR-0025 layout §5): one decimated line
 * over all held data with the visible window as a highlighted rectangle and
 * two handles. Dragging the window pans, dragging a handle resizes, and
 * pressing outside the window centres it there. Every result is clamped
 * through the domain window functions. Colours arrive via fill and stroke
 * attributes bound to the palette; there are no inline style attributes.
 */
export function Navigator(props: {
	readonly days: readonly number[];
	readonly values: readonly number[];
	readonly window: DayWindow;
	readonly extent: DayWindow;
	readonly minSpanDays: number;
	readonly onWindow: (window: DayWindow) => void;
	readonly windowLabel: string;
}): JSX.Element {
	const frame = createFrameScheduler();
	// A queued drag or centre must never fire after unmount.
	onCleanup(() => frame.cancel());
	const model = createMemo(() =>
		buildNavigatorModel({
			days: props.days,
			values: props.values,
			window: props.window,
			width: 600,
			height: 56,
		}),
	);

	/** ViewBox x to integer day number (the viewBox is fixed at 600 px wide). */
	const dayAtX = (x: number): number => {
		const first = props.days[0];
		const last = props.days[props.days.length - 1];
		if (first === undefined || last === undefined) return 0;
		if (last === first) return first;
		const fraction = (x - 2) / (600 - 4);
		return Math.round(first + fraction * (last - first));
	};

	type DragMode =
		| { readonly kind: "move"; readonly grabOffset: number; readonly span: number }
		| { readonly kind: "left"; readonly fixedTo: number }
		| { readonly kind: "right"; readonly fixedFrom: number };
	let drag: DragMode | null = null;
	const HANDLE_HALF = 10;

	/** Pointer position in viewBox coordinates (letterbox-aware, never stretched). */
	const toX = (event: PointerEvent & { readonly currentTarget: SVGSVGElement }): number => {
		const bounds = event.currentTarget.getBoundingClientRect();
		return navigatorViewX(event.clientX, bounds);
	};

	const onPointerDown = (event: PointerEvent & { readonly currentTarget: SVGSVGElement }): void => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		if (!Number.isFinite(event.clientX)) return;
		const current = model();
		if (current === null) return;
		const x = toX(event);
		const left = current.windowLeft;
		const right = current.windowLeft + current.windowWidth;
		const from = Math.min(Math.trunc(props.window.from), Math.trunc(props.window.to));
		const to = Math.max(Math.trunc(props.window.from), Math.trunc(props.window.to));
		if (Math.abs(x - left) <= HANDLE_HALF) {
			drag = { kind: "left", fixedTo: to };
		} else if (Math.abs(x - right) <= HANDLE_HALF) {
			drag = { kind: "right", fixedFrom: from };
		} else if (x > left && x < right) {
			drag = { kind: "move", grabOffset: dayAtX(x) - from, span: to - from };
		} else {
			// Pressing outside centres the window there, keeping its span.
			const day = dayAtX(x);
			const span = to - from;
			const start = day - Math.round(span / 2);
			frame.schedule(() => {
				const centred = clampWindow({ from: start, to: start + span }, props.extent, span);
				if (centred.ok) props.onWindow(centred.value);
			});
			drag = { kind: "move", grabOffset: Math.round(span / 2), span };
		}
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// No pointer capture in some engines; the drag still tracks.
		}
	};

	const onPointerMove = (event: PointerEvent & { readonly currentTarget: SVGSVGElement }): void => {
		const active = drag;
		if (active === null || event.buttons === 0) return;
		if (!Number.isFinite(event.clientX)) return;
		const day = dayAtX(toX(event));
		if (active.kind === "left") {
			frame.schedule(() => {
				const resized = clampWindow(
					{ from: day, to: active.fixedTo },
					props.extent,
					props.minSpanDays,
				);
				if (resized.ok) props.onWindow(resized.value);
			});
		} else if (active.kind === "right") {
			frame.schedule(() => {
				const resized = clampWindow(
					{ from: active.fixedFrom, to: day },
					props.extent,
					props.minSpanDays,
				);
				if (resized.ok) props.onWindow(resized.value);
			});
		} else {
			const start = day - active.grabOffset;
			frame.schedule(() => {
				const moved = clampWindow(
					{ from: start, to: start + active.span },
					props.extent,
					active.span,
				);
				if (moved.ok) props.onWindow(moved.value);
			});
		}
	};

	const endDrag = (): void => {
		drag = null;
	};

	return (
		<Show when={model()}>
			{(current) => (
				<svg
					role="img"
					aria-label={props.windowLabel}
					viewBox="0 0 600 56"
					preserveAspectRatio="xMidYMid meet"
					class="chart-viewer-gesture block h-14 w-full"
					font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
				>
					<rect x="0" y="0" width="600" height="56" fill={CHART_INK.surface} />
					<path
						d={current().d}
						fill="none"
						stroke={CHART_INK.secondary}
						stroke-width="1"
						stroke-linejoin="round"
					/>
					<rect
						x={current().windowLeft}
						y={2}
						width={current().windowWidth}
						height={52}
						fill={CHART_INK.secondary}
						fill-opacity="0.12"
						stroke={CHART_INK.axis}
						stroke-width="1"
					/>
					<rect
						x={current().windowLeft - 3}
						y={2}
						width={6}
						height={52}
						fill={CHART_INK.secondary}
					/>
					<rect
						x={current().windowLeft + current().windowWidth - 3}
						y={2}
						width={6}
						height={52}
						fill={CHART_INK.secondary}
					/>
				</svg>
			)}
		</Show>
	);
}
