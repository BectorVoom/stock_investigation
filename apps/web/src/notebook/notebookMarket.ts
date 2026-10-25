import { distinctWidgetSeriesIds, isMarketWidget, type NotebookWidget } from "@research/contracts";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ok } from "../api/http.ts";
import { notebookFirstRefreshScope, seriesById } from "../home/homeModel.ts";
import {
	createEtagLoader,
	createMarketRefreshQueue,
	type MarketPollSignal,
} from "../home/marketData.ts";
import { createPoller, documentVisibility, type VisibilitySource } from "../lib/polling.ts";
import { createEarningsRefreshQueue } from "../watchlist/earningsRefreshQueue.ts";
import type { WidgetMarketContext } from "../widgets/marketContext.ts";

/**
 * Live market data for one conversation's notebook (ADR-0021), through the
 * same Home widget components the Notebook renders (`WidgetBody`). Loads
 * `getNotebookMarketData` only while the notebook holds market widgets and
 * reloads only when the set of named series changes (the sorted id list,
 * not on every edit); polls while a refresh is active the way Home does;
 * loads the watchlist only while an earnings-calendar widget exists, with
 * the calendar's refresh and "Try again" like Home.
 *
 * When a loaded series is `NEVER_REFRESHED` and no refresh is active, one
 * market refresh is queued per page visit per series set, so a widget the
 * assistant just added fills in by itself. Must be created under a Solid
 * owner (the Notebook panel body); polling stops on disposal.
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

	/** Distinct series the notebook's market widgets name, sorted for comparison. */
	const seriesKey = createMemo(() =>
		[...distinctWidgetSeriesIds(options.widgets())].sort().join(","),
	);
	const hasMarket = createMemo(() => options.widgets().some((widget) => isMarketWidget(widget)));
	const hasCalendar = createMemo(() =>
		options.widgets().some((widget) => widget.type === "earnings-calendar"),
	);
	const byId = createMemo(() => seriesById(dataLoader.value()?.series ?? []));

	const marketQueue = createMarketRefreshQueue(options.api);
	const earningsQueue = createEarningsRefreshQueue(options.api);
	const [earningsQueueBusy, setEarningsQueueBusy] = createSignal(false);
	/** Series sets already given their one automatic refresh this visit. */
	const refreshedKeys = new Set<string>();

	const loadMarket = async (): Promise<MarketPollSignal> => {
		if (options.workspaceId() === null || !hasMarket()) return "unchanged";
		const outcome = await dataLoader.load();
		if (disposed) return "unchanged";
		if (outcome.signal !== "failed") maybeQueueFirstRefresh();
		return outcome.signal;
	};

	/**
	 * One automatic refresh per series set per visit: a series the providers
	 * never refreshed (or one the data does not name yet) fills in by
	 * itself once its widget exists. Never while a refresh is already
	 * active, and never twice for the same set.
	 */
	const maybeQueueFirstRefresh = (): void => {
		const key = seriesKey();
		if (key === "") return;
		const current = dataLoader.value();
		if (current === null || current.refresh.activeRunId !== null) return;
		const ids = distinctWidgetSeriesIds(options.widgets());
		const needs = ids.some((id) => {
			const series = byId().get(id);
			return series === undefined || series.unavailable?.code === "NEVER_REFRESHED";
		});
		if (!needs || refreshedKeys.has(key)) return;
		refreshedKeys.add(key);
		// ADR-0039: only the series without data are fetched, unless a
		// series shown here is stale (then everything, in one job).
		const stamps = ids.map((id) => byId().get(id)?.lastRefreshedAt ?? null);
		const scope = notebookFirstRefreshScope(stamps, Date.now());
		void marketQueue.queue(scope).then((result) => {
			if (disposed) return;
			if (result.kind !== "queued") return;
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
		if (!hasCalendar()) return "unchanged";
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
		if (key === loadedKey) return;
		loadedKey = key;
		void loadMarket().then((signal) => {
			if (!disposed && (signal === "active" || signal === "queued")) dataPoller.start();
		});
	});

	// The watchlist loads once a calendar widget needs it (or again after
	// "Try again" clears the error); an active earnings run keeps polling.
	createEffect(() => {
		if (!hasCalendar()) {
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
		watchlist: watchLoader.value,
		watchlistError: watchLoader.error,
		onRetryWatchlist,
		onRefreshEarnings,
		earningsRefreshBusy: () => earningsQueueBusy() || earningsQueue.busy(),
		api: options.api,
	};
}
