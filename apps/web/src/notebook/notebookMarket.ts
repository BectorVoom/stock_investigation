import { isMarketWidget, type NotebookWidget } from "@research/contracts";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ok } from "../api/http.ts";
import {
	HOME_AUTO_REFRESH_STALE_MS,
	MARKET_RECHECK_INTERVAL_MS,
	marketRefreshStamps,
	notebookAutoRefreshScope,
	seriesById,
} from "../home/homeModel.ts";
import {
	createEtagLoader,
	createMarketRefreshQueue,
	type MarketPollSignal,
} from "../home/marketData.ts";
import {
	createPoller,
	createVisibleTicker,
	documentVisibility,
	type VisibilitySource,
} from "../lib/polling.ts";
import { type AskedStamps, pruneAsked, recheckDecision, recordAsked } from "../lib/refreshScope.ts";
import { createEarningsRefreshQueue } from "../watchlist/earningsRefreshQueue.ts";
import type { WidgetMarketContext } from "../widgets/marketContext.ts";
import { hasListWidget, readsWatchlist, webPageSeriesIds } from "../widgets/pageSeries.ts";

/**
 * Live market data for one conversation's notebook (ADR-0021), through the
 * same Home widget components the Notebook renders (`WidgetBody`). Loads
 * `getNotebookMarketData` only while the notebook holds market widgets and
 * reloads only when the set of page series changes (the sorted id list,
 * not on every edit): the series the widgets name and, after them, the
 * stocks of the Watchlist prices widgets' lists (`pageSeriesIds`, ADR-0040
 * §4). Polls while a refresh is active the way Home does; loads the
 * watchlist only while an earnings-calendar or Watchlist prices widget
 * exists, with the calendar's refresh and "Try again" like Home.
 *
 * After every load, with no refresh active, the Notebook takes Home's
 * staleness decision (ADR-0044 §4, `notebookAutoRefreshScope`): a page
 * series never refreshed — such as one the assistant just added — or
 * refreshed more than 30 minutes ago queues one market refresh, at most
 * once per stale or missing stamp (`recheckDecision`). While the Notebook
 * stays open and shown (`visibility` is the tab's and the panel's own:
 * below `lg` a Chat-first conversation hides the panel) it re-reads the
 * data (conditionally) every 5 minutes and whenever it is shown again, and
 * decides again, so it never sits on day-old prices. Must be created under a Solid owner (the Notebook
 * panel body); polling and the re-check stop on disposal.
 */
