/**
 * Google Calendar API client (FR-019 section 2.2), over the narrow pinned
 * port (`googleHttp.ts`). Only the Calendar v3 paths this sync needs:
 *
 *   POST   /calendar/v3/calendars                       (create)
 *   GET    /calendar/v3/calendars/{id}                  (reuse check)
 *   GET    /calendar/v3/calendars/{id}/events           (managed list, paged)
 *   POST   /calendar/v3/calendars/{id}/events           (insert)
 *   PUT    /calendar/v3/calendars/{id}/events/{eventId} (update)
 *   DELETE /calendar/v3/calendars/{id}/events/{eventId} (delete)
 *
 * Rules: sequential requests only, each admitted by the caller's
 * `beforeRequest` hook first (the same discipline the earnings sources use;
 * the runner paces Google at 5 requests per second). A 401 refreshes the
 * access token ONCE and retries the request once. Redirects are never
 * followed (any 3xx is a failure). Responses are parsed with zod; the exact
 * provider error bodies were NOT verified live, so mapping is defensive:
 * `invalid_grant` on refresh means `GOOGLE_AUTH_EXPIRED`, rate-limit
 * signals mean `GOOGLE_RATE_LIMITED`, everything else is
 * `GOOGLE_REQUEST_FAILED`. Provider text never leaves this module — only
 * stable codes.
 */

import { err, ok, type Result } from "@research/domain";
import { z } from "zod";
import { GOOGLE_CALENDAR_HOST, type GoogleHttpError, type GoogleHttpMethod } from "./googleHttp.ts";

export type GoogleCallCode =
	| "GOOGLE_AUTH_EXPIRED"
	| "GOOGLE_RATE_LIMITED"
	| "GOOGLE_REQUEST_FAILED"
	| "ABORTED";

export interface GoogleCallFailure {
	readonly code: GoogleCallCode;
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
		{ readonly status: number; readonly location: string | null; readonly text: string },
		GoogleHttpError
	>
>;

export interface CalendarCallDeps {
	readonly http: GoogleRawHttp;
	/** Current access token (memory only). */
	readonly accessToken: () => string;
	/**
	 * Refreshes the access token after a 401 (called at most once per
	 * request). `invalid_grant` surfaces as `GOOGLE_AUTH_EXPIRED`.
	 */
	readonly refreshAccessToken: () => Promise<Result<string, GoogleCallFailure>>;
	/** Admits one request start; false (an abort while waiting) stops the call. */
	readonly beforeRequest: () => Promise<boolean>;
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

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function fail<T>(code: GoogleCallCode): GoogleCallResult<T> {
	return err({ code });
}

const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"quotaExceeded",
	"RESOURCE_EXHAUSTED",
]);

/** Every reason-like value of a provider error body (never shown, never logged). */
function errorReasons(text: string): readonly string[] {
	const parsed = errorBodySchema.safeParse(parseJson(text));
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

/** Defensive error mapping (exact bodies not yet observed live). */
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
	readonly text: string;
}

/**
 * Sends one request: admitted by `beforeRequest`, authorized with the
 * current token, with ONE refresh-and-retry on a 401. Returns the raw
 * response (or the stable failure); status mapping stays with the caller.
 */
async function send(
	deps: CalendarCallDeps,
	method: GoogleHttpMethod,
	path: string,
	body: string | null,
): Promise<Result<RawResponse, GoogleCallFailure>> {
	if (deps.signal.aborted) return fail("ABORTED");
	const admitted = await deps.beforeRequest();
	if (!admitted || deps.signal.aborted) return fail("ABORTED");
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
		return ok({ status: response.value.status, text: response.value.text });
	};
	const first = await attempt(deps.accessToken());
	if (!first.ok) {
		// ABORTED means the caller stopped the work. A request that hit the
		// port's own 30 s ceiling is an ordinary request failure.
		return deps.signal.aborted ? fail("ABORTED") : fail("GOOGLE_REQUEST_FAILED");
	}
	if (first.value.status !== 401) return ok(first.value);
	const refreshed = await deps.refreshAccessToken();
	if (!refreshed.ok) return fail(refreshed.error.code);
	if (deps.signal.aborted) return fail("ABORTED");
	const second = await attempt(refreshed.value);
	if (!second.ok) return deps.signal.aborted ? fail("ABORTED") : fail("GOOGLE_REQUEST_FAILED");
	return ok(second.value);
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
	};
}

function eventResource(body: CalendarEventWrite): string {
	return JSON.stringify({
		id: body.id,
		// Stated outright so an update of an event the owner deleted in
		// Google (kept there as `cancelled`) cannot leave it cancelled.
		status: "confirmed",
		summary: body.summary,
		description: body.description,
		start: { date: body.startDate },
		end: { date: body.endDate },
		extendedProperties: {
			private: {
				researchWorkspace: body.privateProperties.researchWorkspace,
				stockId: body.privateProperties.stockId,
				periodKey: body.privateProperties.periodKey,
			},
		},
		source: { title: body.sourceTitle, url: body.sourceUrl },
	});
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
	if (!response.ok) return fail(response.error.code);
	if (response.value.status !== 200) {
		return fail(mapStatus(response.value.status, response.value.text));
	}
	const parsed = calendarSchema.safeParse(parseJson(response.value.text));
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
	if (!response.ok) return fail(response.error.code);
	if (response.value.status === 404) return ok({ found: false });
	if (response.value.status !== 200) {
		return fail(mapStatus(response.value.status, response.value.text));
	}
	const parsed = calendarSchema.safeParse(parseJson(response.value.text));
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
		if (!response.ok) return fail(response.error.code);
		if (response.value.status !== 200) {
			return fail(mapStatus(response.value.status, response.value.text));
		}
		const parsed = eventsListSchema.safeParse(parseJson(response.value.text));
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
	if (!response.ok) return fail(response.error.code);
	if (response.value.status === 409) return ok({ inserted: false, conflict: true });
	if (response.value.status !== 200) {
		return fail(mapStatus(response.value.status, response.value.text));
	}
	return ok({ inserted: true });
}

/** Upserts one event (PUT restores a cancelled event with the desired body). */
export async function updateEvent(
	deps: CalendarCallDeps,
	calendarId: string,
	body: CalendarEventWrite,
): Promise<GoogleCallResult<{ readonly updated: true }>> {
	const response = await send(
		deps,
		"PUT",
		`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(body.id)}`,
		eventResource(body),
	);
	if (!response.ok) return fail(response.error.code);
	if (response.value.status !== 200) {
		return fail(mapStatus(response.value.status, response.value.text));
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
	if (!response.ok) return fail(response.error.code);
	const status = response.value.status;
	if (status !== 200 && status !== 204 && status !== 404 && status !== 410) {
		return fail(mapStatus(status, response.value.text));
	}
	return ok({ deleted: true });
}
