/**
 * Google Calendar API client (FR-019 section 2.2), over the narrow pinned
 * port (`googleHttp.ts`). Only the Calendar v3 calls this sync needs: create
 * and reuse-check the dedicated calendar, list (paged), insert, update and
 * delete its managed events.
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/google-calendar.md
 *
 * Rules: sequential requests only, each attempt admitted by the caller's
 * `beforeRequest` hook first (the same discipline the earnings sources use;
 * the runner paces Google). An access token whose lifetime ran out is
 * refreshed before each attempt; a 401 refreshes it and retries once per
 * call. A rate-limit answer (429, or 403 with a rate-limit
 * reason) is retried with bounded exponential backoff and jitter, honouring
 * `Retry-After`. Redirects are never followed (any 3xx is a failure).
 * Responses are parsed with zod; the 401 error envelope was captured live on
 * 2026-10-31 and the mapping handles it. Only rate-limit signals and
 * `invalid_grant` are distinguished; everything else is
 * `GOOGLE_REQUEST_FAILED`. Provider text never leaves this module — only
 * stable codes.
 */

import {
	err,
	GOOGLE_EVENT_TRANSPARENCY,
	type GoogleEventTransparency,
	ok,
	parseJsonOrNull,
	type Result,
} from "@research/domain";
import { z } from "zod";
import { parseRetryAfterMs } from "../runtime/retryAfter.ts";
import { GOOGLE_CALENDAR_HOST, type GoogleHttpError, type GoogleHttpMethod } from "./googleHttp.ts";

export type GoogleCallCode =
	| "GOOGLE_AUTH_EXPIRED"
	| "GOOGLE_CLIENT_REJECTED"
	| "GOOGLE_RATE_LIMITED"
	| "GOOGLE_REQUEST_FAILED"
	| "ABORTED";

export interface GoogleCallFailure {
	readonly code: GoogleCallCode;
	/**
	 * The status Google answered with when its answer caused the failure,
	 * unchanged; null otherwise (aborted, timed out, an unusable 200) (§4a).
	 */
	readonly upstreamStatus: number | null;
}

export type GoogleCallResult<T> = Result<T, GoogleCallFailure>;

export type GoogleRawHttp = (request: {
	readonly host: string;
	readonly method: GoogleHttpMethod;
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string | null;
	readonly signal: AbortSignal;
}) => Promise<
	Result<
		{
			readonly status: number;
			readonly location: string | null;
			/** `Retry-After` as sent; absent or null when Google sent none. */
			readonly retryAfter?: string | null;
			readonly text: string;
		},
		GoogleHttpError
	>
>;

/**
 * How rate-limit answers are waited out. One object serves every call of a
 * job, so `remainingMs` bounds the job's total waiting, not each call's.
 */
export interface CalendarBackoff {
	/** Waits `ms`; returns early when `signal` fires. */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Uniform in [0, 1): the jitter source. */
	readonly random: () => number;
	/** Epoch milliseconds, for a `Retry-After` HTTP date. */
	readonly nowMs: () => number;
	/** Waiting still allowed in this job; each wait is subtracted. */
	remainingMs: number;
}

/**
 * `events.patch` costs three quota units, every other call one. The pacer
 * admits units, so its 5 per second (300 a minute) stay under Google's 600
 * per minute per user even when a sync patches every event.
 */
export const PATCH_QUOTA_UNITS = 3;

/** At most 4 retries of one request after rate-limit answers. */
export const RATE_LIMIT_MAX_RETRIES = 4;
/** Backoff before retry n (0-based): 1 s × 2^n plus up to 1 s of jitter. */
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_JITTER_MS = 1_000;
/** A `Retry-After` longer than this is not waited out: the call fails now. */
export const RATE_LIMIT_MAX_WAIT_MS = 30_000;
/** Total rate-limit waiting per job (the starting `remainingMs`). */
export const RATE_LIMIT_JOB_BUDGET_MS = 60_000;

