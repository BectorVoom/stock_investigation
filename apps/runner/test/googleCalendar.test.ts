/**
 * Runner execution for google-calendar jobs (FR-019 section 2.6): connect /
 * sync / disconnect against a scripted fake Google (HTTP-function level),
 * with the REAL loopback listener and token store, a fake clock's sleep
 * for the 5-minute timeout, and a secrets scan over every captured log
 * line, sent event and completion (security check 1).
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoogleHttpRequest, GoogleHttpResult } from "@research/adapters/google";
import {
	GOOGLE_CALENDAR_SCOPE,
	readGoogleTokenFile,
	writeGoogleTokenFile,
} from "@research/adapters/google";
import type { PipelineReporter } from "@research/application";
import type { ClaimedJob } from "@research/contracts";
import { GOOGLE_CALENDAR_OAUTH_SCOPE, isGoogleSignInUrl } from "@research/contracts";
import { err, ok } from "@research/domain";
import type { EventLogger, LogFields } from "@research/effects";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../packages/application/test/support.ts";
import {
	executeGoogleCalendar,
	GOOGLE_CONNECT_TIMEOUT_MS,
	type GoogleExecutionEnv,
} from "../src/googleCalendar.ts";
import { executeJob } from "../src/jobExecution.ts";
import { createMarketPacer } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const CLIENT_ID = "test-client-id-abc";
const CLIENT_SECRET = "test-client-secret-xyz";
const AUTH_CODE = "test-auth-code-123";
const REFRESH_TOKEN = "test-refresh-token-456";
const ACCESS_TOKEN = "test-access-token-789";

const never = new AbortController().signal;

interface HttpCall {
	readonly method: string;
	readonly path: string;
	readonly body: string;
}

type Route = (call: HttpCall) => { readonly status: number; readonly text: string };

function json(status: number, value: unknown): Route {
	return () => ({ status, text: JSON.stringify(value) });
}

/** Scripted fake Google at the narrow-HTTP level; records every call. */
function scriptedHttp(routes: Record<string, Route>, calls: HttpCall[]) {
	return async (request: GoogleHttpRequest): Promise<GoogleHttpResult> => {
		const url = new URL(request.path, "https://google.test");
		const call: HttpCall = { method: request.method, path: url.pathname, body: request.body ?? "" };
		calls.push(call);
		const route = routes[`${request.method} ${url.pathname}`];
		if (route === undefined)
			return ok({ status: 404, location: null, contentType: null, text: "{}" });
		const answered = route(call);
		return ok({
			status: answered.status,
			location: null,
			contentType: "application/json",
			text: answered.text,
		});
	};
}

interface CapturedLog {
	readonly level: string;
	readonly event: string;
	readonly fields: LogFields;
}

function capturingLogger(logs: CapturedLog[]): EventLogger {
	return {
		info: (event, fields) => void logs.push({ level: "info", event, fields: fields ?? {} }),
		warn: (event, fields) => void logs.push({ level: "warn", event, fields: fields ?? {} }),
		error: (event, fields) => void logs.push({ level: "error", event, fields: fields ?? {} }),
		logFailures: () => 0,
	};
}

function stubReporter(seen: { states: string[] }): PipelineReporter {
	return {
		state: async (state) => void seen.states.push(state),
		note: async () => {},
		tool: async () => {},
		usage: async () => {},
	};
}

interface GoogleHarness {
	readonly env: GoogleExecutionEnv;
	readonly httpCalls: HttpCall[];
	readonly logs: CapturedLog[];
	readonly states: string[];
	readonly sentUrls: string[];
	readonly sleepMs: number[];
	readonly releaseSleep: () => void;
	readonly tokenFile: string;
	readonly dir: string;
}

