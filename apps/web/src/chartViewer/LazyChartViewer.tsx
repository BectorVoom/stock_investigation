import { createResource, ErrorBoundary, type JSX, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { IconButton, Loading } from "../components/ui.tsx";
import type { ChartViewer, ChartViewerProps } from "./ChartViewer.tsx";
import { captureFocusReturn, focusReturnTarget } from "./openChart.ts";

/**
 * The chart viewer as its own lazy chunk (ADR-0025, fix round 6): the
 * entry points render on every page through the shared `WidgetBody`, but
 * the viewer itself — dialog, render model, navigator, statistics — only
 * downloads on the first open (or the press that precedes it, through
 * `preloadChartViewer`), so the main chunk carries only the openers.
 *
 * The download is one module-level promise, cleared when it rejects: an
 * offline press, or a chunk hash gone after a new release, leaves the next
 * attempt free to import again instead of replaying the failure.
 */
let viewerChunk: Promise<typeof ChartViewer> | null = null;

function loadChartViewer(): Promise<typeof ChartViewer> {
	if (viewerChunk === null) {
		viewerChunk = import("./ChartViewer.tsx").then(
			(module) => module.ChartViewer,
			(error: unknown) => {
				viewerChunk = null;
				throw error;
			},
		);
	}
	return viewerChunk;
}

/**
 * Starts downloading the viewer chunk (idempotent); a press calls it before
 * the click. A failed preload is not reported here: the open that follows
 * imports again and shows the failure where the viewer would be.
 */
export function preloadChartViewer(): void {
	loadChartViewer().then(
		() => undefined,
		() => undefined,
	);
}

/**
 * Mounted only while the viewer is open. While the chunk downloads the
 * widget shows "Loading chart…" (a `status`); a failed download or a render
 * failure inside the viewer stays inside the widget as an `alert` with
 * Try again (imports again) and Close (closes, focus back to the opener) —
 * it never reaches the page's error boundary nor leaves the opener dead.
 */
export function LazyChartViewer(props: ChartViewerProps): JSX.Element {
	const [viewer, { refetch }] = createResource(loadChartViewer);
	// Captured once: this component mounts on the open it serves.
	const focusReturn = captureFocusReturn(props.opener ?? null);
	const close = (): void => {
		props.onClose();
		focusReturnTarget(focusReturn)?.focus();
	};
	return (
		<ErrorBoundary
			fallback={(_error: unknown, reset) => (
				<div
					role="alert"
					data-chart-viewer-failure=""
					class="mt-1 flex flex-wrap items-center gap-1 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
				>
					<p class="mr-auto">The chart viewer could not be loaded.</p>
					<IconButton
						label="Try again"
						icon="arrow-clockwise"
						onClick={() => {
							void refetch();
							reset();
						}}
					/>
					<IconButton label="Close" icon="x-lg" onClick={close} />
				</div>
			)}
		>
			<Suspense fallback={<Loading label="chart" />}>
				<Show when={viewer()}>{(component) => <Dynamic component={component()} {...props} />}</Show>
			</Suspense>
		</ErrorBoundary>
	);
}
