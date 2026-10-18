/**
 * Google Calendar (crate `research-google`): the OAuth helpers, the Calendar
 * client, the token file and the runner's connect / sync / disconnect flows
 * (`googleOAuth.ts`, `googleCalendarClient.ts`, `googleTokenStore.ts`,
 * `apps/runner/src/googleCalendar.ts`).
 *
 * Adapter cases are transcripts over a scripted narrow-HTTP function that
 * records every request. Flow cases run the real orchestration with the real
 * loopback listener and token store in a temporary directory, a scripted
 * "browser" that answers the sign-in link, and a scripted Google; they record
 * the requests (with the random PKCE verifier, state and port masked after
 * being cross-checked against the link), states, logs, sleeps, the token file
 * and the completion.
 *
 * The loopback listener, the pinned TLS transport and the file permissions are
 * hand-tested in Rust against local servers (see the crate's tests).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineReporter } from "@research/application";
import type { ClaimedJob } from "@research/contracts";
import { isGoogleSignInUrl } from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import type { EventLogger } from "@research/effects";
import {
	discardStoredGoogleGrant,
	executeGoogleCalendar,
	type GoogleExecutionEnv,
} from "../../apps/runner/src/googleCalendar.ts";
import { createMarketPacer } from "../../apps/runner/src/marketPacing.ts";
import {
	type CalendarCallDeps,
	type CalendarEventWrite,
	createCalendar,
	deleteEvent,
	type GoogleCallCode,
	getCalendar,
	insertEvent,
	listManagedEvents,
	updateEvent,
} from "../../packages/adapters/src/google/googleCalendarClient.ts";
import type {
	GoogleHttpError,
	GoogleHttpRequest,
	GoogleHttpResult,
} from "../../packages/adapters/src/google/googleHttp.ts";
import {
	buildAuthorizationUrl,
	codeChallengeS256,
	exchangeCode,
	mapTokenFailure,
	newCodeVerifier,
	newOAuthState,
	refreshAccessToken,
	revokeToken,
	scopeGranted,
} from "../../packages/adapters/src/google/googleOAuth.ts";
import {
	deleteGoogleTokenFile,
	readGoogleTokenFile,
	writeGoogleTokenFile,
} from "../../packages/adapters/src/google/googleTokenStore.ts";
import { plain, Rng } from "./finance/support.ts";
import type { VectorExporter, VectorFile } from "./shared.ts";

/* ---------- scripted narrow HTTP ---------- */

type HttpAnswer =
	| { readonly status: number; readonly text: string; readonly location?: string | null }
	| { readonly error: GoogleHttpError };

interface RecordedRequest {
	readonly host: string;
	readonly method: string;
	readonly path: string;
	readonly headers: { readonly [name: string]: string };
	readonly body: string | null;
}

function recordRequest(request: GoogleHttpRequest): RecordedRequest {
	return {
		host: request.host,
		method: request.method,
		path: request.path,
		headers: { ...request.headers },
		body: request.body,
	};
}

function answerOf(answer: HttpAnswer | undefined): GoogleHttpResult {
	if (answer === undefined)
		return ok({ status: 404, location: null, contentType: null, text: "{}" });
	if ("error" in answer) return err(answer.error);
	return ok({
		status: answer.status,
		location: answer.location ?? null,
		contentType: "application/json",
		text: answer.text,
	});
}

/** Answers the n-th call with the n-th entry (404 `{}` past the end). */
function sequentialHttp(
	script: readonly HttpAnswer[],
	requests: RecordedRequest[],
	onCall?: (index: number) => void,
): (request: GoogleHttpRequest) => Promise<GoogleHttpResult> {
	let index = 0;
	return async (request) => {
		requests.push(recordRequest(request));
		const answer = script[index];
		index += 1;
		onCall?.(index);
		return answerOf(answer);
	};
}

const NEVER = new AbortController().signal;

/* ---------- corpora ---------- */

const TOKEN_BODIES: readonly string[] = [
	"",
	"{}",
	"[]",
	"null",
	"{oops",
	'{"error":"invalid_grant"}',
	'{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
	'{"error":{"code":"invalid_grant"}}',
	'{"error":{"code":"rateLimitExceeded"}}',
	'{"error":{"code":5}}',
	'{"error":{"message":"x"}}',
	'{"error":"rateLimitExceeded"}',
	'{"rateLimitExceeded":true}',
	'{"rateLimitExceeded":false,"error":"x"}',
	'{"rateLimitExceeded":"true"}',
	'{"error":"invalid_grant","rateLimitExceeded":true}',
	'{"error":"x","error_description":5}',
	'{"error":5}',
	'{"error":null}',
	'{"error_description":"d"}',
	'{"error":[]}',
	'{"error":{"code":"invalid_grant","extra":1}}',
	'{"error":"invalid_grant","error":"x"}',
	'{"error":"x","error":"invalid_grant"}',
];

const STATUSES: readonly (number | null)[] = [
	null,
	200,
	201,
	204,
	299,
	300,
	301,
	302,
	307,
	399,
	400,
	401,
	403,
	404,
	408,
	429,
	500,
	503,
];

function pureCases(rng: Rng): unknown {
	const clientIds = [
		"client-id.apps.googleusercontent.com",
		"a b&c=d",
		"é日本😀",
		"x".repeat(200),
		"",
		"a+b/c?d#e%f",
	];
	const redirects = [
		"http://127.0.0.1:54321/",
		"http://127.0.0.1:1/",
		"http://localhost:80/x?y=z",
		"",
		"é",
	];
	const states = ["abc", "A-_0".repeat(11), "", "a b", "é"];
	const urls = [];
	for (const clientId of clientIds) {
		for (const redirectUri of redirects) {
			const state = rng.pick(states);
			const challenge = codeChallengeS256(rng.pick(["verifier", "a", "é"]));
			const url = buildAuthorizationUrl({ clientId, redirectUri, state, challenge });
			urls.push({ clientId, redirectUri, state, challenge, url, signIn: isGoogleSignInUrl(url) });
		}
	}
	const verifiers = [
		"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		"",
		"a",
		"é日本😀",
		"x".repeat(1000),
		"A-_0".repeat(11),
		"\u0000",
		"a b",
	];
	const challenges = verifiers.map((verifier) => ({
		verifier,
		challenge: codeChallengeS256(verifier),
	}));
	const scopes = [
		null,
		"",
		"https://www.googleapis.com/auth/calendar.app.created",
		"openid https://www.googleapis.com/auth/calendar.app.created email",
		"https://www.googleapis.com/auth/calendar.app.created ",
		" https://www.googleapis.com/auth/calendar.app.created",
		"https://www.googleapis.com/auth/calendar.app.created  x",
		"https://www.googleapis.com/auth/calendar",
		"https://www.googleapis.com/auth/calendar.app.created\nx",
		"HTTPS://www.googleapis.com/auth/calendar.app.created",
	];
	const failures = [];
	for (const status of STATUSES) {
		for (const text of [...TOKEN_BODIES, null]) {
			failures.push({ status, text, output: mapTokenFailure(status, text) });
		}
	}
	const random = [newCodeVerifier(), newOAuthState()];
	return {
		urls,
		challenges,
		scopes: scopes.map((scope) => ({ scope, output: scopeGranted(scope) })),
		failures,
		shapes: random.map((value) => ({
			length: value.length,
			urlSafe: /^[A-Za-z0-9_-]{43}$/.test(value),
		})),
	};
}