export interface CalendarCallDeps {
	readonly http: GoogleRawHttp;
	/** Current access token (memory only). */
	readonly accessToken: () => string;
	/**
	 * True once the current access token's lifetime (`expires_in`) has run
	 * out: the call refreshes before sending instead of collecting a 401.
	 */
	readonly accessTokenExpired: () => boolean;
	/**
	 * Refreshes the access token: before an attempt whose token has expired,
	 * and once per call after a 401. `invalid_grant` surfaces as
	 * `GOOGLE_AUTH_EXPIRED`. The caller paces it.
	 */
	readonly refreshAccessToken: () => Promise<Result<string, GoogleCallFailure>>;
	/**
	 * Admits one request attempt worth `quotaUnits` of Google's quota (3
	 * for `events.patch`, 1 otherwise); false (an abort while waiting) stops
	 * the call.
	 */
	readonly beforeRequest: (quotaUnits: number) => Promise<boolean>;
	readonly backoff: CalendarBackoff;
	readonly signal: AbortSignal;
}

/** One managed event Google returned (`events.list` with `showDeleted=true`). */
export interface ManagedCalendarEvent {
	readonly id: string;
	readonly status: "confirmed" | "cancelled";
	readonly startDate: string;
	readonly endDate: string;
	readonly summary: string;
	readonly description: string;
	/** Absent in Google means `opaque` (busy); the planner updates such an event. */
	readonly transparency: GoogleEventTransparency;
}

/** Desired event body (mirrors the domain's `GoogleEventBody`). */
export interface CalendarEventWrite {
	readonly id: string;
	readonly summary: string;
	readonly description: string;
	readonly startDate: string;
	readonly endDate: string;
	readonly privateProperties: {
		readonly researchWorkspace: "earnings";
		readonly stockId: string;
		readonly periodKey: string;
	};
	readonly sourceTitle: string;
	readonly sourceUrl: string;
}

const calendarSchema = z.object({ id: z.string().min(1) });

const calendarEventSchema = z.object({
	id: z.string().min(1),
	status: z.string().optional(),
	summary: z.string().optional(),
	description: z.string().optional(),
	transparency: z.string().optional(),
	start: z.object({ date: z.string().optional(), dateTime: z.string().optional() }).optional(),
	end: z.object({ date: z.string().optional(), dateTime: z.string().optional() }).optional(),
});

const eventsListSchema = z.object({
	items: z.array(calendarEventSchema).optional(),
	nextPageToken: z.string().optional(),
});

const errorBodySchema = z.object({
	error: z
		.union([
			z.string(),
			z.looseObject({
				code: z.number().optional(),
				reason: z.string().optional(),
				status: z.string().optional(),
				// Calendar v3 puts the machine-readable reason one level down:
				// `error.errors[].reason` (documentation-derived).
				errors: z.array(z.looseObject({ reason: z.string().optional() })).optional(),
			}),
		])
		.optional(),
});

function fail<T>(code: GoogleCallCode, upstreamStatus: number | null = null): GoogleCallResult<T> {
	return err({ code, upstreamStatus });
}

/** Google's error answer: our code for it, with Google's status kept unchanged. */
function failStatus<T>(response: RawResponse): GoogleCallResult<T> {
	return fail(mapStatus(response.status, response.text), response.status);
}

/**
 * Rate-limit reasons: Google's Calendar errors guide documents
 * `rateLimitExceeded`, `userRateLimitExceeded` and `quotaExceeded` (domain
 * `usageLimits`, with 403 or 429); `RESOURCE_EXHAUSTED` is the envelope's
 * gRPC-style status for the same.
 */
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"quotaExceeded",
	"RESOURCE_EXHAUSTED",
]);

/**
 * The 403 reasons worth a backoff. `quotaExceeded` is left out: it is the
 * Calendar usage limit, which Google lifts after hours, not seconds.
 */
const BACKOFF_REASONS: ReadonlySet<string> = new Set([
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"RESOURCE_EXHAUSTED",
]);

/** Every reason-like value of a provider error body (never shown, never logged). */
function errorReasons(text: string): readonly string[] {
	const parsed = errorBodySchema.safeParse(parseJsonOrNull(text));
	if (!parsed.success) return [];
	const error = parsed.data.error;
	if (error === undefined) return [];
	if (typeof error === "string") return [error];
	const reasons: string[] = [];
	if (error.reason !== undefined) reasons.push(error.reason);
	if (error.status !== undefined) reasons.push(error.status);
	for (const item of error.errors ?? []) {
		if (item.reason !== undefined) reasons.push(item.reason);
	}
	return reasons;
}

