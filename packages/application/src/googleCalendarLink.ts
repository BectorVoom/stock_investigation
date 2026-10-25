/**
 * Link-row bookkeeping for google-calendar runs (FR-019 section 2.5): the
 * patches a finished run applies to `google_calendar_links`. Kept apart
 * from the queueing service so every place a run can end — a runner
 * completion, the claim loop, an owner cancel — can apply them without an
 * import cycle.
 */
import type { GoogleCalendarAction } from "@research/contracts";
import type {
	GoogleCalendarLink,
	GoogleCalendarLinkPatch,
	GoogleCalendarRepository,
	JobRecord,
} from "./ports.ts";

/**
 * Terminal bookkeeping for google-calendar runs that never complete (FR-019
 * section 2.5). `failureUpstreamStatus` is Google's answer status behind
 * `failureCode`, unchanged (docs/rule/error_handling.md §4a); null when the
 * API itself decided the failure (lease expiry, retry ceiling).
 */
export async function applyGoogleTerminalOutcome(
	deps: { readonly googleCalendar: GoogleCalendarRepository },
	ownerId: string,
	job: JobRecord,
	outcome: "failed" | "cancelled",
	failureCode: string | null,
	failureUpstreamStatus: number | null,
	now: string,
): Promise<void> {
	if (job.kind !== "google-calendar") return;
	const action = job.request !== null && "action" in job.request ? job.request.action : null;
	if (action === null) return;
	const link = await deps.googleCalendar.get(ownerId);
	const patch = googleTerminalPatch(link, action, outcome, failureCode, failureUpstreamStatus, now);
	if (patch !== null) await deps.googleCalendar.apply(ownerId, patch, now);
}

/** Link patch for a successful google-calendar completion (`now` stamps the times). */
export function googleSuccessPatch(
	outcome:
		| { readonly outcome: "google-calendar-connected"; readonly calendarId: string }
		| {
				readonly outcome: "google-calendar-synced";
				readonly calendarId: string;
				readonly desiredDigest: string;
				readonly inserted: number;
				readonly updated: number;
				readonly deleted: number;
				readonly unchanged: number;
		  }
		| { readonly outcome: "google-calendar-disconnected" },
	now: string,
): GoogleCalendarLinkPatch {
	switch (outcome.outcome) {
		case "google-calendar-connected":
			return {
				status: "connected",
				connectFrom: null,
				pendingAuthUrl: null,
				calendarId: outcome.calendarId,
				connectedAt: now,
				lastSyncedAt: null,
				syncedDigest: null,
				lastSync: null,
				lastFailureCode: null,
				lastFailureUpstreamStatus: null,
				lastFailureAt: null,
			};
		case "google-calendar-synced":
			return {
				// A sync that went through proves the grant works, whatever
				// an earlier failure had concluded.
				status: "connected",
				calendarId: outcome.calendarId,
				lastSyncedAt: now,
				syncedDigest: outcome.desiredDigest,
				lastSync: {
					inserted: outcome.inserted,
					updated: outcome.updated,
					deleted: outcome.deleted,
					unchanged: outcome.unchanged,
				},
				lastFailureCode: null,
				lastFailureUpstreamStatus: null,
				lastFailureAt: null,
			};
		case "google-calendar-disconnected":
			return {
				status: "disconnected",
				connectFrom: null,
				pendingAuthUrl: null,
				calendarId: null,
				connectedAt: null,
				lastSyncedAt: null,
				syncedDigest: null,
				lastSync: null,
				lastFailureCode: null,
				lastFailureUpstreamStatus: null,
				lastFailureAt: null,
			};
	}
}

/**
 * Link patch for a failed/cancelled/lease-expired google-calendar run.
 * Failed/cancelled/lease-expired connect restores the status from before;
 * a failed sync with `GOOGLE_AUTH_EXPIRED` moves to `needs-reconnect`;
 * other failures only record `last_failure_*` (the code with Google's answer
 * status beside it, §4a). Cancellation records no failure. Null when nothing
 * changes (a cancelled sync/disconnect).
 */
export function googleTerminalPatch(
	link: GoogleCalendarLink | null,
	action: GoogleCalendarAction,
	outcome: "failed" | "cancelled",
	failureCode: string | null,
	failureUpstreamStatus: number | null,
	now: string,
): GoogleCalendarLinkPatch | null {
	if (action === "connect") {
		const failure: GoogleCalendarLinkPatch =
			outcome === "failed" && failureCode !== null
				? {
						lastFailureCode: failureCode,
						lastFailureUpstreamStatus: failureUpstreamStatus,
						lastFailureAt: now,
					}
				: {};
		// Restores only a row this connect left `connecting`. Anything else
		// (an old run's bookkeeping arriving after a later connect finished)
		// must never overwrite the status that is there now.
		if (link !== null && link.status !== "connecting") {
			return outcome === "failed" && failureCode !== null ? failure : null;
		}
		return {
			status: link?.connectFrom ?? "disconnected",
			connectFrom: null,
			pendingAuthUrl: null,
			...failure,
		};
	}
	if (outcome === "cancelled" || failureCode === null) return null;
	if (action === "sync" && failureCode === "GOOGLE_AUTH_EXPIRED") {
		return {
			status: "needs-reconnect",
			lastFailureCode: failureCode,
			lastFailureUpstreamStatus: failureUpstreamStatus,
			lastFailureAt: now,
		};
	}
	return {
		lastFailureCode: failureCode,
		lastFailureUpstreamStatus: failureUpstreamStatus,
		lastFailureAt: now,
	};
}
