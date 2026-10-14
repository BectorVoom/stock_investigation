/**
 * Calendar client (FR-019 section 2.2): CRUD against a local fake Google
 * server (never the real endpoints); a 401 refreshes the token ONCE and
 * retries once; pacing goes through the caller's `beforeRequest` hook.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	type CalendarCallDeps,
	createCalendar,
	deleteEvent,
	getCalendar,
	insertEvent,
	listManagedEvents,
	updateEvent,
} from "../../src/google/googleCalendarClient.ts";
import { createGoogleHttp, GOOGLE_CALENDAR_HOST } from "../../src/google/googleHttp.ts";
import { startTlsServer } from "../node/localTlsServer.ts";

const never = new AbortController().signal;

interface SeenCall {
	readonly method: string | undefined;
	readonly url: string | undefined;
	readonly authorization: string | string[] | undefined;
	readonly body: string;
}

interface FakeCalendarOptions {
	/** handler per "METHOD path" prefix; returns status + JSON text. */
	readonly routes: Record<string, { status: number; body: string }>;
	readonly seen: SeenCall[];
}

async function fakeCalendarServer(options: FakeCalendarOptions) {
	return startTlsServer(
		[GOOGLE_CALENDAR_HOST],
		(request: IncomingMessage, response: ServerResponse) => {
			let body = "";
			request.on("data", (chunk: Uint8Array) => {
				body += Buffer.from(chunk).toString("utf8");
			});
			request.on("end", () => {
				const key = `${request.method} ${(request.url ?? "").split("?")[0]}`;
				options.seen.push({
					method: request.method,
					url: request.url,
					authorization: request.headers.authorization,
					body,
				});
				const route = options.routes[key];
				if (route === undefined) {
					response.writeHead(404, { "content-type": "application/json" });
					response.end('{"error":{"reason":"notFound"}}');
					return;
				}
				response.writeHead(route.status, { "content-type": "application/json" });
				response.end(route.body);
			});
		},
	);
}

function depsThrough(
	server: { port: number; certPem: string },
	overrides: Partial<CalendarCallDeps> = {},
): CalendarCallDeps & { paced: number[] } {
	const paced: number[] = [];
	const http = createGoogleHttp({
		lookup: async () => [{ address: "127.0.0.1", family: 4 as const }],
		tls: { port: server.port, ca: server.certPem },
	});
	return {
		paced,
		http: (request) => http(request),
		accessToken: () => "access-token",
		refreshAccessToken: async () => ok("refreshed-token"),
		beforeRequest: async () => {
			paced.push(1);
			return true;
		},
		signal: never,
		...overrides,
	};
}

const WRITE = {
	id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	summary: "7203: earnings",
	description: "desc",
	startDate: "2026-11-05",
	endDate: "2026-11-06",
	privateProperties: {
		researchWorkspace: "earnings" as const,
		stockId: "jp:7203",
		periodKey: "2026-q3",
	},
	sourceTitle: "JPX",
	sourceUrl: "https://www.jpx.co.jp/",
};

