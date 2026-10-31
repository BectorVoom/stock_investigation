/**
 * Runner execution for `google-calendar` jobs (FR-019 section 2.6):
 * connect (loopback OAuth), sync (plan + apply) and disconnect (revoke +
 * delete). Called from `executeJob` under the job's lease; heartbeats
 * continue while the runner waits, and cancellation/lease-loss/shutdown
 * close the loopback listener (the shared abort signal fires on every stop
 * reason, and the listener closes on abort).
 *
 * Secrecy (section 2.1): no token, client secret, authorization code or
 * PKCE verifier may reach an event, a completion, a log line or a thrown
 * message. This module logs stable codes and counts only, sends exactly
 * one `google-auth-url` event (client id, redirect port, state and PKCE
 * challenge — none of them a credential), and never throws values that
 * carry secrets (failures are returned as completions).
 */
import type { GoogleHttpRequest, GoogleHttpResult } from "@research/adapters/google";
import {
	buildAuthorizationUrl,
	type CalendarCallDeps,
	codeChallengeS256,
	createCalendar,
	deleteEvent,
	deleteGoogleTokenFile,
	exchangeCode,
	GOOGLE_CALENDAR_SCOPE,
	type GoogleCallCode,
	type GoogleCallFailure,
	getCalendar,
	insertEvent,
	listManagedEvents,
	type ManagedCalendarEvent,
	newCodeVerifier,
	newOAuthState,
	RATE_LIMIT_JOB_BUDGET_MS,
	readGoogleTokenFile,
	refreshAccessToken,
	revokeToken,
	scopeGranted,
	startLoopbackListener,
	updateEvent,
	writeGoogleTokenFile,
} from "@research/adapters/google";
import type { Clock, PipelineReporter } from "@research/application";
import type { ClaimedJob, CompleteJobRequest, GoogleCalendarAction } from "@research/contracts";
import { EMPTY_USAGE, err, ok, planGoogleSync, type Result } from "@research/domain";
import type { EventLogger } from "@research/effects";
import type { MarketPacer } from "./marketPacing.ts";

/** The sign-in window: 5 minutes, then GOOGLE_AUTH_TIMEOUT. */
export const GOOGLE_CONNECT_TIMEOUT_MS = 5 * 60 * 1_000;
/** Summary of the dedicated secondary calendar. */
export const GOOGLE_CALENDAR_SUMMARY = "Earnings calendar (Research workspace)";
const GOOGLE_CALENDAR_DESCRIPTION =
	"Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.";
const GOOGLE_CALENDAR_TIMEZONE = "UTC";

export interface GoogleRunnerConfig {
	readonly clientId: string | null;
	readonly clientSecret: string | null;
	readonly tokenFile: string;
}

export type GoogleRunnerHttp = (request: GoogleHttpRequest) => Promise<GoogleHttpResult>;

export interface GoogleRunnerDeps {
	readonly config: GoogleRunnerConfig;
	readonly http: GoogleRunnerHttp;
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Jitter source for rate-limit backoff, uniform in [0, 1); `Math.random` when absent. */
	readonly random?: () => number;
}

/**
 * What the orchestration needs from the runner (a subset of
 * `JobExecutionDeps`, so tests build only this). The shared abort signal
 * fires on every stop reason, and the loopback listener closes on abort.
 */
export interface GoogleExecutionEnv {
	readonly google: GoogleRunnerDeps;
	readonly clock: Clock;
	readonly logger: EventLogger;
	readonly marketPacer: MarketPacer;
}

/**
 * Sends the sign-in URL as one `google-auth-url` event (server
 * sequence-numbered) and answers whether the API has it. Calling it again
 * with the same URL only re-sends what is still undelivered.
 */
export type GoogleAuthUrlSender = (url: string) => Promise<boolean>;

/** Delivery attempts for the sign-in link, and the pause between them. */
const AUTH_URL_SEND_ATTEMPTS = 4;
const AUTH_URL_RETRY_MS = 2_000;