/**
 * Maps a Calendar error status and body to a stable code. Reasons are read
 * from Google's error envelope (its 401 form captured live on 2026-10-31);
 * an unrecognised body falls back to `GOOGLE_REQUEST_FAILED`.
 */
function mapStatus(status: number, text: string): GoogleCallCode {
	if (status === 429) return "GOOGLE_RATE_LIMITED";
	if (status >= 300 && status < 400) return "GOOGLE_REQUEST_FAILED";
	const reasons = errorReasons(text);
	if (reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))) return "GOOGLE_RATE_LIMITED";
	if (reasons.includes("invalid_grant")) return "GOOGLE_AUTH_EXPIRED";
	return "GOOGLE_REQUEST_FAILED";
}

interface RawResponse {
	readonly status: number;
	readonly retryAfter: string | null;
	readonly text: string;
}

/**
 * The wait before retrying a rate-limited answer, or null to stop: not a
 * rate limit worth waiting for, retries used up, a `Retry-After` longer
 * than the cap, or the job's waiting budget spent. Retry n waits
 * 2^n s + jitter, or the `Retry-After` when that is longer.
 */
function rateLimitDelay(
	response: RawResponse,
	retry: number,
	backoff: CalendarBackoff,
): number | null {
	if (retry >= RATE_LIMIT_MAX_RETRIES) return null;
	const limited =
		response.status === 429 ||
		(response.status === 403 &&
			errorReasons(response.text).some((reason) => BACKOFF_REASONS.has(reason)));
	if (!limited) return null;
	const retryAfter = parseRetryAfterMs(response.retryAfter, backoff.nowMs());
	if (retryAfter !== null && retryAfter > RATE_LIMIT_MAX_WAIT_MS) return null;
	const exponential =
		RATE_LIMIT_BASE_MS * 2 ** retry + Math.floor(backoff.random() * RATE_LIMIT_JITTER_MS);
	const delay = Math.max(exponential, retryAfter ?? 0);
	return delay > backoff.remainingMs ? null : delay;
}

/**
 * Sends one request: every attempt readied by `ready` (an expired token
 * refreshed, then the units reserved right before sending) and authorized
 * with the current token; a 401 refreshes and retries once per call,
 * whether or not an expiry refresh came first; a rate-limit answer is
 * retried after `rateLimitDelay`. Returns the raw response (or the stable
 * failure); status mapping stays with the caller.
 */
async function send(
	deps: CalendarCallDeps,
	method: GoogleHttpMethod,
	path: string,
	body: string | null,
): Promise<Result<RawResponse, GoogleCallFailure>> {
	if (deps.signal.aborted) return fail("ABORTED");
	const quotaUnits = method === "PATCH" ? PATCH_QUOTA_UNITS : 1;
	// The 401 fallback is spent at most once per call, and separately from
	// expiry refreshes: a token refreshed on expiry can still be rejected.
	let authRetried = false;
	const attempt = async (token: string): Promise<Result<RawResponse, GoogleHttpError>> => {
		const response = await deps.http({
			host: GOOGLE_CALENDAR_HOST,
			method,
			path,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }),
			},
			body,
			signal: deps.signal,
		});
		if (!response.ok) {
			return err(response.error);
		}
		return ok({
			status: response.value.status,
			retryAfter: response.value.retryAfter ?? null,
			text: response.value.text,
		});
	};
	// ABORTED means the caller stopped the work. A request that hit the
	// port's own 30 s ceiling is an ordinary request failure.
	const transportFailure = (): Result<RawResponse, GoogleCallFailure> =>
		deps.signal.aborted ? fail("ABORTED") : fail("GOOGLE_REQUEST_FAILED");
	const refresh = async (): Promise<Result<void, GoogleCallFailure>> => {
		const renewed = await deps.refreshAccessToken();
		if (!renewed.ok) return err(renewed.error);
		return deps.signal.aborted ? fail("ABORTED") : ok(undefined);
	};
	const admit = async (): Promise<Result<void, GoogleCallFailure>> =>
		(await deps.beforeRequest(quotaUnits)) && !deps.signal.aborted
			? ok(undefined)
			: fail("ABORTED");
	/**
	 * Readies one attempt (after any pacer or backoff wait). An expired token
	 * is refreshed FIRST: the refresh waits on the same pacer and is a request
	 * of its own, so units reserved before it could age out of the window and
	 * the attempt would then start beside newly admitted requests. The units
	 * are reserved immediately before sending; when that wait outlived a
	 * token that was still fresh, it is refreshed and the units reserved once
	 * more (bounded: no loop).
	 */
	const ready = async (): Promise<Result<void, GoogleCallFailure>> => {
		const expired = deps.accessTokenExpired();
		if (expired) {
			const renewed = await refresh();
			if (!renewed.ok) return renewed;
		}
		const admitted = await admit();
		if (!admitted.ok || expired || !deps.accessTokenExpired()) return admitted;
		const renewed = await refresh();
		return renewed.ok ? admit() : renewed;
	};
	for (let retry = 0; ; retry += 1) {
		const readied = await ready();
		if (!readied.ok) return err(readied.error);
		let answer = await attempt(deps.accessToken());
		if (!answer.ok) return transportFailure();
		if (answer.value.status === 401 && !authRetried) {
			authRetried = true;
			const renewed = await refresh();
			if (!renewed.ok) return err(renewed.error);
			// The retry is a request of its own: the pacer admits it too,
			// after the refresh, right before it is sent.
			const admitted = await admit();
			if (!admitted.ok) return err(admitted.error);
			answer = await attempt(deps.accessToken());
			if (!answer.ok) return transportFailure();
		}
		const delay = rateLimitDelay(answer.value, retry, deps.backoff);
		if (delay === null) return ok(answer.value);
		deps.backoff.remainingMs -= delay;
		await deps.backoff.sleep(delay, deps.signal);
		if (deps.signal.aborted) return fail("ABORTED");
	}
}

