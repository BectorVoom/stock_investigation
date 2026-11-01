import type { WatchlistResponse, WatchlistStock, WatchMarket } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { failureMessageIn } from "../api/errorText.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	createIdleReread,
	createPoller,
	type PollSignal,
	type VisibilitySource,
} from "../lib/polling.ts";
import { createGoogleSyncQueue } from "../watchlist/googleSyncQueue.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import {
	googleAutoSyncWanted,
	hasNeverRefreshedStock,
	watchlistRefreshSignal,
} from "../watchlist/watchlistModel.ts";

/**
 * A notice above the page. One that names a queued run goes stale when the
 * run ends (the status line then tells the outcome), so it is marked to be
 * cleared then; the decision is recorded with the text instead of being read
 * back from the words, which differ per language.
 */
export interface PageNotice {
	readonly text: string;
	readonly clearsWhenRunEnds: boolean;
}

/** A failure above the page: what was being done, and the API's answer. */
export interface PageFailure {
	readonly title: string;
	readonly error: ApiFailure;
	/** Set for the first read's failure: Try again reads the watchlist again. */
	readonly retry?: () => void;
}

export interface WatchlistPageState {
	readonly data: Accessor<WatchlistResponse | null>;
	readonly loading: Accessor<boolean>;
	/** True while the page writes the watchlist (add or remove a stock). */
	readonly busy: Accessor<boolean>;
	readonly notice: Accessor<PageNotice | null>;
	readonly failure: Accessor<PageFailure | null>;
	readonly say: (text: string) => void;
	/** Clears the notice (the Stocks page, when another stock is shown). */
	readonly clearNotice: () => void;
	readonly report: (failure: PageFailure | null) => void;
	/** The first read, then the Google rule (Registered stocks) and the idle re-reads. */
	readonly start: () => void;
	/** Re-reads only: no poller, no automatic step (after a refused write that changed nothing). */
	readonly reload: () => Promise<void>;
	/** Re-reads after a write (also a list write), then the Google rule or the poller. */
	readonly reloadAfterWrite: () => Promise<void>;
	/**
	 * Adds one stock; resolves true when the watchlist took it. The caller
	 * then runs `afterStockWatched` (re-read, say its dates are on their way).
	 */
	readonly addStock: (market: WatchMarket, symbol: string) => Promise<boolean>;
	/** Removes one stock from the watchlist (after the page's confirmation); true when it left. */
	readonly removeStock: (stock: WatchlistStock) => Promise<boolean>;
	/**
	 * After a stock was put on the watchlist: re-read (unless the caller
	 * just did) and say `announce`. The server fetches the new stock's
	 * earnings dates at the runner's next claim; the page looks for them
	 * again soon.
	 */
	readonly afterStockWatched: (
		announce: string,
		options?: { readonly reloaded: boolean },
	) => Promise<void>;
}

/**
 * The Watchlist's half of the Registered stocks page (FR-018, ADR-0049 §2),
 * moved from the Watchlist page: the conditional watchlist read and its
 * poller while an earnings sync or a Google Calendar step runs, the idle
 * re-read while the page is visible (`createIdleReread`: every minute,
 * sooner while a stock's dates were never fetched, and on every return to
 * the page), and the automatic Google sync after the page's own changes.
 * The server fetches the earnings dates on its own schedule, so the page
 * never queues an earnings sync. With `automaticRuns: false` (the Stocks
 * page, ADR-0049 §3, ADR-0050 §2) `start` reads the watchlist and queues
 * nothing, and a run the page only watched never queues the Google sync:
 * it follows the owner's own watchlist change as on Registered stocks.
 * Must be created under the page's owner.
 */
