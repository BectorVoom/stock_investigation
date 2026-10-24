import type {
	StockDirectoryRefreshResponse,
	StockDirectoryStatusResponse,
	WatchMarket,
} from "@research/contracts";
import { type Accessor, createSignal } from "solid-js";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import {
	directoryAutoRefreshMarkets,
	isStockDirectoryRunActive,
	stockDirectoryPollSignal,
} from "./watchlistModel.ts";

/** A failed directory request, with what was being done (the view words the title). */
export interface StockDirectoryFailure {
	readonly action: "load" | "queue";
	readonly error: ApiFailure;
}

export interface StockDirectoryApi {
	readonly newIdempotencyKey: () => string;
	readonly getStockDirectory: () => Promise<ApiResult<StockDirectoryStatusResponse>>;
	readonly refreshStockDirectory: (
		markets: readonly WatchMarket[],
		idempotencyKey: string,
	) => Promise<ApiResult<StockDirectoryRefreshResponse>>;
}

export interface StockDirectoryState {
	readonly status: Accessor<StockDirectoryStatusResponse | null>;
	readonly failure: Accessor<StockDirectoryFailure | null>;
	/** A queue request is on its way. */
	readonly queuing: Accessor<boolean>;
	/** The owner queued an update and it has not ended yet (the view announces it). */
	readonly queuedByOwner: Accessor<boolean>;
	/** Loads the status, then applies the once-per-visit automatic rule. Also the retry after a failed load. */
	readonly start: () => void;
	/** "Update stock list": both markets (the API reuses a market's active run). */
	readonly update: () => void;
	readonly dispose: () => void;
}

const BOTH_MARKETS: readonly WatchMarket[] = ["US", "JP"];

/** True when a market's stored list differs between two statuses (a download completed). */
function listsChanged(
	before: StockDirectoryStatusResponse,
	after: StockDirectoryStatusResponse,
): boolean {
	return after.markets.some((market, index) => {
		const previous = before.markets[index];
		return (
			previous === undefined ||
			previous.entryCount !== market.entryCount ||
			previous.retrievedAt !== market.retrievedAt
		);
	});
}

/**
 * The Watchlist's stock-list status and its refresh queue (ADR-0033). Polls
 * only while a list download is active. Opening the page queues one
 * download for the markets `directoryAutoRefreshMarkets` names, at most once
 * per mount, after the first successful load; a failed queue is reported and
 * never retried automatically. The idempotency key is kept only after a
 * network failure (unknown outcome) and only for the same markets, so a
 * resend of that same write is safe; any server answer retires it. A
 * failed queue request reloads the status once, so a market queued anyway
 * is shown and polled.
 */
export function createStockDirectoryState(options: {
	readonly api: StockDirectoryApi;
	readonly visibility: VisibilitySource;
	readonly nowMs?: () => number;
	/** A market's stored list changed (a download completed): re-run the open search. */
	readonly onListsChanged?: () => void;
}): StockDirectoryState {
	const nowMs = options.nowMs ?? (() => Date.now());
	const [status, setStatus] = createSignal<StockDirectoryStatusResponse | null>(null);
	const [failure, setFailure] = createSignal<StockDirectoryFailure | null>(null);
	const [queuing, setQueuing] = createSignal(false);
	const [queuedByOwner, setQueuedByOwner] = createSignal(false);
	let disposed = false;
	let autoTried = false;
	let pendingKey: { readonly markets: string; readonly key: string } | null = null;

	const clearFailure = (action: StockDirectoryFailure["action"]): void => {
		if (failure()?.action === action) setFailure(null);
	};

	const load = async (): Promise<PollSignal> => {
		const result = await options.api.getStockDirectory();
		if (disposed) return "unchanged";
		if (!result.ok) {
			// A poll that fails keeps the shown status and backs off; only a
			// page with nothing to show reports it.
			if (status() === null) setFailure({ action: "load", error: result.error });
			return "failed";
		}
		const before = status();
		setStatus(result.value);
		clearFailure("load");
		if (before !== null && listsChanged(before, result.value)) options.onListsChanged?.();
		return isStockDirectoryRunActive(result.value)
			? stockDirectoryPollSignal(result.value)
			: "changed";
	};

	const poller = createPoller({
		poll: async () => {
			const signal = await load();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") {
				// The poller only runs while a download is active: it has ended.
				poller.stop();
				setQueuedByOwner(false);
			}
			return signal;
		},
		visibility: options.visibility,
	});

	const queue = async (markets: readonly WatchMarket[], byOwner: boolean): Promise<void> => {
		if (queuing() || markets.length === 0) return;
		setQueuing(true);
		const marketsKey = markets.join(",");
		if (pendingKey?.markets !== marketsKey) {
			pendingKey = { markets: marketsKey, key: options.api.newIdempotencyKey() };
		}
		const result = await options.api.refreshStockDirectory(markets, pendingKey.key);
		if (disposed) return;
		setQueuing(false);
		if (!result.ok) {
			if (result.error.kind !== "network") pendingKey = null;
			setFailure({ action: "queue", error: result.error });
			// A failed answer does not prove nothing was queued: one market may
			// have been queued before the other failed (or the answer was lost).
			// One reload shows such a run and polls it to its end.
			await load();
			if (!disposed && isStockDirectoryRunActive(status())) poller.start();
			return;
		}
		pendingKey = null;
		clearFailure("queue");
		if (byOwner) setQueuedByOwner(true);
		poller.start();
	};

	const start = (): void => {
		void load().then(() => {
			if (disposed) return;
			const current = status();
			if (current === null) return;
			if (isStockDirectoryRunActive(current)) poller.start();
			if (autoTried) return;
			autoTried = true;
			void queue(directoryAutoRefreshMarkets(current, nowMs()), false);
		});
	};

	return {
		status,
		failure,
		queuing,
		queuedByOwner,
		start,
		update: () => void queue(BOTH_MARKETS, true),
		dispose: () => {
			disposed = true;
			poller.stop();
		},
	};
}
