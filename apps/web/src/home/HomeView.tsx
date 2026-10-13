import {
	DEFAULT_HOME_DASHBOARD,
	type HomeDashboard,
	type HomeWidget,
	type MarketCatalogEntry,
} from "@research/contracts";
import { applyDashboardEdit, isTerminalJobState } from "@research/domain";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ApiClient, HomeDataResponse } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { Empty, ErrorNotice, IconButton, Notice } from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createPoller, type VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import { nextDropTarget, type SlotRect } from "./dragModel.ts";
import {
	HOME_SIZE_SPAN,
	hasFredSeries,
	needsAutoRefresh,
	seriesById,
	widgetSeriesIds,
} from "./homeModel.ts";
import "./shoelace.ts";
import { ensureHomeIconLibraries } from "./shoelace.ts";
import { WidgetDialog, type WidgetDialogState } from "./WidgetDialog.tsx";
import { WidgetFrame } from "./WidgetFrame.tsx";
import { WIDGET_REGISTRY } from "./widgetRegistry.tsx";

interface HomeNotice {
	readonly tone: "info" | "warning" | "success" | "error";
	readonly text: string;
}

/** What one data poll observed; queued/active keep polling, the rest settle. */
type HomePollSignal = "active" | "queued" | "changed" | "unchanged" | "failed";

/**
 * The run signal carried by the data response itself (V7: no extra run GET).
 * "pending" polls at the slow cadence (V6: the runner may be offline);
 * a leased run polls fast.
 */
function refreshSignal(current: HomeDataResponse | null): "active" | "queued" | "unchanged" {
	if (current !== null && current.refresh.activeRunId !== null) {
		return current.refresh.activeRunState === "pending" ? "queued" : "active";
	}
	return "unchanged";
}

/**
 * Home: market widgets the owner arranges (FR-017). Loads the dashboard and
 * the data in parallel, then polls `/home/data` conditionally only while a
 * refresh is active. The server copy is canonical: every edit is applied with
 * `applyDashboardEdit`, saved with `PUT` (version CAS), and re-rendered from
 * what the server accepted.
 */