async function googleHarness(
	routes: Record<string, Route>,
	options: { clientId?: string | null; clientSecret?: string | null } = {},
): Promise<GoogleHarness> {
	const time = fixedClock();
	const httpCalls: HttpCall[] = [];
	const logs: CapturedLog[] = [];
	const states: string[] = [];
	const sentUrls: string[] = [];
	const sleepMs: number[] = [];
	let release: () => void = () => {};
	const dir = await mkdtemp(join(tmpdir(), "runner-google-test-"));
	const env: GoogleExecutionEnv = {
		google: {
			config: {
				clientId: options.clientId === undefined ? CLIENT_ID : options.clientId,
				clientSecret: options.clientSecret === undefined ? CLIENT_SECRET : options.clientSecret,
				tokenFile: join(dir, "google-token.json"),
			},
			http: scriptedHttp(routes, httpCalls),
			sleep: (ms, signal) => {
				sleepMs.push(ms);
				return new Promise<void>((resolve) => {
					release = () => {
						release = () => {};
						resolve();
					};
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
			},
		},
		clock: time.clock,
		logger: capturingLogger(logs),
		marketPacer: createMarketPacer({
			clock: time.clock,
			// Advances the fake clock (API-007): a sleep that never advanced
			// time would wait forever, exactly as in production.
			sleep: async (ms) => {
				time.advance(ms);
			},
			limits: new Map([["google", { maxPerWindow: 5, windowMs: 1_000 }]]),
		}),
	};
	return {
		env,
		httpCalls,
		logs,
		states,
		sentUrls,
		sleepMs,
		releaseSleep: () => release(),
		tokenFile: join(dir, "google-token.json"),
		dir,
	};
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!check()) throw new Error("timed out waiting for the runner");
}

function syncJob(events: readonly SyncBody[]): Extract<ClaimedJob, { kind: "google-calendar" }> {
	return {
		kind: "google-calendar",
		runId: "run_google",
		leaseGeneration: 2,
		leaseExpiresAt: "2026-10-11T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		action: "sync",
		calendarId: "cal_1",
		desiredDigest: "ab".repeat(32),
		events: [...events],
	};
}

interface SyncBody {
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

const BODY_A: SyncBody = {
	id: "a".repeat(32),
	summary: "New title",
	description: "desc a",
	startDate: "2026-10-29",
	endDate: "2026-10-30",
	privateProperties: {
		researchWorkspace: "earnings" as const,
		stockId: "us:AAPL",
		periodKey: "2026-q4",
	},
	sourceTitle: "Finnhub",
	sourceUrl: "https://finnhub.io/",
};
const BODY_B: SyncBody = {
	id: "b".repeat(32),
	summary: "B title",
	description: "desc b",
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

/** Security check 1: no token/secret/code/verifier in logs, events or completions. */
function scanSecrets(haystacks: readonly string[], secrets: readonly string[]): void {
	for (const haystack of haystacks) {
		for (const secret of secrets) {
			expect(haystack).not.toContain(secret);
		}
	}
}

const CONNECT: Extract<ClaimedJob, { kind: "google-calendar" }> = {
	kind: "google-calendar",
	runId: "run_google",
	leaseGeneration: 1,
	leaseExpiresAt: "2026-10-11T00:01:30.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [],
	action: "connect",
};

/** Starts a connect, answers the loopback callback with the code, and returns the completion. */
async function connectThroughCallback(harness: GoogleHarness, signal: AbortSignal = never) {
	const pending = executeGoogleCalendar(
		CONNECT,
		harness.env,
		signal,
		stubReporter(harness),
		async (url) => harness.sentUrls.push(url) > 0,
	);
	await waitFor(() => harness.sentUrls.length === 1);
	const params = new URL(harness.sentUrls[0] ?? "").searchParams;
	const port = new URL(params.get("redirect_uri") ?? "").port;
	await fetch(`http://127.0.0.1:${port}/?code=${AUTH_CODE}&state=${params.get("state") ?? ""}`);
	return pending;
}

const GRANTED = {
	access_token: ACCESS_TOKEN,
	refresh_token: REFRESH_TOKEN,
	scope: "https://www.googleapis.com/auth/calendar.app.created",
	expires_in: 3600,
};

describe("the scope the runner asks for", () => {
	it("is the one scope the API accepts in a sign-in link", () => {
		expect(GOOGLE_CALENDAR_SCOPE).toBe(GOOGLE_CALENDAR_OAUTH_SCOPE);
	});
});

describe("connect execution", () => {
	it("exchanges the code, creates the calendar and stores the token (security check 1)", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, {
				access_token: ACCESS_TOKEN,
				refresh_token: REFRESH_TOKEN,
				scope: "https://www.googleapis.com/auth/calendar.app.created",
				expires_in: 3600,
			}),
			"POST /calendar/v3/calendars": json(200, { id: "cal_1" }),
		});
		try {
			const job: Extract<ClaimedJob, { kind: "google-calendar" }> = {
				kind: "google-calendar",
				runId: "run_google",
				leaseGeneration: 1,
				leaseExpiresAt: "2026-10-11T00:01:30.000Z",
				attempt: 1,
				heartbeatIntervalMs: 20_000,
				sources: [],
				action: "connect",
			};
			const pending = executeGoogleCalendar(
				job,
				harness.env,
				never,
				stubReporter(harness),
				async (url) => harness.sentUrls.push(url) > 0,
			);
			await waitFor(() => harness.sentUrls.length === 1);
			const sent = harness.sentUrls[0];
			if (sent === undefined) throw new Error("no auth URL sent");
			expect(sent.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
			// The API accepts exactly this shape and nothing looser.
			expect(isGoogleSignInUrl(sent)).toBe(true);
			const params = new URL(sent).searchParams;
			const state = params.get("state");
			if (state === null) throw new Error("auth URL has no state");
			const port = new URL(params.get("redirect_uri") ?? "").port;
			const callback = await fetch(`http://127.0.0.1:${port}/?code=${AUTH_CODE}&state=${state}`);
			expect(callback.status).toBe(200);
			const completion = await pending;
			expect(completion).toMatchObject({
				outcome: "google-calendar-connected",
				leaseGeneration: 1,
				calendarId: "cal_1",
			});
			// The token exchange carried every required field.
			const tokenCall = harness.httpCalls.find((call) => call.path === "/token");
			expect(tokenCall?.body).toContain("grant_type=authorization_code");
			expect(tokenCall?.body).toContain(`code=${AUTH_CODE}`);
			expect(tokenCall?.body).toContain("code_verifier=");
			expect(tokenCall?.body).not.toContain("refresh_token=");
			// The token file holds the refresh token and calendar id, mode 0600.
			expect((await stat(harness.tokenFile)).mode & 0o777).toBe(0o600);
			expect(await readGoogleTokenFile(harness.tokenFile)).toMatchObject({
				version: 1,
				refreshToken: REFRESH_TOKEN,
				calendarId: "cal_1",
			});
			// Security check 1: secrets never reach logs, the sent event or the completion.
			const verifier = new URLSearchParams(tokenCall?.body ?? "").get("code_verifier") ?? "";
			scanSecrets(
				[
					...harness.logs.map((line) => JSON.stringify(line)),
					...harness.sentUrls,
					JSON.stringify(completion),
					JSON.stringify(harness.states),
				],
				[CLIENT_SECRET, AUTH_CODE, verifier, REFRESH_TOKEN, ACCESS_TOKEN],
			);
			expect(harness.states).toEqual([
				"planning",
				"collecting",
				"analyzing",
				"verifying",
				"publishing",
			]);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("reuses the stored calendar id when Google still has it", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, {
				access_token: ACCESS_TOKEN,
				refresh_token: "new-refresh",
				scope: "https://www.googleapis.com/auth/calendar.app.created",
			}),
			"GET /calendar/v3/calendars/cal_old": json(200, { id: "cal_old" }),
		});
		try {
			await writeGoogleTokenFile(harness.tokenFile, {
				version: 1,
				refreshToken: "old-refresh",
				calendarId: "cal_old",
				scope: "https://www.googleapis.com/auth/calendar.app.created",
				savedAt: "2026-10-11T00:00:00.000Z",
			});
			const job: Extract<ClaimedJob, { kind: "google-calendar" }> = {
				kind: "google-calendar",
				runId: "run_google",
				leaseGeneration: 1,
				leaseExpiresAt: "2026-10-11T00:01:30.000Z",
				attempt: 1,
				heartbeatIntervalMs: 20_000,
				sources: [],
				action: "connect",
			};
			const pending = executeGoogleCalendar(
				job,
				harness.env,
				never,
				stubReporter(harness),
				async (url) => harness.sentUrls.push(url) > 0,
			);
			await waitFor(() => harness.sentUrls.length === 1);
			const sent = harness.sentUrls[0];
			if (sent === undefined) throw new Error("no auth URL sent");
			const params = new URL(sent).searchParams;
			const port = new URL(params.get("redirect_uri") ?? "").port;
			await fetch(`http://127.0.0.1:${port}/?code=${AUTH_CODE}&state=${params.get("state") ?? ""}`);
			const completion = await pending;
			expect(completion).toMatchObject({
				outcome: "google-calendar-connected",
				calendarId: "cal_old",
			});
			// No calendar was created.
			expect(
				harness.httpCalls.some(
					(call) => call.path === "/calendar/v3/calendars" && call.method === "POST",
				),
			).toBe(false);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("fails GOOGLE_NOT_CONFIGURED without credentials, touching nothing", async () => {
		const harness = await googleHarness({}, { clientId: null, clientSecret: null });
		try {
			const completion = await executeGoogleCalendar(
				{
					kind: "google-calendar",
					runId: "run_google",
					leaseGeneration: 1,
					leaseExpiresAt: "2026-10-11T00:01:30.000Z",
					attempt: 1,
					heartbeatIntervalMs: 20_000,
					sources: [],
					action: "connect",
				},
				harness.env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({
				outcome: "failed",
				failureCode: "GOOGLE_NOT_CONFIGURED",
				retryable: false,
			});
			expect(harness.httpCalls).toEqual([]);
			expect(harness.sentUrls).toEqual([]);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("times out after 5 minutes on the fake clock and closes the listener", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }),
		});
		try {
			const job: Extract<ClaimedJob, { kind: "google-calendar" }> = {
				kind: "google-calendar",
				runId: "run_google",
				leaseGeneration: 1,
				leaseExpiresAt: "2026-10-11T00:01:30.000Z",
				attempt: 1,
				heartbeatIntervalMs: 20_000,
				sources: [],
				action: "connect",
			};
			const pending = executeGoogleCalendar(
				job,
				harness.env,
				never,
				stubReporter(harness),
				async (url) => harness.sentUrls.push(url) > 0,
			);
			await waitFor(() => harness.sentUrls.length === 1);
			// The 5-minute window comes from the injected sleep (fake clock).
			expect(harness.sleepMs).toEqual([GOOGLE_CONNECT_TIMEOUT_MS]);
			harness.releaseSleep();
			const completion = await pending;
			expect(completion).toMatchObject({ outcome: "failed", failureCode: "GOOGLE_AUTH_TIMEOUT" });
			const port = new URL(
				new URL(harness.sentUrls[0] ?? "").searchParams.get("redirect_uri") ?? "",
			).port;
			await expect(fetch(`http://127.0.0.1:${port}/?code=x&state=y`)).rejects.toThrow();
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("fails at once when the sign-in link cannot reach the API, instead of waiting out the window", async () => {
		const harness = await googleHarness({});
		try {
			const job: Extract<ClaimedJob, { kind: "google-calendar" }> = {
				kind: "google-calendar",
				runId: "run_google",
				leaseGeneration: 1,
				leaseExpiresAt: "2026-10-11T00:01:30.000Z",
				attempt: 1,
				heartbeatIntervalMs: 20_000,
				sources: [],
				action: "connect",
			};
			let attempts = 0;
			const pending = executeGoogleCalendar(
				job,
				harness.env,
				never,
				stubReporter(harness),
				async (url) => {
					attempts += 1;
					harness.sentUrls.push(url);
					return false;
				},
			);
			// Three pauses between four attempts, each released by hand; the
			// first sleep recorded is the listener's own 5-minute window.
			for (let pause = 0; pause < 3; pause += 1) {
				await waitFor(() => harness.sleepMs.length === pause + 2);
				harness.releaseSleep();
			}
			const completion = await pending;
			expect(attempts).toBe(4);
			expect(new Set(harness.sentUrls).size).toBe(1);
			expect(harness.sleepMs).toEqual([GOOGLE_CONNECT_TIMEOUT_MS, 2_000, 2_000, 2_000]);
			expect(completion).toMatchObject({
				outcome: "failed",
				failureCode: "GOOGLE_REQUEST_FAILED",
				retryable: false,
			});
			expect(harness.httpCalls).toEqual([]);
			scanSecrets(
				[...harness.logs.map((line) => JSON.stringify(line)), JSON.stringify(completion)],
				[CLIENT_SECRET],
			);
			const port = new URL(
				new URL(harness.sentUrls[0] ?? "").searchParams.get("redirect_uri") ?? "",
			).port;
			await expect(fetch(`http://127.0.0.1:${port}/?code=x&state=y`)).rejects.toThrow();
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("reports consent-denied without exchanging anything", async () => {
		const harness = await googleHarness({});
		try {
			const job: Extract<ClaimedJob, { kind: "google-calendar" }> = {
				kind: "google-calendar",
				runId: "run_google",
				leaseGeneration: 1,
				leaseExpiresAt: "2026-10-11T00:01:30.000Z",
				attempt: 1,
				heartbeatIntervalMs: 20_000,
				sources: [],
				action: "connect",
			};
			const pending = executeGoogleCalendar(
				job,
				harness.env,
				never,
				stubReporter(harness),
				async (url) => harness.sentUrls.push(url) > 0,
			);
			await waitFor(() => harness.sentUrls.length === 1);
			const sent = harness.sentUrls[0];
			if (sent === undefined) throw new Error("no auth URL sent");
			const params = new URL(sent).searchParams;
			const port = new URL(params.get("redirect_uri") ?? "").port;
			await fetch(
				`http://127.0.0.1:${port}/?error=access_denied&state=${params.get("state") ?? ""}`,
			);
			const completion = await pending;
			expect(completion).toMatchObject({ outcome: "failed", failureCode: "GOOGLE_CONSENT_DENIED" });
			expect(harness.httpCalls).toEqual([]);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("reports scope-missing when Google grants no refresh token", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, { access_token: ACCESS_TOKEN }),
		});
		try {
			const job: Extract<ClaimedJob, { kind: "google-calendar" }> = {
				kind: "google-calendar",
				runId: "run_google",
				leaseGeneration: 1,
				leaseExpiresAt: "2026-10-11T00:01:30.000Z",
				attempt: 1,
				heartbeatIntervalMs: 20_000,
				sources: [],
				action: "connect",
			};
			const pending = executeGoogleCalendar(
				job,
				harness.env,
				never,
				stubReporter(harness),
				async (url) => harness.sentUrls.push(url) > 0,
			);
			await waitFor(() => harness.sentUrls.length === 1);
			const sent = harness.sentUrls[0];
			if (sent === undefined) throw new Error("no auth URL sent");
			const params = new URL(sent).searchParams;
			const port = new URL(params.get("redirect_uri") ?? "").port;
			await fetch(`http://127.0.0.1:${port}/?code=${AUTH_CODE}&state=${params.get("state") ?? ""}`);
			const completion = await pending;
			expect(completion).toMatchObject({ outcome: "failed", failureCode: "GOOGLE_SCOPE_MISSING" });
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("a grant that is not kept is given back", () => {
	it("revokes the new grant and stores nothing when the calendar cannot be created", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, GRANTED),
			"POST /calendar/v3/calendars": json(500, {}),
			"POST /revoke": json(200, {}),
		});
		try {
			const completion = await connectThroughCallback(harness);
			expect(completion).toMatchObject({ outcome: "failed", failureCode: "GOOGLE_REQUEST_FAILED" });
			const revoke = harness.httpCalls.find((call) => call.path === "/revoke");
			expect(revoke?.body).toBe(`token=${REFRESH_TOKEN}`);
			expect(await readGoogleTokenFile(harness.tokenFile)).toBe(null);
			scanSecrets(
				[...harness.logs.map((line) => JSON.stringify(line)), JSON.stringify(completion)],
				[CLIENT_SECRET, AUTH_CODE, REFRESH_TOKEN, ACCESS_TOKEN],
			);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("revokes the new grant when the token file cannot be written, then fails", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, GRANTED),
			"POST /calendar/v3/calendars": json(200, { id: "cal_1" }),
			"POST /revoke": json(200, {}),
		});
		try {
			// A directory in the token file's place makes the atomic rename fail.
			await mkdir(harness.tokenFile);
			await expect(connectThroughCallback(harness)).rejects.toThrow();
			const revoke = harness.httpCalls.find((call) => call.path === "/revoke");
			expect(revoke?.body).toBe(`token=${REFRESH_TOKEN}`);
			expect(harness.logs.find((line) => line.event === "google_grant_discarded")?.fields).toEqual({
				runId: "run_google",
				revoked: true,
			});
			expect(harness.logs.some((line) => line.event === "google_connected")).toBe(false);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("revokes the grant when the granted scope is not the one requested", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, { ...GRANTED, scope: "openid" }),
			"POST /revoke": json(200, {}),
		});
		try {
			const completion = await connectThroughCallback(harness);
			expect(completion).toMatchObject({ outcome: "failed", failureCode: "GOOGLE_SCOPE_MISSING" });
			expect(harness.httpCalls.map((call) => call.path)).toEqual(["/token", "/revoke"]);
			expect(await readGoogleTokenFile(harness.tokenFile)).toBe(null);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("stores nothing and revokes when the job is stopped while the calendar is being created", async () => {
		const stop = new AbortController();
		const harness = await googleHarness({
			"POST /token": json(200, GRANTED),
			// The stop arrives during this call, which itself still succeeds.
			"POST /calendar/v3/calendars": () => {
				stop.abort();
				return { status: 200, text: JSON.stringify({ id: "cal_1" }) };
			},
			"POST /revoke": json(200, {}),
		});
		try {
			const completion = await connectThroughCallback(harness, stop.signal);
			expect(completion.outcome).toBe("failed");
			expect(harness.httpCalls.at(-1)?.path).toBe("/revoke");
			expect(await readGoogleTokenFile(harness.tokenFile)).toBe(null);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("gives a stored grant back when the connect then ends cancelled (executeJob)", async () => {
		// The cancel arrives with the LAST progress event, after the token
		// file was written: the run completes `cancelled`, so the API will
		// say "not connected" — no live token may stay behind.
		const { api, calls } = createFakeApi({});
		const base = createDeps(api);
		const harness = await googleHarness({
			"POST /token": json(200, GRANTED),
			"POST /calendar/v3/calendars": json(200, { id: "cal_1" }),
			"POST /revoke": json(200, {}),
		});
		let written = false;
		const cancelling = {
			...api,
			events: async (...args: Parameters<typeof api.events>) => {
				const sent = await api.events(...args);
				const [, request] = args;
				const publishing = request.events.some(
					(entry) => entry.event.type === "state" && entry.event.state === "publishing",
				);
				if (publishing) {
					written = (await readGoogleTokenFile(harness.tokenFile)) !== null;
					return ok({ cancelRequested: true });
				}
				return sent;
			},
		};
		try {
			const run = executeJob(
				CONNECT,
				{ ...base.deps, api: cancelling, google: harness.env.google },
				never,
			);
			await waitFor(() =>
				calls.events
					.flatMap((request) => request.events)
					.some((entry) => entry.event.type === "google-auth-url"),
			);
			const sent = calls.events
				.flatMap((request) => request.events)
				.find((entry) => entry.event.type === "google-auth-url");
			if (sent === undefined || sent.event.type !== "google-auth-url")
				throw new Error("no auth-url event sent");
			const params = new URL(sent.event.url).searchParams;
			const port = new URL(params.get("redirect_uri") ?? "").port;
			await fetch(`http://127.0.0.1:${port}/?code=${AUTH_CODE}&state=${params.get("state") ?? ""}`);
			await run;
			expect(written).toBe(true);
			expect(calls.completions).toHaveLength(1);
			expect(calls.completions[0]).toMatchObject({ outcome: "cancelled" });
			expect(harness.httpCalls.at(-1)).toMatchObject({
				path: "/revoke",
				body: `token=${REFRESH_TOKEN}`,
			});
			expect(await readGoogleTokenFile(harness.tokenFile)).toBe(null);
			await expect(stat(harness.tokenFile)).rejects.toThrow();
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("request failures are not sign-in timeouts", () => {
	it("reports a Calendar request that hit the port's own time limit as a request failure", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, { access_token: ACCESS_TOKEN, expires_in: 3600 }),
		});
		try {
			await writeGoogleTokenFile(harness.tokenFile, {
				version: 1,
				refreshToken: REFRESH_TOKEN,
				calendarId: "cal_1",
				scope: "https://www.googleapis.com/auth/calendar.app.created",
				savedAt: "2026-10-11T00:00:00.000Z",
			});
			const scripted = harness.env.google.http;
			const env: GoogleExecutionEnv = {
				...harness.env,
				google: {
					...harness.env.google,
					http: async (request) =>
						request.path.startsWith("/calendar/")
							? err({ code: "TIMEOUT", detail: "request timed out" })
							: scripted(request),
				},
			};
			const completion = await executeGoogleCalendar(
				syncJob([]),
				env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({
				outcome: "failed",
				failureCode: "GOOGLE_REQUEST_FAILED",
				retryable: false,
			});
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("sync execution", () => {
	function managedRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
		return {
			"POST /token": json(200, { access_token: ACCESS_TOKEN, expires_in: 3600 }),
			"GET /calendar/v3/calendars/cal_1": json(200, { id: "cal_1" }),
			"GET /calendar/v3/calendars/cal_1/events": json(200, {
				items: [
					{
						...BODY_A,
						status: "confirmed",
						summary: "Old title",
						start: { date: BODY_A.startDate },
						end: { date: BODY_A.endDate },
					},
					{
						id: "c".repeat(32),
						status: "confirmed",
						summary: "gone",
						description: "",
						start: { date: "2026-09-01" },
						end: { date: "2026-09-02" },
					},
					{ id: "d".repeat(32), status: "cancelled" },
				],
			}),
			...extra,
		};
	}

	async function storedToken(harness: GoogleHarness): Promise<void> {
		await writeGoogleTokenFile(harness.tokenFile, {
			version: 1,
			refreshToken: REFRESH_TOKEN,
			calendarId: "cal_1",
			scope: "https://www.googleapis.com/auth/calendar.app.created",
			savedAt: "2026-10-11T00:00:00.000Z",
		});
	}

	it("applies deletes, updates then inserts, and reports counts", async () => {
		const harness = await googleHarness({
			...managedRoutes(),
			"POST /calendar/v3/calendars/cal_1/events": json(200, { id: "b".repeat(32) }),
			"PUT /calendar/v3/calendars/cal_1/events/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": json(200, {}),
			"DELETE /calendar/v3/calendars/cal_1/events/cccccccccccccccccccccccccccccccc": json(200, {}),
		});
		try {
			await storedToken(harness);
			const completion = await executeGoogleCalendar(
				syncJob([BODY_A, BODY_B]),
				harness.env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({
				outcome: "google-calendar-synced",
				leaseGeneration: 2,
				calendarId: "cal_1",
				desiredDigest: "ab".repeat(32),
				inserted: 1,
				updated: 1,
				deleted: 1,
				unchanged: 0,
			});
			// Order: deletes, updates, inserts.
			const writes = harness.httpCalls.filter(
				(call) =>
					call.method === "DELETE" ||
					call.method === "PUT" ||
					(call.method === "POST" && call.path.endsWith("/events")),
			);
			expect(writes.map((call) => `${call.method} ${call.path.split("/").at(-1)}`)).toEqual([
				"DELETE cccccccccccccccccccccccccccccccc",
				"PUT aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"POST events",
			]);
			scanSecrets(
				[...harness.logs.map((line) => JSON.stringify(line)), JSON.stringify(completion)],
				[CLIENT_SECRET, REFRESH_TOKEN, ACCESS_TOKEN],
			);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("retries a conflicting insert once as an update", async () => {
		const harness = await googleHarness({
			...managedRoutes(),
			"POST /calendar/v3/calendars/cal_1/events": json(409, {}),
			"PUT /calendar/v3/calendars/cal_1/events/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": json(200, {}),
			"PUT /calendar/v3/calendars/cal_1/events/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": json(200, {}),
			"DELETE /calendar/v3/calendars/cal_1/events/cccccccccccccccccccccccccccccccc": json(200, {}),
		});
		try {
			await storedToken(harness);
			const completion = await executeGoogleCalendar(
				syncJob([BODY_A, BODY_B]),
				harness.env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({
				outcome: "google-calendar-synced",
				inserted: 0,
				updated: 2,
				deleted: 1,
			});
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("recreates a calendar Google no longer has and treats managed events as empty", async () => {
		const harness = await googleHarness({
			"POST /token": json(200, { access_token: ACCESS_TOKEN }),
			"GET /calendar/v3/calendars/cal_1": json(404, {}),
			"POST /calendar/v3/calendars": json(200, { id: "cal_new" }),
			"POST /calendar/v3/calendars/cal_new/events": json(200, { id: "a".repeat(32) }),
		});
		try {
			await storedToken(harness);
			const completion = await executeGoogleCalendar(
				syncJob([BODY_A]),
				harness.env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({
				outcome: "google-calendar-synced",
				calendarId: "cal_new",
				inserted: 1,
				updated: 0,
				deleted: 0,
				unchanged: 0,
			});
			expect(await readGoogleTokenFile(harness.tokenFile)).toMatchObject({ calendarId: "cal_new" });
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("fails auth-expired with no token file, or on invalid_grant", async () => {
		const missing = await googleHarness({});
		try {
			const completion = await executeGoogleCalendar(
				syncJob([BODY_A]),
				missing.env,
				never,
				stubReporter(missing),
				async () => true,
			);
			expect(completion).toMatchObject({ outcome: "failed", failureCode: "GOOGLE_AUTH_EXPIRED" });
		} finally {
			await rm(missing.dir, { recursive: true, force: true });
		}
		const revoked = await googleHarness({
			"POST /token": json(400, { error: "invalid_grant" }),
		});
		try {
			await storedToken(revoked);
			const completion = await executeGoogleCalendar(
				syncJob([BODY_A]),
				revoked.env,
				never,
				stubReporter(revoked),
				async () => true,
			);
			expect(completion).toMatchObject({ outcome: "failed", failureCode: "GOOGLE_AUTH_EXPIRED" });
		} finally {
			await rm(revoked.dir, { recursive: true, force: true });
		}
	});
});

describe("disconnect execution", () => {
	it("revokes, deletes the token file and completes revoked", async () => {
		const harness = await googleHarness({ "POST /revoke": json(200, {}) });
		try {
			await writeGoogleTokenFile(harness.tokenFile, {
				version: 1,
				refreshToken: REFRESH_TOKEN,
				calendarId: "cal_1",
				scope: "https://www.googleapis.com/auth/calendar.app.created",
				savedAt: "2026-10-11T00:00:00.000Z",
			});
			const completion = await executeGoogleCalendar(
				{
					kind: "google-calendar",
					runId: "run_google",
					leaseGeneration: 1,
					leaseExpiresAt: "2026-10-11T00:01:30.000Z",
					attempt: 1,
					heartbeatIntervalMs: 20_000,
					sources: [],
					action: "disconnect",
				},
				harness.env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({ outcome: "google-calendar-disconnected", revoked: true });
			expect(await readGoogleTokenFile(harness.tokenFile)).toBe(null);
			const revoke = harness.httpCalls.find((call) => call.path === "/revoke");
			expect(revoke?.body).toBe("token=test-refresh-token-456");
			scanSecrets(
				[...harness.logs.map((line) => JSON.stringify(line)), JSON.stringify(completion)],
				[CLIENT_SECRET, REFRESH_TOKEN],
			);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});

	it("completes unrevoked when the revoke fails, still deleting the file", async () => {
		const harness = await googleHarness({ "POST /revoke": json(400, { error: "invalid_token" }) });
		try {
			await writeGoogleTokenFile(harness.tokenFile, {
				version: 1,
				refreshToken: REFRESH_TOKEN,
				calendarId: "cal_1",
				scope: "https://www.googleapis.com/auth/calendar.app.created",
				savedAt: "2026-10-11T00:00:00.000Z",
			});
			const completion = await executeGoogleCalendar(
				{
					kind: "google-calendar",
					runId: "run_google",
					leaseGeneration: 1,
					leaseExpiresAt: "2026-10-11T00:01:30.000Z",
					attempt: 1,
					heartbeatIntervalMs: 20_000,
					sources: [],
					action: "disconnect",
				},
				harness.env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({ outcome: "google-calendar-disconnected", revoked: false });
			expect(await readGoogleTokenFile(harness.tokenFile)).toBe(null);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("disconnect with a token file that does not parse", () => {
	it("still deletes the file (it may hold a token) and completes unrevoked", async () => {
		const harness = await googleHarness({});
		try {
			await writeFile(
				harness.tokenFile,
				JSON.stringify({ version: 1, refreshToken: REFRESH_TOKEN, extra: true }),
				{ mode: 0o600 },
			);
			const completion = await executeGoogleCalendar(
				{ ...CONNECT, action: "disconnect" },
				harness.env,
				never,
				stubReporter(harness),
				async () => true,
			);
			expect(completion).toMatchObject({ outcome: "google-calendar-disconnected", revoked: false });
			await expect(stat(harness.tokenFile)).rejects.toThrow();
			expect(harness.httpCalls).toEqual([]);
		} finally {
			await rm(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("cancellation and lease loss through executeJob", () => {
	const CONNECT_JOB: Extract<ClaimedJob, { kind: "google-calendar" }> = {
		kind: "google-calendar",
		runId: "run_google",
		leaseGeneration: 1,
		leaseExpiresAt: "2026-10-11T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		action: "connect",
	};

	it("cancellation closes the listener and completes cancelled", async () => {
		const { api, calls } = createFakeApi({
			events: [ok({ cancelRequested: true })],
		});
		const harness = createDeps(api);
		const dir = await mkdtemp(join(tmpdir(), "runner-google-cancel-"));
		try {
			const google = {
				config: {
					clientId: CLIENT_ID,
					clientSecret: CLIENT_SECRET,
					tokenFile: join(dir, "google-token.json"),
				},
				http: scriptedHttp(
					{
						"POST /token": json(200, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }),
					},
					[],
				),
				sleep: async () => {},
			};
			await executeJob(CONNECT_JOB, { ...harness.deps, google }, never);
			expect(calls.completions).toHaveLength(1);
			expect(calls.completions[0]).toMatchObject({ outcome: "cancelled", leaseGeneration: 1 });
			// The listener is closed: the captured sign-in port refuses connections.
			const sent = calls.events
				.flatMap((request) => request.events)
				.find((entry) => entry.event.type === "google-auth-url");
			if (sent === undefined || sent.event.type !== "google-auth-url")
				throw new Error("no auth-url event sent");
			const port = new URL(new URL(sent.event.url).searchParams.get("redirect_uri") ?? "").port;
			await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("lease loss abandons the run with no completion and a closed listener", async () => {
		const { api, calls } = createFakeApi({
			events: [err({ code: "STALE_LEASE", detail: "", transient: false })],
		});
		const harness = createDeps(api);
		const dir = await mkdtemp(join(tmpdir(), "runner-google-lease-"));
		try {
			const google = {
				config: {
					clientId: CLIENT_ID,
					clientSecret: CLIENT_SECRET,
					tokenFile: join(dir, "google-token.json"),
				},
				http: scriptedHttp({}, []),
				sleep: async () => {},
			};
			await executeJob(CONNECT_JOB, { ...harness.deps, google }, never);
			expect(calls.completions).toHaveLength(0);
			const sent = calls.events
				.flatMap((request) => request.events)
				.find((entry) => entry.event.type === "google-auth-url");
			if (sent !== undefined && sent.event.type === "google-auth-url") {
				const port = new URL(new URL(sent.event.url).searchParams.get("redirect_uri") ?? "").port;
				await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("an unconfigured google job completes NOT_CONFIGURED through the lease machinery", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(CONNECT_JOB, harness.deps, never);
		expect(calls.completions).toHaveLength(1);
		expect(calls.completions[0]).toMatchObject({
			outcome: "failed",
			failureCode: "GOOGLE_NOT_CONFIGURED",
			retryable: false,
		});
	});
});
