import type { ResearchRun } from "@research/contracts";
import { isTerminalJobState } from "@research/domain";
import type { ApiFailure } from "../api/http.ts";

export type EarningsRefreshQueueResult =
	| { readonly kind: "queued"; readonly run: ResearchRun }
	| { readonly kind: "busy" }
	| { readonly kind: "failed"; readonly error: ApiFailure };

/**
 * The one earnings-refresh queue both `WatchlistView` and `HomeView` use
 * (FR-018 fix F). It owns the idempotency-key rule the Watchlist page had:
 * the key is kept only after a network failure (unknown outcome, safe to
 * retry the same write); a server answer means nothing more is queued under
 * it. A replayed TERMINAL run means nothing was queued — the earlier attempt
 * finished while its answer was lost — so a fresh key is taken and the queue
 * is retried once. A call made while another queue request is in flight
 * answers `busy` instead of sending a second request.
 */
export function createEarningsRefreshQueue(api: {
	readonly newIdempotencyKey: () => string;
	readonly refreshEarnings: (
		key: string,
	) => Promise<
		| { readonly ok: true; readonly value: ResearchRun }
		| { readonly ok: false; readonly error: ApiFailure }
	>;
}): {
	readonly queue: () => Promise<EarningsRefreshQueueResult>;
	readonly busy: () => boolean;
} {
	let refreshKey: string | null = null;
	let inFlight = false;

	const queueOnce = async (): Promise<EarningsRefreshQueueResult> => {
		refreshKey ??= api.newIdempotencyKey();
		const result = await api.refreshEarnings(refreshKey);
		if (!result.ok) {
			if (result.error.kind !== "network") refreshKey = null;
			return { kind: "failed", error: result.error };
		}
		return { kind: "queued", run: result.value };
	};

	return {
		busy: () => inFlight,
		queue: async (): Promise<EarningsRefreshQueueResult> => {
			if (inFlight) return { kind: "busy" };
			inFlight = true;
			try {
				const first = await queueOnce();
				if (first.kind !== "queued") return first;
				if (!isTerminalJobState(first.run.state)) {
					refreshKey = null;
					return first;
				}
				// Replayed TERMINAL run: nothing was queued — fresh key, retry once.
				refreshKey = null;
				const second = await queueOnce();
				if (second.kind === "queued") refreshKey = null;
				return second;
			} finally {
				inFlight = false;
			}
		},
	};
}