/* ---------- OAuth transcripts ---------- */

interface OAuthCase {
	readonly op: "exchange" | "refresh" | "revoke";
	readonly script: readonly HttpAnswer[];
	readonly requests: readonly RecordedRequest[];
	readonly output: unknown;
}

const OAUTH_BODIES: readonly string[] = [
	'{"access_token":"at","refresh_token":"rt","scope":"https://www.googleapis.com/auth/calendar.app.created","expires_in":3600,"token_type":"Bearer"}',
	'{"access_token":"at","refresh_token":"rt"}',
	'{"access_token":"at"}',
	'{"access_token":"at","expires_in":3600}',
	'{"access_token":"at","expires_in":3600.0}',
	'{"access_token":"at","expires_in":-1}',
	'{"access_token":"at","expires_in":1.5}',
	'{"access_token":"at","expires_in":"3600"}',
	'{"access_token":"at","expires_in":9007199254740993}',
	'{"access_token":"","refresh_token":"rt"}',
	'{"access_token":"at","refresh_token":""}',
	'{"access_token":"at","refresh_token":5}',
	'{"access_token":"at","refresh_token":null}',
	'{"access_token":"at","refresh_token":"rt","scope":5}',
	'{"access_token":"at","refresh_token":"rt","token_type":5}',
	'{"access_token":"at","refresh_token":"rt","extra":{"a":1}}',
	'{"refresh_token":"rt"}',
	"{}",
	"[]",
	"",
	"{oops",
	'{"access_token":"at","access_token":"later","refresh_token":"rt"}',
];

async function runOAuth(op: OAuthCase["op"], script: readonly HttpAnswer[]): Promise<OAuthCase> {
	const requests: RecordedRequest[] = [];
	const http = sequentialHttp(script, requests);
	let output: unknown;
	if (op === "exchange") {
		output = await exchangeCode(http, {
			clientId: "cid & 1",
			clientSecret: "sec=ret",
			code: "co de/+",
			verifier: "veri~fier",
			redirectUri: "http://127.0.0.1:5555/",
			signal: NEVER,
		});
	} else if (op === "refresh") {
		output = await refreshAccessToken(http, {
			clientId: "cid",
			clientSecret: "sec",
			refreshToken: "re fresh",
			signal: NEVER,
		});
	} else {
		output = await revokeToken(http, { token: "to ken&=", signal: NEVER });
	}
	return { op, script, requests, output: plain(output) };
}

async function oauthCases(rng: Rng): Promise<OAuthCase[]> {
	const cases: OAuthCase[] = [];
	for (const op of ["exchange", "refresh", "revoke"] as const) {
		for (const body of OAUTH_BODIES) {
			cases.push(await runOAuth(op, [{ status: 200, text: body }]));
		}
		for (const status of [201, 204, 301, 302, 400, 401, 403, 404, 429, 500]) {
			for (const body of TOKEN_BODIES.slice(0, 12)) {
				cases.push(await runOAuth(op, [{ status, text: body }]));
			}
		}
		for (const code of [
			"HOST_NOT_ALLOWED",
			"DNS_FAILED",
			"UNSAFE_DESTINATION",
			"NETWORK_ERROR",
			"TIMEOUT",
			"RESPONSE_TOO_LARGE",
		] as const) {
			cases.push(await runOAuth(op, [{ error: { code, detail: "d" } }]));
		}
	}
	void rng;
	return cases;
}

/* ---------- Calendar client transcripts ---------- */

type CalendarOp =
	| { readonly name: "get"; readonly calendarId: string }
	| { readonly name: "create" }
	| { readonly name: "list"; readonly calendarId: string }
	| { readonly name: "insert"; readonly calendarId: string; readonly body: CalendarEventWrite }
	| { readonly name: "update"; readonly calendarId: string; readonly body: CalendarEventWrite }
	| { readonly name: "delete"; readonly calendarId: string; readonly eventId: string };

type RefreshAnswer = { readonly token: string } | { readonly code: string };

interface CalendarCase {
	readonly ops: readonly CalendarOp[];
	readonly before: readonly boolean[];
	readonly refreshes: readonly RefreshAnswer[];
	readonly abortAfterRequest: number | null;
	readonly abortBeforeStart: boolean;
	readonly script: readonly HttpAnswer[];
	readonly requests: readonly RecordedRequest[];
	readonly output: unknown;
}

function eventBody(rng: Rng): CalendarEventWrite {
	return {
		id: rng.pick(["a".repeat(32), "b".repeat(32), "c/d e", "é日本", "x?y#z"]),
		summary: rng.pick(["Title", 'He said "hi"', "日本語  ", "tab\there", "\u0000ctl", "😀"]),
		description: rng.pick(["desc", "line1\nline2", "", "<b>&amp;</b>", "\\back"]),
		startDate: rng.pick(["2026-10-29", "2026-02-29"]),
		endDate: rng.pick(["2026-10-30", "2026-03-01"]),
		privateProperties: {
			researchWorkspace: "earnings",
			stockId: rng.pick(["us:AAPL", "jp:7203"]),
			periodKey: rng.pick(["2026-q4", "fy2027-03-31-second-quarter"]),
		},
		sourceTitle: rng.pick(["Finnhub", "JPX"]),
		sourceUrl: rng.pick(["https://finnhub.io/", "https://www.jpx.co.jp/"]),
	};
}

const CALENDAR_IDS = ["cal_1", "a/b c", "é日本", "x+y@z.com", "primary", "a%b", "q?r#s", "(a)!*'~"];