function toManaged(event: z.infer<typeof calendarEventSchema>): ManagedCalendarEvent {
	// Defensive: all-day events carry `date`; anything else falls back to
	// the date part of `dateTime`, then to "" (the sync plan compares text).
	const startDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? "";
	const endDate = event.end?.date ?? event.end?.dateTime?.slice(0, 10) ?? "";
	return {
		id: event.id,
		status: event.status === "cancelled" ? "cancelled" : "confirmed",
		startDate,
		endDate,
		summary: event.summary ?? "",
		description: event.description ?? "",
		transparency: event.transparency === "transparent" ? "transparent" : "opaque",
	};
}

/**
 * The fields this app manages, in wire order: the insert body (after `id`)
 * and the whole PATCH body, so an update never touches what the owner set
 * in Google (reminders, colour).
 */
function managedFields(body: CalendarEventWrite) {
	return {
		// Stated outright so an update of an event the owner deleted in
		// Google (kept there as `cancelled`) cannot leave it cancelled.
		status: "confirmed",
		summary: body.summary,
		description: body.description,
		start: { date: body.startDate },
		end: { date: body.endDate },
		// Free, like the .ics (TRANSP:TRANSPARENT): an earnings date is not
		// the owner's appointment.
		transparency: GOOGLE_EVENT_TRANSPARENCY,
		extendedProperties: {
			private: {
				researchWorkspace: body.privateProperties.researchWorkspace,
				stockId: body.privateProperties.stockId,
				periodKey: body.privateProperties.periodKey,
			},
		},
		source: { title: body.sourceTitle, url: body.sourceUrl },
	};
}

function eventResource(body: CalendarEventWrite): string {
	return JSON.stringify({ id: body.id, ...managedFields(body) });
}

function eventPatch(body: CalendarEventWrite): string {
	return JSON.stringify(managedFields(body));
}

/** Creates the dedicated secondary calendar. */
export async function createCalendar(
	deps: CalendarCallDeps,
	input: { readonly summary: string; readonly description: string; readonly timeZone: string },
): Promise<GoogleCallResult<{ readonly id: string }>> {
	const response = await send(
		deps,
		"POST",
		"/calendar/v3/calendars",
		JSON.stringify({
			summary: input.summary,
			description: input.description,
			timeZone: input.timeZone,
		}),
	);
	if (!response.ok) return err(response.error);
	if (response.value.status !== 200) {
		return failStatus(response.value);
	}
	const parsed = calendarSchema.safeParse(parseJsonOrNull(response.value.text));
	if (!parsed.success) return fail("GOOGLE_REQUEST_FAILED");
	return ok({ id: parsed.data.id });
}

export type GetCalendarResult =
	| { readonly found: true; readonly id: string }
	| { readonly found: false };

