/**
 * The examples in docs/external-apis/apis/google-calendar.md, fed through the
 * Calendar client the TypeScript runner uses (conventions §4). A scripted
 * `GoogleRawHttp` answers with each documented body and records the requests
 * the client built — no test contacts Google.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	type CalendarCallDeps,
	type CalendarEventWrite,
	createCalendar,
	getCalendar,
	insertEvent,
	listManagedEvents,
	updateEvent,
} from "../../src/google/googleCalendarClient.ts";
import { GOOGLE_CALENDAR_HOST } from "../../src/google/googleHttp.ts";
import { docExampleText } from "../docExamples.ts";

/**
 * The body of the documented HTTP request whose request line starts with
 * `requestLine`: the line after the blank line that ends its headers.
 */
function docRequestBody(requestLine: string): string {
	const path = fileURLToPath(
		new URL("../../../../docs/external-apis/apis/google-calendar.md", import.meta.url),
	);
	const lines = readFileSync(path, "utf8").split("\n");
	const start = lines.findIndex((line) => line.startsWith(requestLine));
	if (start < 0) throw new Error(`no documented request ${requestLine}`);
	const blank = lines.findIndex((line, at) => at > start && line === "");
	return lines[blank + 1] ?? "";
}

const CALENDAR_ID =
	"c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e@group.calendar.google.com";
const ENCODED_CALENDAR =
	"c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e%40group.calendar.google.com";

interface SeenRequest {
	readonly host: string;
	readonly method: string;
	readonly path: string;
	readonly body: string | null;
}

/** Deps whose Google answers every request with `status` and `text`. */
function answering(
	status: number,
	text: string,
): { deps: CalendarCallDeps; seen: SeenRequest[]; refreshes: number[] } {
	const seen: SeenRequest[] = [];
	const refreshes: number[] = [];
	const deps: CalendarCallDeps = {
		http: async (request) => {
			seen.push({
				host: request.host,
				method: request.method,
				path: request.path,
				body: request.body,
			});
			return ok({ status, location: null, text });
		},
		accessToken: () => "doc-access-token",
		accessTokenExpired: () => false,
		refreshAccessToken: async () => {
			refreshes.push(1);
			return ok("doc-refreshed-token");
		},
		beforeRequest: async () => true,
		backoff: { sleep: async () => {}, random: () => 0, nowMs: () => 0, remainingMs: 0 },
		signal: new AbortController().signal,
	};
	return { deps, seen, refreshes };
}

/** The event body the document's examples show (`googleEventBody` for us:AAPL, 2026-q4). */
const EVENT: CalendarEventWrite = {
	id: "8ap2ge38foujtt6v1ld5e009rtdq788g",
	summary: "AAPL Apple Inc. earnings (Q4 2026)",
	description:
		"Scheduled earnings announcement for AAPL (Q4 2026).\nThe date can change; check the source before acting on it.\nExpected timing: after market close.\nSource: Finnhub.",
	startDate: "2026-10-29",
	endDate: "2026-10-30",
	privateProperties: { researchWorkspace: "earnings", stockId: "us:AAPL", periodKey: "2026-q4" },
	sourceTitle: "Finnhub",
	sourceUrl: "https://finnhub.io/",
};

describe("Google Calendar document examples", () => {
	it("reads the calendar id from the documented calendars.insert body", async () => {
		const { deps, seen } = answering(
			200,
			docExampleText("google-calendar", "google-calendar-calendar"),
		);
		const created = await createCalendar(deps, {
			summary: "Earnings calendar (Research workspace)",
			description:
				"Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.",
			timeZone: "UTC",
		});
		expect(created).toEqual(ok({ id: CALENDAR_ID }));
		expect(seen[0]).toMatchObject({
			host: GOOGLE_CALENDAR_HOST,
			method: "POST",
			path: "/calendar/v3/calendars",
		});
	});

	it("finds the calendar from the documented calendars.get body", async () => {
		const { deps, seen } = answering(
			200,
			docExampleText("google-calendar", "google-calendar-calendar-get"),
		);
		expect(await getCalendar(deps, CALENDAR_ID)).toEqual(ok({ found: true, id: CALENDAR_ID }));
		expect(seen[0]?.path).toBe(`/calendar/v3/calendars/${ENCODED_CALENDAR}`);
	});

	it("lists the managed events from the documented events.list body", async () => {
		const { deps, seen } = answering(
			200,
			docExampleText("google-calendar", "google-calendar-events-list"),
		);
		const listed = await listManagedEvents(deps, CALENDAR_ID);
		expect(listed).toEqual(
			ok([
				{
					id: EVENT.id,
					status: "confirmed",
					startDate: "2026-10-29",
					endDate: "2026-10-30",
					summary: EVENT.summary,
					description: EVENT.description,
					transparency: "transparent",
				},
			]),
		);
		expect(seen[0]?.path).toBe(
			`/calendar/v3/calendars/${ENCODED_CALENDAR}/events?privateExtendedProperty=researchWorkspace%3Dearnings&showDeleted=true&maxResults=250`,
		);
	});

	it("accepts the documented events.insert and events.patch answers and sends the documented bodies", async () => {
		const inserted = answering(
			200,
			docExampleText("google-calendar", "google-calendar-event-insert"),
		);
		expect(await insertEvent(inserted.deps, CALENDAR_ID, EVENT)).toEqual(ok({ inserted: true }));
		const documentedBody = docExampleText("google-calendar", "google-calendar-event-insert");
		expect(JSON.parse(documentedBody)).toMatchObject(JSON.parse(inserted.seen[0]?.body ?? "{}"));

		const updated = answering(
			200,
			docExampleText("google-calendar", "google-calendar-event-update"),
		);
		expect(await updateEvent(updated.deps, CALENDAR_ID, EVENT)).toEqual(ok({ updated: true }));
		expect(updated.seen[0]).toMatchObject({
			method: "PATCH",
			path: `/calendar/v3/calendars/${ENCODED_CALENDAR}/events/${EVENT.id}`,
		});
		const patchBody = updated.seen[0]?.body ?? "";
		expect(patchBody).toBe(docRequestBody("PATCH /calendar/v3/calendars/"));
		expect(
			JSON.parse(docExampleText("google-calendar", "google-calendar-event-update")),
		).toMatchObject(JSON.parse(patchBody));
		expect(inserted.seen[0]?.body).toBe(docRequestBody("POST /calendar/v3/calendars/c_"));
	});

	it("refreshes once on the documented 401 bodies and then fails with Google's status", async () => {
		const bodies = [
			docExampleText("google-calendar", "google-calendar-error-missing-credentials"),
			docExampleText("google-calendar", "google-calendar-error-invalid-token"),
		];
		for (const body of bodies) {
			const { deps, seen, refreshes } = answering(401, body);
			const result = await getCalendar(deps, CALENDAR_ID);
			expect(result.ok ? null : result.error).toEqual({
				code: "GOOGLE_REQUEST_FAILED",
				upstreamStatus: 401,
			});
			expect(refreshes).toHaveLength(1);
			expect(seen).toHaveLength(2);
		}
	});
});
