import { isMarketWidget, type NotebookWidget } from "@research/contracts";
import { createEffect, createMemo, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ok } from "../api/http.ts";
import { awaitsFirstSync, seriesById } from "../home/homeModel.ts";
import { createEtagLoader, type MarketPollSignal } from "../home/marketData.ts";
import {
	createIdleReread,
	createPoller,
	documentVisibility,
	type VisibilitySource,
} from "../lib/polling.ts";
import { hasNeverRefreshedStock } from "../watchlist/watchlistModel.ts";
import type { WidgetMarketContext } from "../widgets/marketContext.ts";
import { hasListWidget, readsWatchlist, webPageSeriesIds } from "../widgets/pageSeries.ts";

/**
 * Live market data for one conversation's notebook (ADR-0021), through the
 * same Home widget components the Notebook renders (`WidgetBody`). Loads
 * `getNotebookMarketData` only while the notebook holds market widgets and
 * reloads only when the set of page series changes (the sorted id list,
 * not on every edit): the series the widgets name and, after them, the
 * stocks of the Watchlist prices widgets' lists (`pageSeriesIds`, ADR-0040
 * §4). Polls while a sync is active the way Home does; loads the
 * watchlist only while an earnings-calendar or Watchlist prices widget
 * exists, with the calendar's "Try again" like Home.
 *
 * The Notebook only reads: the server syncs every tracked series on its
 * own schedule, and fetches a series never refreshed — such as one the
 * assistant just added — at the runner's next claim. While the Notebook
 * stays open and shown (`visibility` is the tab's and the panel's own:
 * below `lg` a Chat-first conversation hides the panel) it re-reads its
 * data and watchlist (conditionally) every minute, sooner while a series
 * or stock shown has no data yet, and whenever it is shown again
 * (`createIdleReread`, Home's helper). Must be created under a Solid owner
 * (the Notebook panel body); polling and the re-reads stop on disposal.
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
	 * loaded (or failed) the market read waits, so the first read already
	 * covers the lists.
	 */
	const listSeriesPending = createMemo(
		() =>
			hasListWidget(options.widgets()) &&
			watchLoader.value() === null &&
			watchLoader.error() === null,
	);
	const byId = createMemo(() => seriesById(dataLoader.value()?.series ?? []));

	const loadMarket = async (): Promise<MarketPollSignal> => {
		if (options.workspaceId() === null || !hasMarket() || listSeriesPending()) return "unchanged";
		const outcome = await dataLoader.load();
		if (disposed) return "unchanged";
		return outcome.signal;
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

	/** The series set the market data was last read for (null: not read yet). */
	let loadedKey: string | null = null;

	/** Reads the market data and follows a sync it shows. */
	const readMarket = async (): Promise<void> => {
		const signal = await loadMarket();
		if (!disposed && (signal === "active" || signal === "queued")) dataPoller.start();
	};
	/** Reads the watchlist and follows a run it shows. */
	const readWatchlist = async (): Promise<void> => {
		const signal = await loadWatchlist();
		if (!disposed && (signal === "active" || signal === "queued")) watchlistPoller.start();
	};

	/**
	 * The idle re-read while the Notebook is shown: what has loaded is read
	 * again unless its poller already follows a run. Nothing loaded yet: the
	 * effects take the first reads.
	 */
	const idleReread = createIdleReread({
		visibility,
		busy: () => disposed || (loadedKey === null && watchLoader.value() === null),
		awaiting: () => {
			if (loadedKey !== null && awaitsFirstSync(pageSeriesList(), byId())) return true;
			const list = watchLoader.value();
			return (
				list !== null &&
				options.widgets().some((widget) => widget.type === "earnings-calendar") &&
				hasNeverRefreshedStock(list)
			);
		},
		reread: async () => {
			const reads: Promise<void>[] = [];
			if (loadedKey !== null && hasMarket() && dataLoader.value()?.refresh.activeRunId === null) {
				reads.push(readMarket());
			}
			const list = watchLoader.value();
			if (
				list !== null &&
				needsWatchlist() &&
				list.refresh.activeRunId === null &&
				list.googleCalendar.activeRunId === null
			) {
				reads.push(readWatchlist());
			}
			await Promise.all(reads);
		},
	});
	idleReread.start();
	onCleanup(() => idleReread.stop());

	// Market data follows the series set, not every edit: a title or size
	// change keeps the same key and loads nothing.
	createEffect(() => {
		const key = seriesKey();
		if (!hasMarket() || options.workspaceId() === null) {
			dataPoller.stop();
			return;
		}
		if (listSeriesPending()) return;
		if (key === loadedKey) return;
		loadedKey = key;
		// A changed series set (the assistant or the owner added one) is
		// looked for again soon: the server fetches it at the next claim.
		void readMarket().then(() => {
			if (!disposed) idleReread.soon();
		});
	});

	// The watchlist loads once a calendar or Watchlist prices widget needs it
	// (or again after "Try again" clears the error); an active earnings run
	// keeps polling.
	createEffect(() => {
		if (!needsWatchlist()) {
			watchlistPoller.stop();
			return;
		}
		if (watchLoader.value() !== null || watchLoader.error() !== null) return;
		// Dates never fetched are looked for again soon, not in a minute.
		void readWatchlist().then(() => {
			if (!disposed) idleReread.soon();
		});
	});

	const onRetryWatchlist = (): void => {
		watchLoader.clearError();
		void readWatchlist();
	};

	return {
		seriesById: byId,
		pageSeries,
		watchlist: watchLoader.value,
		watchlistError: watchLoader.error,
		onRetryWatchlist,
		api: options.api,
	};
}
