import { env } from "cloudflare:test";
import {
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	issuedRunnerCredentialSchema,
	runnerCredentialCheckResponseSchema,
	runnerCredentialListResponseSchema,
	sessionResponseSchema,
	sourceListResponseSchema,
	versionResponseSchema,
	workspaceListResponseSchema,
} from "@research/contracts";
import { err } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.ts";
import { type AuthFailure, createAccessAuthenticator } from "../src/auth.ts";
import { type AppEnv, ownerAuthFailure } from "../src/http.ts";
import {
	body,
	CLAIM_BODY,
	createHarness,
	createWorkspace,
	errorCode,
	issueRunnerToken,
	queueRun,
} from "./helpers.ts";

const TEAM = "team.cloudflareaccess.test";
const AUDIENCE = "aud-tag-123";
const OWNER = "owner@example.test";

async function accessFixture() {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const stranger = await generateKeyPair("RS256");
	const jwk = await exportJWK(publicKey);
	const keys: JWTVerifyGetKey = async () => publicKey;
	const sign = (
		claims: Record<string, unknown>,
		options: {
			issuer?: string;
			audience?: string;
			expiresIn?: string;
			key?: CryptoKey;
		} = {},
	) =>
		new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setIssuer(options.issuer ?? `https://${TEAM}`)
			.setAudience(options.audience ?? AUDIENCE)
			.setIssuedAt()
			.setExpirationTime(options.expiresIn ?? "5m")
			.sign(options.key ?? privateKey);
	const authenticate = createAccessAuthenticator({
		teamDomain: TEAM,
		audience: AUDIENCE,
		ownerEmail: OWNER,
		keys,
	});
	const request = (token: string | null) =>
		new Request("https://research.example.test/api/v1/session", {
			headers: token === null ? {} : { "Cf-Access-Jwt-Assertion": token },
		});
	return { sign, authenticate, request, jwk, strangerKey: stranger.privateKey };
}

