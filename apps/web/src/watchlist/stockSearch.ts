import type { StockDirectorySearchResponse } from "@research/contracts";
import type { ApiResult } from "../api/http.ts";
import { type StockSearchState, stockSearchQuery } from "./watchlistModel.ts";

/** Typing pauses this long before a search is sent (ADR-0033: one request per pause, not per key). */
export const STOCK_SEARCH_DEBOUNCE_MS = 150;

export interface StockSearchOptions {
	/** Never rejects (the API client maps every failure to a result). */
	readonly search: (
		query: string,
		signal: AbortSignal,
	) => Promise<ApiResult<StockDirectorySearchResponse>>;
	readonly onState: (state: StockSearchState) => void;
	readonly debounceMs?: number;
}

export interface StockSearch {
	/** The search box's text changed. */
	readonly input: (text: string) => void;
	/** Sends the current query again at once (e.g. after a stock list arrived). */
	readonly refresh: () => void;
	readonly dispose: () => void;
}

/**
 * The search box's request discipline: a query is sent after a
 * `debounceMs` pause; a newer keystroke aborts the request in flight, so at
 * most one is ever outstanding; and an answer that arrives after a newer
 * query was asked is dropped (a generation counter, since a fetch that
 * ignores its abort signal may still answer). A blank query sends nothing
 * and returns the box to idle; the same query twice (a trailing space)
 * sends nothing new.
 */
export function createStockSearch(options: StockSearchOptions): StockSearch {
	const debounceMs = options.debounceMs ?? STOCK_SEARCH_DEBOUNCE_MS;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: AbortController | null = null;
	let generation = 0;
	let wanted: string | null = null;
	let disposed = false;

	const clearTimer = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	/** Ends whatever is pending: the timer, the request in flight, and any answer still on its way. */
	const cancel = (): void => {
		clearTimer();
		generation += 1;
		inFlight?.abort();
		inFlight = null;
	};

	const send = async (query: string): Promise<void> => {
		timer = null;
		const controller = new AbortController();
		inFlight = controller;
		const mine = generation;
		options.onState({ kind: "searching", query });
		const result = await options.search(query, controller.signal);
		if (disposed || mine !== generation) return;
		inFlight = null;
		options.onState(
			result.ok
				? { kind: "results", query, hits: result.value.hits }
				: { kind: "failed", query, error: result.error },
		);
	};

	const schedule = (query: string, delayMs: number): void => {
		cancel();
		timer = setTimeout(() => void send(query), delayMs);
	};

	return {
		input: (text) => {
			if (disposed) return;
			const query = stockSearchQuery(text);
			if (query === wanted) return;
			wanted = query;
			if (query === null) {
				cancel();
				options.onState({ kind: "idle" });
				return;
			}
			schedule(query, debounceMs);
		},
		refresh: () => {
			if (disposed || wanted === null) return;
			schedule(wanted, 0);
		},
		dispose: () => {
			disposed = true;
			cancel();
		},
	};
}
