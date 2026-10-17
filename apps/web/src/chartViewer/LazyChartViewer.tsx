import { type JSX, lazy, Suspense } from "solid-js";
import type { ChartViewerProps } from "./ChartViewer.tsx";

/**
 * The chart viewer as its own lazy chunk (ADR-0025, fix round 6): the
 * entry points render on every page through the shared `WidgetBody`, but
 * the viewer itself — dialog, render model, navigator, statistics — only
 * downloads on the first open (or the press that precedes it, through
 * `preloadChartViewer`), so the main chunk carries only the openers.
 */
const ChartViewerChunk = lazy(() =>
	import("./ChartViewer.tsx").then((module) => ({ default: module.ChartViewer })),
);

/** Starts downloading the viewer chunk (idempotent); a press calls it before the click. */
export function preloadChartViewer(): void {
	void ChartViewerChunk.preload();
}

export function LazyChartViewer(props: ChartViewerProps): JSX.Element {
	return (
		<Suspense>
			<ChartViewerChunk {...props} />
		</Suspense>
	);
}