type GoogleFailure =
	| "GOOGLE_NOT_CONFIGURED"
	| "GOOGLE_AUTH_TIMEOUT"
	| "GOOGLE_CONSENT_DENIED"
	| "GOOGLE_SCOPE_MISSING"
	| "GOOGLE_AUTH_EXPIRED"
	| "GOOGLE_CLIENT_REJECTED"
	| "GOOGLE_RATE_LIMITED"
	| "GOOGLE_REQUEST_FAILED";

/** `upstreamStatus`: Google's answer status behind the failure, unchanged (§4a). */
function failed(
	job: Extract<ClaimedJob, { kind: "google-calendar" }>,
	failureCode: GoogleFailure,
	retryable: boolean,
	upstreamStatus: number | null = null,
): CompleteJobRequest {
	return {
		outcome: "failed",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		failureCode,
		...(upstreamStatus === null ? {} : { failureUpstreamStatus: upstreamStatus }),
		retryable,
	};
}

/**
 * Returned when the stop signal fired: `executeJob` overrides it (cancelled)
 * or abandons it (lease lost, shutdown), so the code is never shown.
 */
function aborted(job: Extract<ClaimedJob, { kind: "google-calendar" }>): CompleteJobRequest {
	return failed(job, "GOOGLE_REQUEST_FAILED", false);
}

/** Ceiling for a clean-up revoke, which runs after the job's own signal fired. */
const GOOGLE_REVOKE_TIMEOUT_MS = 10_000;

/**
 * Gives a grant back (best effort): used when a sign-in produced a refresh
 * token that will not be kept. Runs on its own short signal because the
 * job's signal has usually fired already. Never throws, logs no token.
 */
async function revokeGrant(env: GoogleExecutionEnv, refreshToken: string): Promise<boolean> {
	try {
		const answer = await revokeToken(env.google.http, {
			token: refreshToken,
			signal: AbortSignal.timeout(GOOGLE_REVOKE_TIMEOUT_MS),
		});
		return answer.revoked;
	} catch {
		return false;
	}
}

/**
 * Undoes a connect that stored its grant but did not end `completed` (the
 * owner cancelled, the lease was lost, or the API refused the completion):
 * the API will say "not connected", so no live refresh token may stay on
 * disk for a grant the app can no longer disconnect.
 */
export async function discardStoredGoogleGrant(
	env: GoogleExecutionEnv,
	runId: string,
): Promise<void> {
	const stored = await readGoogleTokenFile(env.google.config.tokenFile);
	const revoked = stored === null ? false : await revokeGrant(env, stored.refreshToken);
	await deleteGoogleTokenFile(env.google.config.tokenFile);
	env.logger.info("google_grant_discarded", { runId, revoked });
}

function retryable(code: GoogleCallCode | GoogleFailure): boolean {
	return code === "GOOGLE_RATE_LIMITED";
}

/** Maps a calendar-call failure; ABORTED becomes the stop placeholder. */
function callFailed(
	job: Extract<ClaimedJob, { kind: "google-calendar" }>,
	failure: GoogleCallFailure,
): CompleteJobRequest {
	if (failure.code === "ABORTED") return aborted(job);
	return failed(job, failure.code, retryable(failure.code), failure.upstreamStatus);
}

export async function executeGoogleCalendar(
	job: Extract<ClaimedJob, { kind: "google-calendar" }>,
	env: GoogleExecutionEnv,
	signal: AbortSignal,
	reporter: PipelineReporter,
	sendAuthUrl: GoogleAuthUrlSender,
): Promise<CompleteJobRequest> {
	const action: GoogleCalendarAction = job.action;
	if (action === "connect") return executeConnect(job, env, signal, reporter, sendAuthUrl);
	if (action === "sync") return executeSync(job, env, signal, reporter);
	return executeDisconnect(job, env, signal, reporter);
}

