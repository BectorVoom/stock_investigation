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
import type { ApiClient, HomeDataResponse, WatchlistData } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { Empty, ErrorNotice, IconButton, Notice } from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createPoller, type VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import { createEarningsRefreshQueue } from "../watchlist/earningsRefreshQueue.ts";
import { createGoogleSyncQueue } from "../watchlist/googleSyncQueue.ts";
import {
	EARNINGS_AUTO_REFRESH_NOTICE,
	earningsAutoRefreshReason,
	googleAutoSyncWanted,
	isGoogleCalendarRunActive,
	isWatchlistRefreshActive,
	watchlistRefreshSignal,
} from "../watchlist/watchlistModel.ts";
import { hasFredSeries, needsAutoRefresh, seriesById, widgetSeriesIds } from "./homeModel.ts";
import { createWidgetDrag, type WidgetDragDrop } from "./widgetDrag.ts";
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
	/**
	 * The watchlist for earnings-calendar widgets, loaded only when the
	 * dashboard holds at least one (an effect below starts the load). Like
	 * the series, it arrives through an accessor so the widget stays
	 * reactive across reloads.
	 */
	const [watchlist, setWatchlist] = createSignal<WatchlistData | null>(null);
	const [watchlistEtag, setWatchlistEtag] = createSignal<string | null>(null);
	const [watchlistError, setWatchlistError] = createSignal<ApiFailure | null>(null);
	const [notice, setNotice] = createSignal<HomeNotice | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [dialog, setDialog] = createSignal<WidgetDialogState | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	const [catalog, setCatalog] = createSignal<readonly MarketCatalogEntry[] | null>(null);
	const [catalogState, setCatalogState] = createSignal<"loading" | "ready" | "error">("loading");
	/** Polite announcement for every completed move (drag or menu). */
	const [announcement, setAnnouncement] = createSignal("");
	/**
	 * Every completed move announces, even when the sentence repeats the
	 * previous one (a live region sets nothing when the same text is set
	 * twice): the text is cleared first and the message is set on a later
	 * task, so assistive technology observes a change each time.
	 */
	const announceMove = (title: string, position: number, total: number): void => {
		const message = `Moved “${title}” to position ${position} of ${total}.`;
		setAnnouncement("");
		window.setTimeout(() => {
			if (!disposed) setAnnouncement(message);
		}, 0);
	};
	let disposed = false;
	let autoRefreshTried = false;
	let followUpTried = false;
	let refreshKey: string | null = null;
	/** Grid element holding the widget articles (drag preview via CSS `order`). */
	let gridEl: HTMLDivElement | undefined;
	/** True while a dropped preview is being saved (blocks a new drag). */
	let savingPreview = false;
	/** Earnings-date auto-refresh (FR-018 fix F): once per mount, like market data above. */
	const earningsQueue = createEarningsRefreshQueue(props.api);
	const [earningsQueueBusy, setEarningsQueueBusy] = createSignal(false);
	let earningsAutoTried = false;
	/** Google Calendar auto-sync (FR-019): at most one attempt per watchlist ETag. */
	const googleQueue = createGoogleSyncQueue(props.api);
	let googleSyncAttemptedEtag: string | null = null;
	onCleanup(() => {
		disposed = true;
		poller.stop();
		watchlistPoller.stop();
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

	/** Conditional watchlist re-read; the poller below runs it while a refresh is active. */
	const loadWatchlist = async (): Promise<
		"active" | "queued" | "changed" | "unchanged" | "failed"
	> => {
		const result = await props.api.getWatchlist(watchlistEtag());
		if (disposed) return "unchanged";
		if (!result.ok) {
			if (watchlist() === null) setWatchlistError(result.error);
			return "failed";
		}
		if (!result.value.changed) return watchlistRefreshSignal(watchlist());
		setWatchlist(result.value.value);
		setWatchlistEtag(result.value.etag);
		setWatchlistError(null);
		const current = result.value.value;
		// A Google Calendar step keeps the poll alive too (its URL and counts
		// arrive through this poll); only a run-free change settles it.
		return current.refresh.activeRunId !== null || current.googleCalendar.activeRunId !== null
			? watchlistRefreshSignal(current)
			: "changed";
	};

	const watchlistPoller = createPoller({
		poll: async () => {
			const signal = await loadWatchlist();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") {
				watchlistPoller.stop();
				// The run that was active at load has ended: the once-per-mount
				// rule below never ran, so re-evaluate it now. When the ended
				// run already covered every stock the reason is null and
				// nothing more is queued.
				maybeEarningsAutoRefresh();
				maybeGoogleAutoSync();
			}
			return signal;
		},
		visibility: props.visibility,
	});

	/** A poll-worthy watchlist run: an earnings refresh or a Google Calendar step. */
	const isWatchlistPollActive = (): boolean => {
		const current = watchlist();
		return (
			current !== null && (isWatchlistRefreshActive(current) || isGoogleCalendarRunActive(current))
		);
	};

	/** Starts the watchlist load once the dashboard shows a calendar widget needs it. */
	const maybeLoadWatchlist = () => {
		if (disposed || watchlist() !== null || watchlistError() !== null) return;
		if (!widgets().some((widget) => widget.type === "earnings-calendar")) return;
		void loadWatchlist().then(() => {
			if (disposed) return;
			if (isWatchlistPollActive()) watchlistPoller.start();
			else {
				maybeEarningsAutoRefresh();
				maybeGoogleAutoSync();
			}
		});
	};
	createEffect(() => {
		// Tracks the dashboard: a newly added calendar widget triggers the load —
		// or, when the watchlist already loaded, the once-per-mount auto-refresh.
		if (dashboard.value() !== null) {
			if (watchlist() === null) maybeLoadWatchlist();
			else {
				maybeEarningsAutoRefresh();
				maybeGoogleAutoSync();
			}
		}
	});

	/**
	 * Once per mount, after the watchlist has loaded: queue one earnings-date
	 * refresh when a calendar widget is shown, no run is active, and dates
	 * were never fetched or are more than a day old. Announces through Home's
	 * notice; a failed queue is reported, never retried.
	 */
	const maybeEarningsAutoRefresh = (): void => {
		if (earningsAutoTried || disposed) return;
		const current = watchlist();
		if (current === null) return;
		if (!widgets().some((widget) => widget.type === "earnings-calendar")) return;
		if (current.refresh.activeRunId !== null) return;
		const reason = earningsAutoRefreshReason(current, Date.now());
		if (reason === null) return;
		earningsAutoTried = true;
		void queueEarningsRefresh(EARNINGS_AUTO_REFRESH_NOTICE[reason]);
	};

	/** Queues one earnings-date refresh through the shared queue (manual button or auto). */
	const queueEarningsRefresh = async (announce: string): Promise<void> => {
		if (earningsQueue.busy() || earningsQueueBusy()) {
			setNotice({ tone: "info", text: "An earnings-date refresh is already being queued." });
			return;
		}
		setEarningsQueueBusy(true);
		const result = await earningsQueue.queue();
		if (disposed) return;
		setEarningsQueueBusy(false);
		if (result.kind === "busy") {
			setNotice({ tone: "info", text: "An earnings-date refresh is already being queued." });
			return;
		}
		if (result.kind === "failed") {
			setNotice({
				tone: "error",
				text: `The earnings-date refresh was not queued: ${result.error.message}`,
			});
			return;
		}
		setNotice({ tone: "info", text: announce });
		watchlistPoller.start();
		void loadWatchlist();
	};

	/** The calendar widget's refresh button: one manual queue, announced. */
	const refreshEarnings = (): void => {
		void queueEarningsRefresh("Earnings-date refresh queued for the local runner.");
	};
	/** True while an earnings queue request is in flight (the widget button reads this). */
	const earningsRefreshBusy = (): boolean => earningsQueueBusy() || earningsQueue.busy();

	/**
	 * Once per watchlist ETag, when a calendar widget is shown: queue one
	 * Google Calendar sync (the pure `googleAutoSyncWanted` rule shared with
	 * the Watchlist page, which also stops after any recorded failure). A
	 * queue request that fails is reported and not repeated: the ETag is
	 * recorded before the request.
	 */
	const maybeGoogleAutoSync = (): void => {
		if (disposed) return;
		const current = watchlist();
		const tag = watchlistEtag();
		if (current === null || tag === null) return;
		if (!widgets().some((widget) => widget.type === "earnings-calendar")) return;
		if (!googleAutoSyncWanted(current, tag, googleSyncAttemptedEtag)) return;
		googleSyncAttemptedEtag = tag;
		void googleQueue.queue("sync").then((result) => {
			if (disposed) return;
			if (result.kind === "failed") {
				setNotice({
					tone: "error",
					text: `The Google Calendar sync was not queued: ${result.error.message}`,
				});
				return;
			}
			if (result.kind === "queued") {
				watchlistPoller.start();
				void loadWatchlist();
			}
		});
	};

	/** The calendar widget's "Try again": clears the error and reloads. */
	const retryWatchlist = () => {
		setWatchlistError(null);
		maybeLoadWatchlist();
	};

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
				announceMove(moved.title, position + 1, saved.value.dashboard.widgets.length);
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
	 * Drag and drop repositioning (HIG Drag and drop): the pointer/DOM engine
	 * lives in `widgetDrag.ts` (`createWidgetDrag` owns the state, the
	 * listeners, the CSSOM writes and the cleanup). This view keeps only the
	 * wiring: a drag may start when no save is in flight and the view is not
	 * busy, a drop saves exactly one `reorder` edit, and the previewed order
	 * stays on screen (CSS `order`, real DOM order changes only on commit)
	 * until the server copy renders.
	 */
	const onWidgetDrop = (drop: WidgetDragDrop): void => {
		savingPreview = true;
		void saveEdit({ kind: "reorder", widgetId: drop.widgetId, toIndex: drop.toIndex })
			.catch(() => undefined)
			.finally(() => {
				savingPreview = false;
				dragController.clearPreview();
			});
	};
	const dragController = createWidgetDrag({
		getGrid: () => gridEl,
		getWidgets: () => widgets(),
		canStart: () => !savingPreview && !busy() && dashboard.value() !== null,
		onDrop: onWidgetDrop,
	});

	onCleanup(() => {
		dragController.dispose();
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
								onPointerDown={(event) => dragController.onPointerDown(event)}
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
												watchlist={watchlist}
												watchlistError={watchlistError}
												onRetryWatchlist={retryWatchlist}
												onRefreshEarnings={refreshEarnings}
												earningsRefreshBusy={earningsRefreshBusy}
												api={props.api}
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
