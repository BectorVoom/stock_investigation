import type {
	RefreshScope,
	WatchlistResponse,
	WatchlistStock,
	WatchMarket,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { failureMessageIn } from "../api/errorText.ts";
import type { ApiFailure } from "../api/http.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import { createEarningsRefreshQueue } from "../watchlist/earningsRefreshQueue.ts";
import { createGoogleSyncQueue } from "../watchlist/googleSyncQueue.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import {
	earningsAddedRefreshScope,
	earningsAutoRefresh,
	earningsFollowUpScope,
	googleAutoSyncWanted,
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
	/** True while the page writes the watchlist (add or remove a stock, queue a refresh). */
	readonly busy: Accessor<boolean>;
	readonly notice: Accessor<PageNotice | null>;
	readonly failure: Accessor<PageFailure | null>;
	readonly say: (text: string) => void;
	/** Clears the notice (the Stocks page, when another stock is shown). */
	readonly clearNotice: () => void;
	readonly report: (failure: PageFailure | null) => void;
	/** The first read, then the once-per-visit automatic rules. */
	readonly start: () => void;
	/** Re-reads after a write (also a list write), then the Google rule or the poller. */
	readonly reloadAfterWrite: () => Promise<void>;
	/** "Refresh earnings dates", or a narrower scope after an add. */
	readonly queueRefresh: (scope: RefreshScope, announce?: PageNotice) => Promise<void>;
	/**
	 * Adds one stock; resolves true when the watchlist took it. The caller
	 * then runs `afterStockWatched` (re-read, queue its earnings dates).
	 */
	readonly addStock: (market: WatchMarket, symbol: string) => Promise<boolean>;
	/** Removes one stock from the watchlist (after the page's confirmation); true when it left. */
	readonly removeStock: (stock: WatchlistStock) => Promise<boolean>;
	/**
	 * After a stock was put on the watchlist: re-read (unless the caller
	 * just did), then fetch its earnings dates.
	 */
	readonly afterStockWatched: (
		announce: string,
		options?: { readonly reloaded: boolean },
	) => Promise<void>;
}

/**
 * The Watchlist's half of the Registered stocks page (FR-018, ADR-0049 §2),
 * moved from the Watchlist page unchanged: the conditional watchlist read
 * and its poller while an earnings refresh or a Google Calendar step runs,
 * the automatic earnings refresh once per visit (ADR-0039 scopes), the
 * follow-up after a stock added mid-run, and the automatic Google sync
 * after the page's own changes. With `automaticRuns: false` (the Stocks
 * page, ADR-0049 §3, ADR-0050 §2) `start` reads the watchlist and queues
 * nothing, and the staleness refresh is never queued — not even when a run
 * the page watches ends: only the owner's own add queues the new stock's
 * dates (and its follow-up), and the Google sync follows the owner's own
 * watchlist change as on Registered stocks. Must be created under the
 * page's owner.
 */
