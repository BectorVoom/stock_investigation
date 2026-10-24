/**
 * Google Calendar application service (FR-019 section 2.5): queue rules,
 * desired-set assembly, state projection and completion patches — against
 * stub repositories and the in-memory link double.
 */

import { googleEventId } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	assembleDesiredEvents,
	createGoogleCalendarService,
	createInMemoryGoogleCalendarRepository,
	googleSuccessPatch,
	googleTerminalPatch,
	toGoogleCalendarState,
} from "../src/googleCalendar.ts";
import type {
	Clock,
	EarningsRepository,
	Hasher,
	IdGenerator,
	JobRecord,
	JobRepository,
	RateLimiter,
	WatchlistRepository,
} from "../src/ports.ts";
import { headerSafe } from "../src/watchlist.ts";

const OWNER = "owner_1";
const NOW = "2026-10-13T00:00:00.000Z";

function fixedClock(): Clock {
	return { nowMs: () => Date.parse(NOW), nowIso: () => NOW };
}

const ids: IdGenerator = { newId: (prefix) => `${prefix}_1` };
const allowLimiter: RateLimiter = { consume: async () => true };
/** Deterministic stand-in hasher: every input hashes to `ab` × 32 (valid 64-hex). */
const fixedHasher: Hasher = { sha256Hex: async () => "ab".repeat(32) };

function stubJobs(
	overrides: Partial<JobRepository> = {},
): JobRepository & { inserted: Parameters<JobRepository["insert"]>[0][] } {
	const unused = (): never => {
		throw new Error("not used by this test");
	};
	const inserted: Parameters<JobRepository["insert"]>[0][] = [];
	return {
		insert: async (job) => {
			inserted.push(job);
			return { kind: "inserted" };
		},
		findByIdempotencyKey: async () => null,
		get: unused,
		list: unused,
		findLatestResearchRequest: unused,
		listClaimCandidates: unused,
		write: unused,
		writeWithEvents: unused,
		listProgress: unused,
		findActiveByKind: async () => null,
		findActiveNotebookAssist: async () => null,
		findLatestSuccessAtByKind: async () => null,
		findLatestFailureByKind: async () => null,
		findLatestFailedByKind: async () => null,
		countUnfinished: async () => 0,
		...overrides,
		inserted,
	};
}

const EMPTY_WATCHLIST: WatchlistRepository = {
	listStocks: async () => [],
	getStock: async () => null,
	countStocks: async () => 0,
	insertStock: async () => "added",
	removeStock: async () => false,
};

const EMPTY_EARNINGS: EarningsRepository = { getEvents: async () => [] };

function service(
	jobs: JobRepository,
	googleCalendar = createInMemoryGoogleCalendarRepository(),
	limiter: RateLimiter = allowLimiter,
	recorded: { action: string; detail: string }[] = [],
) {
	return {
		recorded,
		googleCalendar,
		service: createGoogleCalendarService({
			jobs,
			googleCalendar,
			clock: fixedClock(),
			ids,
			rateLimiter: limiter,
			audit: {
				record: async (entry) => void recorded.push({ action: entry.action, detail: entry.detail }),
			},
		}),
	};
}

