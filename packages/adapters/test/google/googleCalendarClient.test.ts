/**
 * Calendar client (FR-019 section 2.2): CRUD against a local fake Google
 * server (never the real endpoints); a 401 refreshes the token ONCE and
 * retries once; an expired token is refreshed first; rate limits are
 * retried with bounded backoff; every attempt goes through the caller's
 * `beforeRequest` hook.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	type CalendarBackoff,
	type CalendarCallDeps,
	createCalendar,
	deleteEvent,
	getCalendar,
	insertEvent,
	listManagedEvents,
	PATCH_QUOTA_UNITS,
	RATE_LIMIT_JOB_BUDGET_MS,
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
	readonly routes: Record<
		string,
		{ status: number; body: string; headers?: Readonly<Record<string, string>> }
	>;
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
				response.writeHead(route.status, {
					"content-type": "application/json",
					...(route.headers ?? {}),
				});
				response.end(route.body);
			});
		},
	);
}

/** A backoff that records its waits instead of sleeping; jitter 0 unless given. */
function recordingBackoff(
	random: () => number = () => 0,
	remainingMs = RATE_LIMIT_JOB_BUDGET_MS,
): CalendarBackoff & { waits: number[] } {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms) => {
			waits.push(ms);
		},
		random,
		nowMs: () => Date.UTC(2026, 9, 31, 7, 0, 0),
		remainingMs,
	};
}

