/**
 * Google Calendar sync API layer (FR-019 section 2.5): routes, the
 * `google-auth-url` event, completions, ETag coverage and the API security
 * properties (owner scoping, CSRF/idempotency, strict bodies). Runs in the
 * Workers runtime (real local D1) and, through the root config, against
 * `node:sqlite` too.
 */
import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import {
	completeJobResponseSchema,
	GOOGLE_AUTH_URL_PREFIX,
	researchRunResponseSchema,
	watchlistResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	claim,
	createHarness,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/** A link shaped exactly like the runner's (the event schema checks its contents). */
const AUTH_URL = `${GOOGLE_AUTH_URL_PREFIX}response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2F&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.app.created&access_type=offline&prompt=consent&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=q7Zk2mVh0xJt4Yb9Lw3Rn8Uc5Df1Gs6Pa0Oe2Ix7Hy4`;

async function googleState(harness: ReturnType<typeof createHarness>) {
	const response = await harness.call("GET", "/watchlist");
	expect(response.status).toBe(200);
	return (await body(response, watchlistResponseSchema)).googleCalendar;
}

async function queueGoogle(
	harness: ReturnType<typeof createHarness>,
	action: "connect" | "sync" | "disconnect",
	key: Record<string, string> = idempotencyKey(),
) {
	const response = await harness.call("POST", `/google-calendar/${action}`, undefined, key);
	expect(response.status).toBe(202);
	return (await body(response, researchRunResponseSchema)).run;
}

async function seedOneDatedEvent(harness: ReturnType<typeof createHarness>, token: string) {
	const added = await harness.call("POST", "/watchlist/stocks", { market: "US", symbol: "AAPL" });
	expect(added.status).toBe(200);
	const refresh = await harness.call("POST", "/watchlist/refresh", undefined, idempotencyKey());
	expect(refresh.status).toBe(202);
	const lease = await claim(harness, token);
	expect(lease?.kind).toBe("earnings-refresh");
	if (lease?.kind !== "earnings-refresh") throw new Error("expected an earnings claim");
	await advanceToPublishing(harness, token, lease);
	const completed = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
		outcome: "earnings-refreshed",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		stocks: [
			{
				stockId: "us:AAPL",
				fetchedAt: harness.time.clock.nowIso(),
				name: "Apple Inc",
				events: [
					{
						periodKey: "2026-q4",
						announcementDate: "2026-10-29",
						fiscalPeriodLabel: "Q4 2026",
						fiscalPeriodEnd: null,
						timing: "after-close",
					},
				],
				errorCode: null,
			},
		],
	});
	expect(completed.status).toBe(200);
}

describe("google-calendar routes (FR-019 section 2.5)", () => {
	it("queues connect: status connecting with the active run, covered by the ETag", async () => {
		const harness = createHarness();
		const before = await harness.call("GET", "/watchlist");
		const beforeEtag = before.headers.get("ETag");
		expect((await googleState(harness)).status).toBe("disconnected");
		const run = await queueGoogle(harness, "connect");
		expect(run.kind).toBe("google-calendar");
		expect(run.request).toBe(null);
		const state = await googleState(harness);
		expect(state.status).toBe("connecting");
		expect(state.authUrl).toBe(null);
		expect(state.activeRunId).toBe(run.runId);
		expect(state.activeRunState).toBe("pending");
		expect(state.activeAction).toBe("connect");
		const after = await harness.call("GET", "/watchlist");
		expect(after.headers.get("ETag")).not.toBe(beforeEtag);
	});

	it("refuses sync and disconnect while disconnected, with the stable code", async () => {
		const harness = createHarness();
		for (const action of ["sync", "disconnect"] as const) {
			const response = await harness.call(
				"POST",
				`/google-calendar/${action}`,
				undefined,
				idempotencyKey(),
			);
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe("VALIDATION_FAILED");
			const payload: unknown = await (
				await harness.call("POST", `/google-calendar/${action}`, undefined, idempotencyKey())
			).json();
			expect(JSON.stringify(payload)).toContain("GOOGLE_NOT_CONNECTED");
		}
	});

	it("answers the same step with the active run and refuses a different one (kind-active rule)", async () => {
		const harness = createHarness();
		const first = await queueGoogle(harness, "connect");
		const again = await queueGoogle(harness, "connect");
		expect(again.runId).toBe(first.runId);
		// A different step is not answered 202 with the connect run — that
		// would look as if it had been queued.
		for (const action of ["sync", "disconnect"] as const) {
			const other = await harness.call(
				"POST",
				`/google-calendar/${action}`,
				undefined,
				idempotencyKey(),
			);
			expect(other.status).toBe(409);
			expect(await errorCode(other)).toBe("CONFLICT");
		}
		expect((await googleState(harness)).activeRunId).toBe(first.runId);
	});

	it("replays idempotency keys and rejects reuse across actions", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const key = idempotencyKey();
		const first = await queueGoogle(harness, "connect", key);
		const replay = await queueGoogle(harness, "connect", key);
		expect(replay.runId).toBe(first.runId);
		// After it completes, the same key for another action is a reuse.
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, lease);
		const done = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "google-calendar-connected",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
		});
		expect(done.status).toBe(200);
		const reuse = await harness.call("POST", "/google-calendar/sync", undefined, key);
		expect(reuse.status).toBe(409);
		expect(await errorCode(reuse)).toBe("IDEMPOTENCY_KEY_REUSED");
	});
});

