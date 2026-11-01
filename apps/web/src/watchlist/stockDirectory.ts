import type { StockDirectoryStatusResponse } from "@research/contracts";
import { type Accessor, createSignal } from "solid-js";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
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
 * list weekly (ADR-0053), so the page never queues a download. Polls only
 * while a download it can see is active.
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
			if (signal === "changed" || signal === "unchanged") poller.stop();
			return signal;
		},
		visibility: options.visibility,
	});

	return {
		status,
		failure,
		start: () => {
			void load().then(() => {
				if (!disposed && isStockDirectoryRunActive(status())) poller.start();
			});
		},
		dispose: () => {
			disposed = true;
			poller.stop();
		},
	};
}