export function createWatchlistPageState(options: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** Queue the automatic Google sync on start and after any run the page watched (default true). */
	readonly automaticRuns?: boolean;
}): WatchlistPageState {
	const api = options.api;
	const m = useMessages(watchlistMessages);
	const locale = useLocale();
	const [data, setData] = createSignal<WatchlistResponse | null>(null);
	const [etag, setEtag] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [failure, setFailure] = createSignal<PageFailure | null>(null);
	const [notice, setNotice] = createSignal<PageNotice | null>(null);
	const [busy, setBusy] = createSignal(false);
	const say = (text: string): void => {
		setNotice({ text, clearsWhenRunEnds: false });
	};
	let disposed = false;
	const googleQueue = createGoogleSyncQueue(api);
	/**
	 * True once the Google rule may follow a run's end: from the start on
	 * Registered stocks; on the Stocks page only after the owner's own
	 * watchlist change, so a sync the server ran never queues one there.
	 */
	let googleFollowsRuns = options.automaticRuns !== false;
	/** The watchlist ETag an automatic Google sync was already attempted for (at most one per ETag). */
	let googleSyncAttemptedEtag: string | null = null;

	/**
	 * A notice that names a queued run goes stale when the run ends — the
	 * status line then tells the outcome — so the poller clears it. Any other
	 * notice (added/removed, plain failures) is kept.
	 */
	const clearQueuedNotice = (): void => {
		if (notice()?.clearsWhenRunEnds === true) setNotice(null);
	};

	const retryFirstRead = (): void => {
		setFailure(null);
		setLoading(true);
		void loadWatchlist();
	};

	const loadWatchlist = async (): Promise<PollSignal> => {
		const result = await api.getWatchlist(etag());
		if (disposed) return "unchanged";
		if (!result.ok) {
			if (data() === null) {
				setFailure({ title: m().loadFailed, error: result.error, retry: retryFirstRead });
			} else {
				say(m().didNotRefresh);
			}
			setLoading(false);
			return "failed";
		}
		// A read that answers takes down the warning a failed one left.
		if (notice()?.text === m().didNotRefresh) setNotice(null);
		if (!result.value.changed) {
			setLoading(false);
			return watchlistRefreshSignal(data());
		}
		setData(result.value.value);
		setEtag(result.value.etag);
		setFailure(null);
		setLoading(false);
		const current = result.value.value;
		return isPollActiveFor(current) ? watchlistRefreshSignal(current) : "changed";
	};

	/** A poll-worthy run: an earnings refresh or a Google Calendar step. */
	function isPollActiveFor(current: WatchlistResponse): boolean {
		return current.refresh.activeRunId !== null || current.googleCalendar.activeRunId !== null;
	}

	const isPollActive = (): boolean => {
		const current = data();
		return current !== null && isPollActiveFor(current);
	};

	const poller = createPoller({
		poll: async () => {
			const signal = await loadWatchlist();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") {
				// The poller only runs for a queued or active run, so stopping
				// here means that run has ended.
				poller.stop();
				clearQueuedNotice();
				// The run has ended: the Google rule takes its decision on the
				// settled watchlist.
				if (googleFollowsRuns) maybeAutoGoogleSync();
			}
			return signal;
		},
		visibility: options.visibility,
	});
	/**
	 * The server syncs the earnings dates on its own schedule: while the
	 * page is visible and no run is followed, the watchlist is re-read
	 * (conditionally) so a sync shows; one that sees a run starts the poller.
	 */
	const idleReread = createIdleReread({
		visibility: options.visibility,
		busy: () => disposed || data() === null || isPollActive(),
		awaiting: () => {
			const current = data();
			return current !== null && hasNeverRefreshedStock(current);
		},
		reread: async () => {
			const signal = await loadWatchlist();
			if (disposed) return;
			if (isPollActive()) {
				poller.start();
				return;
			}
			// A sync that ran between two re-reads ended unseen: once every
			// stock has dates, the notice about fetching them is stale too.
			const current = data();
			if (signal === "changed" && current !== null && !hasNeverRefreshedStock(current)) {
				clearQueuedNotice();
			}
		},
	});
	onCleanup(() => {
		disposed = true;
		poller.stop();
		idleReread.stop();
	});

	/**
	 * After a load: queue one Google Calendar sync when the pure
	 * `googleAutoSyncWanted` rule says so (connected, out of sync, no failure
	 * on record, no run of either kind active, not already attempted for
	 * this ETag). The ETag is recorded before the request, so a queue
	 * request that fails is reported and not repeated.
	 */
	const maybeAutoGoogleSync = (): void => {
		if (disposed) return;
		const current = data();
		const tag = etag();
		if (current === null || tag === null) return;
		if (!googleAutoSyncWanted(current, tag, googleSyncAttemptedEtag)) return;
		googleSyncAttemptedEtag = tag;
		void googleQueue.queue("sync").then((result) => {
			if (disposed) return;
			if (result.kind === "failed") {
				say(m().googleSyncNotQueued(failureMessageIn(result.error, locale())));
				return;
			}
			if (result.kind === "queued") {
				poller.start();
				void loadWatchlist();
			}
		});
	};

	const start = (): void => {
		idleReread.start();
		void loadWatchlist().then(() => {
			if (disposed) return;
			// Dates never fetched are looked for again soon, not in a minute.
			idleReread.soon();
			if (options.automaticRuns === false) return;
			if (isPollActive()) poller.start();
			else maybeAutoGoogleSync();
		});
	};

	const reloadAfterWrite = async (): Promise<void> => {
		googleFollowsRuns = true;
		await loadWatchlist();
		if (disposed) return;
		if (isPollActive()) poller.start();
		else maybeAutoGoogleSync();
	};

	const afterStockWatched = async (
		announce: string,
		afterOptions?: { readonly reloaded: boolean },
	): Promise<void> => {
		if (afterOptions?.reloaded !== true) await reloadAfterWrite();
		if (disposed) return;
		// The run that fetches the dates ends the notice: the status line
		// then tells the outcome.
		setNotice({ text: announce, clearsWhenRunEnds: true });
		idleReread.soon();
	};

	const addStock = async (market: WatchMarket, symbol: string): Promise<boolean> => {
		if (busy()) return false;
		setBusy(true);
		setFailure(null);
		setNotice(null);
		const result = await api.addWatchlistStock({ market, symbol });
		if (disposed) return false;
		setBusy(false);
		if (!result.ok) {
			setFailure({ title: m().notAdded, error: result.error });
			return false;
		}
		return true;
	};

	const removeStock = async (stock: WatchlistStock): Promise<boolean> => {
		if (busy()) return false;
		setBusy(true);
		setFailure(null);
		const result = await api.removeWatchlistStock(stock.stockId);
		if (disposed) return false;
		setBusy(false);
		if (!result.ok) {
			setFailure({ title: m().notRemoved, error: result.error });
			return false;
		}
		say(m().removed(stock.symbol));
		await reloadAfterWrite();
		return true;
	};

	return {
		data,
		loading,
		busy,
		notice,
		failure,
		say,
		clearNotice: () => setNotice(null),
		report: setFailure,
		start,
		reload: async () => {
			await loadWatchlist();
		},
		reloadAfterWrite,
		addStock,
		removeStock,
		afterStockWatched,
	};
}