export function HomeView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	ensureHomeIconLibraries();
	const dashboard = createRemote(() => props.api.getHomeDashboard());
	const [data, setData] = createSignal<HomeDataResponse | null>(null);
	const [dataEtag, setDataEtag] = createSignal<string | null>(null);
	const [dataLoading, setDataLoading] = createSignal(true);
	const [dataError, setDataError] = createSignal<ApiFailure | null>(null);
	const [notice, setNotice] = createSignal<HomeNotice | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [dialog, setDialog] = createSignal<WidgetDialogState | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	const [catalog, setCatalog] = createSignal<readonly MarketCatalogEntry[] | null>(null);
	const [catalogState, setCatalogState] = createSignal<"loading" | "ready" | "error">("loading");
	/** Polite announcement for every completed move (drag or menu). */
	const [announcement, setAnnouncement] = createSignal("");
	let disposed = false;
	let autoRefreshTried = false;
	let followUpTried = false;
	let refreshKey: string | null = null;
	/** Grid element holding the widget articles (drag preview via CSS `order`). */
	let gridEl: HTMLDivElement | undefined;
	/** Active pointer drag, or null. All positions are preview-order indices. */
	let drag: {
		readonly widgetId: string;
		readonly pointerId: number;
		readonly pressX: number;
		readonly pressY: number;
		readonly grabDX: number;
		readonly grabDY: number;
		readonly width: number;
		readonly height: number;
		readonly fromIndex: number;
		readonly article: HTMLElement;
		readonly grid: HTMLElement;
		readonly draggedSize: HomeWidget["size"];
		started: boolean;
		preview: string[];
		target: number;
		banned: number | null;
		slots: SlotRect[];
		lastX: number;
		lastY: number;
		raf: number;
		placeholder: HTMLElement | null;
	} | null = null;
	/** True while a dropped preview is being saved (blocks a new drag). */
	let savingPreview = false;
	onCleanup(() => {
		disposed = true;
		poller.stop();
	});

	const loadData = async (): Promise<HomePollSignal> => {
		const result = await props.api.getHomeData(dataEtag());
		if (disposed) return "unchanged";
		if (!result.ok) {
			if (data() === null) setDataError(result.error);
			else setNotice({ tone: "warning", text: "Market data did not refresh." });
			setDataLoading(false);
			return "failed";
		}
		if (!result.value.changed) {
			setDataLoading(false);
			return refreshSignal(data());
		}
		setData(result.value.value);
		setDataEtag(result.value.etag);
		setDataError(null);
		setDataLoading(false);
		const current = result.value.value;
		return current.refresh.activeRunId !== null ? refreshSignal(current) : "changed";
	};

	/** One follow-up refresh when the run that just ended never covered a series (V4). */
	const maybeFollowUpRefresh = async (): Promise<void> => {
		if (followUpTried || disposed) return;
		const current = data();
		const dash = dashboard.value();
		if (current === null || dash === null) return;
		const byId = seriesById(current.series);
		const unrefreshed = dash.dashboard.widgets
			.flatMap((widget) => [...widgetSeriesIds(widget)])
			.filter((id) => byId.get(id)?.lastRefreshedAt == null);
		if (unrefreshed.length === 0) return;
		followUpTried = true;
		await queueRefresh(
			"A series was added while the refresh ran, so one follow-up refresh was queued.",
		);
	};

	const poller = createPoller({
		poll: async () => {
			const signal = await loadData();
			if (disposed) return "unchanged";
			// V1: stop only when the run is known to have ended. A failed
			// poll backs off (the poller's failed cadence) and continues —
			// one 500 must never wedge the status on "Refreshing…" forever.
			if (signal === "changed" || signal === "unchanged") {
				poller.stop();
				await maybeFollowUpRefresh();
			}
			return signal;
		},
		visibility: props.visibility,
	});

	/**
	 * V3: decided only once BOTH dashboard and data are loaded (an effect
	 * below re-checks when either arrives); an empty series list never needs
	 * a refresh, so a bare dashboard queues nothing.
	 */
	const maybeAutoRefresh = () => {
		if (autoRefreshTried || disposed) return;
		const dash = dashboard.value();
		const current = data();
		if (dash === null || current === null || current.refresh.activeRunId !== null) return;
		autoRefreshTried = true;
		const byId = seriesById(current.series);
		const stamps = dash.dashboard.widgets.flatMap((widget) =>
			widgetSeriesIds(widget).map((id) => byId.get(id)?.lastRefreshedAt ?? null),
		);
		if (needsAutoRefresh(stamps, Date.now())) {
			void queueRefresh("Market data is stale, so one refresh was queued.");
		}
	};
	createEffect(() => {
		// Tracks both remotes: the decision runs once both have loaded,
		// whichever arrives last (V3).
		if (dashboard.value() !== null && data() !== null) maybeAutoRefresh();
	});

	const queueRefresh = async (announce?: string, isRetry = false): Promise<void> => {
		// V8: a skipped action says why instead of silently doing nothing.
		if (busy()) {
			setNotice({ tone: "info", text: "A market-data refresh is already being queued." });
			return;
		}
		setBusy(true);
		refreshKey ??= props.api.newIdempotencyKey();
		const result = await props.api.refreshMarket(refreshKey);
		if (disposed) return;
		setBusy(false);
		if (!result.ok) {
			// V9: keep the key only for an unambiguous retry of the same
			// attempt — a network failure with unknown outcome. A server
			// answer means nothing was queued under this key.
			if (result.error.kind !== "network") refreshKey = null;
			setNotice({
				tone: "error",
				text: `The market-data refresh was not queued: ${result.error.message}`,
			});
			return;
		}
		// V9: a replayed TERMINAL run means nothing was queued (the earlier
		// attempt finished while its answer was lost): take a fresh key and
		// queue again, once.
		if (isTerminalJobState(result.value.state) && !isRetry) {
			refreshKey = null;
			await queueRefresh(announce, true);
			return;
		}
		refreshKey = null;
		setNotice({
			tone: "info",
			text: announce ?? "Market-data refresh queued for the local runner.",
		});
		poller.start();
		void loadData();
	};

	/** Reloads data after a save and starts the poller when a run is active (V4). */
	const reloadDataAfterSave = async (): Promise<void> => {
		await loadData();
		if (disposed) return;
		const current = data();
		if (current !== null && current.refresh.activeRunId !== null) poller.start();
	};

	const initialLoad = async () => {
		await loadData();
		if (disposed) return;
		maybeAutoRefresh();
		// V5: data() may still be null after a failed first load — a null is
		// never "active", so no poller starts on nothing.
		const current = data();
		if (current !== null && current.refresh.activeRunId !== null) poller.start();
	};
	onMount(() => {
		void initialLoad();
	});

	const currentDashboard = (): { dashboard: HomeDashboard; version: number } | null => {
		const ready = dashboard.value();
		return ready === null ? null : { dashboard: ready.dashboard, version: ready.version };
	};

	/** Applies an edit locally, saves with CAS, and re-renders from the server copy. */
	const saveEdit = async (
		edit:
			| { readonly kind: "add"; readonly widget: HomeWidget }
			| { readonly kind: "remove"; readonly widgetId: string }
			| {
					readonly kind: "move";
					readonly widgetId: string;
					readonly direction: "earlier" | "later";
			  }
			| { readonly kind: "reorder"; readonly widgetId: string; readonly toIndex: number }
			| { readonly kind: "replace"; readonly widget: HomeWidget }
			| { readonly kind: "reset" },
	): Promise<void> => {
		const current = currentDashboard();
		if (current === null) return;
		// V8: edits attempted while a save is in flight say why (the dialog
		// stays open so nothing is lost); the toolbar and menus are disabled
		// while busy so this is the dialog-save path.
		if (busy()) {
			setNotice({
				tone: "warning",
				text: "The dashboard is being saved; please try your change again in a moment.",
			});
			return;
		}
		const transition =
			edit.kind === "reset"
				? applyDashboardEdit(current.dashboard, {
						kind: "reset",
						dashboard: {
							schemaVersion: 1,
							widgets: [...DEFAULT_HOME_DASHBOARD.widgets],
						},
					})
				: applyDashboardEdit(current.dashboard, edit);
		if (!transition.ok) {
			setNotice({ tone: "error", text: `The change was rejected: ${transition.error}` });
			return;
		}
		setBusy(true);
		const saved = await props.api.saveHomeDashboard(transition.value, current.version);
		if (disposed) return;
		setBusy(false);
		if (!saved.ok) {
			if (saved.error.code === "VERSION_CONFLICT") {
				await dashboard.reload();
				if (disposed) return;
				// V4: the conflict reload may carry new series — refresh data too.
				await loadData();
				if (disposed) return;
				setNotice({
					tone: "warning",
					text: "The dashboard changed elsewhere; it was reloaded. Please try your change again.",
				});
			} else {
				setNotice({ tone: "error", text: `The dashboard was not saved: ${saved.error.message}` });
			}
			return;
		}
		dashboard.set(saved.value);
		setDialog(null);
		if (edit.kind === "move" || edit.kind === "reorder") {
			const movedId = edit.widgetId;
			const position = saved.value.dashboard.widgets.findIndex(
				(entry) => entry.widgetId === movedId,
			);
			const moved = saved.value.dashboard.widgets[position];
			if (position >= 0 && moved !== undefined) {
				setAnnouncement(
					`Moved “${moved.title}” to position ${position + 1} of ${saved.value.dashboard.widgets.length}.`,
				);
			}
		}
		// V4: data is reloaded after every successful save, so widgets never
		// show "unavailable … source not stated" for observations the server
		// already holds.
		await reloadDataAfterSave();
		if (disposed) return;
		if (edit.kind === "add" || edit.kind === "replace") {
			const added = saved.value.dashboard.widgets.find(
				(entry) => entry.widgetId === edit.widget.widgetId,
			);
			if (added !== undefined) {
				const byId = seriesById(data()?.series ?? []);
				const needsData = widgetSeriesIds(added).some((id) => {
					const series = byId.get(id);
					return series === undefined || series.observations.length === 0;
				});
				if (needsData && data()?.refresh.activeRunId === null) {
					void queueRefresh("New series have no data yet, so one refresh was queued.");
				}
			}
		}
	};

	/**
	 * V2: the way out when the stored dashboard no longer parses — a dedicated
	 * reset that needs no expectedVersion (the owner discards whatever is
	 * stored). Usable from the dashboard error state, where versioned PUTs
	 * (and the toolbar Reset, which needs the dashboard) cannot run.
	 */
	const resetToDefaults = async (): Promise<void> => {
		if (busy()) return;
		setBusy(true);
		const result = await props.api.resetHomeDashboard();
		if (disposed) return;
		setBusy(false);
		if (!result.ok) {
			setNotice({
				tone: "error",
				text: `The dashboard was not reset: ${result.error.message}`,
			});
			return;
		}
		dashboard.set(result.value);
		setDialog(null);
		setNotice({ tone: "success", text: "The dashboard was reset to the default arrangement." });
		// V4: a reset changes the series set, so data is reloaded.
		await reloadDataAfterSave();
	};

	const loadCatalog = async () => {
		setCatalogState("loading");
		const result = await props.api.listMarketCatalog();
		if (disposed) return;
		if (!result.ok) {
			setCatalogState("error");
			return;
		}
		setCatalog(result.value);
		setCatalogState("ready");
	};

	const openDialog = (
		state: WidgetDialogState,
		event: MouseEvent & { readonly currentTarget: HTMLElement },
	) => {
		setOpener(event.currentTarget);
		setDialog(state);
		if (catalog() === null) void loadCatalog();
	};

	/** The Actions button of a widget menu: dialog focus returns to it on close. */
	const openEditDialog = (target: HomeWidget) => {
		const opener = document.querySelector(`[data-widget-actions="${target.widgetId}"]`);
		setOpener(opener instanceof HTMLElement ? opener : null);
		if (catalog() === null) void loadCatalog();
		setDialog({ mode: "edit", widget: target });
	};

	const statusLine = createMemo((): string | null => {
		const current = data();
		if (current === null) return null;
		if (current.refresh.activeRunId !== null) {
			const state = current.refresh.activeRunState ?? "queued";
			return `Refreshing market data… (${state}, run ${current.refresh.activeRunId}). It is fetched by the local runner; if the runner is offline it stays queued until the runner reconnects.`;
		}
		// S2: the last SUCCESSFUL completion and the last failure are told
		// apart — a failed refresh never poses as "Last refresh: <time>".
		const parts: string[] = [];
		if (current.refresh.lastSucceededAt !== null) {
			parts.push(`Last successful refresh: ${formatInstant(current.refresh.lastSucceededAt)}.`);
		}
		if (current.refresh.lastFailure !== null) {
			parts.push(
				`Last refresh failed (${current.refresh.lastFailure.code}) at ${formatInstant(current.refresh.lastFailure.at)}.`,
			);
		}
		if (parts.length > 0) return parts.join(" ");
		return "No market-data refresh has completed yet.";
	});

	/**
	 * Memoized derivations (UI-002): `seriesById` rebuilds a Map per read, so
	 * every derivation over the dashboard is a memo. The `byId` memo itself —
	 * not its value — is passed to the widgets, so a refresh updates numbers
	 * and provenance through the live accessor without tearing down any
	 * widget subtree (its `<article>`, open disclosures, focus and hover all
	 * survive).
	 */
	const byId = createMemo(() => seriesById(data()?.series ?? []));
	const widgets = createMemo(() => dashboard.value()?.dashboard.widgets ?? []);
	const fredShown = createMemo(() =>
		hasFredSeries(widgets().flatMap((widget) => [...widgetSeriesIds(widget)])),
	);
	const dashboardError = (): ApiFailure | null => {
		const state = dashboard.state();
		return state.status === "error" ? state.error : null;
	};

	/**
	 * Drag and drop repositioning (HIG Drag and drop): the whole header strip
	 * is the handle, Pointer Events only, 4 px threshold, the lifted widget
	 * follows the pointer with its grab offset, the target slot shows a
	 * same-size dashed placeholder and the others reflow in their real grid
	 * positions via CSS `order` (DOM nodes never move during the drag, so open
	 * disclosures, scroll positions and charts keep their state; the real DOM
	 * order changes only on commit when the server copy renders). Positions
	 * are applied through the CSSOM, never as an inline style attribute. Pointer moves coalesce on `requestAnimationFrame`
	 * (one layout read and one write per frame at most); slot rectangles are
	 * re-read only when the target changes. Window listeners survive Solid
	 * `<For>` node moves; everything is removed and reset on end/cancel/dispose.
	 */
	const articlesIn = (grid: HTMLElement): HTMLElement[] => {
		const found: HTMLElement[] = [];
		for (const node of grid.querySelectorAll("article[data-widget-id]")) {
			if (node instanceof HTMLElement) found.push(node);
		}
		return found;
	};

	const articleWithId = (grid: HTMLElement, widgetId: string): HTMLElement | null => {
		for (const article of articlesIn(grid)) {
			if (article.getAttribute("data-widget-id") === widgetId) return article;
		}
		return null;
	};

	const rectOf = (element: HTMLElement): SlotRect => {
		const box = element.getBoundingClientRect();
		return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
	};

	/** Slot rectangles in preview order; the dragged slot is the placeholder. */
	const readPreviewSlots = (
		grid: HTMLElement,
		preview: readonly string[],
		draggedId: string,
		placeholder: HTMLElement,
	): SlotRect[] => {
		const byId = new Map<string, HTMLElement>();
		for (const article of articlesIn(grid)) {
			const id = article.getAttribute("data-widget-id");
			if (id !== null) byId.set(id, article);
		}
		const slots: SlotRect[] = [];
		for (const id of preview) {
			if (id === draggedId) {
				slots.push(rectOf(placeholder));
				continue;
			}
			const article = byId.get(id);
			if (article === undefined) continue;
			slots.push(rectOf(article));
		}
		return slots;
	};

	const applyDuringDragOrders = (
		grid: HTMLElement,
		preview: readonly string[],
		draggedId: string,
		target: number,
		placeholder: HTMLElement,
	): void => {
		const positions = new Map<string, number>();
		for (const [index, id] of preview.entries()) positions.set(id, index);
		for (const article of articlesIn(grid)) {
			const id = article.getAttribute("data-widget-id");
			if (id === null || id === draggedId) continue;
			const position = positions.get(id);
			if (position === undefined) continue;
			article.style.setProperty("order", String(position));
		}
		placeholder.style.setProperty("order", String(target));
	};

	const applyPreviewOrders = (grid: HTMLElement, preview: readonly string[]): void => {
		const positions = new Map<string, number>();
		for (const [index, id] of preview.entries()) positions.set(id, index);
		for (const article of articlesIn(grid)) {
			const id = article.getAttribute("data-widget-id");
			if (id === null) continue;
			const position = positions.get(id);
			if (position === undefined) continue;
			article.style.setProperty("order", String(position));
		}
	};

	const clearGridOrders = (grid: HTMLElement): void => {
		for (const article of articlesIn(grid)) article.style.removeProperty("order");
	};

	const liftDragged = (article: HTMLElement, x: number, y: number, w: number, h: number): void => {
		article.style.setProperty("position", "fixed");
		article.style.setProperty("left", `${x}px`);
		article.style.setProperty("top", `${y}px`);
		article.style.setProperty("width", `${w}px`);
		article.style.setProperty("height", `${h}px`);
		article.style.setProperty("opacity", "0.9");
		article.style.setProperty("z-index", "30");
		article.style.setProperty("pointer-events", "none");
		article.classList.add("ring-2", "ring-blue-600", "cursor-grabbing");
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (handle instanceof HTMLElement) {
			handle.classList.remove("cursor-grab");
			handle.classList.add("cursor-grabbing");
		}
	};

	const moveLifted = (article: HTMLElement, x: number, y: number): void => {
		article.style.setProperty("left", `${x}px`);
		article.style.setProperty("top", `${y}px`);
	};

	const unliftDragged = (article: HTMLElement): void => {
		for (const property of [
			"position",
			"left",
			"top",
			"width",
			"height",
			"opacity",
			"z-index",
			"pointer-events",
		]) {
			article.style.removeProperty(property);
		}
		article.classList.remove("ring-2", "ring-blue-600", "cursor-grabbing");
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (handle instanceof HTMLElement) {
			handle.classList.remove("cursor-grabbing");
			handle.classList.add("cursor-grab");
		}
	};

	const suppressSelection = (): void => {
		document.body.style.setProperty("user-select", "none");
	};

	const releaseSelection = (): void => {
		document.body.style.removeProperty("user-select");
	};

	const removeDragListeners = (): void => {
		window.removeEventListener("pointermove", onDragPointerMove);
		window.removeEventListener("pointerup", onDragPointerUp);
		window.removeEventListener("pointercancel", onDragPointerCancel);
		window.removeEventListener("keydown", onDragKeyDown);
		window.removeEventListener("blur", onDragBlur);
	};

	const resetDragDom = (): void => {
		const state = drag;
		if (state === null) return;
		if (state.raf !== 0) {
			cancelAnimationFrame(state.raf);
			state.raf = 0;
		}
		unliftDragged(state.article);
		state.placeholder?.remove();
		clearGridOrders(state.grid);
		releaseSelection();
	};

	/** Cancels the active press/drag: the widget returns, nothing is saved. */
	function cancelDrag(): void {
		if (drag === null) return;
		removeDragListeners();
		resetDragDom();
		drag = null;
	}

	const scheduleDragFrame = (): void => {
		if (drag === null || drag.raf !== 0) return;
		drag.raf = requestAnimationFrame(onDragFrame);
	};

	function onDragFrame(): void {
		const state = drag;
		if (state === null) return;
		state.raf = 0;
		const placeholder = state.placeholder;
		if (!state.started || placeholder === null) return;
		// HIG: scroll the destination when necessary; stops when the drag ends
		// (no loop — one nudge per coalesced frame while the pointer rests low/high).
		if (state.lastY < 80) window.scrollBy(0, -12);
		else if (state.lastY > window.innerHeight - 80) window.scrollBy(0, 12);
		moveLifted(state.article, state.lastX - state.grabDX, state.lastY - state.grabDY);
		const next = nextDropTarget({
			slots: state.slots,
			draggedIndex: state.target,
			pointer: { x: state.lastX, y: state.lastY },
			previous: { target: state.target, banned: state.banned },
		});
		if (next.target === state.target) {
			state.banned = next.banned;
			return;
		}
		const widgetId = state.widgetId;
		const without = state.preview.filter((id) => id !== widgetId);
		without.splice(next.target, 0, widgetId);
		state.preview = without;
		state.target = next.target;
		state.banned = next.banned;
		applyDuringDragOrders(state.grid, state.preview, state.widgetId, state.target, placeholder);
		state.slots = readPreviewSlots(state.grid, state.preview, state.widgetId, placeholder);
	}

	function startDrag(state: NonNullable<typeof drag>): void {
		state.started = true;
		const placeholder = document.createElement("div");
		placeholder.setAttribute("data-widget-placeholder", "");
		placeholder.setAttribute("aria-hidden", "true");
		placeholder.className = `rounded-2xl border border-dashed border-slate-300 ${HOME_SIZE_SPAN[state.draggedSize]}`;
		state.grid.appendChild(placeholder);
		state.placeholder = placeholder;
		suppressSelection();
		liftDragged(
			state.article,
			state.lastX - state.grabDX,
			state.lastY - state.grabDY,
			state.width,
			state.height,
		);
		applyDuringDragOrders(state.grid, state.preview, state.widgetId, state.target, placeholder);
		state.slots = readPreviewSlots(state.grid, state.preview, state.widgetId, placeholder);
	}

	function onDragPointerMove(event: PointerEvent): void {
		const state = drag;
		if (state === null || event.pointerId !== state.pointerId) return;
		if (event.isPrimary === false) return;
		state.lastX = event.clientX;
		state.lastY = event.clientY;
		if (!state.started) {
			const moved = Math.hypot(state.lastX - state.pressX, state.lastY - state.pressY);
			// HIG: the drag image appears after about three points (4 px here);
			// a press and release without that movement is a plain click.
			if (moved < 4) return;
			startDrag(state);
		}
		scheduleDragFrame();
	}

	function onDragPointerUp(event: PointerEvent): void {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		const finished = drag;
		removeDragListeners();
		if (finished.raf !== 0) {
			cancelAnimationFrame(finished.raf);
			finished.raf = 0;
		}
		if (!finished.started) {
			drag = null;
			return;
		}
		// Flush the release point synchronously: a coalesced frame holding the
		// final pointer position may still be pending (or was just cancelled),
		// and the drop must commit what is under the pointer, not the last
		// frame that ran.
		finished.lastX = event.clientX;
		finished.lastY = event.clientY;
		const flushed = nextDropTarget({
			slots: finished.slots,
			draggedIndex: finished.target,
			pointer: { x: finished.lastX, y: finished.lastY },
			previous: { target: finished.target, banned: finished.banned },
		});
		if (flushed.target !== finished.target) {
			const widgetId = finished.widgetId;
			const without = finished.preview.filter((id) => id !== widgetId);
			without.splice(flushed.target, 0, widgetId);
			finished.preview = without;
			finished.target = flushed.target;
			finished.banned = flushed.banned;
		}
		const widgetId = finished.widgetId;
		const toIndex = finished.target;
		const fromIndex = finished.fromIndex;
		const preview = [...finished.preview];
		// Settle the lifted widget back into flow before deciding.
		unliftDragged(finished.article);
		finished.placeholder?.remove();
		releaseSelection();
		if (toIndex === fromIndex) {
			clearGridOrders(finished.grid);
			drag = null;
			return;
		}
		// The previewed order stays on screen while the save is in flight (no
		// snap back): keep CSS orders until the server copy renders.
		applyPreviewOrders(finished.grid, preview);
		const grid = finished.grid;
		drag = null;
		savingPreview = true;
		void saveEdit({ kind: "reorder", widgetId, toIndex })
			.catch(() => undefined)
			.finally(() => {
				savingPreview = false;
				clearGridOrders(grid);
			});
	}

	function onDragPointerCancel(event: PointerEvent): void {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		cancelDrag();
	}

	function onDragKeyDown(event: KeyboardEvent): void {
		if (event.key !== "Escape" || drag === null) return;
		event.preventDefault();
		cancelDrag();
	}

	function onDragBlur(): void {
		if (drag === null) return;
		cancelDrag();
	}

	const onGridPointerDown = (event: PointerEvent): void => {
		if (drag !== null || savingPreview || busy()) return;
		if (dashboard.value() === null || widgets().length <= 1) return;
		if (event.isPrimary === false) return;
		if (event.pointerType === "mouse" && event.button !== 0) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		// A press on the actions button (or any interactive control) never
		// starts a drag; a click on it still opens the menu.
		if (
			target.closest(
				'button,a,input,select,textarea,summary,[role="menu"],[role="menuitem"],sl-dialog,sl-select,sl-input,sl-option',
			) !== null
		) {
			return;
		}
		const handle = target.closest("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) return;
		const widgetId = handle.getAttribute("data-widget-drag-handle");
		if (widgetId === null || widgetId === "") return;
		const grid = gridEl;
		if (grid === undefined) return;
		const article = articleWithId(grid, widgetId);
		if (article === null) return;
		const serverIds = widgets().map((entry) => entry.widgetId);
		const fromIndex = serverIds.indexOf(widgetId);
		if (fromIndex < 0) return;
		const current = widgets().find((entry) => entry.widgetId === widgetId);
		if (current === undefined) return;
		const box = article.getBoundingClientRect();
		drag = {
			widgetId,
			pointerId: event.pointerId,
			pressX: event.clientX,
			pressY: event.clientY,
			grabDX: event.clientX - box.left,
			grabDY: event.clientY - box.top,
			width: box.width,
			height: box.height,
			fromIndex,
			article,
			grid,
			draggedSize: current.size,
			started: false,
			preview: [...serverIds],
			target: fromIndex,
			banned: null,
			slots: [],
			lastX: event.clientX,
			lastY: event.clientY,
			raf: 0,
			placeholder: null,
		};
		window.addEventListener("pointermove", onDragPointerMove);
		window.addEventListener("pointerup", onDragPointerUp);
		window.addEventListener("pointercancel", onDragPointerCancel);
		window.addEventListener("keydown", onDragKeyDown);
		window.addEventListener("blur", onDragBlur);
	};

	onCleanup(() => {
		removeDragListeners();
		if (drag !== null) {
			resetDragDom();
			drag = null;
		}
		savingPreview = false;
	});

	/**
	 * V2: the data loading skeleton — and nothing else — while data loads.
	 * When the data GET failed, the error state above stands alone (no
	 * skeleton beside the error).
	 */
	const DataPending = (): JSX.Element => (
		<Show
			when={dataError() === null}
			fallback={<span class="sr-only">Market data failed to load.</span>}
		>
			<section class="space-y-2" aria-label="Loading market data">
				<output class="block text-sm text-slate-600">Loading market data…</output>
				<div class="grid auto-rows-[17rem] grid-cols-2 gap-4 lg:grid-cols-4">
					<For each={[0, 1, 2, 3]}>{() => <sl-skeleton effect="sheen" class="block h-full" />}</For>
				</div>
			</section>
		</Show>
	);

	return (
		<div class="space-y-3">
			{/* V2: a failed data GET with no data is an error state, never a
			    loading skeleton beside the error. */}
			<Show when={data() === null}>
				<Show when={dataError()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title="Could not load market data."
							iconRetry={true}
							onRetry={() => {
								setDataError(null);
								setDataLoading(true);
								void reloadDataAfterSave().then(() => maybeAutoRefresh());
							}}
						/>
					)}
				</Show>
			</Show>
			<Show when={notice()}>{(item) => <Notice tone={item().tone}>{item().text}</Notice>}</Show>

			<section aria-label="Market widgets toolbar" class="flex flex-wrap items-center gap-2">
				<Show when={statusLine()}>
					{(line) => (
						<output
							class="mr-auto block min-w-0 flex-1 text-xs text-slate-700"
							data-field="home-status"
						>
							{line()}
						</output>
					)}
				</Show>
				<div class="ml-auto flex items-center gap-1">
					<IconButton
						label="Add widget"
						icon="plus-lg"
						variant="primary"
						disabled={busy() || dashboard.value() === null}
						onClick={(event) => openDialog({ mode: "add" }, event)}
					/>
					<IconButton
						label="Refresh market data"
						icon="arrow-clockwise"
						disabled={busy() || data()?.refresh.activeRunId !== null}
						onClick={() => void queueRefresh()}
					/>
					<IconButton
						label="Reset to default arrangement"
						icon="arrow-counterclockwise"
						disabled={busy() || dashboard.value() === null}
						onClick={(event) => openDialog({ mode: "confirm-reset" }, event)}
					/>
				</div>
			</section>

			<output class="sr-only" aria-live="polite">
				{announcement()}
			</output>

			{/* V2: the dashboard GET has its own error state (stable code, Try
			    again) instead of an endless skeleton; when the stored document
			    no longer parses, Reset replaces it (no expectedVersion needed). */}
			<Switch>
				<Match when={dashboard.value() === null && dashboardError() === null}>
					<section class="space-y-2" aria-label="Loading home">
						<output class="block text-sm text-slate-600">Loading market widgets…</output>
						<div class="grid auto-rows-[17rem] grid-cols-2 gap-4 lg:grid-cols-4">
							<For each={[0, 1, 2, 3]}>
								{() => <sl-skeleton effect="sheen" class="block h-full" />}
							</For>
						</div>
					</section>
				</Match>
				<Match when={dashboard.value() === null && dashboardError() !== null}>
					<section class="space-y-2" aria-label="Dashboard error">
						<Show when={dashboardError()}>
							{(error) => (
								<ErrorNotice
									failure={error()}
									title="Could not load the dashboard."
									iconRetry={true}
									onRetry={() => {
										void dashboard.reload();
									}}
								/>
							)}
						</Show>
						<div>
							<IconButton
								label="Reset to default arrangement"
								icon="arrow-counterclockwise"
								disabled={busy()}
								onClick={() => void resetToDefaults()}
							/>
						</div>
					</section>
				</Match>
				<Match when={dashboard.value() !== null}>
					<Show when={data() !== null && !dataLoading()} fallback={<DataPending />}>
						<Show
							when={(dashboard.value()?.dashboard.widgets.length ?? 0) > 0}
							fallback={<Empty>No widgets yet. Use the + button to add one.</Empty>}
						>
							<div
								class="grid auto-rows-[17rem] grid-cols-2 gap-4 lg:grid-cols-4"
								data-widget-grid
								ref={(element) => {
									gridEl = element;
								}}
								onPointerDown={(event) => onGridPointerDown(event)}
							>
								<For each={dashboard.value()?.dashboard.widgets ?? []}>
									{(widget, index) => (
										<WidgetFrame
											widget={widget}
											position={index()}
											total={dashboard.value()?.dashboard.widgets.length ?? 0}
											actionsDisabled={busy()}
											onEdit={openEditDialog}
											onMove={(target, direction) =>
												void saveEdit({ kind: "move", widgetId: target.widgetId, direction })
											}
											onRemove={(target) =>
												void saveEdit({ kind: "remove", widgetId: target.widgetId })
											}
										>
											{/*
											 * The registry entry's component, with the live series
											 * accessor as a prop: the For callback never reads the
											 * data (only `widget.type`), so a refresh updates the
											 * widgets in place instead of rebuilding every subtree.
											 */}
											<Dynamic
												component={WIDGET_REGISTRY[widget.type].component}
												widget={widget}
												seriesById={byId}
												disabled={busy()}
												onSaveRange={(next: HomeWidget) =>
													void saveEdit({ kind: "replace", widget: next })
												}
											/>
										</WidgetFrame>
									)}
								</For>
							</div>
						</Show>
					</Show>
				</Match>
			</Switch>

			<Show when={fredShown()}>
				<p class="text-2xs text-slate-600">
					This product uses the FRED® API but is not endorsed or certified by the Federal Reserve
					Bank of St. Louis.
				</p>
			</Show>
			<p class="text-2xs text-slate-600">
				Change compares the latest observation with the one before it; 1-year change compares with
				the observation nearest to one year earlier.
			</p>

			<WidgetDialog
				state={dialog()}
				opener={opener()}
				dashboard={dashboard.value()?.dashboard ?? { schemaVersion: 1 as const, widgets: [] }}
				catalog={catalog()}
				catalogState={catalogState()}
				seriesById={byId()}
				onSave={(widget) => {
					const exists = widgets().some((entry) => entry.widgetId === widget.widgetId);
					void saveEdit(exists ? { kind: "replace", widget } : { kind: "add", widget });
				}}
				onConfirmReset={() => void saveEdit({ kind: "reset" })}
				onClose={() => {
					setDialog(null);
					opener()?.focus();
				}}
			/>
		</div>
	);
}