describe("google-auth-url event (FR-019 section 2.5, security check 3)", () => {
	async function connectLease(harness: ReturnType<typeof createHarness>, token: string) {
		await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		expect(lease?.kind).toBe("google-calendar");
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		expect(lease.action).toBe("connect");
		expect(lease).not.toHaveProperty("calendarId");
		return lease;
	}

	it("stores the sign-in URL for a leased connect job; the ETag moves", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const lease = await connectLease(harness, token);
		const before = (await harness.call("GET", "/watchlist")).headers.get("ETag");
		const sent = await harness.runner(token, `/jobs/${lease.runId}/events`, {
			leaseGeneration: lease.leaseGeneration,
			events: [
				{
					seq: 0,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect(sent.status).toBe(200);
		const state = await googleState(harness);
		expect(state.status).toBe("connecting");
		expect(state.authUrl).toBe(AUTH_URL);
		expect((await harness.call("GET", "/watchlist")).headers.get("ETag")).not.toBe(before);
	});

	it("rejects a URL outside the pinned prefix (strict body)", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const lease = await connectLease(harness, token);
		const sent = await harness.runner(token, `/jobs/${lease.runId}/events`, {
			leaseGeneration: lease.leaseGeneration,
			events: [
				{
					seq: 0,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: "https://evil.example.com/sign-in" },
				},
			],
		});
		expect(sent.status).toBe(400);
		expect((await googleState(harness)).authUrl).toBe(null);
	});

	it("rejects the event for another job kind, another action, or a stale lease", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		// Another job kind: an earnings-refresh run.
		await seedOneDatedEvent(harness, token);
		await harness.call("POST", "/watchlist/stocks", { market: "JP", symbol: "7203" });
		const refresh = await harness.call("POST", "/watchlist/refresh", undefined, idempotencyKey());
		expect(refresh.status).toBe(202);
		const earnings = await claim(harness, token);
		expect(earnings?.kind).toBe("earnings-refresh");
		if (earnings?.kind !== "earnings-refresh") throw new Error("expected an earnings claim");
		const wrongKind = await harness.runner(token, `/jobs/${earnings.runId}/events`, {
			leaseGeneration: earnings.leaseGeneration,
			events: [
				{
					seq: 0,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect(wrongKind.status).toBe(400);
		expect(await errorCode(wrongKind)).toBe("VALIDATION_FAILED");

		// Another action: finish the earnings run, connect, then queue a sync.
		await advanceToPublishing(harness, token, earnings);
		const done = await harness.runner(token, `/jobs/${earnings.runId}/complete`, {
			outcome: "earnings-refreshed",
			leaseGeneration: earnings.leaseGeneration,
			usage: USAGE,
			stocks: [],
		});
		expect(done.status).toBe(200);
		await queueGoogle(harness, "connect");
		const connect = await claim(harness, token);
		if (connect?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, connect);
		const linked = await harness.runner(token, `/jobs/${connect.runId}/complete`, {
			outcome: "google-calendar-connected",
			leaseGeneration: connect.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
		});
		expect(linked.status).toBe(200);
		await queueGoogle(harness, "sync");
		const sync = await claim(harness, token);
		if (sync?.kind !== "google-calendar") throw new Error("expected a google claim");
		expect(sync.action).toBe("sync");
		const wrongAction = await harness.runner(token, `/jobs/${sync.runId}/events`, {
			leaseGeneration: sync.leaseGeneration,
			events: [
				{
					seq: 0,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect(wrongAction.status).toBe(400);
		expect(await errorCode(wrongAction)).toBe("VALIDATION_FAILED");

		// A stale lease generation for the connect run.
		const stale = await harness.runner(token, `/jobs/${connect.runId}/events`, {
			leaseGeneration: connect.leaseGeneration,
			events: [
				{
					seq: 99,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("STALE_LEASE");
	});
});

describe("google-calendar completions (FR-019 section 2.5)", () => {
	it("connects, syncs with counts and digest, then disconnects cleared", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await seedOneDatedEvent(harness, token);

		await queueGoogle(harness, "connect");
		const connect = await claim(harness, token);
		if (connect?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, connect);
		await harness.runner(token, `/jobs/${connect.runId}/events`, {
			leaseGeneration: connect.leaseGeneration,
			events: [
				{
					seq: 5,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		const linked = await harness.runner(token, `/jobs/${connect.runId}/complete`, {
			outcome: "google-calendar-connected",
			leaseGeneration: connect.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
		});
		expect(linked.status).toBe(200);
		expect((await body(linked, completeJobResponseSchema)).state).toBe("completed");
		const connected = await googleState(harness);
		expect(connected).toMatchObject({
			status: "connected",
			authUrl: null,
			calendarId: "cal_1",
			activeRunId: null,
			activeAction: null,
			inSync: false,
		});
		expect(connected.connectedAt).not.toBe(null);
		expect(connected.lastFailure).toBe(null);

		await queueGoogle(harness, "sync");
		const sync = await claim(harness, token);
		if (sync?.kind !== "google-calendar") throw new Error("expected a google claim");
		expect(sync.action).toBe("sync");
		expect(sync.calendarId).toBe("cal_1");
		const syncEvents = sync.events ?? [];
		expect(syncEvents).toHaveLength(1);
		expect(syncEvents[0]?.privateProperties.stockId).toBe("us:AAPL");
		await advanceToPublishing(harness, token, sync);
		const synced = await harness.runner(token, `/jobs/${sync.runId}/complete`, {
			outcome: "google-calendar-synced",
			leaseGeneration: sync.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
			desiredDigest: sync.desiredDigest,
			inserted: 1,
			updated: 0,
			deleted: 0,
			unchanged: 0,
		});
		expect(synced.status).toBe(200);
		const afterSync = await googleState(harness);
		expect(afterSync).toMatchObject({
			status: "connected",
			calendarId: "cal_1",
			lastSync: { inserted: 1, updated: 0, deleted: 0, unchanged: 0 },
			inSync: true,
		});
		expect(afterSync.lastSyncedAt).not.toBe(null);

		// A removed stock flips inSync without any extra write.
		const stocks = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(stocks.stocks).toHaveLength(1);
		const removed = await harness.call("DELETE", "/watchlist/stocks/us:AAPL");
		expect(removed.status).toBe(200);
		expect((await googleState(harness)).inSync).toBe(false);

		await queueGoogle(harness, "disconnect");
		const bye = await claim(harness, token);
		if (bye?.kind !== "google-calendar") throw new Error("expected a google claim");
		expect(bye.action).toBe("disconnect");
		await advanceToPublishing(harness, token, bye);
		const gone = await harness.runner(token, `/jobs/${bye.runId}/complete`, {
			outcome: "google-calendar-disconnected",
			leaseGeneration: bye.leaseGeneration,
			usage: USAGE,
			revoked: true,
		});
		expect(gone.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "disconnected",
			calendarId: null,
			connectedAt: null,
			lastSyncedAt: null,
			lastSync: null,
			inSync: null,
			lastFailure: null,
		});
	});

	it("restores a failed connect and moves auth-expired syncs to needs-reconnect", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await seedOneDatedEvent(harness, token);

		// Failed connect from disconnected restores disconnected + records the failure.
		await queueGoogle(harness, "connect");
		const first = await claim(harness, token);
		if (first?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, first);
		const failed = await harness.runner(token, `/jobs/${first.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: first.leaseGeneration,
			usage: USAGE,
			failureCode: "GOOGLE_AUTH_TIMEOUT",
			retryable: false,
		});
		expect(failed.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "disconnected",
			authUrl: null,
			activeRunId: null,
			lastFailure: {
				code: "GOOGLE_AUTH_TIMEOUT",
				reason: "Google sign-in timed out after 5 minutes; try connecting again.",
			},
		});

		// Connect for real, then an auth-expired sync moves to needs-reconnect.
		await queueGoogle(harness, "connect");
		const second = await claim(harness, token);
		if (second?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, second);
		const linked = await harness.runner(token, `/jobs/${second.runId}/complete`, {
			outcome: "google-calendar-connected",
			leaseGeneration: second.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
		});
		expect(linked.status).toBe(200);
		await queueGoogle(harness, "sync");
		const sync = await claim(harness, token);
		if (sync?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, sync);
		const expired = await harness.runner(token, `/jobs/${sync.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: sync.leaseGeneration,
			usage: USAGE,
			failureCode: "GOOGLE_AUTH_EXPIRED",
			retryable: false,
		});
		expect(expired.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "needs-reconnect",
			calendarId: "cal_1",
			lastFailure: { code: "GOOGLE_AUTH_EXPIRED" },
		});

		// A failed connect from needs-reconnect restores needs-reconnect.
		await queueGoogle(harness, "connect");
		const third = await claim(harness, token);
		if (third?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, third);
		const denied = await harness.runner(token, `/jobs/${third.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: third.leaseGeneration,
			usage: USAGE,
			failureCode: "GOOGLE_CONSENT_DENIED",
			retryable: false,
		});
		expect(denied.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "needs-reconnect",
			lastFailure: { code: "GOOGLE_CONSENT_DENIED" },
		});
	});

	it("never retries a google step on its own: a retryable failure is terminal and restores the link", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const run = await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, lease);
		// A runner fault reports `retryable: true`. Re-queueing the connect
		// would restore the link row first, so the retried sign-in link could
		// never be stored: the run has to end here instead.
		const failed = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "GOOGLE_RATE_LIMITED",
			retryable: true,
		});
		expect(failed.status).toBe(200);
		expect((await body(failed, completeJobResponseSchema)).state).toBe("failed");
		expect(await googleState(harness)).toMatchObject({
			status: "disconnected",
			authUrl: null,
			activeRunId: null,
			lastFailure: { code: "GOOGLE_RATE_LIMITED" },
		});
		// Nothing is left to claim.
		expect(await claim(harness, token)).toBeNull();
		const shown = await harness.call("GET", `/research-runs/${run.runId}`);
		expect((await body(shown, researchRunResponseSchema)).run.state).toBe("failed");
	});

	it("refuses an undecidable sync at claim time: failed, recorded, and not left leased", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await seedOneDatedEvent(harness, token);
		await queueGoogle(harness, "connect");
		const connect = await claim(harness, token);
		if (connect?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, connect);
		const linked = await harness.runner(token, `/jobs/${connect.runId}/complete`, {
			outcome: "google-calendar-connected",
			leaseGeneration: connect.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
		});
		expect(linked.status).toBe(200);
		const run = await queueGoogle(harness, "sync");

		// The stored date cannot be turned into an all-day event, so the
		// desired set is undecidable: the claim must refuse it before the
		// lease is granted, or the refusal loses its compare-and-set and the
		// job sits leased to a runner that was told there is no job.
		const persistence = createD1Adapters(env.DB);
		const undecidable = createHarness({
			ownerId: harness.ownerId,
			time: harness.time,
			persistence: {
				...persistence,
				earnings: {
					...persistence.earnings,
					getEvents: async (ownerId, stockIds) =>
						(await persistence.earnings.getEvents(ownerId, stockIds)).map((event) => ({
							...event,
							announcementDate: "2026-13-45",
						})),
				},
			},
		});
		expect(await claim(undecidable, token)).toBeNull();

		const shown = await harness.call("GET", `/research-runs/${run.runId}`);
		expect((await body(shown, researchRunResponseSchema)).run).toMatchObject({
			state: "failed",
			failureCode: "GOOGLE_REQUEST_FAILED",
		});
		expect(await googleState(harness)).toMatchObject({
			status: "connected",
			activeRunId: null,
			lastFailure: { code: "GOOGLE_REQUEST_FAILED" },
		});
	});

	it("restores the link when the owner cancels a connect nobody holds a live lease on", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);

		// Pending (no runner yet): the cancel is immediate.
		const pending = await queueGoogle(harness, "connect");
		expect((await googleState(harness)).status).toBe("connecting");
		const first = await harness.call("POST", `/research-runs/${pending.runId}/cancel`);
		expect(first.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "disconnected",
			authUrl: null,
			activeRunId: null,
			lastFailure: null,
		});

		// Leased, link stored, then the runner vanishes and the lease runs out.
		const second = await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		const sent = await harness.runner(token, `/jobs/${lease.runId}/events`, {
			leaseGeneration: lease.leaseGeneration,
			events: [
				{
					seq: 0,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect(sent.status).toBe(200);
		expect((await googleState(harness)).authUrl).toBe(AUTH_URL);
		harness.time.advance(10 * 60_000);
		const late = await harness.call("POST", `/research-runs/${second.runId}/cancel`);
		expect(late.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "disconnected",
			authUrl: null,
			activeRunId: null,
		});
		// Cancelling the already-cancelled run again changes nothing later on.
		await queueGoogle(harness, "connect");
		const third = await claim(harness, token);
		if (third?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, third);
		const linked = await harness.runner(token, `/jobs/${third.runId}/complete`, {
			outcome: "google-calendar-connected",
			leaseGeneration: third.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
		});
		expect(linked.status).toBe(200);
		const repeat = await harness.call("POST", `/research-runs/${second.runId}/cancel`);
		expect(repeat.status).toBe(200);
		expect((await googleState(harness)).status).toBe("connected");
	});

	it("fails a connect whose lease expired instead of opening a new sign-in on its own", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const run = await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		const sent = await harness.runner(token, `/jobs/${lease.runId}/events`, {
			leaseGeneration: lease.leaseGeneration,
			events: [
				{
					seq: 0,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect(sent.status).toBe(200);
		// The runner dies; hours later a runner polls again.
		harness.time.advance(8 * 3_600_000);
		expect(await claim(harness, token)).toBeNull();
		const shown = await harness.call("GET", `/research-runs/${run.runId}`);
		expect((await body(shown, researchRunResponseSchema)).run).toMatchObject({
			state: "failed",
			failureCode: "GOOGLE_AUTH_TIMEOUT",
		});
		expect(await googleState(harness)).toMatchObject({
			status: "disconnected",
			authUrl: null,
			activeRunId: null,
			lastFailure: { code: "GOOGLE_AUTH_TIMEOUT" },
		});
	});

	it("accepts only the success outcome of the job's own step", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, lease);
		for (const wrong of [
			{
				outcome: "google-calendar-synced",
				calendarId: "cal_1",
				desiredDigest: "a".repeat(64),
				inserted: 0,
				updated: 0,
				deleted: 0,
				unchanged: 0,
			},
			{ outcome: "google-calendar-disconnected", revoked: true },
		]) {
			const refused = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
				...wrong,
				leaseGeneration: lease.leaseGeneration,
				usage: USAGE,
			});
			expect(refused.status).toBe(400);
			expect(await errorCode(refused)).toBe("VALIDATION_FAILED");
		}
		expect((await googleState(harness)).status).toBe("connecting");
	});

	it("requeues a connect whose runner shut down, dropping its dead sign-in link (ADR-0036)", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const run = await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		await harness.runner(token, `/jobs/${lease.runId}/events`, {
			leaseGeneration: lease.leaseGeneration,
			events: [
				{
					seq: 0,
					at: harness.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect((await googleState(harness)).authUrl).toBe(AUTH_URL);
		const released = await harness.runner(token, `/jobs/${lease.runId}/release`, {
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
		});
		expect(released.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "connecting",
			authUrl: null,
			activeRunId: run.runId,
		});
		// Taken again at once as a fresh claim, not failed as an abandoned sign-in.
		const again = await claim(harness, token);
		expect(again).toMatchObject({ kind: "google-calendar", runId: run.runId, attempt: 1 });
	});

	it("restores the link when a connect with a requested cancel is handed back", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const run = await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		expect((await harness.call("POST", `/research-runs/${run.runId}/cancel`)).status).toBe(200);
		const released = await harness.runner(token, `/jobs/${lease.runId}/release`, {
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
		});
		expect(released.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({
			status: "disconnected",
			activeRunId: null,
			lastFailure: null,
		});
	});

	it("restores a cancelled connect with no failure recorded", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const run = await queueGoogle(harness, "connect");
		const lease = await claim(harness, token);
		if (lease?.kind !== "google-calendar") throw new Error("expected a google claim");
		const cancelled = await harness.call("POST", `/research-runs/${run.runId}/cancel`);
		expect(cancelled.status).toBe(200);
		const done = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "cancelled",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
		});
		expect(done.status).toBe(200);
		expect(await googleState(harness)).toMatchObject({ status: "disconnected", lastFailure: null });
	});

	it("rejects outcomes that do not apply to the job kind", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await seedOneDatedEvent(harness, token);
		await queueGoogle(harness, "connect");
		const connect = await claim(harness, token);
		if (connect?.kind !== "google-calendar") throw new Error("expected a google claim");
		await advanceToPublishing(harness, token, connect);
		const earningsForGoogle = await harness.runner(token, `/jobs/${connect.runId}/complete`, {
			outcome: "earnings-refreshed",
			leaseGeneration: connect.leaseGeneration,
			usage: USAGE,
			stocks: [],
		});
		expect(earningsForGoogle.status).toBe(400);
		expect(await errorCode(earningsForGoogle)).toBe("VALIDATION_FAILED");

		// The reverse direction on a fresh owner: a google outcome for an
		// earnings run is rejected too.
		const other = createHarness();
		const otherToken = await issueRunnerToken(other);
		await seedOneDatedEvent(other, otherToken);
		const refresh = await other.call("POST", "/watchlist/refresh", undefined, idempotencyKey());
		expect(refresh.status).toBe(202);
		const earnings = await claim(other, otherToken);
		if (earnings?.kind !== "earnings-refresh") throw new Error("expected an earnings claim");
		await advanceToPublishing(other, otherToken, earnings);
		const googleForEarnings = await other.runner(otherToken, `/jobs/${earnings.runId}/complete`, {
			outcome: "google-calendar-connected",
			leaseGeneration: earnings.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
		});
		expect(googleForEarnings.status).toBe(400);
		expect(await errorCode(googleForEarnings)).toBe("VALIDATION_FAILED");
	});
});

describe("google-calendar API security", () => {
	it("isolates owners: state, jobs and runner tokens do not cross tenants", async () => {
		const first = createHarness();
		const second = createHarness();
		const token = await issueRunnerToken(first);
		await queueGoogle(first, "connect");
		expect((await googleState(first)).status).toBe("connecting");
		expect((await googleState(second)).status).toBe("disconnected");
		// The second owner's runner token cannot touch the first owner's run.
		const otherToken = await issueRunnerToken(second);
		const lease = await claim(first, token);
		if (lease === null) throw new Error("expected a claim");
		const cross = await second.runner(otherToken, `/jobs/${lease.runId}/heartbeat`, {
			leaseGeneration: lease.leaseGeneration,
		});
		expect(cross.status).toBe(404);
		const crossEvents = await second.runner(otherToken, `/jobs/${lease.runId}/events`, {
			leaseGeneration: lease.leaseGeneration,
			events: [
				{
					seq: 0,
					at: second.time.clock.nowIso(),
					event: { type: "google-auth-url", url: AUTH_URL },
				},
			],
		});
		expect(crossEvents.status).toBe(404);
		expect((await googleState(second)).status).toBe("disconnected");
	});

	it("rejects cross-site and unprotected writes (CSRF)", async () => {
		const harness = createHarness();
		for (const init of [
			{ headers: {} },
			{ headers: { Origin: "https://evil.example.com" } },
			{ headers: { Origin: "http://localhost" } },
		] as const) {
			const response = await harness.raw("POST", "/google-calendar/connect", {
				headers: { ...init.headers } as Record<string, string>,
			});
			expect(response.status).toBe(403);
			expect(await errorCode(response)).toBe("CSRF_REJECTED");
		}
		expect((await googleState(harness)).status).toBe("disconnected");
	});
});
