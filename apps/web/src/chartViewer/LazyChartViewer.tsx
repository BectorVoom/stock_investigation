import { useMessages } from "@research/i18n/solid";
import {
	createResource,
	ErrorBoundary,
	type JSX,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { BUTTON, IconButton, Loading } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import type * as ViewerModule from "./ChartViewer.tsx";
import type { ChartViewerProps, InlineChartViewerProps } from "./ChartViewer.tsx";
import { chartViewerMessages } from "./chartViewer.messages.tsx";
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
 * attempt free to import again instead of replaying the failure. The
 * inline viewer (`LazyInlineChartViewer`) is in the same chunk and shares
 * the promise, so whichever loads first serves both.
 */
let viewerChunk: Promise<typeof ViewerModule> | null = null;

function loadViewerModule(): Promise<typeof ViewerModule> {
	if (viewerChunk === null) {
		viewerChunk = import("./ChartViewer.tsx").catch((error: unknown) => {
			viewerChunk = null;
			throw error;
		});
	}
	return viewerChunk;
}

const loadChartViewer = (): Promise<typeof ViewerModule.ChartViewer> =>
	loadViewerModule().then((module) => module.ChartViewer);

const loadInlineChartViewer = (): Promise<typeof ViewerModule.InlineChartViewer> =>
	loadViewerModule().then((module) => module.InlineChartViewer);

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
 * The one viewer that may exist (ADR-0025, fix round 8): opening a viewer
 * while another is still downloading or open supersedes the earlier one —
 * its widget's open state is closed through its `onClose`, without moving
 * focus — so two widgets pressed during one download never stack two modal
 * dialogs with competing focus traps.
 */
let currentViewer: { readonly supersede: () => void } | null = null;

/**
 * The loading and failure notices sit at a fixed place at the top of the
 * viewport (in a portal on `<body>`, so no widget's clipping or scroll
 * hides them): where the viewer's sheet will appear, visible whatever part
 * of the widget the press came from.
 */
const NOTICE_PLACE = "fixed inset-x-4 top-4 z-50 mx-auto max-w-md";

/** The failed-download alert; Try again takes focus when it appears. */
function ViewerFailure(props: {
	readonly onRetry: () => void;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(chartViewerMessages);
	const common = useMessages(commonMessages);
	let retry: HTMLButtonElement | undefined;
	onMount(() => {
		// The portal attaches its content in its own effect: focus once the
		// button is in the document.
		const focusRetry = (): void => retry?.focus();
		if (retry?.isConnected === true) focusRetry();
		else queueMicrotask(focusRetry);
	});
	return (
		<div
			role="alert"
			data-chart-viewer-failure=""
			class={`${NOTICE_PLACE} flex flex-wrap items-center gap-1 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900`}
		>
			<p class="mr-auto">{m().loadFailed}</p>
			<IconButton
				label={common().tryAgain}
				icon="arrow-clockwise"
				ref={(element) => {
					retry = element;
				}}
				onClick={() => props.onRetry()}
			/>
			<IconButton label={common().close} icon="x-lg" onClick={() => props.onClose()} />
		</div>
	);
}

/**
 * Mounted only while the viewer is open, once per press of an opener (the
 * entry points key it on the press, so pressing the opener again while the
 * failure shows imports again). While the chunk downloads a viewport-fixed
 * "Loading chart…" (a `status`) answers the press; a failed download or a
 * render failure inside the viewer becomes a viewport-fixed `alert` with
 * Try again (imports again; it takes focus) and Close (closes, focus back to
 * the opener) — it never reaches the page's error boundary nor leaves the
 * opener dead. Focus return is captured here, once, at the press, and handed
 * to the viewer, so a reload that replaced the opener during the download
 * still returns focus to the widget.
 */
export function LazyChartViewer(props: ChartViewerProps): JSX.Element {
	const m = useMessages(chartViewerMessages);
	const [viewer, { refetch }] = createResource(loadChartViewer);
	const focusReturn = props.focusReturn ?? captureFocusReturn(props.opener ?? null);
	const token = { supersede: () => props.onClose() };
	const previous = currentViewer;
	currentViewer = token;
	previous?.supersede();
	onCleanup(() => {
		if (currentViewer === token) currentViewer = null;
	});
	const close = (): void => {
		props.onClose();
		focusReturnTarget(focusReturn)?.focus();
	};
	return (
		<ErrorBoundary
			fallback={(_error: unknown, reset) => (
				<Portal>
					<ViewerFailure
						onRetry={() => {
							void refetch();
							reset();
						}}
						onClose={close}
					/>
				</Portal>
			)}
		>
			<Suspense
				fallback={
					<Portal>
						<div class={`${NOTICE_PLACE} rounded border border-slate-200 bg-white px-3 py-2`}>
							<Loading label={m().chartThing} />
						</div>
					</Portal>
				}
			>
				<Show when={viewer()}>
					{(component) => <Dynamic component={component()} {...props} focusReturn={focusReturn} />}
				</Show>
			</Suspense>
		</ErrorBoundary>
	);
}

/**
 * The inline viewer's failed-download alert, where the viewer would be (not
 * a viewport notice: the region is in the page). Try again imports again.
 */
function InlineViewerFailure(props: { readonly onRetry: () => void }): JSX.Element {
	const m = useMessages(chartViewerMessages);
	const common = useMessages(commonMessages);
	return (
		<div
			role="alert"
			data-chart-viewer-failure=""
			class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
		>
			<p>{m().loadFailed}</p>
			<button
				type="button"
				class={`${BUTTON} mt-1 pointer-coarse:min-h-11`}
				onClick={() => props.onRetry()}
			>
				{common().tryAgain}
			</button>
		</div>
	);
}

/**
 * The inline viewer (ADR-0049 §4) as part of the viewer's lazy chunk: the
 * region says "Loading chart…" while the chunk downloads, and a failed
 * download (or a render failure inside the viewer) becomes an alert in its
 * place with Try again, which imports again — it never reaches the page's
 * error boundary. The chunk promise is the dialog's (`loadViewerModule`).
 */
export function LazyInlineChartViewer(props: InlineChartViewerProps): JSX.Element {
	const m = useMessages(chartViewerMessages);
	const [viewer, { refetch }] = createResource(loadInlineChartViewer);
	return (
		<ErrorBoundary
			fallback={(_error: unknown, reset) => (
				<InlineViewerFailure
					onRetry={() => {
						void refetch();
						reset();
					}}
				/>
			)}
		>
			<Suspense fallback={<Loading label={m().chartThing} />}>
				<Show when={viewer()}>{(component) => <Dynamic component={component()} {...props} />}</Show>
			</Suspense>
		</ErrorBoundary>
	);
}