async function executeConnect(
	job: Extract<ClaimedJob, { kind: "google-calendar" }>,
	env: GoogleExecutionEnv,
	signal: AbortSignal,
	reporter: PipelineReporter,
	sendAuthUrl: GoogleAuthUrlSender,
): Promise<CompleteJobRequest> {
	const { clientId, clientSecret } = env.google.config;
	if (clientId === null || clientSecret === null) {
		env.logger.warn("google_not_configured", { runId: job.runId });
		return failed(job, "GOOGLE_NOT_CONFIGURED", false);
	}
	await reporter.state("planning");
	const state = newOAuthState();
	const listener = await startLoopbackListener({
		expectedState: state,
		timeoutMs: GOOGLE_CONNECT_TIMEOUT_MS,
		signal,
		sleep: env.google.sleep,
	});
	try {
		const verifier = newCodeVerifier();
		const url = buildAuthorizationUrl({
			clientId,
			redirectUri: listener.redirectUri,
			state,
			challenge: codeChallengeS256(verifier),
		});
		await reporter.state("collecting");
		// Without the link in the API nobody can sign in, so an
		// undelivered link fails now instead of waiting out the window.
		let delivered = await sendAuthUrl(url);
		for (let attempt = 1; !delivered && attempt < AUTH_URL_SEND_ATTEMPTS; attempt += 1) {
			if (signal.aborted) return aborted(job);
			await env.google.sleep(AUTH_URL_RETRY_MS, signal);
			if (signal.aborted) return aborted(job);
			delivered = await sendAuthUrl(url);
		}
		if (signal.aborted) return aborted(job);
		if (!delivered) {
			env.logger.warn("google_auth_url_not_delivered", { runId: job.runId });
			return failed(job, "GOOGLE_REQUEST_FAILED", false);
		}
		const result = await listener.wait();
		if (signal.aborted || result.kind === "aborted") return aborted(job);
		if (result.kind === "timeout") {
			env.logger.warn("google_auth_timeout", { runId: job.runId });
			return failed(job, "GOOGLE_AUTH_TIMEOUT", false);
		}
		if (result.kind === "denied") {
			env.logger.warn("google_consent_denied", { runId: job.runId });
			return failed(job, "GOOGLE_CONSENT_DENIED", false);
		}
		await reporter.state("analyzing");
		const exchanged = await exchangeCode(env.google.http, {
			clientId,
			clientSecret,
			code: result.code,
			verifier,
			redirectUri: listener.redirectUri,
			signal,
		});
		if (!exchanged.ok) {
			if (signal.aborted) return aborted(job);
			env.logger.warn("google_exchange_failed", {
				runId: job.runId,
				code: exchanged.error.code,
				upstreamStatus: exchanged.error.upstreamStatus,
			});
			return failed(
				job,
				exchanged.error.code,
				retryable(exchanged.error.code),
				exchanged.error.upstreamStatus,
			);
		}
		// From here on a refresh token exists. Unless it ends up stored, it
		// is given back: a grant the app holds no token for could never be
		// disconnected from the app. Nothing is stored yet, so a token Google
		// rotates during the calendar step only replaces the one kept in memory.
		const session = calendarSession(
			env,
			signal,
			{ clientId, clientSecret },
			exchanged.value.refreshToken,
			async () => {},
		);
		session.adopt(exchanged.value.accessToken, exchanged.value.expiresIn);
		const giveBack = async (completion: CompleteJobRequest): Promise<CompleteJobRequest> => {
			const revoked = await revokeGrant(env, session.refreshToken());
			env.logger.info("google_grant_discarded", { runId: job.runId, revoked });
			return completion;
		};
		if (!scopeGranted(exchanged.value.scope)) {
			env.logger.warn("google_scope_missing", { runId: job.runId });
			return giveBack(failed(job, "GOOGLE_SCOPE_MISSING", false));
		}
		await reporter.state("verifying");
		const calls = session.calls;
		// Reuse the calendar id from an existing token file when the
		// calendar is still there; otherwise create the dedicated calendar.
		let calendarId: string | null = null;
		const previous = await readGoogleTokenFile(env.google.config.tokenFile);
		if (previous !== null) {
			const checked = await getCalendar(calls, previous.calendarId);
			if (!checked.ok) {
				if (signal.aborted) return giveBack(aborted(job));
				return giveBack(callFailed(job, checked.error));
			}
			if (checked.value.found) calendarId = previous.calendarId;
		}
		if (calendarId === null) {
			if (signal.aborted) return giveBack(aborted(job));
			const created = await createCalendar(calls, {
				summary: GOOGLE_CALENDAR_SUMMARY,
				description: GOOGLE_CALENDAR_DESCRIPTION,
				timeZone: GOOGLE_CALENDAR_TIMEZONE,
			});
			if (!created.ok) {
				if (signal.aborted) return giveBack(aborted(job));
				env.logger.warn("google_create_failed", { runId: job.runId, code: created.error.code });
				return giveBack(callFailed(job, created.error));
			}
			calendarId = created.value.id;
		}
		// Stopped while talking to Google: nothing is stored.
		if (signal.aborted) return giveBack(aborted(job));
		try {
			await writeGoogleTokenFile(env.google.config.tokenFile, {
				version: 1,
				refreshToken: session.refreshToken(),
				calendarId,
				scope: GOOGLE_CALENDAR_SCOPE,
				savedAt: env.clock.nowIso(),
			});
		} catch (error) {
			// The grant was not stored, so it is given back before the fault
			// propagates (the job then ends as a retryable runner error).
			await giveBack(failed(job, "GOOGLE_REQUEST_FAILED", false));
			throw error;
		}
		env.logger.info("google_connected", { runId: job.runId, calendarId });
		await reporter.state("publishing");
		return {
			outcome: "google-calendar-connected",
			leaseGeneration: job.leaseGeneration,
			usage: EMPTY_USAGE,
			calendarId,
		};
	} finally {
		// Cancellation, shutdown and every terminal path close the listener.
		await listener.close();
	}
}