describe("owner authentication (section 9.1)", () => {
	it("accepts a valid Access token for the configured owner, case-insensitively", async () => {
		const access = await accessFixture();
		const result = await access.authenticate(
			access.request(await access.sign({ email: "Owner@Example.test" })),
		);
		expect(result).toEqual({
			ok: true,
			value: { ownerId: OWNER, authMode: "cloudflare-access" },
		});
	});

	it("rejects missing, expired, wrongly-addressed and forged tokens as unauthenticated", async () => {
		const access = await accessFixture();
		const cases: (string | null)[] = [
			null,
			"not-a-jwt",
			await access.sign({ email: OWNER }, { expiresIn: "-1m" }),
			await access.sign({ email: OWNER }, { audience: "another-application" }),
			await access.sign({ email: OWNER }, { issuer: "https://attacker.example" }),
			await access.sign({ email: OWNER }, { key: access.strangerKey }),
		];
		for (const token of cases) {
			const result = await access.authenticate(access.request(token));
			expect(result).toEqual({ ok: false, error: "UNAUTHENTICATED" });
		}
	});

	it("rejects an unsigned (alg=none) token", async () => {
		const access = await accessFixture();
		const encode = (value: object) =>
			btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
		const token = `${encode({ alg: "none" })}.${encode({
			email: OWNER,
			iss: `https://${TEAM}`,
			aud: AUDIENCE,
			exp: 4_102_444_800,
		})}.`;
		expect(await access.authenticate(access.request(token))).toEqual({
			ok: false,
			error: "UNAUTHENTICATED",
		});
	});

	it("forbids a valid identity that is not the owner, including service tokens without an email", async () => {
		const access = await accessFixture();
		for (const claims of [{ email: "someone-else@example.test" }, { common_name: "service" }]) {
			const result = await access.authenticate(access.request(await access.sign(claims)));
			expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
		}
	});

	it("denies everything when auth is unconfigured, unknown or incomplete (fail closed)", async () => {
		const app = createApp();
		const configurations = [
			{},
			{ AUTH_MODE: "something-new" },
			{ AUTH_MODE: "cloudflare-access" },
			{ AUTH_MODE: "cloudflare-access", OWNER_EMAIL: OWNER, ACCESS_TEAM_DOMAIN: TEAM },
		];
		for (const configuration of configurations) {
			const response = await app.request(
				"http://localhost/api/v1/session",
				{},
				{ DB: env.DB, ...configuration },
			);
			expect(response.status).toBe(401);
			expect(await errorCode(response)).toBe("UNAUTHENTICATED");
		}
	});

	it("honours local-dev mode for loopback requests only", async () => {
		const app = createApp();
		const bindings = { DB: env.DB, AUTH_MODE: "local-dev", OWNER_EMAIL: OWNER };
		const local = await app.request("http://localhost/api/v1/session", {}, bindings);
		expect(await body(local, sessionResponseSchema)).toEqual({
			ownerId: OWNER,
			authMode: "local-dev",
			// No APP_ENV binding: fail towards the quiet, safe presentation (ADR-0011).
			environment: "production",
		});
		// A deployed Worker is never addressed as localhost, so a misconfiguration cannot open it.
		for (const url of [
			"https://research.example.com/api/v1/session",
			"https://localhost.evil.example/api/v1/session",
		]) {
			expect((await app.request(url, {}, bindings)).status).toBe(401);
		}
	});

	it("reports the configured environment, defaulting to production when unknown", async () => {
		const app = createApp();
		const base = { DB: env.DB, AUTH_MODE: "local-dev", OWNER_EMAIL: OWNER };
		for (const [appEnv, expected] of [
			["development", "development"],
			["production", "production"],
			[undefined, "production"],
			["staging", "production"],
			["", "production"],
		] as const) {
			const response = await app.request(
				"http://localhost/api/v1/session",
				{},
				appEnv === undefined ? base : { ...base, APP_ENV: appEnv },
			);
			expect(await body(response, sessionResponseSchema)).toMatchObject({
				environment: expected,
			});
		}
	});

	it("reports the release generation the instance was built into, nothing sensitive", async () => {
		const app = createApp();
		const base = { DB: env.DB, AUTH_MODE: "local-dev", OWNER_EMAIL: OWNER };
		// Outside a release (development, tests): nulls, environment still reported.
		const bare = await app.request("http://localhost/api/v1/version", {}, base);
		expect(await body(bare, versionResponseSchema)).toEqual({
			generation: null,
			builtAt: null,
			environment: "production",
		});
		// From a release: the baked-in generation id and build time.
		const released = await app.request(
			"http://localhost/api/v1/version",
			{},
			{
				...base,
				APP_ENV: "production",
				RELEASE_GENERATION: "20261012T000000Z-abcdef",
				RELEASE_BUILT_AT: "2026-10-12T00:00:00.000Z",
			},
		);
		expect(await body(released, versionResponseSchema)).toEqual({
			generation: "20261012T000000Z-abcdef",
			builtAt: "2026-10-12T00:00:00.000Z",
			environment: "production",
		});
	});

	it("requires authentication on every owner route", async () => {
		const harness = createHarness();
		const routes: [string, string][] = [
			["GET", "/session"],
			["GET", "/version"],
			["GET", "/sources"],
			["POST", "/sources/preview"],
			["GET", "/sources/recommended"],
			["GET", "/articles"],
			["GET", "/agents"],
			["GET", "/research-runs"],
			["POST", "/research-runs"],
			["GET", "/research-runs/run_x"],
			["POST", "/research-runs/run_x/cancel"],
			["GET", "/workspaces"],
			["POST", "/workspaces"],
			["GET", "/workspaces/ws_x"],
			["POST", "/workspaces/ws_x/commands"],
			["GET", "/workspaces/ws_x/export"],
			["POST", "/workspaces/import"],
			["GET", "/runner-credentials"],
			["POST", "/runner-credentials"],
			["DELETE", "/runner-credentials/rc_x"],
			["POST", "/google-calendar/connect"],
			["POST", "/google-calendar/sync"],
			["POST", "/google-calendar/disconnect"],
			["GET", "/watchlist/directory"],
			["GET", "/watchlist/directory/search?q=apple"],
			["POST", "/watchlist/directory/refresh"],
		];
		for (const [method, path] of routes) {
			const response = await harness.raw(method, path, {
				headers: {
					"X-Test-Anonymous": "1",
					Origin: "http://localhost",
					[CSRF_HEADER]: CSRF_HEADER_VALUE,
				},
			});
			expect(response.status, `${method} ${path}`).toBe(401);
		}
	});
});

describe("Cloudflare Access signing keys unavailable (fail closed, distinct code)", () => {
	async function withKeyFetch(
		respond: (access: Awaited<ReturnType<typeof accessFixture>>) => Promise<Response>,
	) {
		const access = await accessFixture();
		const calls: string[] = [];
		const authenticate = createAccessAuthenticator({
			teamDomain: TEAM,
			audience: AUDIENCE,
			ownerEmail: OWNER,
			fetch: async (input) => {
				calls.push(String(input));
				return respond(access);
			},
		});
		const token = await access.sign({ email: OWNER });
		return { result: await authenticate(access.request(token)), calls };
	}

	it("verifies the owner with the key set the endpoint serves", async () => {
		const { result, calls } = await withKeyFetch(
			async (access) =>
				new Response(JSON.stringify({ keys: [{ ...access.jwk, kid: "test", alg: "RS256" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		expect(result).toEqual({ ok: true, value: { ownerId: OWNER, authMode: "cloudflare-access" } });
		expect(calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
	});

	it.each([
		[503, "<html>Service Unavailable</html>"],
		[404, "<html>Unable to find your Access organization!</html>"],
		[302, ""],
	])("answers a %i from the key endpoint as AUTH_KEYS_UNAVAILABLE with that status", async (status, text) => {
		const { result } = await withKeyFetch(async () => new Response(text, { status }));
		expect(result).toEqual({
			ok: false,
			error: {
				code: "AUTH_KEYS_UNAVAILABLE",
				detail: "KEY_FETCH_HTTP_ERROR",
				upstreamStatus: status,
			},
		});
	});

	it.each([
		["a network failure", () => Promise.reject(new TypeError("fetch failed")), "KEY_FETCH_FAILED"],
		[
			"a timeout",
			() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
			"KEY_FETCH_TIMEOUT",
		],
		[
			"a body that is not a key set",
			() => Promise.resolve(new Response("<html>login</html>", { status: 200 })),
			"KEY_SET_INVALID",
		],
		[
			"a key set without keys",
			() => Promise.resolve(new Response('{"public_cert":{}}', { status: 200 })),
			"KEY_SET_INVALID",
		],
	] as const)("answers %s without an upstream status", async (_label, respond, detail) => {
		const { result } = await withKeyFetch(respond);
		expect(result).toEqual({ ok: false, error: { code: "AUTH_KEYS_UNAVAILABLE", detail } });
	});

	it("stops reading a key set over 1 MiB, even one that never ends, and cancels it", async () => {
		let pulls = 0;
		let cancelled = false;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
			},
			cancel() {
				cancelled = true;
			},
		});
		const { result } = await withKeyFetch(async () => new Response(endless, { status: 200 }));
		expect(result).toEqual({
			ok: false,
			error: { code: "AUTH_KEYS_UNAVAILABLE", detail: "KEY_SET_INVALID" },
		});
		expect(cancelled).toBe(true);
		// 16 chunks reach the limit; the 17th passes it. A stream may pull a little ahead.
		expect(pulls).toBeLessThan(20);
	});

	it("gives up on a key set body that stalls past the fetch deadline, and cancels it", async () => {
		const access = await accessFixture();
		let cancelled = false;
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"keys":['));
			},
			cancel() {
				cancelled = true;
			},
		});
		const authenticate = createAccessAuthenticator({
			teamDomain: TEAM,
			audience: AUDIENCE,
			ownerEmail: OWNER,
			keyFetchTimeoutMs: 50,
			fetch: async () => new Response(stalled, { status: 200 }),
		});
		const result = await authenticate(access.request(await access.sign({ email: OWNER })));
		expect(result).toEqual({
			ok: false,
			error: { code: "AUTH_KEYS_UNAVAILABLE", detail: "KEY_FETCH_TIMEOUT" },
		});
		expect(cancelled).toBe(true);
	});

	it.each([
		["a stalled key set body", 200, '{"keys":[', "KEY_FETCH_TIMEOUT", undefined],
		["a non-200 answer", 503, "<html>down</html>", "KEY_FETCH_HTTP_ERROR", 503],
	] as const)("answers %s by the deadline even when cancelling the body never settles", async (_label, status, text, detail, upstreamStatus) => {
		const access = await accessFixture();
		let cancelStarted = false;
		// Sends its first chunk, then neither ends nor lets itself be cancelled.
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
			},
			cancel() {
				cancelStarted = true;
				return new Promise<void>(() => undefined);
			},
		});
		const authenticate = createAccessAuthenticator({
			teamDomain: TEAM,
			audience: AUDIENCE,
			ownerEmail: OWNER,
			keyFetchTimeoutMs: 50,
			fetch: async () => new Response(body, { status }),
		});
		const result = await authenticate(access.request(await access.sign({ email: OWNER })));
		expect(result).toEqual({
			ok: false,
			error:
				upstreamStatus === undefined
					? { code: "AUTH_KEYS_UNAVAILABLE", detail }
					: { code: "AUTH_KEYS_UNAVAILABLE", detail, upstreamStatus },
		});
		expect(cancelStarted).toBe(true);
	});

	it("still answers an invalid token as not signed in, without fetching keys", async () => {
		const calls: string[] = [];
		const authenticate = createAccessAuthenticator({
			teamDomain: TEAM,
			audience: AUDIENCE,
			ownerEmail: OWNER,
			fetch: async (input) => {
				calls.push(String(input));
				return new Response("", { status: 503 });
			},
		});
		const access = await accessFixture();
		expect(await authenticate(access.request("not-a-jwt"))).toEqual({
			ok: false,
			error: "UNAUTHENTICATED",
		});
		expect(calls).toEqual([]);
	});

	it("answers the API request with the code, the endpoint's status, and a log line", async () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => lines.push(line));
		const cases: readonly [AuthFailure, number, string][] = [
			[
				{ code: "AUTH_KEYS_UNAVAILABLE", detail: "KEY_FETCH_HTTP_ERROR", upstreamStatus: 503 },
				503,
				"AUTH_KEYS_UNAVAILABLE",
			],
			[
				{ code: "AUTH_KEYS_UNAVAILABLE", detail: "KEY_FETCH_TIMEOUT" },
				502,
				"AUTH_KEYS_UNAVAILABLE",
			],
			["UNAUTHENTICATED", 401, "UNAUTHENTICATED"],
			["FORBIDDEN", 403, "FORBIDDEN"],
		];
		for (const [failure, status, code] of cases) {
			const app = new Hono<AppEnv>().get("/api/v1/session", (c) =>
				ownerAuthFailure(c, logger, failure),
			);
			const response = await app.request("https://research.example.test/api/v1/session");
			expect(response.status).toBe(status);
			expect(await errorCode(response)).toBe(code);
		}
		const logged = lines.map((line) =>
			z.looseObject({ event: z.string() }).parse(JSON.parse(line)),
		);
		expect(logged.map((line) => line.event)).toEqual([
			"owner_auth_keys_unavailable",
			"owner_auth_keys_unavailable",
		]);
		expect(lines.join("\n")).toContain('"upstreamStatus":503');
	});

	it("answers an owner route with AUTH_KEYS_UNAVAILABLE when the authenticator cannot read the keys", async () => {
		const app = createApp({
			overrides: {
				ownerAuthenticator: async () =>
					err({
						code: "AUTH_KEYS_UNAVAILABLE",
						detail: "KEY_FETCH_HTTP_ERROR",
						upstreamStatus: 503,
					}),
			},
		});
		const response = await app.request(
			"https://research.example.test/api/v1/session",
			{},
			{
				DB: env.DB,
			},
		);
		expect(response.status).toBe(503);
		expect(await errorCode(response)).toBe("AUTH_KEYS_UNAVAILABLE");
	});
});

describe("CSRF protection on cookie-authenticated writes (API-005)", () => {
	it("rejects writes from another origin, without an origin, or without the CSRF header", async () => {
		const harness = createHarness();
		const attempts: Record<string, string>[] = [
			{ [CSRF_HEADER]: CSRF_HEADER_VALUE },
			{ Origin: "https://evil.example", [CSRF_HEADER]: CSRF_HEADER_VALUE },
			{ Origin: "http://localhost.evil.example", [CSRF_HEADER]: CSRF_HEADER_VALUE },
			{ Origin: "null", [CSRF_HEADER]: CSRF_HEADER_VALUE },
			{ Origin: "http://localhost" },
		];
		for (const headers of attempts) {
			const response = await harness.raw("POST", "/workspaces", {
				body: { title: "csrf" },
				headers,
			});
			expect(response.status).toBe(403);
			expect(await errorCode(response)).toBe("CSRF_REJECTED");
		}
		const list = await body(await harness.call("GET", "/workspaces"), workspaceListResponseSchema);
		expect(list.workspaces).toHaveLength(0);
	});

	it("does not require CSRF headers for safe reads", async () => {
		const harness = createHarness();
		expect((await harness.raw("GET", "/workspaces")).status).toBe(200);
	});

	it("accepts a second origin only when it is the configured development origin", async () => {
		const app = createApp();
		const write = (origin: string, bindings: Record<string, unknown>) =>
			app.request(
				"http://localhost/api/v1/workspaces",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: origin,
						[CSRF_HEADER]: CSRF_HEADER_VALUE,
					},
					body: JSON.stringify({ title: "dev origin" }),
				},
				{ DB: env.DB, AUTH_MODE: "local-dev", OWNER_EMAIL: "owner@example.test", ...bindings },
			);
		const devBindings = { DEV_ALLOWED_ORIGIN: "http://localhost:3000" };
		// The Vite dev server origin is accepted when configured (development only).
		expect((await write("http://localhost:3000", devBindings)).status).toBe(201);
		// Any other second origin is refused even then.
		expect((await write("http://localhost:3001", devBindings)).status).toBe(403);
		// Without the binding (production) the dev origin is refused too.
		expect((await write("http://localhost:3000", {})).status).toBe(403);
	});

	it("rejects a form-encoded write even with valid CSRF headers", async () => {
		const harness = createHarness();
		const response = await harness.raw("POST", "/workspaces", {
			headers: {
				Origin: "http://localhost",
				[CSRF_HEADER]: CSRF_HEADER_VALUE,
				"Content-Type": "application/x-www-form-urlencoded",
			},
		});
		expect(response.status).toBe(400);
	});
});

describe("runner credentials are separately scoped, expiring and revocable (section 10)", () => {
	it("keeps runner endpoints away from browsers and owner sessions", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);

		// An authenticated owner session without a bearer token gets nothing.
		const ownerOnly = await harness.call("POST", "/runner/jobs/claim", CLAIM_BODY);
		expect(ownerOnly.status).toBe(403);

		// Even a valid token is refused when the request comes from a browser context.
		const browserHeaders: Record<string, string>[] = [
			{ Origin: "http://localhost" },
			{ Cookie: "CF_Authorization=abc" },
		];
		for (const extra of browserHeaders) {
			const response = await harness.raw("POST", "/runner/jobs/claim", {
				body: CLAIM_BODY,
				headers: { Authorization: `Bearer ${token}`, ...extra },
			});
			expect(response.status).toBe(403);
		}

		for (const authorization of [
			undefined,
			"Bearer",
			"Bearer short",
			`Basic ${token}`,
			`Bearer rk_${"0".repeat(64)}`,
		]) {
			const response = await harness.raw("POST", "/runner/jobs/claim", {
				body: CLAIM_BODY,
				headers: authorization === undefined ? {} : { Authorization: authorization },
			});
			expect(response.status).toBe(401);
		}
	});

	it("does not let a runner credential act as the owner", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const response = await harness.raw("GET", "/workspaces", {
			headers: { Authorization: `Bearer ${token}`, "X-Test-Anonymous": "1" },
		});
		expect(response.status).toBe(401);
	});

	it("stores no token, stops working when revoked, and expires", async () => {
		const harness = createHarness();
		const issued = await body(
			await harness.call("POST", "/runner-credentials", { label: "laptop", expiresInDays: 1 }),
			issuedRunnerCredentialSchema,
		);
		expect(issued.token).toMatch(/^rk_[0-9a-f]{64}$/);

		const listed = await harness.call("GET", "/runner-credentials");
		const listedText = await listed.clone().text();
		expect(listedText).not.toContain(issued.token);
		const stored = await env.DB.prepare(
			"SELECT token_hash FROM runner_credentials WHERE credential_id = ?",
		)
			.bind(issued.credential.credentialId)
			.first<{ token_hash: string }>();
		expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(stored?.token_hash).not.toContain(issued.token.slice(3));

		expect((await harness.runner(issued.token, "/jobs/claim", CLAIM_BODY)).status).toBe(200);
		const used = await body(listed, runnerCredentialListResponseSchema);
		expect(used.credentials).toHaveLength(1);

		// Expiry: one day and a second later the same token is dead.
		harness.time.advance(86_400_000 + 1_000);
		expect((await harness.runner(issued.token, "/jobs/claim", CLAIM_BODY)).status).toBe(401);

		const second = await issueRunnerToken(harness, "desktop");
		expect((await harness.runner(second, "/jobs/claim", CLAIM_BODY)).status).toBe(200);
		const credentials = await body(
			await harness.call("GET", "/runner-credentials"),
			runnerCredentialListResponseSchema,
		);
		const desktop = credentials.credentials.find((credential) => credential.label === "desktop");
		expect(
			(await harness.call("DELETE", `/runner-credentials/${desktop?.credentialId}`)).status,
		).toBe(204);
		expect((await harness.runner(second, "/jobs/claim", CLAIM_BODY)).status).toBe(401);
	});

	it("tells a runner which credential its token belongs to, and nothing to anyone else", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness, "desktop");
		const check = (authorization: string, headers: Record<string, string> = {}) =>
			harness.raw("GET", "/runner/credential", {
				headers: { Authorization: authorization, ...headers },
			});
		const credentials = await body(
			await harness.call("GET", "/runner-credentials"),
			runnerCredentialListResponseSchema,
		);
		const accepted = await body(
			await check(`Bearer ${token}`),
			runnerCredentialCheckResponseSchema,
		);
		expect(accepted.credentialId).toBe(credentials.credentials[0]?.credentialId);

		expect((await check(`Bearer ${"rk_"}${"0".repeat(64)}`)).status).toBe(401);
		// A browser cannot use it even with a valid token.
		expect(
			(await check(`Bearer ${token}`, { Origin: "https://research.example.com" })).status,
		).toBe(403);
		await harness.call("DELETE", `/runner-credentials/${accepted.credentialId}`);
		expect((await check(`Bearer ${token}`)).status).toBe(401);
	});

	it("lets a runner renew its own credential, invalidating the old token", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const renewed = await body(
			await harness.runner(token, "/credentials/renew", { expiresInDays: 30 }),
			issuedRunnerCredentialSchema,
		);
		expect(renewed.token).not.toBe(token);
		expect((await harness.runner(token, "/jobs/claim", CLAIM_BODY)).status).toBe(401);
		expect((await harness.runner(renewed.token, "/jobs/claim", CLAIM_BODY)).status).toBe(200);
	});
});

describe("authorization on every resource id (API-004)", () => {
	it("hides one owner's workspaces, runs, sources and leases from another", async () => {
		const alice = createHarness();
		const mallory = createHarness();
		const workspaceId = await createWorkspace(alice);
		const runId = await queueRun(alice, workspaceId);
		const aliceToken = await issueRunnerToken(alice);
		const malloryToken = await issueRunnerToken(mallory);

		const reads = [
			`/workspaces/${workspaceId}`,
			`/workspaces/${workspaceId}/messages`,
			`/workspaces/${workspaceId}/events`,
			`/workspaces/${workspaceId}/export`,
			`/research-runs/${runId}`,
			`/research-runs/${runId}/records`,
		];
		for (const path of reads) {
			expect((await mallory.call("GET", path)).status, path).toBe(404);
		}
		expect((await mallory.call("POST", `/research-runs/${runId}/cancel`)).status).toBe(404);
		expect(
			(await body(await mallory.call("GET", "/workspaces"), workspaceListResponseSchema))
				.workspaces,
		).toHaveLength(0);
		expect(
			(await body(await mallory.call("GET", "/sources"), sourceListResponseSchema)).sources,
		).toHaveLength(0);

		// Mallory's runner cannot claim, heartbeat, release or complete Alice's job.
		const stolen = await mallory.runner(malloryToken, "/jobs/claim", CLAIM_BODY);
		expect(await stolen.text()).toContain('"job":null');
		const lease = await alice.runner(aliceToken, "/jobs/claim", CLAIM_BODY);
		expect(lease.status).toBe(200);
		const heartbeat = await mallory.runner(malloryToken, `/jobs/${runId}/heartbeat`, {
			leaseGeneration: 1,
		});
		expect(heartbeat.status).toBe(404);
		// Nor hand Alice's lease back (ADR-0036).
		const release = await mallory.runner(malloryToken, `/jobs/${runId}/release`, {
			leaseGeneration: 1,
			usage: {
				agentSteps: 0,
				toolCalls: 0,
				inputBytes: 0,
				knownCostUsd: 0,
				hasUnmeteredUsage: false,
			},
		});
		expect(release.status).toBe(404);
	});

	it("never echoes internals in error responses", async () => {
		const harness = createHarness();
		const malformed = await harness.raw("POST", "/workspaces", {
			headers: {
				Origin: "http://localhost",
				[CSRF_HEADER]: CSRF_HEADER_VALUE,
				"Content-Type": "application/json",
			},
		});
		expect(malformed.status).toBe(400);
		const text = await malformed.text();
		expect(text).not.toMatch(/stack|at .*\.ts|SQLITE|D1_/i);
		expect(malformed.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(malformed.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("rejects oversized request bodies", async () => {
		const harness = createHarness();
		const response = await harness.call("POST", "/workspaces", { title: "x".repeat(1_100_000) });
		expect(response.status).toBe(413);
	});
});

describe("plain HTTP is refused outside local development", () => {
	const bindings = { DB: env.DB, AUTH_MODE: "local-dev", OWNER_EMAIL: OWNER };

	it("redirects a read to HTTPS and rejects a write, before any authentication", async () => {
		const app = createApp();
		const read = await app.request(
			"http://research.example.com/api/v1/session?x=1",
			{ headers: { Authorization: "Bearer rk_secret" } },
			bindings,
		);
		expect(read.status).toBe(308);
		expect(read.headers.get("Location")).toBe("https://research.example.com/api/v1/session?x=1");

		for (const path of ["/api/v1/workspaces", "/api/v1/runner/jobs/claim"]) {
			const write = await app.request(
				`http://research.example.com${path}`,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
				bindings,
			);
			expect(write.status).toBe(403);
			expect(await errorCode(write)).toBe("FORBIDDEN");
		}
	});

	it("still serves local development over HTTP and sends HSTS on every API response", async () => {
		const app = createApp();
		const local = await app.request("http://localhost/api/v1/session", {}, bindings);
		expect(local.status).toBe(200);
		const secure = await app.request("https://research.example.com/api/v1/session", {}, bindings);
		// Not a loopback host, so local-dev auth is refused — but the response still carries HSTS.
		expect(secure.status).toBe(401);
		expect(secure.headers.get("Strict-Transport-Security")).toBe(
			"max-age=31536000; includeSubDomains",
		);
	});
});