/** Reuse check: 200 reuses the stored id, 404 means "create a new one". */
export async function getCalendar(
	deps: CalendarCallDeps,
	calendarId: string,
): Promise<GoogleCallResult<GetCalendarResult>> {
	const response = await send(
		deps,
		"GET",
		`/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
		null,
	);
	if (!response.ok) return err(response.error);
	if (response.value.status === 404) return ok({ found: false });
	if (response.value.status !== 200) {
		return failStatus(response.value);
	}
	const parsed = calendarSchema.safeParse(parseJsonOrNull(response.value.text));
	if (!parsed.success) return fail("GOOGLE_REQUEST_FAILED");
	return ok({ found: true, id: parsed.data.id });
}

/** Pages of at most 250, at most 10 pages (bounded work per sync). */
const LIST_PAGE_SIZE = 250;
const LIST_MAX_PAGES = 10;

/**
 * Lists the managed events (private `researchWorkspace=earnings`,
 * `showDeleted=true` so cancelled ids stay visible to the sync plan).
 */
export async function listManagedEvents(
	deps: CalendarCallDeps,
	calendarId: string,
): Promise<GoogleCallResult<readonly ManagedCalendarEvent[]>> {
	const events: ManagedCalendarEvent[] = [];
	let pageToken: string | null = null;
	for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
		const query = new URLSearchParams({
			privateExtendedProperty: "researchWorkspace=earnings",
			showDeleted: "true",
			maxResults: String(LIST_PAGE_SIZE),
			...(pageToken === null ? {} : { pageToken }),
		});
		const response = await send(
			deps,
			"GET",
			`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`,
			null,
		);
		if (!response.ok) return err(response.error);
		if (response.value.status !== 200) {
			return failStatus(response.value);
		}
		const parsed = eventsListSchema.safeParse(parseJsonOrNull(response.value.text));
		if (!parsed.success) return fail("GOOGLE_REQUEST_FAILED");
		for (const item of parsed.data.items ?? []) events.push(toManaged(item));
		pageToken = parsed.data.nextPageToken ?? null;
		if (pageToken === null) return ok(events);
	}
	// More pages than the bound: an incomplete listing would plan from a
	// partial picture (events beyond it would never be deleted), so fail.
	return fail("GOOGLE_REQUEST_FAILED");
}

export type InsertResult =
	| { readonly inserted: true }
	| { readonly inserted: false; readonly conflict: true };

/**
 * Inserts one event. A 409 (duplicate id — the event is already there)
 * reports `conflict` so the caller retries once as an update.
 */
export async function insertEvent(
	deps: CalendarCallDeps,
	calendarId: string,
	body: CalendarEventWrite,
): Promise<GoogleCallResult<InsertResult>> {
	const response = await send(
		deps,
		"POST",
		`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
		eventResource(body),
	);
	if (!response.ok) return err(response.error);
	if (response.value.status === 409) return ok({ inserted: false, conflict: true });
	if (response.value.status !== 200) {
		return failStatus(response.value);
	}
	return ok({ inserted: true });
}

/**
 * Updates one event with PATCH: only the managed fields are sent, so the
 * owner's reminders and colour survive, and `status: confirmed` restores a
 * cancelled event.
 */
export async function updateEvent(
	deps: CalendarCallDeps,
	calendarId: string,
	body: CalendarEventWrite,
): Promise<GoogleCallResult<{ readonly updated: true }>> {
	const response = await send(
		deps,
		"PATCH",
		`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(body.id)}`,
		eventPatch(body),
	);
	if (!response.ok) return err(response.error);
	if (response.value.status !== 200) {
		return failStatus(response.value);
	}
	return ok({ updated: true });
}

/**
 * Deletes one managed event. 200 and 204 mean deleted; 404 and 410 mean it
 * was already gone (removed in Google between the listing and this call),
 * which is the outcome the plan wanted.
 */
export async function deleteEvent(
	deps: CalendarCallDeps,
	calendarId: string,
	eventId: string,
): Promise<GoogleCallResult<{ readonly deleted: true }>> {
	const response = await send(
		deps,
		"DELETE",
		`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
		null,
	);
	if (!response.ok) return err(response.error);
	const status = response.value.status;
	if (status !== 200 && status !== 204 && status !== 404 && status !== 410) {
		return failStatus(response.value);
	}
	return ok({ deleted: true });
}