/**
 * Refresh this long before `expires_in` runs out, so no request starts with
 * a token that lapses on the way.
 */
export const GOOGLE_ACCESS_TOKEN_MARGIN_MS = 60_000;

interface CalendarSession {
	readonly calls: CalendarCallDeps;
	/** Takes an access token and its lifetime in seconds (null: unknown). */
	adopt(accessToken: string, expiresIn: number | null): void;
	/** The refresh token in force: Google may rotate it on a refresh. */
	refreshToken(): string;
}

/**
 * One job's Google credentials and Calendar call dependencies. Every token
 * refresh and every Calendar attempt is admitted by the shared pacer, the
 * access token's `expires_in` decides when to refresh before a request, and
 * a refresh token Google rotates is adopted and handed to `onRotated`
 * before the refresh returns (a store failure propagates).
 */
function calendarSession(
	env: GoogleExecutionEnv,
	signal: AbortSignal,
	client: { readonly clientId: string; readonly clientSecret: string },
	refreshToken: string,
	onRotated: (refreshToken: string) => Promise<void>,
): CalendarSession {
	let accessToken = "";
	let expiresAtMs: number | null = null;
	let current = refreshToken;
	const adopt = (token: string, expiresIn: number | null): void => {
		accessToken = token;
		expiresAtMs = expiresIn === null ? null : env.clock.nowMs() + expiresIn * 1_000;
	};
	const refresh = async (): Promise<Result<string, GoogleCallFailure>> => {
		if (!(await env.marketPacer.pace("google", signal))) {
			return err({ code: "ABORTED", upstreamStatus: null });
		}
		const refreshed = await refreshAccessToken(env.google.http, {
			clientId: client.clientId,
			clientSecret: client.clientSecret,
			refreshToken: current,
			signal,
		});
		if (!refreshed.ok) return err(refreshed.error satisfies GoogleCallFailure);
		adopt(refreshed.value.accessToken, refreshed.value.expiresIn);
		const rotated = refreshed.value.refreshToken;
		if (rotated !== null && rotated !== current) {
			current = rotated;
			await onRotated(rotated);
		}
		return ok(accessToken);
	};
	return {
		calls: {
			http: env.google.http,
			accessToken: () => accessToken,
			accessTokenExpired: () =>
				expiresAtMs !== null && env.clock.nowMs() >= expiresAtMs - GOOGLE_ACCESS_TOKEN_MARGIN_MS,
			refreshAccessToken: refresh,
			// The pacer admits Google quota units (a PATCH counts three).
			beforeRequest: (quotaUnits) => env.marketPacer.pace("google", signal, quotaUnits),
			backoff: {
				sleep: env.google.sleep,
				random: env.google.random ?? Math.random,
				nowMs: () => env.clock.nowMs(),
				remainingMs: RATE_LIMIT_JOB_BUDGET_MS,
			},
			signal,
		},
		adopt,
		refreshToken: () => current,
	};
}