describe("calendar client against a fake Google server", () => {
	it("creates a calendar and reuses it on a 200 reuse check", async () => {
		const seen: SeenCall[] = [];
		const server = await fakeCalendarServer({
			seen,
			routes: {
				"POST /calendar/v3/calendars": { status: 200, body: '{"id":"cal_1"}' },
				"GET /calendar/v3/calendars/cal_1": { status: 200, body: '{"id":"cal_1"}' },
			},
		});
		try {
			const deps = depsThrough(server);
			const created = await createCalendar(deps, {
				summary: "Earnings calendar (Research workspace)",
				description: "d",
				timeZone: "UTC",
			});
			expect(created).toEqual(ok({ id: "cal_1" }));
			const reused = await getCalendar(deps, "cal_1");
			expect(reused).toEqual(ok({ found: true, id: "cal_1" }));
			expect(seen[0]?.authorization).toBe("Bearer access-token");
			expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
				summary: "Earnings calendar (Research workspace)",
				timeZone: "UTC",
			});
			// Every request passed through the pacing hook.
			expect(deps.paced).toHaveLength(2);
		} finally {
			await server.close();
		}
	});

	it("treats a 404 reuse check as missing (create a new calendar)", async () => {
		const seen: SeenCall[] = [];
		const server = await fakeCalendarServer({ seen, routes: {} });
		try {
			const reused = await getCalendar(depsThrough(server), "gone");
			expect(reused).toEqual(ok({ found: false }));
		} finally {
			await server.close();
		}
	});

	it("lists managed events with the earnings filter", async () => {
		const single: SeenCall[] = [];
		const onePage = await fakeCalendarServer({
			seen: single,
			routes: {
				"GET /calendar/v3/calendars/cal_1/events": {
					status: 200,
					body: JSON.stringify({
						items: [
							{
								id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
								status: "confirmed",
								summary: "s",
								description: "d",
								start: { date: "2026-11-05" },
								end: { date: "2026-11-06" },
							},
							{ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", status: "cancelled" },
						],
					}),
				},
			},
		});
		try {
			const listed = await listManagedEvents(depsThrough(onePage), "cal_1");
			expect(listed).toEqual(
				ok([
					{
						id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						status: "confirmed",
						startDate: "2026-11-05",
						endDate: "2026-11-06",
						summary: "s",
						description: "d",
					},
					{
						id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						status: "cancelled",
						startDate: "",
						endDate: "",
						summary: "",
						description: "",
					},
				]),
			);
			const url = new URL(`https://x${single[0]?.url ?? ""}`);
			expect(url.searchParams.get("privateExtendedProperty")).toBe("researchWorkspace=earnings");
			expect(url.searchParams.get("showDeleted")).toBe("true");
			expect(url.searchParams.get("maxResults")).toBe("250");
		} finally {
			await onePage.close();
		}
	});

	it("inserts, reports a 409 conflict, updates and deletes", async () => {
		const seen: SeenCall[] = [];
		const server = await fakeCalendarServer({
			seen,
			routes: {
				"POST /calendar/v3/calendars/cal_1/events": { status: 409, body: "{}" },
				[`PUT /calendar/v3/calendars/cal_1/events/${WRITE.id}`]: { status: 200, body: "{}" },
				[`DELETE /calendar/v3/calendars/cal_1/events/${WRITE.id}`]: { status: 204, body: "" },
			},
		});
		try {
			const deps = depsThrough(server);
			expect(await insertEvent(deps, "cal_1", WRITE)).toEqual(
				ok({ inserted: false, conflict: true }),
			);
			expect(await updateEvent(deps, "cal_1", WRITE)).toEqual(ok({ updated: true }));
			expect(await deleteEvent(deps, "cal_1", WRITE.id)).toEqual(ok({ deleted: true }));
			const inserted = JSON.parse(seen[0]?.body ?? "{}");
			expect(inserted).toMatchObject({
				id: WRITE.id,
				status: "confirmed",
				start: { date: "2026-11-05" },
				end: { date: "2026-11-06" },
				extendedProperties: {
					private: { researchWorkspace: "earnings", stockId: "jp:7203", periodKey: "2026-q3" },
				},
				source: { title: "JPX", url: "https://www.jpx.co.jp/" },
			});
		} finally {
			await server.close();
		}
	});

	it("refreshes the token ONCE on a 401 and retries with the new token", async () => {
		const seen: SeenCall[] = [];
		let calls = 0;
		const server = await startTlsServer([GOOGLE_CALENDAR_HOST], (request, response) => {
			request.on("data", () => {});
			request.on("end", () => {
				calls += 1;
				seen.push({
					method: request.method,
					url: request.url,
					authorization: request.headers.authorization,
					body: "",
				});
				if (calls === 1) {
					response.writeHead(401, { "content-type": "application/json" });
					response.end('{"error":{"reason":"authError"}}');
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"id":"cal_1"}');
			});
		});
		try {
			const deps = depsThrough(server);
			const reused = await getCalendar(deps, "cal_1");
			expect(reused).toEqual(ok({ found: true, id: "cal_1" }));
			expect(calls).toBe(2);
			expect(seen[0]?.authorization).toBe("Bearer access-token");
			expect(seen[1]?.authorization).toBe("Bearer refreshed-token");
		} finally {
			await server.close();
		}
	});

	it("surfaces a failed refresh as auth-expired (re-connect)", async () => {
		const server = await startTlsServer([GOOGLE_CALENDAR_HOST], (_request, response) => {
			response.writeHead(401, { "content-type": "application/json" });
			response.end('{"error":{"reason":"authError"}}');
		});
		try {
			const deps = depsThrough(server, {
				refreshAccessToken: async () => err({ code: "GOOGLE_AUTH_EXPIRED" as const }),
			});
			const reused = await getCalendar(deps, "cal_1");
			expect(reused).toEqual(err({ code: "GOOGLE_AUTH_EXPIRED" }));
		} finally {
			await server.close();
		}
	});

	it("maps rate limits and refuses to pace when the hook says stop", async () => {
		const seen: SeenCall[] = [];
		const server = await fakeCalendarServer({
			seen,
			routes: {
				"GET /calendar/v3/calendars/cal_1": { status: 429, body: "{}" },
			},
		});
		try {
			const limited = await getCalendar(depsThrough(server), "cal_1");
			expect(limited).toEqual(err({ code: "GOOGLE_RATE_LIMITED" }));
			const stopped = await getCalendar(
				depsThrough(server, { beforeRequest: async () => false }),
				"cal_1",
			);
			expect(stopped).toEqual(err({ code: "ABORTED" }));
			// The refused call sent nothing: still exactly one request seen.
			expect(seen).toHaveLength(1);
		} finally {
			await server.close();
		}
	});

	it("reads the rate-limit reason where Calendar v3 puts it (403, error.errors[].reason)", async () => {
		const server = await fakeCalendarServer({
			seen: [],
			routes: {
				"GET /calendar/v3/calendars/cal_1": {
					status: 403,
					body: JSON.stringify({
						error: {
							errors: [
								{
									domain: "usageLimits",
									reason: "rateLimitExceeded",
									message: "Rate Limit Exceeded",
								},
							],
							code: 403,
							message: "Rate Limit Exceeded",
						},
					}),
				},
				// A plain 403 (no rate-limit reason) stays the generic failure.
				"GET /calendar/v3/calendars/cal_2": {
					status: 403,
					body: JSON.stringify({
						error: { errors: [{ domain: "global", reason: "forbidden" }], code: 403 },
					}),
				},
			},
		});
		try {
			const deps = depsThrough(server);
			expect(await getCalendar(deps, "cal_1")).toEqual(err({ code: "GOOGLE_RATE_LIMITED" }));
			expect(await getCalendar(deps, "cal_2")).toEqual(err({ code: "GOOGLE_REQUEST_FAILED" }));
		} finally {
			await server.close();
		}
	});

	it("treats an event that is already gone (404, 410) as deleted", async () => {
		const server = await fakeCalendarServer({
			seen: [],
			routes: {
				"DELETE /calendar/v3/calendars/cal_1/events/gone404": { status: 404, body: "{}" },
				"DELETE /calendar/v3/calendars/cal_1/events/gone410": { status: 410, body: "{}" },
				"DELETE /calendar/v3/calendars/cal_1/events/broken": { status: 500, body: "{}" },
			},
		});
		try {
			const deps = depsThrough(server);
			expect(await deleteEvent(deps, "cal_1", "gone404")).toEqual(ok({ deleted: true }));
			expect(await deleteEvent(deps, "cal_1", "gone410")).toEqual(ok({ deleted: true }));
			expect(await deleteEvent(deps, "cal_1", "broken")).toEqual(
				err({ code: "GOOGLE_REQUEST_FAILED" }),
			);
		} finally {
			await server.close();
		}
	});

	it("fails rather than plan from a listing that never ends (10-page bound)", async () => {
		const seen: SeenCall[] = [];
		const server = await fakeCalendarServer({
			seen,
			routes: {
				"GET /calendar/v3/calendars/cal_1/events": {
					status: 200,
					body: JSON.stringify({ items: [], nextPageToken: "more" }),
				},
			},
		});
		try {
			expect(await listManagedEvents(depsThrough(server), "cal_1")).toEqual(
				err({ code: "GOOGLE_REQUEST_FAILED" }),
			);
			expect(seen).toHaveLength(10);
		} finally {
			await server.close();
		}
	});
});
