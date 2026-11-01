import { type Accessor, createSignal } from "solid-js";
import type { ApiFailure, ApiResult, Conditional } from "../api/http.ts";

/**
 * Shared market-data loading both Home and the Notebook use (ADR-0021):
 * the ETag GET and the poll signal of the sync the server runs. Extracted
 * from `HomeView.tsx` so the two views cannot drift; the pages only read —
 * the server queues every market and earnings sync itself.
 */

/** What one data poll observed; queued/active keep polling, the rest settle. */
export type MarketPollSignal = "active" | "queued" | "changed" | "unchanged" | "failed";

export interface MarketRefreshState {
	readonly activeRunId: string | null;
	readonly activeRunState: string | null;
}

/**
 * The run signal carried by the data response itself (V7: no extra run
 * GET). "pending" polls at the slow cadence (V6: the runner may be
 * offline); a leased run polls fast.
 */
export function marketRefreshSignal(
	refresh: MarketRefreshState,
): "active" | "queued" | "unchanged" {
	if (refresh.activeRunId !== null) {
		return refresh.activeRunState === "pending" ? "queued" : "active";
	}
	return "unchanged";
}

export interface EtagLoader<T> {
	/** The last loaded value, null until the first successful load. */
	readonly value: Accessor<T | null>;
	readonly etag: Accessor<string | null>;
	/** The first-load failure; later failures leave the last value on screen. */
	readonly error: Accessor<ApiFailure | null>;
	readonly loading: Accessor<boolean>;
	readonly clearError: () => void;
	/**
	 * Restarts a failed first load from the loading state (the "Try again"
	 * path): clears the error and shows the skeleton again until the next
	 * load settles. A value already on screen stays visible.
	 */
	readonly beginReload: () => void;
	/**
	 * One conditional GET. Updates the signals and answers the poll signal
	 * for the poller: `failed` on any failure, the refresh signal on a 304,
	 * and `changed` once a settled (run-free) value arrives. A failed poll
	 * with a value already on screen also reports `stale: true` so the view
	 * can warn without replacing the numbers.
	 */
	readonly load: () => Promise<{ readonly signal: MarketPollSignal; readonly stale: boolean }>;
}

/**
 * One conditional-GET resource with its ETag (Home's `/home/data`, the
 * watchlist, the notebook's market data). Must be created under a Solid
 * owner; responses that arrive after disposal are ignored.
 */
export function createEtagLoader<T>(options: {
	readonly load: (etag: string | null) => Promise<ApiResult<Conditional<T>>>;
	readonly refreshOf: (value: T) => MarketRefreshState;
	readonly isDisposed: () => boolean;
}): EtagLoader<T> {
	const [value, setValue] = createSignal<T | null>(null);
	const [etag, setEtag] = createSignal<string | null>(null);
	const [error, setError] = createSignal<ApiFailure | null>(null);
	const [loading, setLoading] = createSignal(true);

	const load = async (): Promise<{
		readonly signal: MarketPollSignal;
		readonly stale: boolean;
	}> => {
		const result = await options.load(etag());
		if (options.isDisposed()) return { signal: "unchanged", stale: false };
		if (!result.ok) {
			if (value() === null) setError(result.error);
			setLoading(false);
			return { signal: "failed", stale: value() !== null };
		}
		const body = result.value;
		if (!body.changed) {
			setLoading(false);
			const current = value();
			return {
				signal: current === null ? "unchanged" : marketRefreshSignal(options.refreshOf(current)),
				stale: false,
			};
		}
		setValue(() => body.value);
		setEtag(body.etag);
		setError(null);
		setLoading(false);
		const refresh = marketRefreshSignal(options.refreshOf(body.value));
		return { signal: refresh === "unchanged" ? "changed" : refresh, stale: false };
	};

	return {
		value,
		etag,
		error,
		loading,
		clearError: () => setError(null),
		beginReload: () => {
			setError(null);
			if (value() === null) setLoading(true);
		},
		load,
	};
}