export function createNotebookMarketContext(options: {
	readonly api: ApiClient;
	/** Null until the notebook session's first load names its workspace. */
	readonly workspaceId: () => string | null;
	readonly widgets: () => readonly NotebookWidget[];
	readonly visibility?: VisibilitySource;
}): WidgetMarketContext {
	const visibility = options.visibility ?? documentVisibility(document);
	let disposed = false;

	const dataLoader = createEtagLoader({
		load: (etag) => {
			const workspaceId = options.workspaceId();
			if (workspaceId === null) return Promise.resolve(ok({ changed: false as const }));
			return options.api.getNotebookMarketData(workspaceId, etag);
		},
		refreshOf: (value) => value.refresh,
		isDisposed: () => disposed,
	});
	const watchLoader = createEtagLoader({
		load: (etag) => options.api.getWatchlist(etag),
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

	/** The series the notebook is served, in page order (ADR-0040 §4). */
	const pageSeriesList = createMemo(() => webPageSeriesIds(options.widgets(), watchLoader.value()));
	const pageSeries = createMemo((): ReadonlySet<string> => new Set(pageSeriesList()));
	/** The page series sorted, for comparison: a reorder loads nothing. */
	const seriesKey = createMemo(() => [...pageSeriesList()].sort().join(","));
	const hasMarket = createMemo(() => options.widgets().some((widget) => isMarketWidget(widget)));
	const needsWatchlist = createMemo(() => options.widgets().some(readsWatchlist));
	/**
	 * A Watchlist prices widget's series need the watchlist: until it has
	 * loaded (or failed) the market read waits, so the first read and the one
	 * automatic refresh already cover the lists.
	 */
	const listSeriesPending = createMemo(
		() =>
			hasListWidget(options.widgets()) &&
			watchLoader.value() === null &&
			watchLoader.error() === null,
	);
	const byId = createMemo(() => seriesById(dataLoader.value()?.series ?? []));

	const marketQueue = createMarketRefreshQueue(options.api);
	const earningsQueue = createEarningsRefreshQueue(options.api);
	const [earningsQueueBusy, setEarningsQueueBusy] = createSignal(false);
	/** The stale or missing stamps queued automatic refreshes asked for, with when (`recheckDecision`). */
	const askedStamps: AskedStamps = new Map();
	/** When the last staleness-driven automatic refresh was queued: the next waits 30 minutes. */
	let lastStaleQueueAt: number | null = null;

	const loadMarket = async (): Promise<MarketPollSignal> => {
		if (options.workspaceId() === null || !hasMarket() || listSeriesPending()) return "unchanged";
		const outcome = await dataLoader.load();
		if (disposed) return "unchanged";
		if (outcome.signal !== "failed") maybeQueueRefresh();
		return outcome.signal;
	};

	/**
	 * The automatic refresh: Home's staleness rule over the page series'
	 * stamps (materials left out, `marketRefreshStamps`). Never while a
	 * refresh is active or the panel is not shown (a hidden Notebook asks
	 * when it is shown again, through the re-check), and at most once per
	 * stale or missing stamp — so the re-checks, a title edit, a reload of
	 * unchanged data, or a series the refresh never stamps queue nothing
	 * more, while a new series or a stamp gone stale since opens the
	 * decision again. The stamps count as asked only once the refresh was
	 * queued (a failed request is tried again at the next check), and only
	 * for 30 minutes: a job that failed as a whole may be asked for once
	 * more after that, never in a loop. Staleness-driven refreshes are also
	 * spaced 30 minutes apart (a run that outlasts the limit writes stamps
	 * already stale); a never-refreshed series still asks at once.
	 */
	const maybeQueueRefresh = (): void => {
		if (seriesKey() === "" || !visibility.isVisible()) return;
		const current = dataLoader.value();
		if (current === null) return;
		const stamps = marketRefreshStamps(pageSeriesList(), byId());
		const nowMs = Date.now();
		const decision = recheckDecision({
			scope: notebookAutoRefreshScope(
				stamps.map((stamp) => stamp.lastRefreshedAt),
				nowMs,
			),
			stamps,
			staleAfterMs: HOME_AUTO_REFRESH_STALE_MS,
			nowMs,
			refreshActive: current.refresh.activeRunId !== null,
			asked: askedStamps,
			lastStaleQueueAt,
		});
		pruneAsked(askedStamps, stamps);
		if (decision === null) return;
		void marketQueue.queue(decision.scope).then((result) => {
			if (disposed) return;
			if (result.kind !== "queued") return;
			const queuedAt = Date.now();
			recordAsked(askedStamps, decision.keys, queuedAt);
			if (decision.stale) lastStaleQueueAt = queuedAt;
			dataPoller.start();
			void loadMarket();
		});
	};

	const dataPoller = createPoller({
		poll: async () => {
			const signal = await loadMarket();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") dataPoller.stop();
			return signal;
		},
		visibility,
	});

	const loadWatchlist = async (): Promise<MarketPollSignal> => {
		if (!needsWatchlist()) return "unchanged";
		const outcome = await watchLoader.load();
		if (disposed) return "unchanged";
		return outcome.signal;
	};

	const watchlistPoller = createPoller({
		poll: async () => {
			const signal = await loadWatchlist();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") watchlistPoller.stop();
			return signal;
		},
		visibility,
	});

	onCleanup(() => {
		disposed = true;
		dataPoller.stop();
		watchlistPoller.stop();
	});

	// Market data follows the series set, not every edit: a title or size
	// change keeps the same key and loads nothing.
	let loadedKey: string | null = null;
	createEffect(() => {
		const key = seriesKey();
		if (!hasMarket() || options.workspaceId() === null) {
			dataPoller.stop();
			return;
		}
		if (listSeriesPending()) return;
		if (key === loadedKey) return;
		loadedKey = key;
		void loadMarket().then((signal) => {
			if (!disposed && (signal === "active" || signal === "queued")) dataPoller.start();
		});
	});

	/**
	 * The re-check while open: a conditional re-read (a 304 when nothing
	 * moved) followed by the decision above. Skipped while a refresh is
	 * active — the data poller already follows that run.
	 */
	const recheck = createVisibleTicker({
		visibility,
		intervalMs: MARKET_RECHECK_INTERVAL_MS,
		tick: () => {
			// Nothing loaded yet: the effect above takes the first read.
			if (disposed || loadedKey === null) return;
			if ((dataLoader.value()?.refresh.activeRunId ?? null) !== null) return;
			void loadMarket().then((signal) => {
				if (!disposed && (signal === "active" || signal === "queued")) dataPoller.start();
			});
		},
	});
	recheck.start();
	onCleanup(() => recheck.stop());

	// The watchlist loads once a calendar or Watchlist prices widget needs it
	// (or again after "Try again" clears the error); an active earnings run
	// keeps polling.
	createEffect(() => {
		if (!needsWatchlist()) {
			watchlistPoller.stop();
			return;
		}
		if (watchLoader.value() !== null || watchLoader.error() !== null) return;
		void loadWatchlist().then((signal) => {
			if (!disposed && (signal === "active" || signal === "queued")) watchlistPoller.start();
		});
	});

	const onRetryWatchlist = (): void => {
		watchLoader.clearError();
		void loadWatchlist().then((signal) => {
			if (!disposed && (signal === "active" || signal === "queued")) watchlistPoller.start();
		});
	};

	/** The calendar widget's refresh button: one manual queue through the shared queue. */
	const onRefreshEarnings = (): void => {
		if (earningsQueue.busy() || earningsQueueBusy()) return;
		setEarningsQueueBusy(true);
		void earningsQueue.queue("all").then((result) => {
			if (disposed) return;
			setEarningsQueueBusy(false);
			if (result.kind !== "queued") return;
			watchlistPoller.start();
			void loadWatchlist();
		});
	};

	return {
		seriesById: byId,
		pageSeries,
		watchlist: watchLoader.value,
		watchlistError: watchLoader.error,
		onRetryWatchlist,
		onRefreshEarnings,
		earningsRefreshBusy: () => earningsQueueBusy() || earningsQueue.busy(),
		api: options.api,
	};
}