async function executeSync(
	job: Extract<ClaimedJob, { kind: "google-calendar" }>,
	env: GoogleExecutionEnv,
	signal: AbortSignal,
	reporter: PipelineReporter,
): Promise<CompleteJobRequest> {
	const { clientId, clientSecret } = env.google.config;
	if (clientId === null || clientSecret === null) {
		env.logger.warn("google_not_configured", { runId: job.runId });
		return failed(job, "GOOGLE_NOT_CONFIGURED", false);
	}
	await reporter.state("planning");
	const stored = await readGoogleTokenFile(env.google.config.tokenFile);
	if (stored === null) {
		// No token file while the API believes it is connected: the grant
		// is gone (or was never stored here) — re-connect.
		env.logger.warn("google_auth_expired", { runId: job.runId });
		return failed(job, "GOOGLE_AUTH_EXPIRED", false);
	}
	if (
		job.action !== "sync" ||
		job.calendarId === undefined ||
		job.desiredDigest === undefined ||
		job.events === undefined
	) {
		return failed(job, "GOOGLE_REQUEST_FAILED", false);
	}
	await reporter.state("collecting");
	// What the token file holds; every write keeps the other fields.
	let record = stored;
	const session = calendarSession(
		env,
		signal,
		{ clientId, clientSecret },
		stored.refreshToken,
		async (refreshToken) => {
			// Stored at once: Google may already have retired the old token.
			record = { ...record, refreshToken, savedAt: env.clock.nowIso() };
			await writeGoogleTokenFile(env.google.config.tokenFile, record);
			env.logger.info("google_refresh_token_rotated", { runId: job.runId });
		},
	);
	const calls = session.calls;
	const initial = await calls.refreshAccessToken();
	if (!initial.ok) {
		if (signal.aborted) return aborted(job);
		env.logger.warn("google_refresh_failed", { runId: job.runId, code: initial.error.code });
		return callFailed(job, initial.error);
	}
	await reporter.state("analyzing");
	// The claim names the calendar the API believes is connected; the token
	// file's id is the fallback for a claim that carries none (null).
	let calendarId = job.calendarId ?? stored.calendarId;
	let existing: readonly ManagedCalendarEvent[] = [];
	const checked = await getCalendar(calls, calendarId);
	if (!checked.ok) {
		if (signal.aborted) return aborted(job);
		return callFailed(job, checked.error);
	}
	if (!checked.value.found) {
		// The calendar is gone from Google (deleted there): create a new
		// one, save its id, and treat the managed set as empty.
		if (signal.aborted) return aborted(job);
		const created = await createCalendar(calls, {
			summary: GOOGLE_CALENDAR_SUMMARY,
			description: GOOGLE_CALENDAR_DESCRIPTION,
			timeZone: GOOGLE_CALENDAR_TIMEZONE,
		});
		if (!created.ok) {
			if (signal.aborted) return aborted(job);
			return callFailed(job, created.error);
		}
		calendarId = created.value.id;
		record = { ...record, calendarId, savedAt: env.clock.nowIso() };
		await writeGoogleTokenFile(env.google.config.tokenFile, record);
	} else {
		const listed = await listManagedEvents(calls, calendarId);
		if (!listed.ok) {
			if (signal.aborted) return aborted(job);
			return callFailed(job, listed.error);
		}
		existing = listed.value;
	}
	const planned = planGoogleSync(job.events, existing);
	if (!planned.ok) {
		env.logger.warn("google_plan_failed", { runId: job.runId });
		return failed(job, "GOOGLE_REQUEST_FAILED", false);
	}
	const plan = planned.value;
	await reporter.state("verifying");
	let inserted = 0;
	let updated = 0;
	let deleted = 0;
	for (const eventId of plan.deletes) {
		if (signal.aborted) return aborted(job);
		const removed = await deleteEvent(calls, calendarId, eventId);
		if (!removed.ok) {
			if (signal.aborted) return aborted(job);
			return callFailed(job, removed.error);
		}
		deleted += 1;
	}
	for (const body of plan.updates) {
		if (signal.aborted) return aborted(job);
		const written = await updateEvent(calls, calendarId, body);
		if (!written.ok) {
			if (signal.aborted) return aborted(job);
			return callFailed(job, written.error);
		}
		updated += 1;
	}
	for (const body of plan.inserts) {
		if (signal.aborted) return aborted(job);
		const added = await insertEvent(calls, calendarId, body);
		if (!added.ok) {
			if (signal.aborted) return aborted(job);
			return callFailed(job, added.error);
		}
		if (added.value.inserted) {
			inserted += 1;
		} else {
			// A 409 answers that the id is already there: retry once as an update.
			const rewritten = await updateEvent(calls, calendarId, body);
			if (!rewritten.ok) {
				if (signal.aborted) return aborted(job);
				return callFailed(job, rewritten.error);
			}
			updated += 1;
		}
	}
	env.logger.info("google_synced", {
		runId: job.runId,
		calendarId,
		inserted,
		updated,
		deleted,
		unchanged: plan.unchanged.length,
	});
	await reporter.state("publishing");
	return {
		outcome: "google-calendar-synced",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		calendarId,
		desiredDigest: job.desiredDigest,
		inserted,
		updated,
		deleted,
		unchanged: plan.unchanged.length,
	};
}