export function createWatchlistPageState(options: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** Queue the automatic earnings refresh and Google sync on start (default true). */
	readonly automaticRuns?: boolean;
}): WatchlistPageState {
	const api = options.api;
	const m = useMessages(watchlistMessages);
	const model = useMessages(watchlistModelMessages);
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
	const refreshQueue = createEarningsRefreshQueue(api);
	const googleQueue = createGoogleSyncQueue(api);
	let autoRefreshTried = false;
	/** The staleness refresh was sent while a run was active (at most once per mount). */
	let staleSentWhileActive = false;
	let followUpArmed = false;
	/** The watchlist ETag an automatic Google sync was already attempted for (at most one per ETag). */
	let googleSyncAttemptedEtag: string | null = null;

	/**
	 * A notice that names a queued run goes stale when the run ends — the
	 * status line then tells the outcome — so the poller clears it. Any other
	 * notice (added/removed, plain failures, the follow-up announcement) is kept.
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
				// When the first load found an active run the load rule below
				// never ran: evaluate it now, unless a follow-up was just
				// queued (a no-op once the rule has fired).
				if (!(await maybeFollowUpRefresh())) {
					maybeAutoRefresh();
					maybeAutoGoogleSync();
				}
			}
			return signal;
		},
		visibility: options.visibility,
	});
	onCleanup(() => {
		disposed = true;
		poller.stop();
	});

	/**
	 * Once per mount, after the first successful load: queue one refresh when
	 * the list is non-empty, no run is active, and a stock's dates were
	 * never fetched or are more than a day old (`earningsAutoRefresh` picks
	 * the scope). A failed queue is reported, never retried.
	 */
	const maybeAutoRefresh = (): void => {
		if (autoRefreshTried || disposed || options.automaticRuns === false) return;
		const current = data();
		if (current === null) return;
		const auto = earningsAutoRefresh(current, Date.now());
		if (current.refresh.activeRunId !== null) {
			// ADR-0039: stale dates with a run already active still ask for
			// every stock, once — the server widens a pending narrow job (no
			// provider request) or answers with the claimed one — and the
			// decision stays open, so it is taken again when that run ends.
			if (auto?.scope === "all" && !staleSentWhileActive) {
				staleSentWhileActive = true;
				void queueRefresh("all", {
					text: model().autoRefreshNotice(auto.reason),
					clearsWhenRunEnds: true,
				});
			}
			return;
		}
		if (auto === null) return;
		autoRefreshTried = true;
		void queueRefresh(auto.scope, {
			text: model().autoRefreshNotice(auto.reason),
			clearsWhenRunEnds: true,
		});
	};

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

	/**
	 * One follow-up per ended run that a stock was added during, when that
	 * run left a stock never refreshed. A run that was still pending at the
	 * add claims the current watchlist — the new stock included — so when it
	 * covered the new stock nothing more is queued. Bounded by the adds: the
	 * flag is armed only by an add and consumed here.
	 */
	const maybeFollowUpRefresh = async (): Promise<boolean> => {
		if (!followUpArmed || disposed) return false;
		const current = data();
		if (current === null) return false;
		followUpArmed = false;
		const scope = earningsFollowUpScope(current, Date.now());
		if (scope === null) return false;
		await queueRefresh(scope, { text: m().followUpQueued, clearsWhenRunEnds: false });
		return true;
	};

	const start = (): void => {
		if (options.automaticRuns === false) {
			void loadWatchlist();
			return;
		}
		void loadWatchlist().then(() => {
			if (disposed) return;
			if (isPollActive()) {
				poller.start();
				// An earnings run is active: stale dates still ask for everything.
				const loaded = data();
				if (loaded !== null && loaded.refresh.activeRunId !== null) maybeAutoRefresh();
			} else {
				maybeAutoRefresh();
				maybeAutoGoogleSync();
			}
		});
	};

	const reloadAfterWrite = async (): Promise<void> => {
		await loadWatchlist();
		if (disposed) return;
		if (isPollActive()) poller.start();
		else maybeAutoGoogleSync();
	};

	const queueRefresh = async (scope: RefreshScope, announce?: PageNotice): Promise<void> => {
		if (refreshQueue.busy() || busy()) {
			say(m().alreadyQueuing);
			return;
		}
		setBusy(true);
		setFailure(null);
		const result = await refreshQueue.queue(scope);
		if (disposed) return;
		setBusy(false);
		if (result.kind === "busy") {
			say(m().alreadyQueuing);
			return;
		}
		if (result.kind === "failed") {
			setFailure({ title: m().refreshNotQueued, error: result.error });
			return;
		}
		setNotice(announce ?? { text: m().refreshQueued, clearsWhenRunEnds: true });
		poller.start();
		void loadWatchlist();
	};

	const afterStockWatched = async (
		announce: string,
		afterOptions?: { readonly reloaded: boolean },
	): Promise<void> => {
		if (afterOptions?.reloaded !== true) await reloadAfterWrite();
		if (disposed) return;
		if (isPollActive()) {
			// A run is already underway: remember that a follow-up may be
			// needed, and say the dates are being fetched.
			followUpArmed = true;
			setNotice({ text: announce, clearsWhenRunEnds: true });
			return;
		}
		// ADR-0039: fetch the new stock's dates only, not every stock's —
		// unless no stock has dates yet or another stock's are stale.
		const current = data();
		const scope = current === null ? "unrefreshed" : earningsAddedRefreshScope(current, Date.now());
		await queueRefresh(scope, { text: announce, clearsWhenRunEnds: true });
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
		reloadAfterWrite,
		queueRefresh,
		addStock,
		removeStock,
		afterStockWatched,
	};
}
