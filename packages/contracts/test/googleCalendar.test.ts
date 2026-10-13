import { describe, expect, it } from "vitest";
import {
	claimedJobSchema,
	completeJobRequestSchema,
	DISCONNECTED_GOOGLE_CALENDAR_STATE,
	EARNINGS_LIMITS,
	GOOGLE_AUTH_URL_PREFIX,
	GOOGLE_CALENDAR_FAILURE_CODES,
	GOOGLE_CALENDAR_FAILURE_REASONS,
	GOOGLE_SYNC_MAX_EVENTS,
	googleAuthUrlEventSchema,
	googleCalendarActionSchema,
	googleCalendarFailure,
	googleCalendarFailureSchema,
	googleCalendarStateSchema,
	googleCalendarSyncPayloadSchema,
	googleEventBodySchema,
	jobKindSchema,
	runnerEventSchema,
	watchlistResponseSchema,
} from "../src/index.ts";
import { resourceUsage } from "./fixtures.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

const T0 = "2026-10-11T03:00:00.000Z";
const AUTH_URL =
	"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A9&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.app.created&state=s&code_challenge=c&code_challenge_method=S256&access_type=offline&prompt=consent";

const EVENT_BODY = {
	id: "a".repeat(32),
	summary: "AAPL Apple Inc earnings (Q4 2026)",
	description: "Scheduled earnings announcement for AAPL (Q4 2026).",
	startDate: "2026-10-29",
	endDate: "2026-10-30",
	privateProperties: { researchWorkspace: "earnings", stockId: "us:AAPL", periodKey: "2026-q4" },
	sourceTitle: "Finnhub",
	sourceUrl: "https://finnhub.io/",
} as const;

describe("google calendar state", () => {
	it("accepts the disconnected placeholder and requires every field", () => {
		expectAccepted(googleCalendarStateSchema, DISCONNECTED_GOOGLE_CALENDAR_STATE);
		expect(DISCONNECTED_GOOGLE_CALENDAR_STATE.status).toBe("disconnected");
		for (const status of ["disconnected", "connecting", "connected", "needs-reconnect"]) {
			expectAccepted(googleCalendarStateSchema, {
				...DISCONNECTED_GOOGLE_CALENDAR_STATE,
				status,
			});
		}
		expectRejected(
			googleCalendarStateSchema,
			without(DISCONNECTED_GOOGLE_CALENDAR_STATE, "status"),
		);
		expectRejected(googleCalendarStateSchema, {
			...DISCONNECTED_GOOGLE_CALENDAR_STATE,
			status: "linked",
		});
		// Strict: no extra keys.
		expectRejected(googleCalendarStateSchema, {
			...DISCONNECTED_GOOGLE_CALENDAR_STATE,
			refreshToken: "secret",
		});
	});

	it("pins the auth URL to the Google OAuth prefix and bounds it", () => {
		expect(GOOGLE_AUTH_URL_PREFIX).toBe("https://accounts.google.com/o/oauth2/v2/auth?");
		expectAccepted(googleCalendarStateSchema, {
			...DISCONNECTED_GOOGLE_CALENDAR_STATE,
			status: "connecting",
			authUrl: AUTH_URL,
		});
		expectRejected(googleCalendarStateSchema, {
			...DISCONNECTED_GOOGLE_CALENDAR_STATE,
			authUrl: "https://evil.example.com/o/oauth2/v2/auth?x=1",
		});
		expectRejected(googleCalendarStateSchema, {
			...DISCONNECTED_GOOGLE_CALENDAR_STATE,
			authUrl: `${AUTH_URL}${"x".repeat(2000)}`,
		});
	});

	it("accepts a connected state with counts and an active run", () => {
		expectAccepted(googleCalendarStateSchema, {
			status: "connected",
			authUrl: null,
			calendarId: "cal_abc",
			connectedAt: T0,
			lastSyncedAt: T0,
			lastSync: { inserted: 3, updated: 0, deleted: 1, unchanged: 5 },
			inSync: true,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: null,
		});
	});

	it("is required on the watchlist response", () => {
		expectAccepted(watchlistResponseSchema, {
			stocks: [],
			refresh: {
				activeRunId: null,
				activeRunState: null,
				lastSucceededAt: null,
				lastFailure: null,
			},
			feed: { enabled: false, createdAt: null },
			googleCalendar: DISCONNECTED_GOOGLE_CALENDAR_STATE,
		});
		expectRejected(
			watchlistResponseSchema,
			{
				stocks: [],
				refresh: {
					activeRunId: null,
					activeRunState: null,
					lastSucceededAt: null,
					lastFailure: null,
				},
				feed: { enabled: false, createdAt: null },
			},
			["googleCalendar"],
		);
	});

	it("pins every failure code to one fixed reason sentence", () => {
		expect(GOOGLE_CALENDAR_FAILURE_CODES).toEqual([
			"GOOGLE_NOT_CONFIGURED",
			"GOOGLE_AUTH_TIMEOUT",
			"GOOGLE_CONSENT_DENIED",
			"GOOGLE_SCOPE_MISSING",
			"GOOGLE_AUTH_EXPIRED",
			"GOOGLE_RATE_LIMITED",
			"GOOGLE_REQUEST_FAILED",
			"GOOGLE_NOT_CONNECTED",
		]);
		for (const code of GOOGLE_CALENDAR_FAILURE_CODES) {
			const failure = googleCalendarFailure(code, T0);
			expect(failure.reason).toBe(GOOGLE_CALENDAR_FAILURE_REASONS[code]);
			expect(failure.reason.length).toBeGreaterThan(0);
			expect(failure.reason.length).toBeLessThanOrEqual(300);
			expectAccepted(googleCalendarFailureSchema, failure);
		}
		expect(GOOGLE_CALENDAR_FAILURE_REASONS.GOOGLE_NOT_CONFIGURED).toBe(
			"Google Calendar is not configured; set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in apps/runner/.env.",
		);
		expectRejected(googleCalendarFailureSchema, { code: "BROKEN", reason: "x", at: T0 });
		for (const action of ["connect", "sync", "disconnect"]) {
			expectAccepted(googleCalendarActionSchema, action);
		}
		expectRejected(googleCalendarActionSchema, "refresh");
	});
});

