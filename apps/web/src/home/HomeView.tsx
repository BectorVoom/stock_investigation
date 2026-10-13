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
import { BUTTON, BUTTON_PRIMARY, Empty, ErrorNotice, Notice, PANEL } from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createPoller, type VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import { hasFredSeries, needsAutoRefresh, seriesById, widgetSeriesIds } from "./homeModel.ts";
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
	let disposed = false;
	let autoRefreshTried = false;
	let followUpTried = false;
	let refreshKey: string | null = null;
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
				<For each={[0, 1, 2]}>{() => <sl-skeleton effect="sheen" class="block h-24" />}</For>
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

			<section aria-label="Market widgets toolbar" class={PANEL}>
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						class={BUTTON_PRIMARY}
						disabled={busy() || dashboard.value() === null}
						onClick={(event) => openDialog({ mode: "add" }, event)}
					>
						Add widget
					</button>
					<button
						type="button"
						class={BUTTON}
						disabled={busy() || data()?.refresh.activeRunId !== null}
						onClick={() => void queueRefresh()}
					>
						Refresh market data
					</button>
					<button
						type="button"
						class={BUTTON}
						disabled={busy() || dashboard.value() === null}
						onClick={(event) => openDialog({ mode: "confirm-reset" }, event)}
					>
						Reset to default arrangement
					</button>
				</div>
				<Show when={statusLine()}>
					{(line) => (
						<output class="mt-2 block text-xs text-slate-700" data-field="home-status">
							{line()}
						</output>
					)}
				</Show>
			</section>

			{/* V2: the dashboard GET has its own error state (stable code, Try
			    again) instead of an endless skeleton; when the stored document
			    no longer parses, Reset replaces it (no expectedVersion needed). */}
			<Switch>
				<Match when={dashboard.value() === null && dashboardError() === null}>
					<section class="space-y-2" aria-label="Loading home">
						<output class="block text-sm text-slate-600">Loading market widgets…</output>
						<For each={[0, 1, 2, 3]}>{() => <sl-skeleton effect="sheen" class="block h-24" />}</For>
					</section>
				</Match>
				<Match when={dashboard.value() === null && dashboardError() !== null}>
					<section class="space-y-2" aria-label="Dashboard error">
						<Show when={dashboardError()}>
							{(error) => (
								<ErrorNotice
									failure={error()}
									title="Could not load the dashboard."
									onRetry={() => {
										void dashboard.reload();
									}}
								/>
							)}
						</Show>
						<div>
							<button
								type="button"
								class={BUTTON}
								disabled={busy()}
								onClick={() => void resetToDefaults()}
							>
								Reset to default arrangement
							</button>
						</div>
					</section>
				</Match>
				<Match when={dashboard.value() !== null}>
					<Show when={data() !== null && !dataLoading()} fallback={<DataPending />}>
						<Show
							when={(dashboard.value()?.dashboard.widgets.length ?? 0) > 0}
							fallback={
								<Empty>No widgets yet. Choose “Add widget” to track prices and indicators.</Empty>
							}
						>
							<div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
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
