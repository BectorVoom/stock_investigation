import type { JSX } from "solid-js";
import { preloadChartViewer } from "./LazyChartViewer.tsx";
import { OPEN_CHART_BUTTON_CLASS, OPEN_PRESS_SLOP_PX } from "./openChart.ts";

/**
 * The native button that opens the chart viewer from a widget (ADR-0025
 * "Where it opens"). Its accessible name is computed from its content — a
 * visually hidden "Open chart: " prefix followed by the visible text — so a
 * screen reader hears the values the button shows and speech input can say
 * what it sees (WCAG 2.5.3 Label in Name); there is no `aria-label`
 * replacing them. Children must be phrasing content (spans, an SVG), the
 * only content a `<button>` may hold.
 *
 * A mouse press that travels at least `OPEN_PRESS_SLOP_PX` before its
 * release is a text selection, never an open. The rule is mouse-only: touch
 * selects no text, and a touch or pen tap that drifts a few px still opens
 * (a real touch drag never produces a click); a pen can drag-select text in
 * some desktop browsers, and such a press may still open — accepted. A keyboard activation (click `detail` 0) always
 * opens. The clicked button itself is handed to `onOpen`, so focus returns
 * there even where a mouse click never focuses a button (Safari, Firefox on
 * macOS); `openerKey` lets focus find the widget's new button after a
 * reload re-rendered it.
 */
export function ChartOpener(props: {
	/** Visually hidden text read before the visible content ("Open chart: "). */
	readonly srPrefix: string;
	/** Unique within the widget (the series id, or "plot"): `data-chart-opener` (`CHART_OPENER_ATTRIBUTE`). */
	readonly openerKey: string;
	readonly onOpen: (button: HTMLButtonElement) => void;
	readonly children: JSX.Element;
}): JSX.Element {
	let pressedAt: { readonly x: number; readonly y: number } | null = null;
	return (
		<button
			type="button"
			class={OPEN_CHART_BUTTON_CLASS}
			data-chart-opener={props.openerKey}
			onPointerDown={(event) => {
				pressedAt =
					event.pointerType === "mouse" &&
					event.isPrimary &&
					Number.isFinite(event.clientX) &&
					Number.isFinite(event.clientY)
						? { x: event.clientX, y: event.clientY }
						: null;
				preloadChartViewer();
			}}
			onClick={(event) => {
				const start = pressedAt;
				pressedAt = null;
				if (
					event.detail > 0 &&
					start !== null &&
					Math.hypot(event.clientX - start.x, event.clientY - start.y) >= OPEN_PRESS_SLOP_PX
				) {
					return;
				}
				props.onOpen(event.currentTarget);
			}}
		>
			<span class="sr-only">{props.srPrefix}</span>
			{props.children}
		</button>
	);
}
