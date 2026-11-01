import type { StockDirectoryStatusResponse } from "@research/contracts";
import { type Accessor, createSignal } from "solid-js";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import {
	createIdleReread,
	createPoller,
	type PollSignal,
	type VisibilitySource,
} from "../lib/polling.ts";
import { isStockDirectoryRunActive, stockDirectoryPollSignal } from "./watchlistModel.ts";

export interface StockDirectoryApi {
	readonly getStockDirectory: () => Promise<ApiResult<StockDirectoryStatusResponse>>;
}

export interface StockDirectoryState {
	readonly status: Accessor<StockDirectoryStatusResponse | null>;
	/** The first status read's failure; cleared by the next success. */
	readonly failure: Accessor<ApiFailure | null>;
	/** Loads the status and follows a download that is running. Also the retry after a failed load. */
	readonly start: () => void;
	readonly dispose: () => void;
}

/**
 * The stock lists' status on Registered stocks (ADR-0034, ADR-0050 §4),
 * read-only: the server downloads a missing list at once and refreshes each
 * list weekly (ADR-0053), so the page never queues a download. Polls while
 * a download it can see is active, and otherwise re-reads while visible
 * (`createIdleReread`) so a download the server starts shows — from 5 s
 * while a market has no list and no failed download, every minute else.
 */
export function createStockDirectoryState(options: {
	readonly api: StockDirectoryApi;
	readonly visibility: VisibilitySource;
}): StockDirectoryState {
	const [status, setStatus] = createSignal<StockDirectoryStatusResponse | null>(null);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	let disposed = false;

	const load = async (): Promise<PollSignal> => {
		const result = await options.api.getStockDirectory();
		if (disposed) return "unchanged";
		if (!result.ok) {
			// A poll that fails keeps the shown status and backs off; only a
			// page with nothing to show reports it.
			if (status() === null) setFailure(result.error);
			return "failed";
		}
		setStatus(result.value);
		setFailure(null);
		return isStockDirectoryRunActive(result.value)
			? stockDirectoryPollSignal(result.value)
			: "changed";
	};

	const poller = createPoller({
		poll: async () => {
			const signal = await load();
			if (disposed) return "unchanged";
			// The poller only runs while a download is active: it has ended.
			if (signal === "changed" || signal === "unchanged") {
				poller.stop();
				idleReread.soon();
			}
			return signal;
		},
		visibility: options.visibility,
	});

	/** A market with no stored list and no failed download: the server queues it at the runner's next claim. */
	const awaitingList = (): boolean =>
		status()?.markets.some(
			(market) =>
				(market.entryCount === 0 || market.retrievedAt === null) && market.lastFailure === null,
		) ?? false;

	const idleReread = createIdleReread({
		visibility: options.visibility,
		busy: () => disposed || status() === null || isStockDirectoryRunActive(status()),
		awaiting: awaitingList,
		reread: async () => {
			await load();
			if (!disposed && isStockDirectoryRunActive(status())) poller.start();
		},
	});

	return {
		status,
		failure,
		start: () => {
			void load().then(() => {
				if (disposed) return;
				if (isStockDirectoryRunActive(status())) poller.start();
				// Started once the status is known, so a missing list gets the short delay.
				idleReread.start();
			});
		},
		dispose: () => {
			disposed = true;
			poller.stop();
			idleReread.stop();
		},
	};
}
