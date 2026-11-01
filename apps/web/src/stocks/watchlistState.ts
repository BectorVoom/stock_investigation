import type { WatchlistResponse, WatchlistStock, WatchMarket } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	createIdleReread,
	createPoller,
	type PollSignal,
	type VisibilitySource,
} from "../lib/polling.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { hasNeverRefreshedStock, watchlistRefreshSignal } from "../watchlist/watchlistModel.ts";

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
	/** The first read, then the idle re-reads (and the poller while a run is active). */
	readonly start: () => void;
	/** Re-reads only, without starting the poller (after a refused write that changed nothing). */
	readonly reload: () => Promise<void>;
	/** Re-reads after a write (also a list write), then the poller while a run is active. */
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
 * The Watchlist's half of the Registered stocks and Stocks pages (FR-018,
 * ADR-0049 §2): the conditional watchlist read and its poller while an
 * earnings sync or a Google Calendar step runs, the idle re-read while the
 * page is visible (`createIdleReread`: every minute, sooner while a stock's
 * dates were never fetched, and on every return to the page), and the
 * owner's own adds and removes. The server syncs the earnings dates and the
 * Google Calendar on its own schedule (ADR-0051, ADR-0053), so the page
 * never queues a sync of any kind: it only reads.
 * Must be created under the page's owner.
 */
export function createWatchlistPageState(options: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): WatchlistPageState {
	const api = options.api;
	const m = useMessages(watchlistMessages);
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

	const start = (): void => {
		idleReread.start();
		void loadWatchlist().then(() => {
			if (disposed) return;
			// Dates never fetched are looked for again soon, not in a minute.
			idleReread.soon();
			if (isPollActive()) poller.start();
		});
	};

	const reloadAfterWrite = async (): Promise<void> => {
		await loadWatchlist();
		if (disposed) return;
		if (isPollActive()) poller.start();
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
