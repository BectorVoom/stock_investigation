import type { ResearchRun } from "@research/contracts";
import { isTerminalJobState } from "@research/domain";
import type { ApiFailure } from "../api/http.ts";

export type GoogleSyncQueueResult =
	| { readonly kind: "queued"; readonly run: ResearchRun }
	| { readonly kind: "busy" }
	| { readonly kind: "failed"; readonly error: ApiFailure };

/**
 * The one Google Calendar queue the Watchlist card and the automatic sync
 * rule share (FR-019 section 2.7). Same idempotency-key rule as the
 * earnings-refresh queue: the key is kept only after a network failure
 * (unknown outcome, safe to retry the same write); a server answer means
 * nothing more is queued under it. A replayed TERMINAL run means nothing
 * was queued, so a fresh key is taken and the queue is retried once. A call
 * made while another queue request is in flight answers `busy`.
 */
export function createGoogleSyncQueue(api: {
	readonly newIdempotencyKey: () => string;
	readonly connectGoogleCalendar: (
		key: string,
	) => Promise<
		| { readonly ok: true; readonly value: ResearchRun }
		| { readonly ok: false; readonly error: ApiFailure }
	>;
	readonly syncGoogleCalendar: (
		key: string,
	) => Promise<
		| { readonly ok: true; readonly value: ResearchRun }
		| { readonly ok: false; readonly error: ApiFailure }
	>;
	readonly disconnectGoogleCalendar: (
		key: string,
	) => Promise<
		| { readonly ok: true; readonly value: ResearchRun }
		| { readonly ok: false; readonly error: ApiFailure }
	>;
}): {
	readonly queue: (action: "connect" | "sync" | "disconnect") => Promise<GoogleSyncQueueResult>;
	readonly busy: () => boolean;
} {
	let queueKey: string | null = null;
	let inFlight = false;

	return {
		busy: () => inFlight,
		queue: async (action): Promise<GoogleSyncQueueResult> => {
			if (inFlight) return { kind: "busy" };
			inFlight = true;
			try {
				queueKey ??= api.newIdempotencyKey();
				const send =
					action === "connect"
						? api.connectGoogleCalendar
						: action === "sync"
							? api.syncGoogleCalendar
							: api.disconnectGoogleCalendar;
				const first = await send(queueKey);
				if (!first.ok) {
					if (first.error.kind !== "network") queueKey = null;
					return { kind: "failed", error: first.error };
				}
				if (!isTerminalJobState(first.value.state)) {
					queueKey = null;
					return { kind: "queued", run: first.value };
				}
				// Replayed TERMINAL run: nothing was queued — fresh key, retry once.
				queueKey = null;
				queueKey ??= api.newIdempotencyKey();
				const second = await send(queueKey);
				if (!second.ok) {
					if (second.error.kind !== "network") queueKey = null;
					return { kind: "failed", error: second.error };
				}
				queueKey = null;
				return { kind: "queued", run: second.value };
			} finally {
				inFlight = false;
			}
		},
	};
}