function managedEvent(rng: Rng): unknown {
	const event: { [key: string]: unknown } = {
		id: rng.pick(["e1", "e2", "f".repeat(32), "é"]),
		status: rng.pick(["confirmed", "cancelled", "tentative", undefined]),
		summary: rng.pick(["S", "", undefined, "日本"]),
		description: rng.pick(["D", undefined]),
		start: rng.pick<unknown>([
			{ date: "2026-10-29" },
			{ dateTime: "2026-10-29T10:00:00Z" },
			{ date: "2026-10-29", dateTime: "x" },
			{},
			undefined,
			{ dateTime: "😀😀😀😀😀😀😀😀😀😀😀" },
			{ dateTime: "short" },
			{ date: "" },
		]),
		end: rng.pick<unknown>([
			{ date: "2026-10-30" },
			{ dateTime: "2026-10-30T10:00:00Z" },
			undefined,
			{},
		]),
	};
	for (const key of Object.keys(event)) if (event[key] === undefined) delete event[key];
	if (rng.chance(0.06)) {
		return rng.pick([
			null,
			"x",
			{ id: "" },
			{ id: 5 },
			{ id: "ok", status: 5 },
			{ id: "ok", start: null },
			{ id: "ok", start: { date: 5 } },
			{ id: "ok", summary: null },
		]);
	}
	return event;
}

function calendarBody(rng: Rng, op: CalendarOp["name"]): HttpAnswer {
	const roll = rng.float();
	if (op === "list") {
		if (roll < 0.55) {
			return {
				status: 200,
				text: JSON.stringify({
					items: Array.from({ length: rng.int(0, 4) }, () => managedEvent(rng)),
					...(rng.chance(0.4) ? { nextPageToken: rng.pick(["tok", "", "a b&c", "é"]) } : {}),
				}),
			};
		}
		if (roll < 0.62)
			return {
				status: 200,
				text: rng.pick([
					"{}",
					"[]",
					"{oops",
					'{"nextPageToken":5}',
					'{"items":5}',
					'{"items":[null]}',
				]),
			};
	} else if (op === "get" || op === "create") {
		if (roll < 0.5)
			return { status: 200, text: JSON.stringify({ id: rng.pick(["cal_1", "cal 2/é"]) }) };
		if (roll < 0.58)
			return { status: 200, text: rng.pick(["{}", '{"id":""}', '{"id":5}', "[]", "{oops", ""]) };
		if (op === "get" && roll < 0.68) return { status: 404, text: "{}" };
	} else if (op === "insert") {
		if (roll < 0.5) return { status: 200, text: "{}" };
		if (roll < 0.62) return { status: 409, text: "{}" };
	} else if (op === "update") {
		if (roll < 0.6) return { status: 200, text: "{}" };
	} else if (roll < 0.6) {
		return { status: rng.pick([200, 204, 404, 410]), text: "" };
	}
	const status = rng.pick([201, 204, 301, 302, 400, 401, 401, 403, 404, 409, 410, 429, 500, 503]);
	const text = rng.pick([
		"{}",
		"",
		"{oops",
		'{"error":"invalid_grant"}',
		'{"error":{"code":403,"reason":"rateLimitExceeded"}}',
		'{"error":{"code":403,"status":"RESOURCE_EXHAUSTED"}}',
		'{"error":{"errors":[{"reason":"quotaExceeded"}]}}',
		'{"error":{"errors":[{"reason":"userRateLimitExceeded"},{"reason":"x"}]}}',
		'{"error":{"errors":[{"reason":5}]}}',
		'{"error":{"errors":[5]}}',
		'{"error":{"errors":5}}',
		'{"error":{"reason":5}}',
		'{"error":{"code":"x"}}',
		'{"error":{"errors":[{"reason":"invalid_grant"}],"reason":"rateLimitExceeded"}}',
		'{"error":"rateLimitExceeded"}',
		'{"error":null}',
		'{"error":{"reason":"invalid_grant"}}',
	]);
	return { status, text };
}

async function runCalendar(
	ops: readonly CalendarOp[],
	before: readonly boolean[],
	refreshes: readonly RefreshAnswer[],
	abortAfterRequest: number | null,
	abortBeforeStart: boolean,
	script: readonly HttpAnswer[],
): Promise<CalendarCase> {
	const requests: RecordedRequest[] = [];
	const controller = new AbortController();
	if (abortBeforeStart) controller.abort();
	const http = sequentialHttp(script, requests, (count) => {
		if (abortAfterRequest === count) controller.abort();
	});
	let token = "tok-0";
	let beforeIndex = 0;
	let refreshIndex = 0;
	const trace: unknown[] = [];
	const deps: CalendarCallDeps = {
		http,
		accessToken: () => token,
		refreshAccessToken: async (): Promise<Result<string, { code: GoogleCallCode }>> => {
			const answer = refreshes[refreshIndex];
			refreshIndex += 1;
			trace.push({ refresh: true });
			if (answer === undefined) return err({ code: "GOOGLE_REQUEST_FAILED" });
			if ("code" in answer) return err({ code: answer.code as GoogleCallCode });
			token = answer.token;
			return ok(token);
		},
		beforeRequest: async () => {
			trace.push({ before: true });
			const answer = before[beforeIndex] ?? true;
			beforeIndex += 1;
			return answer;
		},
		signal: controller.signal,
	};
	const outputs: unknown[] = [];
	for (const op of ops) {
		let result: unknown;
		if (op.name === "get") result = await getCalendar(deps, op.calendarId);
		else if (op.name === "create") {
			result = await createCalendar(deps, {
				summary: "Earnings calendar",
				description: 'd "q" é',
				timeZone: "UTC",
			});
		} else if (op.name === "list") result = await listManagedEvents(deps, op.calendarId);
		else if (op.name === "insert") result = await insertEvent(deps, op.calendarId, op.body);
		else if (op.name === "update") result = await updateEvent(deps, op.calendarId, op.body);
		else result = await deleteEvent(deps, op.calendarId, op.eventId);
		outputs.push(plain(result));
	}
	return {
		ops,
		before,
		refreshes,
		abortAfterRequest,
		abortBeforeStart,
		script,
		requests,
		output: { outputs, trace },
	};
}

