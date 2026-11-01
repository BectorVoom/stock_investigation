import {
	asHomeWidget,
	DEFAULT_HOME_DASHBOARD,
	HOME_WIDGET_TYPES,
	type HomeDashboard,
	type HomeWidget,
	homeCapacityProblem,
	homeDashboardSchema,
	MARKET_LIMITS,
	widgetSeriesIds,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
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
import type { ApiClient } from "../api/client.ts";
import { failureMessageIn } from "../api/errorText.ts";
import type { ApiFailure } from "../api/http.ts";
import { Empty, ErrorNotice, IconButton, Notice } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { withUpstreamStatus } from "../i18n/upstreamStatus.ts";
import { formatInstant } from "../lib/format.ts";
import { createIdleReread, createPoller, type VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import {
	hasNeverRefreshedStock,
	isGoogleCalendarRunActive,
	isWatchlistRefreshActive,
} from "../watchlist/watchlistModel.ts";
import type { WidgetMarketContext } from "../widgets/marketContext.ts";
import { readsWatchlist, webPageSeriesIds } from "../widgets/pageSeries.ts";
import { WidgetBody } from "../widgets/WidgetBody.tsx";
import { createWidgetBoard, type WidgetBoardSession } from "../widgets/widgetBoard.tsx";
import { HOME_CLIPBOARD_SCOPE, widgetClipboard } from "../widgets/widgetClipboard.ts";
import { homeMessages } from "./home.messages.ts";
import { awaitsFirstSync, hasFredSeries, seriesById } from "./homeModel.ts";
import { createEtagLoader, type MarketPollSignal } from "./marketData.ts";
import "./shoelace.ts";
import { WIDGET_GRID_CLASS, WidgetFrame, WidgetGrid } from "@research/widget-grid";
import { ResetDialog } from "./ResetDialog.tsx";
import { ensureHomeIconLibraries } from "./shoelace.ts";
import "@research/widget-grid/styles.css";

interface HomeNotice {
	readonly tone: "info" | "warning" | "success" | "error";
	readonly text: string;
}

/** What one data poll observed; queued/active keep polling, the rest settle. */
type HomePollSignal = MarketPollSignal;

/**
 * FRED's terms of use require this attribution in this exact wording, so it
 * is shown as it is in every UI language.
 */
const FRED_NOTICE =
	// i18n-exempt: the attribution FRED's terms of use require, in their exact wording
	"This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";

/** Undo depth of Home's in-session history (the Notebook keeps as many on the server). */
const HOME_UNDO_DEPTH = 20;

/**
 * Home: widgets the owner arranges (FR-017), with every widget type and
 * action of the one widget specification (ADR-0024). Loads the dashboard and
 * the data in parallel and only reads: the server syncs the market data and
 * earnings dates on its own schedule. While the page stays open and visible
 * it re-reads the data conditionally every minute (sooner while a series
 * shown has no data yet) and on every return to the page, and polls fast
 * while a sync is queued or running. The server copy is canonical: every edit is saved with
 * `PUT` (version CAS) and re-rendered from what the server accepted; Undo
 * restores the bodies kept in this page visit.
 */
export function HomeView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	ensureHomeIconLibraries();
	const m = useMessages(homeMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	const dashboard = createRemote(() => props.api.getHomeDashboard());
	/**
	 * Market data and the watchlist through the shared ETag loader
	 * (`home/marketData.ts`, also used by the Notebook): the signals below
	 * keep their names so the view reads unchanged; only the mechanics moved.
	 */
	let disposed = false;
	const dataLoader = createEtagLoader({
		load: (etag) => props.api.getHomeData(etag),
		refreshOf: (value) => value.refresh,
		isDisposed: () => disposed,
	});
	const data = dataLoader.value;
	const dataError = dataLoader.error;
	const dataLoading = dataLoader.loading;
	/**
	 * The watchlist for the earnings-calendar and Watchlist prices widgets,
	 * loaded only when the dashboard holds one (an effect below starts the
	 * load). Like the series, it arrives through an accessor so the widgets
	 * stay reactive across reloads.
	 */
	const watchLoader = createEtagLoader({
		load: (etag) => props.api.getWatchlist(etag),
		refreshOf: (value) =>
			value.refresh.activeRunId !== null
				? value.refresh
				: value.googleCalendar.activeRunId !== null
					? {
							activeRunId: value.googleCalendar.activeRunId,
							activeRunState: value.googleCalendar.activeRunState,
						}
					: { activeRunId: null, activeRunState: null },
		isDisposed: () => disposed,
	});
	const watchlist = watchLoader.value;
	const watchlistError = watchLoader.error;
	const [notice, setNotice] = createSignal<HomeNotice | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [resetOpen, setResetOpen] = createSignal(false);
	const [resetOpener, setResetOpener] = createSignal<HTMLElement | null>(null);
	const [selection, setSelection] = createSignal<readonly string[]>([]);
	/** Earlier widget lists of this page visit, newest last (Undo). */
	const [history, setHistory] = createSignal<readonly (readonly HomeWidget[])[]>([]);
	onCleanup(() => {
		disposed = true;
		poller.stop();
		watchlistPoller.stop();
		idleReread.stop();
	});

	/**
	 * One conditional read of `/home/data`. A failed read with numbers on
	 * screen warns that they may be out of date; the next read that answers
	 * takes that warning down again.
	 */
	const loadData = async (): Promise<HomePollSignal> => {
		const outcome = await dataLoader.load();
		if (disposed) return "unchanged";
		if (outcome.signal === "failed" && outcome.stale) {
			setNotice({ tone: "warning", text: m().dataNotRefreshed });
		} else if (outcome.signal !== "failed" && notice()?.text === m().dataNotRefreshed) {
			setNotice(null);
		}
		return outcome.signal;
	};

	/** Follows a sync the server runs: polls fast until the data says it ended (V1). */
	const poller = createPoller({
		poll: async () => {
			const signal = await loadData();
			if (disposed) return "unchanged";
			// V1: stop only when the run is known to have ended. A failed
			// poll backs off (the poller's failed cadence) and continues —
			// one 500 must never wedge the status on "Refreshing…" forever.
			if (signal === "changed" || signal === "unchanged") poller.stop();
			return signal;
		},
		visibility: props.visibility,
	});

	/** Reads the data and starts the poller when a sync is queued or running. */
	const readData = async (): Promise<void> => {
		const signal = await loadData();
		if (!disposed && (signal === "active" || signal === "queued")) poller.start();
	};

	/** Conditional watchlist re-read; the poller below runs it while a run is active. */
	const loadWatchlist = async (): Promise<
		"active" | "queued" | "changed" | "unchanged" | "failed"
	> => {
		// A Google Calendar step keeps the poll alive too (its URL and counts
		// arrive through this poll); only a run-free change settles it. The
		// shared loader answers the combined refresh signal for both runs.
		const outcome = await watchLoader.load();
		if (disposed) return "unchanged";
		return outcome.signal;
	};

	const watchlistPoller = createPoller({
		poll: async () => {
			const signal = await loadWatchlist();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") {
				watchlistPoller.stop();
			}
			return signal;
		},
		visibility: props.visibility,
	});

	/** A poll-worthy watchlist run: an earnings sync or a Google Calendar step. */
	const isWatchlistPollActive = (): boolean => {
		const current = watchlist();
		return (
			current !== null && (isWatchlistRefreshActive(current) || isGoogleCalendarRunActive(current))
		);
	};

	/**
	 * Reads the watchlist and follows a run it shows. The page never queues
	 * one: the server syncs the earnings dates and the Google Calendar
	 * (ADR-0051, ADR-0054).
	 */
	const readWatchlist = async (): Promise<void> => {
		await loadWatchlist();
		if (disposed) return;
		if (isWatchlistPollActive()) watchlistPoller.start();
	};

	/** The first watchlist load while it runs: a second need waits for it instead of reading twice. */
	let watchlistFirstLoad: Promise<void> | null = null;
	/**
	 * Starts the watchlist load once the dashboard shows a widget that reads
	 * it (an earnings calendar or a Watchlist prices widget); resolves when
	 * that load has settled.
	 */
	const maybeLoadWatchlist = (): Promise<void> => {
		if (disposed || watchlist() !== null || watchlistError() !== null) return Promise.resolve();
		if (!widgets().some(readsWatchlist)) return Promise.resolve();
		if (watchlistFirstLoad !== null) return watchlistFirstLoad;
		watchlistFirstLoad = readWatchlist().then(() => {
			watchlistFirstLoad = null;
			// Dates never fetched are looked for again soon, not in a minute.
			if (!disposed) idleReread.soon();
		});
		return watchlistFirstLoad;
	};
	createEffect(() => {
		// Tracks the dashboard: a newly added calendar widget triggers the load.
		if (dashboard.value() !== null && watchlist() === null) void maybeLoadWatchlist();
	});

	/** The calendar widget's "Try again": clears the error and reloads. */
	const retryWatchlist = () => {
		watchLoader.clearError();
		void maybeLoadWatchlist();
	};

	/**
	 * True while the page shows something the server has not fetched yet: a
	 * page series the data does not name or never refreshed (a widget just
	 * added — the server queues it at the runner's next claim), or, with a
	 * calendar shown, a stock whose earnings dates were never fetched.
	 * Imported materials are left out: no sync ever stamps them.
	 */
	const awaitingSync = (): boolean => {
		if (data() !== null && awaitsFirstSync(pageSeriesList(), byId())) return true;
		const list = watchlist();
		return (
			list !== null &&
			widgets().some((widget) => widget.type === "earnings-calendar") &&
			hasNeverRefreshedStock(list)
		);
	};

	/**
	 * The server syncs on its own schedule; while the page stays open and
	 * visible it re-reads (conditionally — a 304 when nothing moved) every
	 * minute, sooner while something shown has not been fetched yet, and
	 * whenever it becomes visible again. A re-read that sees a sync starts
	 * the fast poller, which follows it to the end; a part whose run is
	 * already being followed is not re-read here.
	 */
	const idleReread = createIdleReread({
		visibility: props.visibility,
		busy: () => disposed || data() === null,
		awaiting: awaitingSync,
		reread: async () => {
			const reads: Promise<void>[] = [];
			if (data()?.refresh.activeRunId === null) reads.push(readData());
			if (watchlist() !== null && widgets().some(readsWatchlist) && !isWatchlistPollActive()) {
				reads.push(readWatchlist());
			}
			await Promise.all(reads);
		},
	});

	/** True while `reloadDataAfterSave` reads: the series-change re-read below waits for it. */
	let reloadingData = false;
	/**
	 * Reloads data after a save and starts the poller when a run is active
	 * (V4); a new series the server has yet to fetch is looked for again soon.
	 */
	const reloadDataAfterSave = async (): Promise<void> => {
		reloadingData = true;
		try {
			await readData();
		} finally {
			reloadingData = false;
		}
		if (!disposed) idleReread.soon();
	};

	onMount(() => {
		// V5: data() may still be null after a failed first load — a null is
		// never "active", so no poller starts on nothing.
		idleReread.start();
		// The first read decides the cadence: a series never fetched is
		// looked for again soon, not in a minute.
		void readData().then(() => {
			if (!disposed) idleReread.soon();
		});
	});

	const currentDashboard = (): { dashboard: HomeDashboard; version: number } | null => {
		const ready = dashboard.value();
		return ready === null ? null : { dashboard: ready.dashboard, version: ready.version };
	};

	/**
	 * An agent (or another tab) may have edited the dashboard elsewhere: when
	 * the page becomes visible again, re-read it quietly — no skeleton, no
	 * notice — and adopt a newer version with its market data, as after a
	 * save. Skipped while a save is in flight, a dialog is open or a drag is
	 * active; failures are silent here (the next deliberate action reports
	 * them as it does today). Never two re-reads at once.
	 */
	let rereadInFlight = false;
	const rereadDashboardIfStale = async (): Promise<void> => {
		if (disposed || rereadInFlight || busy() || dialogOpen()) return;
		if (document.querySelector("[data-widget-dragging]") !== null) return;
		const current = currentDashboard();
		if (current === null) return;
		rereadInFlight = true;
		try {
			const result = await props.api.getHomeDashboard();
			if (disposed || busy() || dialogOpen()) return;
			if (document.querySelector("[data-widget-dragging]") !== null) return;
			if (!result.ok) return;
			const latest = currentDashboard();
			if (latest === null) return;
			if (result.value.version <= latest.version) return;
			dashboard.set(result.value);
			await reloadDataAfterSave();
		} finally {
			rereadInFlight = false;
		}
	};
	const stopWatchingVisibility = props.visibility.subscribe(() => {
		if (props.visibility.isVisible()) void rereadDashboardIfStale();
	});
	onCleanup(() => stopWatchingVisibility());

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
	/** The series Home is served (ADR-0040 §4), as the API computes them. */
	const pageSeriesList = createMemo(() => webPageSeriesIds(widgets(), watchlist()));
	const pageSeries = createMemo((): ReadonlySet<string> => new Set(pageSeriesList()));

	/**
	 * The page's series changed after the data loaded — a list gained a stock
	 * (here or in another tab) and the watchlist re-read shows it — and the
	 * data does not name one of them: re-read `/home/data`, once per series
	 * set. Deferred a microtask, so a save's own reload starts first and this
	 * one is skipped.
	 */
	let seriesReloadKey: string | null = null;
	createEffect(() => {
		const ids = pageSeriesList();
		const current = data();
		if (current === null) return;
		const named = new Set(current.series.map((entry) => entry.seriesId));
		if (ids.every((id) => named.has(id))) return;
		const key = [...ids].sort().join(",");
		queueMicrotask(() => {
			if (disposed || reloadingData || busy() || key === seriesReloadKey) return;
			seriesReloadKey = key;
			void reloadDataAfterSave();
		});
	});

	/**
	 * Saves the next widget list with CAS and re-renders from the server
	 * copy; resolves true when saved. Every board edit (add, paste, edit,
	 * size, duplicate, move, drag, cut, remove) and Reset come through here;
	 * `undo` saves a kept body back without recording it again.
	 */
	const saveWidgets = async (
		next: readonly HomeWidget[],
		kind: "edit" | "undo" = "edit",
	): Promise<boolean> => {
		const current = currentDashboard();
		if (current === null) return false;
		// V8: a change attempted while a save is in flight says why; the
		// menus and toolbar are disabled while busy, so this is the in-place
		// editor and dialog path.
		if (busy()) {
			setNotice({
				tone: "warning",
				text: m().saveInFlight,
			});
			return false;
		}
		const capacity = homeCapacityProblem(next);
		if (capacity !== null) {
			setNotice({ tone: "error", text: capacity.message });
			return false;
		}
		const parsed = homeDashboardSchema.safeParse({ schemaVersion: 2, widgets: [...next] });
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			setNotice({
				tone: "error",
				text: m().changeRejected(issue === undefined ? m().dashboardInvalid : issue.message),
			});
			return false;
		}
		setBusy(true);
		const saved = await props.api.saveHomeDashboard(parsed.data, current.version);
		if (disposed) return false;
		setBusy(false);
		if (!saved.ok) {
			if (saved.error.code === "VERSION_CONFLICT") {
				await dashboard.reload();
				if (disposed) return false;
				// The kept bodies were made against a version that is gone.
				setHistory([]);
				// V4: the conflict reload may carry new series — refresh data too.
				await loadData();
				if (disposed) return false;
				setNotice({
					tone: "warning",
					text: m().changedElsewhere,
				});
			} else {
				setNotice({ tone: "error", text: m().notSaved(failureMessageIn(saved.error, locale())) });
			}
			return false;
		}
		if (kind === "undo") setHistory((kept) => kept.slice(0, -1));
		else setHistory((kept) => [...kept, current.dashboard.widgets].slice(-HOME_UNDO_DEPTH));
		dashboard.set(saved.value);
		const live = new Set(saved.value.dashboard.widgets.map((widget) => widget.widgetId));
		setSelection((selected) => selected.filter((id) => live.has(id)));
		// V4: data is reloaded after every successful save, so widgets never
		// show "unavailable … source not stated" for observations the server
		// already holds.
		await reloadDataAfterSave();
		return true;
	};

	/**
	 * Edits made while a save is in flight wait for it, then apply to the
	 * saved result (the Notebook session's rule, ADR-0024): a dialog save or
	 * an in-place text save during a move is applied after it, never lost.
	 */
	let saveChain: Promise<unknown> = Promise.resolve();
	const queueSave = (
		next: () => readonly HomeWidget[] | null,
		kind: "edit" | "undo" = "edit",
	): Promise<boolean> => {
		const run = saveChain.then(() => {
			const widgetsNext = next();
			return widgetsNext === null ? false : saveWidgets(widgetsNext, kind);
		});
		saveChain = run;
		return run;
	};

	/** Home as the shared board's session: the dashboard, saved with CAS. */
	const homeSession: WidgetBoardSession<HomeWidget> = {
		widgets: () => widgets(),
		pending: () => busy(),
		selection,
		select: (widgetId, mode) => {
			if (widgetId === null) {
				setSelection([]);
				return;
			}
			const order = widgets().map((widget) => widget.widgetId);
			if (mode === "replace") {
				setSelection(order.includes(widgetId) ? [widgetId] : []);
				return;
			}
			setSelection((current) => {
				const next = current.includes(widgetId)
					? current.filter((id) => id !== widgetId)
					: [...current, widgetId];
				return order.filter((id) => next.includes(id));
			});
		},
		edit: (change) => queueSave(() => change(widgets())),
		replaceWidget: (core) => {
			const next = asHomeWidget(core);
			if (next === null) return Promise.resolve(false);
			return queueSave(() =>
				widgets().map((widget) => (widget.widgetId === core.widgetId ? next : widget)),
			);
		},
		toWidget: (entry) => asHomeWidget(entry.core),
		undoAvailable: () => history().length > 0,
		undo: () => queueSave(() => history().at(-1) ?? null, "undo"),
	};

	/**
	 * Market data for the market widgets, as the shared `WidgetBody` reads
	 * it: Home's own loaders, passed as live accessors so a refresh updates
	 * the widgets in place instead of rebuilding them.
	 */
	const marketContext: WidgetMarketContext = {
		seriesById: () => byId(),
		pageSeries,
		watchlist,
		watchlistError,
		onRetryWatchlist: () => retryWatchlist(),
		api: props.api,
	};

	const board = createWidgetBoard<HomeWidget>({
		session: homeSession,
		types: HOME_WIDGET_TYPES,
		clipboard: widgetClipboard(),
		scope: () => HOME_CLIPBOARD_SCOPE,
		api: props.api,
		visibility: props.visibility,
		watchlist,
		seriesById: () => byId(),
		marketLimits: {
			scope: "dashboard",
			maxWidgets: MARKET_LIMITS.maxWidgets,
			maxSeries: MARKET_LIMITS.maxSeries,
		},
	});
	const dialogOpen = (): boolean => resetOpen() || board.dialogOpen();

	/** Reset replaces every widget with the default arrangement (Undo restores them). */
	const confirmReset = async (): Promise<void> => {
		const saved = await queueSave(() => DEFAULT_HOME_DASHBOARD.widgets);
		if (disposed) return;
		setResetOpen(false);
		if (saved) {
			setNotice({ tone: "success", text: m().resetDone });
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
				text: m().notReset(failureMessageIn(result.error, locale())),
			});
			return;
		}
		dashboard.set(result.value);
		setHistory([]);
		setResetOpen(false);
		setNotice({ tone: "success", text: m().resetDone });
		// V4: a reset changes the series set, so data is reloaded.
		await reloadDataAfterSave();
	};

	const statusLine = createMemo((): string | null => {
		const current = data();
		if (current === null) return null;
		if (current.refresh.activeRunId !== null) {
			const state = current.refresh.activeRunState ?? "queued";
			return m().refreshing(state, current.refresh.activeRunId);
		}
		// S2: the last SUCCESSFUL completion and the last failure are told
		// apart — a failed refresh never poses as "Last refresh: <time>".
		const parts: string[] = [];
		if (current.refresh.lastSucceededAt !== null) {
			parts.push(m().lastSucceeded(formatInstant(current.refresh.lastSucceededAt)));
		}
		if (current.refresh.lastFailure !== null) {
			parts.push(
				m().lastFailed(
					withUpstreamStatus(
						current.refresh.lastFailure.code,
						current.refresh.lastFailure.upstreamStatus,
						common(),
					),
					formatInstant(current.refresh.lastFailure.at),
				),
			);
		}
		if (parts.length > 0) return parts.join(" ");
		return m().noRefreshYet;
	});

	const fredShown = createMemo(() =>
		hasFredSeries(widgets().flatMap((widget) => [...widgetSeriesIds(widget)])),
	);
	const dashboardError = (): ApiFailure | null => {
		const state = dashboard.state();
		return state.status === "error" ? state.error : null;
	};

	/**
	 * V2: the data loading skeleton — and nothing else — while data loads.
	 * When the data GET failed, the error state above stands alone (no
	 * skeleton beside the error).
	 */
	const DataPending = (): JSX.Element => (
		<Show
			when={dataError() === null}
			fallback={<span class="sr-only">{m().dataFailedToLoad}</span>}
		>
			<section class="space-y-2" aria-label={m().loadingDataLabel}>
				<output class="block text-sm text-slate-600">{m().loadingData}</output>
				<div class={WIDGET_GRID_CLASS}>
					<For each={[0, 1, 2, 3]}>{() => <sl-skeleton effect="sheen" class="block h-full" />}</For>
				</div>
			</section>
		</Show>
	);

	return (
		<section
			aria-label={m().widgetsLabel}
			class="space-y-3"
			ref={(element) => board.attach(element)}
			onKeyDown={(event) => board.onSectionKeyDown(event)}
		>
			{/* V2: a failed data GET with no data is an error state, never a
			    loading skeleton beside the error. */}
			<Show when={data() === null}>
				<Show when={dataError()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().dataLoadFailed}
							iconRetry={true}
							onRetry={() => {
								dataLoader.beginReload();
								void reloadDataAfterSave();
							}}
						/>
					)}
				</Show>
			</Show>
			<Show when={notice()}>{(item) => <Notice tone={item().tone}>{item().text}</Notice>}</Show>

			<section aria-label={m().toolbarLabel} class="flex flex-wrap items-center gap-2">
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
					<Show when={dashboard.value() !== null}>
						<board.HeaderButtons paste={false} />
					</Show>
					<IconButton
						label={m().resetArrangement}
						icon="arrow-repeat"
						disabled={busy() || dashboard.value() === null}
						onClick={(event) => {
							setResetOpener(event.currentTarget);
							setResetOpen(true);
						}}
					/>
				</div>
			</section>

			<board.SelectionToolbar />
			<board.Announcements />

			{/* V2: the dashboard GET has its own error state (stable code, Try
			    again) instead of an endless skeleton; when the stored document
			    no longer parses, Reset replaces it (no expectedVersion needed). */}
			<Switch>
				<Match when={dashboard.value() === null && dashboardError() === null}>
					<section class="space-y-2" aria-label={m().loadingHomeLabel}>
						<output class="block text-sm text-slate-600">{m().loadingWidgets}</output>
						<div class={WIDGET_GRID_CLASS}>
							<For each={[0, 1, 2, 3]}>
								{() => <sl-skeleton effect="sheen" class="block h-full" />}
							</For>
						</div>
					</section>
				</Match>
				<Match when={dashboard.value() === null && dashboardError() !== null}>
					<section class="space-y-2" aria-label={m().dashboardErrorLabel}>
						<Show when={dashboardError()}>
							{(error) => (
								<ErrorNotice
									failure={error()}
									title={m().dashboardLoadFailed}
									iconRetry={true}
									onRetry={() => {
										void dashboard.reload();
									}}
								/>
							)}
						</Show>
						<div>
							<IconButton
								label={m().resetArrangement}
								icon="arrow-repeat"
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
							fallback={<Empty>{m().empty}</Empty>}
						>
							<WidgetGrid
								widgets={board.entries()}
								canDrag={!busy() && dashboard.value() !== null}
								ignoreDragFrom="sl-dialog,sl-select,sl-input,sl-option,dialog,input,select,textarea,[data-rich-text-editor]"
								onReorder={board.onDrop}
							>
								{(entry, index) => (
									<WidgetFrame
										widget={entry}
										titleHidden
										selected={board.isSelected(entry.widgetId)}
										onSelectChange={(id, mode) => board.select(id, mode)}
										actions={<board.ActionsMenu widget={entry.widget} index={index()} />}
									>
										{/*
										 * The live series reach the market widgets through the
										 * context's accessors: the For callback never reads the
										 * data, so a refresh updates the widgets in place instead
										 * of rebuilding every subtree.
										 */}
										<WidgetBody
											widget={entry.widget}
											view={null}
											api={props.api}
											visibility={props.visibility}
											market={marketContext}
											editingDisabled={busy()}
											onSaveText={board.saveText}
											onSaveMarketWidget={board.saveMarketWidget}
											onSaveWidget={board.saveWidget}
										/>
									</WidgetFrame>
								)}
							</WidgetGrid>
						</Show>
					</Show>
				</Match>
			</Switch>

			<Show when={fredShown()}>
				<p class="text-2xs text-slate-600">{FRED_NOTICE}</p>
			</Show>
			<p class="text-2xs text-slate-600">{m().changeExplainer}</p>

			<board.Dialogs />
			<ResetDialog
				open={resetOpen()}
				opener={resetOpener()}
				onConfirm={() => void confirmReset()}
				onClose={() => setResetOpen(false)}
			/>
		</section>
	);
}