describe("google calendar event bodies", () => {
	it("accepts a 32-char base32hex id and bounds the sync payload", () => {
		expect(GOOGLE_SYNC_MAX_EVENTS).toBe(
			EARNINGS_LIMITS.maxStocks * EARNINGS_LIMITS.maxEventsPerStock,
		);
		expect(GOOGLE_SYNC_MAX_EVENTS).toBe(400);
		expectAccepted(googleEventBodySchema, EVENT_BODY);
		expectRejected(googleEventBodySchema, { ...EVENT_BODY, id: "A".repeat(32) }, ["id"]);
		expectRejected(googleEventBodySchema, { ...EVENT_BODY, id: "w".repeat(32) }, ["id"]);
		expectRejected(googleEventBodySchema, { ...EVENT_BODY, id: "a".repeat(31) }, ["id"]);
		expectAccepted(googleCalendarSyncPayloadSchema, {
			action: "sync",
			calendarId: null,
			desiredDigest: "a".repeat(64),
			events: [EVENT_BODY],
		});
		expectRejected(googleCalendarSyncPayloadSchema, {
			action: "sync",
			calendarId: null,
			desiredDigest: "xyz",
			events: [],
		});
		expectRejected(googleCalendarSyncPayloadSchema, {
			action: "sync",
			calendarId: null,
			desiredDigest: "a".repeat(64),
			events: repeat(EVENT_BODY, GOOGLE_SYNC_MAX_EVENTS + 1),
		});
	});
});

describe("google-calendar jobs (additive)", () => {
	const lease = {
		runId: "run_gcal",
		leaseGeneration: 1,
		leaseExpiresAt: T0,
		attempt: 1,
		heartbeatIntervalMs: 15_000,
		sources: [],
	};

	it("knows the google-calendar kind and its claimed payloads", () => {
		expectAccepted(jobKindSchema, "google-calendar");
		expectAccepted(claimedJobSchema, { kind: "google-calendar", ...lease, action: "connect" });
		expectAccepted(claimedJobSchema, { kind: "google-calendar", ...lease, action: "disconnect" });
		expectAccepted(claimedJobSchema, {
			kind: "google-calendar",
			...lease,
			action: "sync",
			calendarId: null,
			desiredDigest: "b".repeat(64),
			events: [EVENT_BODY],
		});
		expectRejected(claimedJobSchema, { kind: "google-calendar", ...lease, action: "refresh" });
		expectRejected(claimedJobSchema, {
			kind: "google-calendar",
			...lease,
			action: "sync",
			calendarId: null,
			desiredDigest: "b".repeat(64),
			events: repeat(EVENT_BODY, GOOGLE_SYNC_MAX_EVENTS + 1),
		});
	});

	it("accepts the google-auth-url runner event, pinned and bounded", () => {
		expectAccepted(googleAuthUrlEventSchema, { type: "google-auth-url", url: AUTH_URL });
		expectAccepted(runnerEventSchema, {
			seq: 0,
			at: T0,
			event: { type: "google-auth-url", url: AUTH_URL },
		});
		expectRejected(runnerEventSchema, {
			seq: 0,
			at: T0,
			event: { type: "google-auth-url", url: "https://evil.example.com/auth?x=1" },
		});
		expectRejected(runnerEventSchema, {
			seq: 0,
			at: T0,
			event: { type: "google-auth-url", url: `${AUTH_URL}${"x".repeat(2000)}` },
		});
	});

	it("accepts the three completion outcomes", () => {
		const base = { leaseGeneration: 1, usage: resourceUsage };
		expectAccepted(completeJobRequestSchema, {
			outcome: "google-calendar-connected",
			...base,
			calendarId: "cal_abc",
		});
		expectAccepted(completeJobRequestSchema, {
			outcome: "google-calendar-synced",
			...base,
			calendarId: "cal_abc",
			desiredDigest: "c".repeat(64),
			inserted: 3,
			updated: 0,
			deleted: 1,
			unchanged: 5,
		});
		expectAccepted(completeJobRequestSchema, {
			outcome: "google-calendar-disconnected",
			...base,
			revoked: false,
		});
		expectRejected(completeJobRequestSchema, {
			outcome: "google-calendar-connected",
			...base,
			calendarId: "",
		});
		expectRejected(completeJobRequestSchema, {
			outcome: "google-calendar-synced",
			...base,
			calendarId: "cal_abc",
			desiredDigest: "short",
			inserted: 0,
			updated: 0,
			deleted: 0,
			unchanged: 0,
		});
	});
});
