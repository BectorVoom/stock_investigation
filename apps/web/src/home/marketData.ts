import type { RefreshScope, ResearchRun } from "@research/contracts";
import { isTerminalJobState } from "@research/domain";
import { type Accessor, createSignal } from "solid-js";
import type { ApiFailure, ApiResult, Conditional } from "../api/http.ts";

/**
 * Shared market-data loading both Home and the Notebook use (ADR-0021):
 * the ETag GET, the refresh poll signal and the market-refresh queue.
 * Extracted from `HomeView.tsx` so the two views cannot drift; Home's
 * behaviour is unchanged (its notices, auto-refresh and follow-up stay in
 * the view — only the mechanics live here).
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

export type MarketRefreshQueueResult =
	| { readonly kind: "queued"; readonly run: ResearchRun }
	| { readonly kind: "busy" }
	| { readonly kind: "failed"; readonly error: ApiFailure };

/**
 * The one market-refresh queue both Home and the Notebook share. It owns
 * the idempotency-key rule Home had (V9): the key is kept only after a
 * network failure (unknown outcome, safe to retry the same write); a
 * server answer means nothing more is queued under it. A replayed TERMINAL
 * run means nothing was queued — the earlier attempt finished while its
 * answer was lost — so a fresh key is taken and the queue is retried once.
 * A call made while another queue request is in flight answers `busy`
 * instead of sending a second request.
 */
export function createMarketRefreshQueue(api: {
	readonly newIdempotencyKey: () => string;
	readonly refreshMarket: (
		key: string,
		scope: RefreshScope,
	) => Promise<
		| { readonly ok: true; readonly value: ResearchRun }
		| { readonly ok: false; readonly error: ApiFailure }
	>;
}): {
	readonly queue: (scope: RefreshScope) => Promise<MarketRefreshQueueResult>;
	readonly busy: () => boolean;
} {
	/**
	 * The key kept after a network failure, with the scope it was sent for:
	 * the API fingerprints the scope (ADR-0039), so a later request for the
	 * other scope is a different write and takes a fresh key.
	 */
	let kept: { readonly key: string; readonly scope: RefreshScope } | null = null;
	let inFlight = false;

	const queueOnce = async (scope: RefreshScope): Promise<MarketRefreshQueueResult> => {
		const key = kept !== null && kept.scope === scope ? kept.key : api.newIdempotencyKey();
		kept = { key, scope };
		const result = await api.refreshMarket(key, scope);
		if (!result.ok) {
			if (result.error.kind !== "network") kept = null;
			return { kind: "failed", error: result.error };
		}
		return { kind: "queued", run: result.value };
	};

	return {
		busy: () => inFlight,
		queue: async (scope: RefreshScope): Promise<MarketRefreshQueueResult> => {
			if (inFlight) return { kind: "busy" };
			inFlight = true;
			try {
				const first = await queueOnce(scope);
				if (first.kind !== "queued") return first;
				if (!isTerminalJobState(first.run.state)) {
					kept = null;
					return first;
				}
				// Replayed TERMINAL run: nothing was queued — fresh key, retry once.
				kept = null;
				const second = await queueOnce(scope);
				if (second.kind === "queued") kept = null;
				return second;
			} finally {
				inFlight = false;
			}
		},
	};
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