/** A leased google-calendar job, as the job repository would return it. */
function leasedGoogleJob(runId: string, action: "connect" | "sync" | "disconnect"): JobRecord {
	return {
		runId,
		ownerId: OWNER,
		kind: "google-calendar",
		state: "claimed",
		request: { action },
		workspaceId: null,
		usage: {
			agentSteps: 0,
			toolCalls: 0,
			inputBytes: 0,
			knownCostUsd: 0,
			hasUnmeteredUsage: false,
		},
		attempt: 1,
		maxAttempts: 3,
		leaseGeneration: 1,
		leaseOwnerId: "cred",
		leaseExpiresAt: NOW,
		lastEventSeq: -1,
		cancelRequested: false,
		failureCode: null,
		failureDetail: null,
		approvalRequest: null,
		retryOfRunId: null,
		contextAnchorSeq: null,
		verificationStatus: null,
		providerModel: null,
		providerSessionRef: null,
		completedGeneration: null,
		provenance: null,
		version: 1,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe("queue", () => {
	it("queues connect: status connecting, job carries the action, audit recorded", async () => {
		const jobs = stubJobs();
		const harness = service(jobs);
		const queued = await harness.service.queue(OWNER, "connect", "key-1");
		expect(queued.ok).toBe(true);
		if (!queued.ok) return;
		expect(queued.value.replayed).toBe(false);
		expect(queued.value.run.kind).toBe("google-calendar");
		expect(jobs.inserted).toHaveLength(1);
		expect(jobs.inserted[0]).toMatchObject({
			kind: "google-calendar",
			request: { action: "connect" },
		});
		expect(await harness.googleCalendar.get(OWNER)).toMatchObject({
			status: "connecting",
			connectFrom: "disconnected",
			pendingAuthUrl: null,
		});
		expect(harness.recorded).toEqual([
			{ action: "google_calendar.connect_requested", detail: "action=connect" },
		]);
	});

	it("undoes `connecting` when the connect job is not stored (capacity reached)", async () => {
		const jobs = stubJobs({ insert: async () => ({ kind: "at-capacity" }) });
		const googleCalendar = createInMemoryGoogleCalendarRepository();
		await googleCalendar.apply(OWNER, { status: "needs-reconnect", calendarId: "cal_1" }, NOW);
		const harness = service(jobs, googleCalendar);
		const queued = await harness.service.queue(OWNER, "connect", "key-1");
		expect(queued.ok).toBe(false);
		// Not left `connecting` with no run and no sign-in link.
		expect(await googleCalendar.get(OWNER)).toMatchObject({
			status: "needs-reconnect",
			connectFrom: null,
			pendingAuthUrl: null,
			calendarId: "cal_1",
		});
		expect(harness.recorded).toEqual([]);
	});

	it("keeps a concurrent connect's `connecting` status when it wins the insert race", async () => {
		const googleCalendar = createInMemoryGoogleCalendarRepository();
		const winner = leasedGoogleJob("run_winner", "connect");
		let raced = false;
		const jobs = stubJobs({
			// The first check sees nothing; the winner appears before our insert.
			findActiveByKind: async () => (raced ? winner : null),
			insert: async () => {
				raced = true;
				// The winner's sign-in link arrived while we were inserting.
				await googleCalendar.setPendingAuthUrl(OWNER, "https://accounts.google.com/x", NOW);
				return { kind: "kind-active", job: winner };
			},
		});
		const harness = service(jobs, googleCalendar);
		const queued = await harness.service.queue(OWNER, "connect", "key-2");
		expect(queued.ok).toBe(true);
		if (!queued.ok) return;
		expect(queued.value).toMatchObject({ replayed: true, run: { runId: "run_winner" } });
		expect(await googleCalendar.get(OWNER)).toMatchObject({
			status: "connecting",
			pendingAuthUrl: "https://accounts.google.com/x",
		});
	});

	it("returns the active run while one is non-terminal", async () => {
		const active = {
			runId: "run_active",
			ownerId: OWNER,
			kind: "google-calendar",
			state: "claimed",
			request: { action: "connect" },
			workspaceId: null,
			usage: {
				agentSteps: 0,
				toolCalls: 0,
				inputBytes: 0,
				knownCostUsd: 0,
				hasUnmeteredUsage: false,
			},
			attempt: 1,
			maxAttempts: 3,
			leaseGeneration: 1,
			leaseOwnerId: "cred",
			leaseExpiresAt: NOW,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			approvalRequest: null,
			retryOfRunId: null,
			contextAnchorSeq: null,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 1,
			createdAt: NOW,
			updatedAt: NOW,
		} as const;
		const jobs = stubJobs({ findActiveByKind: async () => ({ ...active }) });
		const harness = service(jobs);
		const queued = await harness.service.queue(OWNER, "connect", "key-2");
		expect(queued.ok).toBe(true);
		if (!queued.ok) return;
		expect(queued.value.replayed).toBe(true);
		expect(queued.value.run.runId).toBe("run_active");
		// A different step is refused rather than answered with the connect run.
		const other = await harness.service.queue(OWNER, "disconnect", "key-3");
		expect(other.ok).toBe(false);
		if (other.ok) return;
		expect(other.error.code).toBe("CONFLICT");
		expect(jobs.inserted).toHaveLength(0);
	});

	it("replays the same idempotency key and rejects reuse across actions", async () => {
		const jobs = stubJobs({
			findByIdempotencyKey: async () => ({
				job: {
					runId: "run_old",
					ownerId: OWNER,
					kind: "google-calendar",
					state: "pending",
					request: { action: "connect" },
					workspaceId: null,
					usage: {
						agentSteps: 0,
						toolCalls: 0,
						inputBytes: 0,
						knownCostUsd: 0,
						hasUnmeteredUsage: false,
					},
					attempt: 0,
					maxAttempts: 3,
					leaseGeneration: 0,
					leaseOwnerId: null,
					leaseExpiresAt: null,
					lastEventSeq: -1,
					cancelRequested: false,
					failureCode: null,
					failureDetail: null,
					approvalRequest: null,
					retryOfRunId: null,
					contextAnchorSeq: null,
					verificationStatus: null,
					providerModel: null,
					providerSessionRef: null,
					completedGeneration: null,
					provenance: null,
					version: 0,
					createdAt: NOW,
					updatedAt: NOW,
				},
				requestFingerprint: "google-calendar:connect",
			}),
		});
		const harness = service(jobs);
		const replay = await harness.service.queue(OWNER, "connect", "key-old");
		expect(replay.ok && replay.value.replayed).toBe(true);
		const reuse = await harness.service.queue(OWNER, "sync", "key-old");
		expect(reuse.ok).toBe(false);
		if (reuse.ok) return;
		expect(reuse.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
	});

	it("refuses sync and disconnect while disconnected", async () => {
		const harness = service(stubJobs());
		for (const action of ["sync", "disconnect"] as const) {
			const queued = await harness.service.queue(OWNER, action, `key-${action}`);
			expect(queued.ok).toBe(false);
			if (queued.ok) continue;
			expect(queued.error.code).toBe("VALIDATION_FAILED");
			expect(queued.error.detail).toBe("GOOGLE_NOT_CONNECTED");
		}
	});

	it("queues sync and disconnect while connected or needs-reconnect", async () => {
		for (const status of ["connected", "needs-reconnect"] as const) {
			const jobs = stubJobs();
			const links = createInMemoryGoogleCalendarRepository();
			await links.apply(OWNER, { status, calendarId: "cal_1" }, NOW);
			const harness = service(jobs, links);
			for (const action of ["sync", "disconnect"] as const) {
				const queued = await harness.service.queue(OWNER, action, `key-${status}-${action}`);
				expect(queued.ok).toBe(true);
			}
			expect(harness.recorded).toEqual([]);
		}
	});
});

describe("desired-set assembly", () => {
	const watchlist: WatchlistRepository = {
		...EMPTY_WATCHLIST,
		listStocks: async () => [
			{
				stockId: "us:AAPL",
				market: "US",
				symbol: "AAPL",
				name: "Apple Inc",
				addedAt: NOW,
				lastRefreshedAt: NOW,
				retrievedAt: NOW,
				unavailableCode: null,
			},
			{
				stockId: "jp:7203",
				market: "JP",
				symbol: "7203",
				name: null,
				addedAt: NOW,
				lastRefreshedAt: NOW,
				retrievedAt: null,
				unavailableCode: "NEVER_REFRESHED",
			},
		],
	};
	const earnings: EarningsRepository = {
		getEvents: async () => [
			{
				stockId: "us:AAPL",
				periodKey: "2026-q4",
				announcementDate: "2026-10-29",
				fiscalPeriodLabel: "Q4 2026",
				fiscalPeriodEnd: null,
				timing: "after-close",
			},
			{
				stockId: "us:AAPL",
				periodKey: "2027-q1",
				announcementDate: null,
				fiscalPeriodLabel: "Q1 2027",
				fiscalPeriodEnd: null,
				timing: "unknown",
			},
			{
				stockId: "jp:7203",
				periodKey: "2026-q3",
				announcementDate: "2026-11-05",
				fiscalPeriodLabel: "Q3",
				fiscalPeriodEnd: null,
				timing: "before-open",
			},
		],
	};

	it("assembles dated events of retrieved stocks only, with deterministic ids", async () => {
		const assembled = await assembleDesiredEvents(
			{ watchlist, earnings, hasher: fixedHasher },
			OWNER,
		);
		expect(assembled.ok).toBe(true);
		if (!assembled.ok) return;
		// Only the dated AAPL event: the undecided one is skipped, and 7203
		// has no retrieved stamp so its dated event is skipped too.
		expect(assembled.value.bodies).toHaveLength(1);
		const body = assembled.value.bodies[0];
		expect(body?.privateProperties.stockId).toBe("us:AAPL");
		expect(body).toMatchObject({
			startDate: "2026-10-29",
			endDate: "2026-10-30",
			privateProperties: {
				researchWorkspace: "earnings",
				stockId: "us:AAPL",
				periodKey: "2026-q4",
			},
			sourceTitle: "Finnhub",
			sourceUrl: "https://finnhub.io/",
		});
		// The id is the first-20-bytes digest (`ab` × 20 here), encoded by
		// the domain — computed independently, not copied from the output.
		const expectedId = googleEventId(new Array<number>(20).fill(0xab));
		if (!expectedId.ok) throw new Error("test vector is invalid");
		expect(body?.id).toBe(expectedId.value);
		expect(body?.id).toMatch(/^[0-9a-v]{32}$/);
		expect(assembled.value.digest).toBe("ab".repeat(32));
	});

	it("assembles an empty set when nothing is retrievable", async () => {
		const assembled = await assembleDesiredEvents(
			{ watchlist: EMPTY_WATCHLIST, earnings: EMPTY_EARNINGS, hasher: fixedHasher },
			OWNER,
		);
		expect(assembled.ok).toBe(true);
		if (!assembled.ok) return;
		expect(assembled.value.bodies).toEqual([]);
		expect(assembled.value.digest).toBe("ab".repeat(32));
	});
});

describe("state projection", () => {
	const at = NOW;
	it("projects a fresh owner as disconnected with the active run", () => {
		expect(
			toGoogleCalendarState(null, { runId: "run_1", state: "claimed", action: "connect" }, null),
		).toEqual({
			status: "disconnected",
			authUrl: null,
			calendarId: null,
			connectedAt: null,
			lastSyncedAt: null,
			lastSync: null,
			inSync: null,
			activeRunId: "run_1",
			activeRunState: "claimed",
			activeAction: "connect",
			lastFailure: null,
		});
	});

	it("shows the pending URL only while connecting", () => {
		const link = {
			status: "connecting",
			connectFrom: "disconnected",
			pendingAuthUrl: "https://accounts.google.com/o/oauth2/v2/auth?x",
			calendarId: null,
			connectedAt: null,
			lastSyncedAt: null,
			syncedDigest: null,
			lastSync: null,
			lastFailureCode: null,
			lastFailureAt: null,
			updatedAt: at,
		} as const;
		const running = { runId: "run_1", state: "collecting", action: "connect" } as const;
		expect(toGoogleCalendarState(link, running, null).authUrl).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth?x",
		);
		expect(toGoogleCalendarState({ ...link, status: "connected" }, null, null).authUrl).toBe(null);
		// A `connecting` row whose run is gone shows the restore status, never
		// a sign-in link nobody listens for.
		expect(toGoogleCalendarState(link, null, null)).toMatchObject({
			status: "disconnected",
			authUrl: null,
		});
		expect(
			toGoogleCalendarState({ ...link, connectFrom: "needs-reconnect" }, null, null).status,
		).toBe("needs-reconnect");
	});

	it("computes inSync from the stored versus current digest", () => {
		const digest = "a".repeat(64);
		const link = {
			status: "connected",
			connectFrom: null,
			pendingAuthUrl: null,
			calendarId: "cal_1",
			connectedAt: at,
			lastSyncedAt: at,
			syncedDigest: digest,
			lastSync: { inserted: 1, updated: 0, deleted: 0, unchanged: 0 },
			lastFailureCode: null,
			lastFailureAt: null,
			updatedAt: at,
		} as const;
		expect(toGoogleCalendarState(link, null, digest).inSync).toBe(true);
		expect(toGoogleCalendarState(link, null, "b".repeat(64)).inSync).toBe(false);
		expect(toGoogleCalendarState(link, null, null).inSync).toBe(false);
		expect(toGoogleCalendarState({ ...link, syncedDigest: null }, null, digest).inSync).toBe(false);
		expect(toGoogleCalendarState({ ...link, status: "needs-reconnect" }, null, digest).inSync).toBe(
			null,
		);
	});

	it("maps failures to fixed reasons, unknown codes to the generic one", () => {
		const link = {
			status: "needs-reconnect",
			connectFrom: null,
			pendingAuthUrl: null,
			calendarId: "cal_1",
			connectedAt: at,
			lastSyncedAt: null,
			syncedDigest: null,
			lastSync: null,
			lastFailureCode: "GOOGLE_AUTH_EXPIRED",
			lastFailureAt: at,
			updatedAt: at,
		} as const;
		expect(toGoogleCalendarState(link, null, null).lastFailure).toEqual({
			code: "GOOGLE_AUTH_EXPIRED",
			reason: "The Google connection expired; reconnect Google Calendar.",
			at,
		});
		expect(
			toGoogleCalendarState({ ...link, lastFailureCode: "SOME_RUNNER_CODE" }, null, null)
				.lastFailure,
		).toEqual({ code: "GOOGLE_REQUEST_FAILED", reason: "The Google Calendar request failed.", at });
	});
});

describe("completion patches", () => {
	it("builds the three success patches with stamps", () => {
		expect(
			googleSuccessPatch({ outcome: "google-calendar-connected", calendarId: "cal_1" }, NOW),
		).toEqual({
			status: "connected",
			connectFrom: null,
			pendingAuthUrl: null,
			calendarId: "cal_1",
			connectedAt: NOW,
			lastSyncedAt: null,
			syncedDigest: null,
			lastSync: null,
			lastFailureCode: null,
			lastFailureAt: null,
		});
		expect(
			googleSuccessPatch(
				{
					outcome: "google-calendar-synced",
					calendarId: "cal_2",
					desiredDigest: "d".repeat(64),
					inserted: 3,
					updated: 1,
					deleted: 0,
					unchanged: 5,
				},
				NOW,
			),
		).toEqual({
			status: "connected",
			calendarId: "cal_2",
			lastSyncedAt: NOW,
			syncedDigest: "d".repeat(64),
			lastSync: { inserted: 3, updated: 1, deleted: 0, unchanged: 5 },
			lastFailureCode: null,
			lastFailureAt: null,
		});
		expect(googleSuccessPatch({ outcome: "google-calendar-disconnected" }, NOW)).toMatchObject({
			status: "disconnected",
			calendarId: null,
		});
	});

	it("restores the previous status for a failed or cancelled connect", () => {
		const link = {
			status: "connecting",
			connectFrom: "needs-reconnect",
			pendingAuthUrl: "https://accounts.google.com/o/oauth2/v2/auth?x",
			calendarId: "cal_1",
			connectedAt: NOW,
			lastSyncedAt: null,
			syncedDigest: null,
			lastSync: null,
			lastFailureCode: null,
			lastFailureAt: null,
			updatedAt: NOW,
		} as const;
		expect(googleTerminalPatch(link, "connect", "failed", "GOOGLE_AUTH_TIMEOUT", NOW)).toEqual({
			status: "needs-reconnect",
			connectFrom: null,
			pendingAuthUrl: null,
			lastFailureCode: "GOOGLE_AUTH_TIMEOUT",
			lastFailureAt: NOW,
		});
		expect(googleTerminalPatch(link, "connect", "cancelled", null, NOW)).toEqual({
			status: "needs-reconnect",
			connectFrom: null,
			pendingAuthUrl: null,
		});
		expect(
			googleTerminalPatch(null, "connect", "failed", "GOOGLE_CONSENT_DENIED", NOW),
		).toMatchObject({
			status: "disconnected",
		});
	});

	it("moves sync to needs-reconnect only on auth-expired; disconnect failures only record", () => {
		expect(googleTerminalPatch(null, "sync", "failed", "GOOGLE_AUTH_EXPIRED", NOW)).toEqual({
			status: "needs-reconnect",
			lastFailureCode: "GOOGLE_AUTH_EXPIRED",
			lastFailureAt: NOW,
		});
		expect(googleTerminalPatch(null, "sync", "failed", "GOOGLE_RATE_LIMITED", NOW)).toEqual({
			lastFailureCode: "GOOGLE_RATE_LIMITED",
			lastFailureAt: NOW,
		});
		expect(googleTerminalPatch(null, "sync", "cancelled", null, NOW)).toBe(null);
		expect(googleTerminalPatch(null, "disconnect", "failed", "GOOGLE_REQUEST_FAILED", NOW)).toEqual(
			{
				lastFailureCode: "GOOGLE_REQUEST_FAILED",
				lastFailureAt: NOW,
			},
		);
		expect(googleTerminalPatch(null, "disconnect", "cancelled", null, NOW)).toBe(null);
	});
});

describe("headerSafe (runner-supplied text inside the watchlist ETag)", () => {
	it("passes printable ASCII through and escapes everything a header value cannot carry", () => {
		expect(headerSafe("https://accounts.google.com/o/oauth2/v2/auth?a=b&c=d")).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth?a=b&c=d",
		);
		const hostile = 'x"y\\z%\n\u3042 \ud800';
		const safe = headerSafe(hostile);
		expect(safe).toMatch(/^[\x21-\x7e]*$/);
		expect(safe).not.toContain('"');
		// It is a header value any runtime accepts.
		expect(() => new Headers({ ETag: `"${safe}"` })).not.toThrow();
	});

	it("never maps two different values to the same text", () => {
		expect(headerSafe("a%62;")).not.toBe(headerSafe("ab"));
		expect(headerSafe("%")).toBe("%25;");
	});
});
