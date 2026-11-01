import type {
	StockDirectoryRefreshResponse,
	StockDirectoryStatusResponse,
	WatchMarket,
} from "@research/contracts";
import { type Accessor, createSignal } from "solid-js";
import type { ApiResult } from "../api/http.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import {
	directoryAutoRefreshMarkets,
	isStockDirectoryRunActive,
	stockDirectoryPollSignal,
} from "./watchlistModel.ts";

export interface StockDirectoryApi {
	readonly newIdempotencyKey: () => string;
	readonly getStockDirectory: () => Promise<ApiResult<StockDirectoryStatusResponse>>;
	readonly refreshStockDirectory: (
		markets: readonly WatchMarket[],
		idempotencyKey: string,
	) => Promise<ApiResult<StockDirectoryRefreshResponse>>;
}

export interface StockDirectoryState {
	/** The last loaded status (which markets have a stored list); null until loaded. */
	readonly status: Accessor<StockDirectoryStatusResponse | null>;
	/** Loads the status, then applies the once-per-visit automatic rule. */
	readonly start: () => void;
	readonly dispose: () => void;
}

/**
 * The stock lists' background refresh on Registered stocks (ADR-0034,
 * ADR-0050 §4; the page shows no list area since 2026-11-01). Polls only
 * while a list download is active. Opening the page queues one download
 * for the markets `directoryAutoRefreshMarkets` names, at most once per
 * mount, after the first successful load; a failed load or queue is never
 * retried automatically (the next visit tries again). A failed queue
 * request reloads the status once, so a market queued anyway is polled.
 */
export function createStockDirectoryState(options: {
	readonly api: StockDirectoryApi;
	readonly visibility: VisibilitySource;
	readonly nowMs?: () => number;
}): StockDirectoryState {
	const nowMs = options.nowMs ?? (() => Date.now());
	const [status, setStatus] = createSignal<StockDirectoryStatusResponse | null>(null);
	let disposed = false;
	let autoTried = false;

	const load = async (): Promise<PollSignal> => {
		const result = await options.api.getStockDirectory();
		if (disposed) return "unchanged";
		// A poll that fails keeps the last status and backs off.
		if (!result.ok) return "failed";
		setStatus(result.value);
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
			}
			return signal;
		},
		visibility: options.visibility,
	});

	/** One queue request; its idempotency key is fresh, since it is never resent. */
	const queue = async (markets: readonly WatchMarket[]): Promise<void> => {
		if (markets.length === 0) return;
		const result = await options.api.refreshStockDirectory(
			markets,
			options.api.newIdempotencyKey(),
		);
		if (disposed) return;
		if (!result.ok) {
			// A failed answer does not prove nothing was queued: one market may
			// have been queued before the other failed (or the answer was lost).
			// One reload shows such a run and polls it to its end.
			await load();
			if (!disposed && isStockDirectoryRunActive(status())) poller.start();
			return;
		}
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
			void queue(directoryAutoRefreshMarkets(current, nowMs()));
		});
	};

	return {
		status,
		start,
		dispose: () => {
			disposed = true;
			poller.stop();
		},
	};
}