async function calendarCases(rng: Rng): Promise<CalendarCase[]> {
	const cases: CalendarCase[] = [];
	for (let index = 0; index < 900; index += 1) {
		const count = rng.int(1, 4);
		const ops: CalendarOp[] = Array.from({ length: count }, () => {
			const name = rng.pick(["get", "create", "list", "insert", "update", "delete"] as const);
			const calendarId = rng.pick(CALENDAR_IDS);
			if (name === "create") return { name };
			if (name === "get" || name === "list") return { name, calendarId };
			if (name === "delete")
				return { name, calendarId, eventId: rng.pick(["a".repeat(32), "c/d e", "é", "x?y"]) };
			return { name, calendarId, body: eventBody(rng) };
		});
		const script: HttpAnswer[] = [];
		for (let item = 0; item < 40; item += 1) {
			const op = ops[Math.min(Math.floor(item / 3), ops.length - 1)];
			script.push(
				rng.chance(0.05)
					? {
							error: {
								code: rng.pick([
									"TIMEOUT",
									"NETWORK_ERROR",
									"RESPONSE_TOO_LARGE",
									"DNS_FAILED",
								] as const),
								detail: "d",
							},
						}
					: calendarBody(rng, op?.name ?? "get"),
			);
		}
		const refreshes: RefreshAnswer[] = Array.from({ length: 4 }, () =>
			rng.chance(0.8)
				? { token: `tok-${rng.int(1, 9)}` }
				: {
						code: rng.pick([
							"GOOGLE_AUTH_EXPIRED",
							"GOOGLE_RATE_LIMITED",
							"GOOGLE_REQUEST_FAILED",
							"ABORTED",
						]),
					},
		);
		const before = Array.from({ length: rng.int(0, 4) }, () => rng.chance(0.9));
		cases.push(
			await runCalendar(
				ops,
				before,
				refreshes,
				rng.chance(0.12) ? rng.int(1, 4) : null,
				rng.chance(0.03),
				script,
			),
		);
	}
	// More pages than the bound.
	const endless: HttpAnswer[] = Array.from({ length: 12 }, () => ({
		status: 200,
		text: JSON.stringify({ items: [], nextPageToken: "more" }),
	}));
	cases.push(
		await runCalendar([{ name: "list", calendarId: "cal_1" }], [], [], null, false, endless),
	);
	const ten: HttpAnswer[] = [
		...Array.from({ length: 9 }, () => ({
			status: 200,
			text: JSON.stringify({ items: [], nextPageToken: "more" }),
		})),
		{ status: 200, text: JSON.stringify({ items: [{ id: "last" }] }) },
	];
	cases.push(await runCalendar([{ name: "list", calendarId: "cal_1" }], [], [], null, false, ten));
	return cases;
}

/* ---------- token store ---------- */