async function executeDisconnect(
	job: Extract<ClaimedJob, { kind: "google-calendar" }>,
	env: GoogleExecutionEnv,
	signal: AbortSignal,
	reporter: PipelineReporter,
): Promise<CompleteJobRequest> {
	await reporter.state("planning");
	const stored = await readGoogleTokenFile(env.google.config.tokenFile);
	let revoked = false;
	// Every job walks planning, collecting, analyzing, verifying, publishing.
	await reporter.state("collecting");
	if (stored !== null) {
		// Best effort: a failed revoke still deletes the local token file
		// and completes with `revoked: false`. Revocation takes the token
		// only — no client credentials are needed.
		if (!signal.aborted) {
			const answer = await revokeToken(env.google.http, { token: stored.refreshToken, signal });
			revoked = answer.revoked;
		}
	}
	// Stopped before the revoke could be tried: keep the file, so the
	// disconnect can be run again and still revoke the grant.
	if (signal.aborted && stored !== null && !revoked) return aborted(job);
	// Deleted even when it could not be read as a token record: a file
	// that does not parse may still hold a token.
	await deleteGoogleTokenFile(env.google.config.tokenFile);
	env.logger.info("google_disconnected", { runId: job.runId, revoked });
	await reporter.state("analyzing");
	await reporter.state("verifying");
	await reporter.state("publishing");
	return {
		outcome: "google-calendar-disconnected",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		revoked,
	};
}