function depsThrough(
	server: { port: number; certPem: string },
	overrides: Partial<CalendarCallDeps> = {},
): CalendarCallDeps & { paced: number[]; refreshed: number[] } {
	const paced: number[] = [];
	const refreshed: number[] = [];
	const http = createGoogleHttp({
		lookup: async () => [{ address: "127.0.0.1", family: 4 as const }],
		tls: { port: server.port, ca: server.certPem },
	});
	return {
		paced,
		refreshed,
		http: (request) => http(request),
		accessToken: () => (refreshed.length === 0 ? "access-token" : "refreshed-token"),
		accessTokenExpired: () => false,
		refreshAccessToken: async () => {
			refreshed.push(1);
			return ok("refreshed-token");
		},
		beforeRequest: async (quotaUnits) => {
			paced.push(quotaUnits);
			return true;
		},
		backoff: recordingBackoff(),
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
							{
								id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
								status: "cancelled",
								transparency: "transparent",
							},
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
						transparency: "opaque",
					},
					{
						id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						status: "cancelled",
						startDate: "",
						endDate: "",
						summary: "",
						description: "",
						transparency: "transparent",
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
				[`PATCH /calendar/v3/calendars/cal_1/events/${WRITE.id}`]: { status: 200, body: "{}" },
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
				transparency: "transparent",
			});
			// The update is a PATCH of the managed fields only: no id, and
			// nothing the owner may set in Google (reminders, colorId).
			expect(seen[1]?.method).toBe("PATCH");
			const patched = JSON.parse(seen[1]?.body ?? "{}");
			expect(Object.keys(patched)).toEqual([
				"status",
				"summary",
				"description",
				"start",
				"end",
				"transparency",
				"extendedProperties",
				"source",
			]);
			expect(patched.transparency).toBe("transparent");
			// A PATCH costs Google three quota units; the pacer admits units.
			expect(deps.paced).toEqual([1, PATCH_QUOTA_UNITS, 1]);
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
			// The retry is admitted by the pacer like the first attempt.
			expect(deps.paced).toHaveLength(2);
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
				refreshAccessToken: async () =>
					err({ code: "GOOGLE_AUTH_EXPIRED" as const, upstreamStatus: 400 }),
			});
			const reused = await getCalendar(deps, "cal_1");
			// The refresh's own code and Google's status end the call.
			expect(reused).toEqual(err({ code: "GOOGLE_AUTH_EXPIRED", upstreamStatus: 400 }));
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
			const deps = depsThrough(server);
			const limited = await getCalendar(deps, "cal_1");
			// Google's own status travels beside our code, unchanged (§4a).
			expect(limited).toEqual(err({ code: "GOOGLE_RATE_LIMITED", upstreamStatus: 429 }));
			// Four retries, 1 s × 2^n apart (jitter 0 here), each paced.
			expect(seen).toHaveLength(5);
			expect(deps.paced).toHaveLength(5);
			expect((deps.backoff as CalendarBackoff & { waits: number[] }).waits).toEqual([
				1_000, 2_000, 4_000, 8_000,
			]);
			const stopped = await getCalendar(
				depsThrough(server, { beforeRequest: async () => false }),
				"cal_1",
			);
			expect(stopped).toEqual(err({ code: "ABORTED", upstreamStatus: null }));
			// The refused call sent nothing.
			expect(seen).toHaveLength(5);
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
			const deps = depsThrough(server, { backoff: recordingBackoff(() => 0, 0) });
			// No waiting budget left: the 403 rate limit is not retried.
			expect(await getCalendar(deps, "cal_1")).toEqual(
				err({ code: "GOOGLE_RATE_LIMITED", upstreamStatus: 403 }),
			);
			expect(await getCalendar(deps, "cal_2")).toEqual(
				err({ code: "GOOGLE_REQUEST_FAILED", upstreamStatus: 403 }),
			);
			expect(deps.paced).toHaveLength(2);
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
				err({ code: "GOOGLE_REQUEST_FAILED", upstreamStatus: 500 }),
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
			// Every page answered 200: the failure is ours, so no upstream status.
			expect(await listManagedEvents(depsThrough(server), "cal_1")).toEqual(
				err({ code: "GOOGLE_REQUEST_FAILED", upstreamStatus: null }),
			);
			expect(seen).toHaveLength(10);
		} finally {
			await server.close();
		}
	});

	it("backs off a 429 with jitter and succeeds on the retry", async () => {
		let calls = 0;
		const server = await startTlsServer([GOOGLE_CALENDAR_HOST], (request, response) => {
			request.on("data", () => {});
			request.on("end", () => {
				calls += 1;
				if (calls <= 2) {
					response.writeHead(429, { "content-type": "application/json" });
					response.end("{}");
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"id":"cal_1"}');
			});
		});
		try {
			const backoff = recordingBackoff(() => 0.25);
			const deps = depsThrough(server, { backoff });
			expect(await getCalendar(deps, "cal_1")).toEqual(ok({ found: true, id: "cal_1" }));
			expect(backoff.waits).toEqual([1_250, 2_250]);
			// The waits come out of the job's budget.
			expect(backoff.remainingMs).toBe(RATE_LIMIT_JOB_BUDGET_MS - 3_500);
		} finally {
			await server.close();
		}
	});

	it("honours Retry-After, and gives up when it is longer than the cap", async () => {
		const server = await fakeCalendarServer({
			seen: [],
			routes: {
				"GET /calendar/v3/calendars/soon": {
					status: 429,
					body: "{}",
					headers: { "retry-after": "5" },
				},
				"GET /calendar/v3/calendars/later": {
					status: 403,
					body: '{"error":{"errors":[{"domain":"usageLimits","reason":"userRateLimitExceeded"}]}}',
					headers: { "retry-after": "31" },
				},
			},
		});
		try {
			const soon = recordingBackoff();
			expect(await getCalendar(depsThrough(server, { backoff: soon }), "soon")).toEqual(
				err({ code: "GOOGLE_RATE_LIMITED", upstreamStatus: 429 }),
			);
			// 5 s each, until the exponential wait (8 s) is the longer one.
			expect(soon.waits).toEqual([5_000, 5_000, 5_000, 8_000]);
			const later = recordingBackoff();
			const deps = depsThrough(server, { backoff: later });
			expect(await getCalendar(deps, "later")).toEqual(
				err({ code: "GOOGLE_RATE_LIMITED", upstreamStatus: 403 }),
			);
			expect(later.waits).toEqual([]);
			expect(deps.paced).toHaveLength(1);
		} finally {
			await server.close();
		}
	});

	it("does not wait out a Calendar usage limit (403 quotaExceeded) or a spent budget", async () => {
		const server = await fakeCalendarServer({
			seen: [],
			routes: {
				"GET /calendar/v3/calendars/cal_1": {
					status: 403,
					body: '{"error":{"errors":[{"domain":"usageLimits","reason":"quotaExceeded"}]}}',
				},
				"GET /calendar/v3/calendars/cal_2": { status: 429, body: "{}" },
			},
		});
		try {
			const backoff = recordingBackoff(() => 0, 4_000);
			const deps = depsThrough(server, { backoff });
			expect(await getCalendar(deps, "cal_1")).toEqual(
				err({ code: "GOOGLE_RATE_LIMITED", upstreamStatus: 403 }),
			);
			expect(backoff.waits).toEqual([]);
			// 1 s + 2 s fit into 4 s; the third wait (4 s) does not.
			expect(await getCalendar(deps, "cal_2")).toEqual(
				err({ code: "GOOGLE_RATE_LIMITED", upstreamStatus: 429 }),
			);
			expect(backoff.waits).toEqual([1_000, 2_000]);
			expect(backoff.remainingMs).toBe(1_000);
		} finally {
			await server.close();
		}
	});

	it("refreshes an expired access token before the request, not after a 401", async () => {
		const seen: SeenCall[] = [];
		const server = await fakeCalendarServer({
			seen,
			routes: { "GET /calendar/v3/calendars/cal_1": { status: 200, body: '{"id":"cal_1"}' } },
		});
		try {
			const deps = depsThrough(server, { accessTokenExpired: () => true });
			expect(await getCalendar(deps, "cal_1")).toEqual(ok({ found: true, id: "cal_1" }));
			expect(deps.refreshed).toHaveLength(1);
			expect(seen).toHaveLength(1);
			expect(seen[0]?.authorization).toBe("Bearer refreshed-token");
		} finally {
			await server.close();
		}
	});

	/** Google answering each request in turn (the last answer repeats). */
	async function answersInTurn(answers: readonly { status: number; body: string }[]) {
		const seen: SeenCall[] = [];
		const server = await startTlsServer([GOOGLE_CALENDAR_HOST], (request, response) => {
			request.on("data", () => {});
			request.on("end", () => {
				seen.push({
					method: request.method,
					url: request.url,
					authorization: request.headers.authorization,
					body: "",
				});
				const answer = answers[Math.min(seen.length, answers.length) - 1];
				response.writeHead(answer?.status ?? 500, { "content-type": "application/json" });
				response.end(answer?.body ?? "{}");
			});
		});
		return { server, seen };
	}
	const unauthorized = { status: 401, body: '{"error":{"errors":[{"reason":"authError"}]}}' };
	const found = { status: 200, body: '{"id":"cal_1"}' };
	const expiredOnce = () => {
		let calls = 0;
		return () => {
			calls += 1;
			return calls === 1;
		};
	};

	it("still refreshes and retries on a 401 right after an expiry refresh", async () => {
		const { server, seen } = await answersInTurn([unauthorized, found]);
		try {
			const deps = depsThrough(server, { accessTokenExpired: expiredOnce() });
			expect(await getCalendar(deps, "cal_1")).toEqual(ok({ found: true, id: "cal_1" }));
			// The expiry refresh, then the 401 fallback's own refresh.
			expect(deps.refreshed).toHaveLength(2);
			expect(seen).toHaveLength(2);
			expect(deps.paced).toHaveLength(2);
		} finally {
			await server.close();
		}
	});

	it("maps a second 401: the fallback retries once per call", async () => {
		const { server, seen } = await answersInTurn([unauthorized]);
		try {
			const deps = depsThrough(server, { accessTokenExpired: expiredOnce() });
			expect(await getCalendar(deps, "cal_1")).toEqual(
				err({ code: "GOOGLE_REQUEST_FAILED", upstreamStatus: 401 }),
			);
			expect(deps.refreshed).toHaveLength(2);
			expect(seen).toHaveLength(2);
		} finally {
			await server.close();
		}
	});

	it("refreshes a token that expired during a backoff wait before the retry", async () => {
		const { server, seen } = await answersInTurn([{ status: 429, body: "{}" }, found]);
		let expired = false;
		const waits: number[] = [];
		try {
			const deps = depsThrough(server, {
				accessTokenExpired: () => expired,
				backoff: {
					sleep: async (ms) => {
						waits.push(ms);
						// The token's lifetime runs out while the call waits.
						expired = true;
					},
					random: () => 0,
					nowMs: () => 0,
					remainingMs: RATE_LIMIT_JOB_BUDGET_MS,
				},
			});
			expect(await getCalendar(deps, "cal_1")).toEqual(ok({ found: true, id: "cal_1" }));
			expect(waits).toEqual([1_000]);
			expect(deps.refreshed).toHaveLength(1);
			expect(seen.map((call) => call.authorization)).toEqual([
				"Bearer access-token",
				"Bearer refreshed-token",
			]);
		} finally {
			await server.close();
		}
	});

	it("refreshes and retries on a 401 that follows a backoff", async () => {
		const { server, seen } = await answersInTurn([
			{ status: 429, body: "{}" },
			unauthorized,
			found,
		]);
		try {
			const deps = depsThrough(server);
			expect(await getCalendar(deps, "cal_1")).toEqual(ok({ found: true, id: "cal_1" }));
			expect(deps.refreshed).toHaveLength(1);
			expect(seen).toHaveLength(3);
			expect(deps.paced).toHaveLength(3);
		} finally {
			await server.close();
		}
	});
});