async function tokenStoreCases(rng: Rng): Promise<unknown> {
	const dir = await mkdtemp(join(tmpdir(), "vectors-google-token-"));
	try {
		const reads: unknown[] = [];
		const record = {
			version: 1 as const,
			refreshToken: "rt",
			calendarId: "cal_1",
			scope: "https://www.googleapis.com/auth/calendar.app.created",
			savedAt: "2026-10-17T03:00:00.000Z",
		};
		const texts: string[] = [
			JSON.stringify(record),
			`${JSON.stringify(record)}\n`,
			`  ${JSON.stringify(record)}  `,
			JSON.stringify({ ...record, extra: 1 }),
			JSON.stringify({ ...record, version: 2 }),
			JSON.stringify({ ...record, version: 1.0 }),
			'{"version":1.0,"refreshToken":"rt","calendarId":"c","scope":"s","savedAt":"t"}',
			'{"version":1e0,"refreshToken":"rt","calendarId":"c","scope":"s","savedAt":"t"}',
			'{"version":"1","refreshToken":"rt","calendarId":"c","scope":"s","savedAt":"t"}',
			JSON.stringify({ ...record, refreshToken: "" }),
			JSON.stringify({ ...record, refreshToken: "x".repeat(2000) }),
			JSON.stringify({ ...record, refreshToken: "x".repeat(2001) }),
			JSON.stringify({ ...record, refreshToken: "😀".repeat(1000) }),
			JSON.stringify({ ...record, refreshToken: "😀".repeat(1001) }),
			JSON.stringify({ ...record, calendarId: "c".repeat(256) }),
			JSON.stringify({ ...record, calendarId: "c".repeat(257) }),
			JSON.stringify({ ...record, scope: "s".repeat(200) }),
			JSON.stringify({ ...record, scope: "s".repeat(201) }),
			JSON.stringify({ ...record, savedAt: "t".repeat(64) }),
			JSON.stringify({ ...record, savedAt: "t".repeat(65) }),
			JSON.stringify({ ...record, savedAt: null }),
			'{"version":1,"refreshToken":"a","refreshToken":"b","calendarId":"c","scope":"s","savedAt":"t"}',
			"",
			"{}",
			"[]",
			"null",
			"{oops",
			`﻿${JSON.stringify(record)}`,
			'{"version":1,"refreshToken":"rt","calendarId":"c","scope":"s"}',
		];
		for (const text of texts) {
			const path = join(dir, "read.json");
			await writeFile(path, text);
			reads.push({ text, output: plain(await readGoogleTokenFile(path)) });
		}
		const missing = plain(await readGoogleTokenFile(join(dir, "missing.json")));
		// Invalid UTF-8 reads as replacement characters, not as a failure.
		await writeFile(join(dir, "bytes.json"), Buffer.from([0x7b, 0xff, 0x7d]));
		const lossy = plain(await readGoogleTokenFile(join(dir, "bytes.json")));
		const writes: unknown[] = [];
		const records = [
			record,
			{ ...record, refreshToken: "x".repeat(2000) },
			{ ...record, refreshToken: "😀".repeat(1000) },
			{ ...record, refreshToken: "" },
			{ ...record, refreshToken: "x".repeat(2001) },
			{ ...record, calendarId: "" },
			{ ...record, scope: "s".repeat(201) },
			{ ...record, savedAt: "" },
			{ ...record, refreshToken: 'quote"back\\slash\n ' },
			{ ...record, calendarId: "日本\u0000" },
		];
		for (const value of records) {
			const path = join(dir, "write.json");
			let outcome: unknown;
			try {
				await writeGoogleTokenFile(path, value);
				outcome = {
					text: await readFile(path, "utf8"),
					mode: ((await stat(path)).mode & 0o777).toString(8),
				};
			} catch {
				outcome = { failed: true };
			}
			await deleteGoogleTokenFile(path);
			writes.push({ record: value, outcome });
		}
		void rng;
		return { reads, missing, lossy, writes };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/* ---------- runner flows ---------- */

const CLIENT_ID = "test-client-id-abc";
const CLIENT_SECRET = "test-client-secret-xyz";
const SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

interface Route {
	/** `"<METHOD> <pathname>"`. */
	readonly key: string;
	readonly answers: readonly HttpAnswer[];
}

type Browser =
	| { readonly kind: "none" }
	| { readonly kind: "callbacks"; readonly requests: readonly BrowserRequest[] };

type BrowserRequest =
	| { readonly kind: "code"; readonly code: string }
	| { readonly kind: "badState" }
	| { readonly kind: "noState" }
	| { readonly kind: "error"; readonly error: string }
	| { readonly kind: "emptyCode" }
	| { readonly kind: "longCode" }
	| { readonly kind: "wrongHost" }
	| { readonly kind: "post" };

interface FlowCase {
	readonly action: "connect" | "sync" | "disconnect" | "discard";
	readonly clientConfigured: boolean;
	readonly job: unknown;
	readonly tokenFile: string | null;
	/** A directory sits in the token file's place, so writing it fails. */
	readonly tokenFileBlocked?: boolean;
	readonly routes: readonly Route[];
	readonly browser: Browser;
	/** How many `sendAuthUrl` attempts fail before one is delivered; null never. */
	readonly deliverAfterFailures: number | null;
	/** Whether the 5-minute timeout sleep resolves at once. */
	readonly timeoutFires: boolean;
	/** Where the run is stopped; null never. */
	readonly abortAt: string | null;
	readonly output: unknown;
}

interface FlowLog {
	readonly level: string;
	readonly event: string;
	readonly fields: unknown;
}

function maskBody(body: string | null, urlParams: URLSearchParams | null): unknown {
	if (body === null) return null;
	// Form bodies carry the random PKCE verifier and the random loopback port;
	// check them against the link, then mask.
	if (!body.includes("=") || body.startsWith("{")) return body;
	const params = new URLSearchParams(body);
	if (params.has("code_verifier") && urlParams !== null) {
		const verifier = params.get("code_verifier") ?? "";
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		if (challenge !== urlParams.get("code_challenge"))
			throw new Error("verifier does not match the challenge");
		params.set("code_verifier", "<verifier>");
	}
	if (params.has("redirect_uri") && urlParams !== null) {
		if (params.get("redirect_uri") !== urlParams.get("redirect_uri"))
			throw new Error("redirect mismatch");
		params.set("redirect_uri", "<redirect>");
	}
	return params.toString();
}

function maskUrl(url: string): string {
	const parsed = new URL(url);
	for (const key of ["state", "code_challenge", "redirect_uri"]) {
		if (parsed.searchParams.has(key)) parsed.searchParams.set(key, `<${key}>`);
	}
	return parsed.toString();
}

async function waitFor(check: () => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 500 && !check(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return check();
}

function tokenRecordText(refreshToken: string, calendarId: string): string {
	return `${JSON.stringify({ version: 1, refreshToken, calendarId, scope: SCOPE, savedAt: "2026-10-01T00:00:00.000Z" })}\n`;
}

async function runFlow(spec: Omit<FlowCase, "output">): Promise<FlowCase> {
	const dir = await mkdtemp(join(tmpdir(), "vectors-google-flow-"));
	try {
		const tokenFile = join(dir, "sub", "google-token.json");
		if (spec.tokenFile !== null) {
			await writeGoogleTokenFile(tokenFile, {
				version: 1,
				refreshToken: "x",
				calendarId: "x",
				scope: "x",
				savedAt: "x",
			});
			await writeFile(tokenFile, spec.tokenFile);
		}
		if (spec.tokenFileBlocked === true) await mkdir(tokenFile, { recursive: true });
		let nowMs = Date.UTC(2026, 9, 17, 3, 0, 0);
		const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
		const requests: (RecordedRequest & { masked?: unknown })[] = [];
		const logs: FlowLog[] = [];
		const states: string[] = [];
		const sentUrls: string[] = [];
		const googleSleeps: number[] = [];
		const paceSleeps: number[] = [];
		const paceCalls: unknown[] = [];
		const controller = new AbortController();
		const routeIndex = new Map<string, number>();
		const seenCalls = { n: 0 };
		let urlParams: URLSearchParams | null = null;
		const abortWhen = (where: string): void => {
			if (spec.abortAt === where) controller.abort();
		};
		const http = async (request: GoogleHttpRequest): Promise<GoogleHttpResult> => {
			const url = new URL(request.path, "https://google.test");
			const key = `${request.method} ${url.pathname}`;
			requests.push({
				...recordRequest(request),
				path: request.path,
				body: null,
				masked: maskBody(request.body, urlParams),
			});
			seenCalls.n += 1;
			const route = spec.routes.find((candidate) => candidate.key === key);
			let answer: HttpAnswer | undefined;
			if (route !== undefined) {
				const position = routeIndex.get(key) ?? 0;
				routeIndex.set(key, position + 1);
				answer = route.answers[Math.min(position, route.answers.length - 1)];
			}
			const result = answerOf(answer);
			abortWhen(key);
			return result;
		};
		const env: GoogleExecutionEnv = {
			google: {
				config: {
					clientId: spec.clientConfigured ? CLIENT_ID : null,
					clientSecret: spec.clientConfigured ? CLIENT_SECRET : null,
					tokenFile,
				},
				http,
				sleep: (ms, signal) => {
					googleSleeps.push(ms);
					if (ms === 300_000) {
						if (spec.timeoutFires) return Promise.resolve();
						return new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
							if (signal.aborted) resolve();
						});
					}
					return Promise.resolve();
				},
			},
			clock,
			logger: logger(logs),
			marketPacer: (() => {
				const inner = createMarketPacer({
					clock,
					sleep: async (ms) => {
						paceSleeps.push(ms);
						nowMs += ms;
					},
					limits: new Map([["google", { maxPerWindow: 5, windowMs: 1_000 }]]),
				});
				return {
					async pace(provider, signal, requests) {
						const granted = await inner.pace(
							provider,
							signal,
							...(requests === undefined ? [] : [requests]),
						);
						paceCalls.push({ provider, granted });
						return granted;
					},
				};
			})(),
		};
		const reporter: PipelineReporter = {
			state: async (state) => {
				states.push(state);
				abortWhen(`state:${state}`);
			},
			note: async () => {},
			tool: async () => {},
			usage: async () => {},
		};
		let attempts = 0;
		const sendAuthUrl = async (url: string): Promise<boolean> => {
			attempts += 1;
			sentUrls.push(url);
			if (spec.deliverAfterFailures === null || attempts <= spec.deliverAfterFailures) return false;
			abortWhen("authUrl");
			return true;
		};
		if (spec.abortAt === "before") controller.abort();
		const job = spec.job as Extract<ClaimedJob, { kind: "google-calendar" }>;
		const browserLog: unknown[] = [];
		let pending: Promise<unknown>;
		if (spec.action === "discard") {
			pending = discardStoredGoogleGrant(env, "run_google").then(() => null);
		} else {
			pending = executeGoogleCalendar(job, env, controller.signal, reporter, sendAuthUrl);
		}
		if (spec.action === "connect" && spec.browser.kind === "callbacks") {
			const delivered = await waitFor(
				() =>
					(sentUrls.length > 0 &&
						(spec.deliverAfterFailures === null ? false : attempts > spec.deliverAfterFailures)) ||
					controller.signal.aborted,
			);
			const sent = sentUrls.at(-1);
			if (delivered && sent !== undefined && !controller.signal.aborted) {
				urlParams = new URL(sent).searchParams;
				const state = urlParams.get("state") ?? "";
				const port = new URL(urlParams.get("redirect_uri") ?? "http://127.0.0.1:1/").port;
				for (const request of spec.browser.requests) {
					let query: string;
					let method = "GET";
					let host = `127.0.0.1:${port}`;
					if (request.kind === "code")
						query = `code=${encodeURIComponent(request.code)}&state=${state}`;
					else if (request.kind === "badState") query = `code=c&state=${state}x`;
					else if (request.kind === "noState") query = "code=c";
					else if (request.kind === "error")
						query = `error=${encodeURIComponent(request.error)}&state=${state}`;
					else if (request.kind === "emptyCode") query = `code=&state=${state}`;
					else if (request.kind === "longCode") query = `code=${"x".repeat(501)}&state=${state}`;
					else if (request.kind === "post") {
						query = `code=c&state=${state}`;
						method = "POST";
					} else {
						query = `code=c&state=${state}`;
						host = "localhost";
					}
					const status = await new Promise<number | string>((resolve) => {
						const outgoing = httpRequest(
							{
								host: "127.0.0.1",
								port: Number(port),
								method,
								path: `/?${query}`,
								headers: { host },
								agent: false,
							},
							(response) => {
								response.resume();
								response.once("end", () => resolve(response.statusCode ?? 0));
							},
						);
						outgoing.once("error", () => resolve("closed"));
						outgoing.end();
					});
					browserLog.push({ kind: request.kind, status });
				}
			}
		}
		// A fault that escapes (a failed token write) is part of the contract.
		const completion = await pending.catch(() => ({ threw: true }));
		let tokenText: string | null = null;
		let tokenMode: string | null = null;
		try {
			tokenText = await readFile(tokenFile, "utf8");
			tokenMode = ((await stat(tokenFile)).mode & 0o777).toString(8);
		} catch {
			tokenText = null;
		}
		const first = sentUrls[0];
		return {
			...spec,
			output: {
				completion: plain(completion),
				states,
				logs,
				requests: requests.map((request) => ({
					host: request.host,
					method: request.method,
					path: request.path,
					headers: request.headers,
					body: request.masked,
				})),
				sentUrls: sentUrls.map(maskUrl),
				signIn: first === undefined ? null : isGoogleSignInUrl(first),
				attempts,
				browser: browserLog,
				googleSleeps,
				paceSleeps,
				paceCalls,
				tokenFile: tokenText === null ? null : { text: tokenText, mode: tokenMode },
			},
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function logger(sink: FlowLog[]): EventLogger {
	const write =
		(level: string) => (event: string, fields?: { readonly [key: string]: unknown }) => {
			sink.push({ level, event, fields: plain(fields ?? {}) });
		};
	return { info: write("info"), warn: write("warn"), error: write("error"), logFailures: () => 0 };
}

const BODY = (n: string, summary: string) => ({
	id: n.repeat(32),
	summary,
	description: `desc ${n}`,
	startDate: "2026-10-29",
	endDate: "2026-10-30",
	privateProperties: { researchWorkspace: "earnings", stockId: "us:AAPL", periodKey: "2026-q4" },
	sourceTitle: "Finnhub",
	sourceUrl: "https://finnhub.io/",
});

function jobOf(
	action: "connect" | "sync" | "disconnect",
	extra: { [key: string]: unknown } = {},
): unknown {
	return {
		kind: "google-calendar",
		runId: "run_google",
		leaseGeneration: 2,
		leaseExpiresAt: "2026-10-11T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		action,
		...extra,
	};
}

const GRANTED = JSON.stringify({
	access_token: "at-1",
	refresh_token: "rt-1",
	scope: SCOPE,
	expires_in: 3600,
});
const OK_CAL = (id: string): HttpAnswer => ({ status: 200, text: JSON.stringify({ id }) });
const OK_EMPTY: HttpAnswer = { status: 200, text: "{}" };

function routes(entries: { [key: string]: HttpAnswer[] }): Route[] {
	return Object.entries(entries).map(([key, answers]) => ({ key, answers }));
}

async function flowCases(): Promise<FlowCase[]> {
	const rng = new Rng(0x60091e);
	const cases: FlowCase[] = [];
	const base = {
		clientConfigured: true,
		tokenFile: null as string | null,
		browser: { kind: "none" } as Browser,
		deliverAfterFailures: 0 as number | null,
		timeoutFires: false,
		abortAt: null as string | null,
	};
	const connect = (
		over: Partial<Omit<FlowCase, "output" | "action" | "job">>,
		extra: Route[] = [],
	): Promise<FlowCase> =>
		runFlow({ ...base, action: "connect", job: jobOf("connect"), routes: extra, ...over });
	const code = (c = "auth-code-1"): Browser => ({
		kind: "callbacks",
		requests: [{ kind: "code", code: c }],
	});
	// Connect.
	cases.push(
		await connect(
			{ browser: code() },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_1")],
			}),
		),
	);
	// F1: a token file that cannot be written gives the new grant back, then the fault escapes.
	cases.push(
		await connect(
			{ browser: code(), tokenFileBlocked: true },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_1")],
				"POST /revoke": [OK_EMPTY],
			}),
		),
	);
	cases.push(await connect({ clientConfigured: false }));
	cases.push(await connect({ timeoutFires: true }));
	cases.push(
		await connect({
			browser: { kind: "callbacks", requests: [{ kind: "error", error: "access_denied" }] },
		}),
	);
	cases.push(
		await connect({
			browser: { kind: "callbacks", requests: [{ kind: "error", error: "server_error" }] },
		}),
	);
	cases.push(await connect({ deliverAfterFailures: null }));
	cases.push(
		await connect(
			{ deliverAfterFailures: 2, browser: code() },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_2")],
			}),
		),
	);
	cases.push(
		await connect(
			{ deliverAfterFailures: 3, browser: code() },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_2")],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code() },
			routes({ "POST /token": [{ status: 400, text: '{"error":"invalid_grant"}' }] }),
		),
	);
	cases.push(
		await connect({ browser: code() }, routes({ "POST /token": [{ status: 429, text: "{}" }] })),
	);
	cases.push(
		await connect(
			{ browser: code() },
			routes({
				"POST /token": [
					{
						status: 200,
						text: JSON.stringify({ access_token: "a", refresh_token: "rt-1", scope: "openid" }),
					},
				],
				"POST /revoke": [OK_EMPTY],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code() },
			routes({
				"POST /token": [{ status: 200, text: JSON.stringify({ access_token: "a", scope: SCOPE }) }],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code() },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [
					{ status: 403, text: '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}' },
				],
				"POST /revoke": [OK_EMPTY],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code() },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [{ status: 500, text: "{}" }],
				"POST /revoke": [{ status: 500, text: "{}" }],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code(), tokenFile: tokenRecordText("old-rt", "cal_old") },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"GET /calendar/v3/calendars/cal_old": [OK_CAL("cal_old")],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code(), tokenFile: tokenRecordText("old-rt", "cal_old") },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"GET /calendar/v3/calendars/cal_old": [{ status: 404, text: "{}" }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_new")],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code(), tokenFile: tokenRecordText("old-rt", "cal_old") },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"GET /calendar/v3/calendars/cal_old": [{ status: 500, text: "{}" }],
				"POST /revoke": [OK_EMPTY],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code(), tokenFile: "{corrupt" },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_3")],
			}),
		),
	);
	cases.push(
		await connect(
			{
				browser: {
					kind: "callbacks",
					requests: [
						{ kind: "badState" },
						{ kind: "noState" },
						{ kind: "emptyCode" },
						{ kind: "longCode" },
						{ kind: "wrongHost" },
						{ kind: "post" },
						{ kind: "code", code: "ok-code" },
					],
				},
			},
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_4")],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: { kind: "callbacks", requests: [{ kind: "code", code: "special &=+/ code" }] } },
			routes({
				"POST /token": [{ status: 200, text: GRANTED }],
				"POST /calendar/v3/calendars": [OK_CAL("cal 5/é")],
			}),
		),
	);
	// A 401 on the first calendar call refreshes once.
	cases.push(
		await connect(
			{ browser: code() },
			routes({
				"POST /token": [
					{ status: 200, text: GRANTED },
					{ status: 200, text: JSON.stringify({ access_token: "at-2" }) },
				],
				"POST /calendar/v3/calendars": [{ status: 401, text: "{}" }, OK_CAL("cal_6")],
			}),
		),
	);
	cases.push(
		await connect(
			{ browser: code() },
			routes({
				"POST /token": [
					{ status: 200, text: GRANTED },
					{ status: 400, text: '{"error":"invalid_grant"}' },
				],
				"POST /calendar/v3/calendars": [{ status: 401, text: "{}" }],
				"POST /revoke": [OK_EMPTY],
			}),
		),
	);
	// Aborts at every stop.
	for (const abortAt of [
		"before",
		"authUrl",
		"state:collecting",
		"state:analyzing",
		"state:verifying",
		"POST /token",
		"POST /calendar/v3/calendars",
		"state:publishing",
	]) {
		cases.push(
			await connect(
				{ abortAt, browser: code() },
				routes({
					"POST /token": [{ status: 200, text: GRANTED }],
					"POST /calendar/v3/calendars": [OK_CAL("cal_7")],
					"POST /revoke": [OK_EMPTY],
				}),
			),
		);
	}
	// Sync.
	const syncJob = (events: unknown[], extra: { [key: string]: unknown } = {}) =>
		jobOf("sync", { calendarId: "cal_stored", desiredDigest: "ab".repeat(32), events, ...extra });
	const stored = tokenRecordText("rt-stored", "cal_stored");
	const syncRoutes = (over: { [key: string]: HttpAnswer[] }) =>
		routes({
			"POST /token": [{ status: 200, text: JSON.stringify({ access_token: "at-s" }) }],
			...over,
		});
	const sync = (
		job: unknown,
		over: Partial<Omit<FlowCase, "output" | "action" | "job">>,
		extra: Route[],
	) => runFlow({ ...base, action: "sync", job, routes: extra, ...over });
	const existingList = (items: unknown[]): HttpAnswer => ({
		status: 200,
		text: JSON.stringify({ items }),
	});
	cases.push(
		await sync(
			syncJob([BODY("a", "New title"), BODY("b", "B")]),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [
					existingList([
						{
							id: "a".repeat(32),
							status: "confirmed",
							summary: "Old title",
							description: "desc a",
							start: { date: "2026-10-29" },
							end: { date: "2026-10-30" },
						},
						{
							id: "c".repeat(32),
							status: "confirmed",
							summary: "C",
							description: "desc c",
							start: { date: "2026-10-29" },
							end: { date: "2026-10-30" },
						},
						{
							id: "d".repeat(32),
							status: "cancelled",
							summary: "D",
							description: "",
							start: { date: "2026-10-29" },
							end: { date: "2026-10-30" },
						},
					]),
				],
				[`DELETE /calendar/v3/calendars/cal_stored/events/${"c".repeat(32)}`]: [
					{ status: 204, text: "" },
				],
				[`PUT /calendar/v3/calendars/cal_stored/events/${"a".repeat(32)}`]: [OK_EMPTY],
				"POST /calendar/v3/calendars/cal_stored/events": [OK_EMPTY],
			}),
		),
	);
	cases.push(
		await sync(
			syncJob([BODY("a", "A")]),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [existingList([])],
				"POST /calendar/v3/calendars/cal_stored/events": [{ status: 409, text: "{}" }],
				[`PUT /calendar/v3/calendars/cal_stored/events/${"a".repeat(32)}`]: [OK_EMPTY],
			}),
		),
	);
	cases.push(
		await sync(
			syncJob([BODY("a", "A")]),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [{ status: 404, text: "{}" }],
				"POST /calendar/v3/calendars": [OK_CAL("cal_made")],
				"POST /calendar/v3/calendars/cal_made/events": [OK_EMPTY],
			}),
		),
	);
	// F7: the claim's calendar id wins over the token file's.
	cases.push(
		await sync(
			syncJob([BODY("a", "A")], { calendarId: "cal_claim" }),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_claim": [OK_CAL("cal_claim")],
				"GET /calendar/v3/calendars/cal_claim/events": [existingList([])],
				"POST /calendar/v3/calendars/cal_claim/events": [OK_EMPTY],
			}),
		),
	);
	cases.push(await sync(syncJob([]), { tokenFile: null }, syncRoutes({})));
	cases.push(await sync(syncJob([]), { tokenFile: "{bad" }, syncRoutes({})));
	cases.push(
		await sync(syncJob([]), { clientConfigured: false, tokenFile: stored }, syncRoutes({})),
	);
	cases.push(
		await sync(jobOf("sync", { calendarId: "cal_1" }), { tokenFile: stored }, syncRoutes({})),
	);
	cases.push(
		await sync(
			jobOf("sync", { desiredDigest: "ab".repeat(32), events: [] }),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [existingList([])],
			}),
		),
	);
	cases.push(
		await sync(
			syncJob([], { calendarId: null }),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [existingList([])],
			}),
		),
	);
	cases.push(
		await sync(
			syncJob([BODY("a", "A"), BODY("a", "dup")]),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [existingList([])],
			}),
		),
	);
	cases.push(
		await sync(
			syncJob([]),
			{ tokenFile: stored },
			routes({ "POST /token": [{ status: 400, text: '{"error":"invalid_grant"}' }] }),
		),
	);
	cases.push(
		await sync(
			syncJob([]),
			{ tokenFile: stored },
			routes({ "POST /token": [{ status: 429, text: "{}" }] }),
		),
	);
	cases.push(
		await sync(
			syncJob([BODY("a", "A")]),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [{ status: 500, text: "{}" }],
			}),
		),
	);
	cases.push(
		await sync(
			syncJob([BODY("a", "A")]),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [existingList([])],
				"POST /calendar/v3/calendars/cal_stored/events": [{ status: 429, text: "{}" }],
			}),
		),
	);
	cases.push(
		await sync(
			syncJob([BODY("a", "A")]),
			{ tokenFile: stored },
			syncRoutes({
				"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
				"GET /calendar/v3/calendars/cal_stored/events": [existingList([])],
				"POST /calendar/v3/calendars/cal_stored/events": [{ status: 401, text: "{}" }, OK_EMPTY],
				"POST /token": [
					{ status: 200, text: JSON.stringify({ access_token: "at-1" }) },
					{ status: 200, text: JSON.stringify({ access_token: "at-2" }) },
				],
			}),
		),
	);
	for (const abortAt of [
		"before",
		"state:collecting",
		"state:analyzing",
		"POST /token",
		"GET /calendar/v3/calendars/cal_stored",
		"GET /calendar/v3/calendars/cal_stored/events",
		"state:verifying",
		"POST /calendar/v3/calendars/cal_stored/events",
	]) {
		cases.push(
			await sync(
				syncJob([BODY("a", "A"), BODY("b", "B")]),
				{ tokenFile: stored, abortAt },
				syncRoutes({
					"GET /calendar/v3/calendars/cal_stored": [OK_CAL("cal_stored")],
					"GET /calendar/v3/calendars/cal_stored/events": [existingList([])],
					"POST /calendar/v3/calendars/cal_stored/events": [OK_EMPTY],
				}),
			),
		);
	}
	// Disconnect and discard.
	const disconnect = (over: Partial<Omit<FlowCase, "output" | "action" | "job">>, extra: Route[]) =>
		runFlow({ ...base, action: "disconnect", job: jobOf("disconnect"), routes: extra, ...over });
	cases.push(await disconnect({ tokenFile: stored }, routes({ "POST /revoke": [OK_EMPTY] })));
	cases.push(
		await disconnect(
			{ tokenFile: stored },
			routes({ "POST /revoke": [{ status: 400, text: "{}" }] }),
		),
	);
	cases.push(
		await disconnect(
			{ tokenFile: stored },
			routes({ "POST /revoke": [{ error: { code: "NETWORK_ERROR", detail: "x" } }] }),
		),
	);
	cases.push(await disconnect({ tokenFile: null }, routes({})));
	cases.push(await disconnect({ tokenFile: "{corrupt" }, routes({})));
	cases.push(
		await disconnect(
			{ tokenFile: stored, abortAt: "before" },
			routes({ "POST /revoke": [OK_EMPTY] }),
		),
	);
	cases.push(
		await disconnect(
			{ tokenFile: stored, abortAt: "state:collecting" },
			routes({ "POST /revoke": [OK_EMPTY] }),
		),
	);
	cases.push(
		await disconnect(
			{ tokenFile: stored, abortAt: "POST /revoke" },
			routes({ "POST /revoke": [OK_EMPTY] }),
		),
	);
	cases.push(await disconnect({ tokenFile: null, abortAt: "before" }, routes({})));
	const discard = (over: Partial<Omit<FlowCase, "output" | "action" | "job">>, extra: Route[]) =>
		runFlow({ ...base, action: "discard", job: jobOf("disconnect"), routes: extra, ...over });
	cases.push(await discard({ tokenFile: stored }, routes({ "POST /revoke": [OK_EMPTY] })));
	cases.push(
		await discard({ tokenFile: stored }, routes({ "POST /revoke": [{ status: 500, text: "{}" }] })),
	);
	cases.push(await discard({ tokenFile: null }, routes({})));
	cases.push(await discard({ tokenFile: "{corrupt" }, routes({})));
	void rng;
	return cases;
}

export const googleExporter: VectorExporter = {
	name: "google",
	async build(): Promise<readonly VectorFile[]> {
		const rng = new Rng(0x6006);
		return [
			{ path: "google/pure.json", content: pureCases(rng) },
			{ path: "google/oauth.json", content: await oauthCases(rng) },
			{ path: "google/calendar.json", content: await calendarCases(rng) },
			{ path: "google/token_store.json", content: await tokenStoreCases(rng) },
			{ path: "google/flows.json", content: await flowCases() },
		];
	},
};
