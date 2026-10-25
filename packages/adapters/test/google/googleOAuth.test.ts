/**
 * Google OAuth builders and token calls (FR-019 section 2.2). Pure builders
 * carry hand-worked expectations (the RFC 7636 appendix-B vector); HTTP
 * calls run against a local fake Google server — never the real endpoints.
 */

import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createGoogleHttp, GOOGLE_OAUTH_HOST } from "../../src/google/googleHttp.ts";
import {
	buildAuthorizationUrl,
	codeChallengeS256,
	exchangeCode,
	GOOGLE_CALENDAR_SCOPE,
	type GoogleOAuthHttp,
	mapTokenFailure,
	newCodeVerifier,
	newOAuthState,
	refreshAccessToken,
	revokeToken,
	scopeGranted,
} from "../../src/google/googleOAuth.ts";
import { startTlsServer } from "../node/localTlsServer.ts";

const never = new AbortController().signal;

describe("PKCE and authorization URL builders", () => {
	it("derives the RFC 7636 appendix-B challenge", () => {
		// RFC 7636 §4.2 / appendix B test vector, worked by the RFC itself.
		expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});

	it("builds 32-byte verifiers and states as unpadded base64url", () => {
		const fill7 = () => new Uint8Array(32).fill(7);
		const verifier = newCodeVerifier(fill7);
		expect(verifier).toBe(Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"));
		expect(verifier).toHaveLength(43);
		expect(newOAuthState(() => new Uint8Array(32).fill(9))).toHaveLength(43);
		expect(newCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("builds the authorization URL with the one scope and PKCE", () => {
		const url = buildAuthorizationUrl({
			clientId: "client-id",
			redirectUri: "http://127.0.0.1:51234/",
			state: "state-value",
			challenge: "challenge-value",
		});
		const parsed = new URL(url);
		expect(`${parsed.origin}${parsed.pathname}`).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("client_id")).toBe("client-id");
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:51234/");
		expect(parsed.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPE);
		expect(parsed.searchParams.get("access_type")).toBe("offline");
		expect(parsed.searchParams.get("prompt")).toBe("consent");
		expect(parsed.searchParams.get("code_challenge")).toBe("challenge-value");
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe("state-value");
	});
});

describe("token endpoint mapping", () => {
	it("maps invalid_grant, rate limits and anything else", () => {
		expect(mapTokenFailure(400, '{"error":"invalid_grant"}')).toBe("GOOGLE_AUTH_EXPIRED");
		expect(mapTokenFailure(400, '{"error":{"code":"rateLimitExceeded"}}')).toBe(
			"GOOGLE_RATE_LIMITED",
		);
		expect(mapTokenFailure(429, "{}")).toBe("GOOGLE_RATE_LIMITED");
		expect(mapTokenFailure(400, '{"error":"redirect_uri_mismatch"}')).toBe("GOOGLE_REQUEST_FAILED");
		expect(mapTokenFailure(500, "boom")).toBe("GOOGLE_REQUEST_FAILED");
		expect(mapTokenFailure(302, null)).toBe("GOOGLE_REQUEST_FAILED");
		expect(mapTokenFailure(null, null)).toBe("GOOGLE_REQUEST_FAILED");
	});

	it("grants only the exact scope string", () => {
		expect(scopeGranted(GOOGLE_CALENDAR_SCOPE)).toBe(true);
		expect(scopeGranted(`openid ${GOOGLE_CALENDAR_SCOPE}`)).toBe(true);
		expect(scopeGranted("https://www.googleapis.com/auth/calendar")).toBe(false);
		expect(scopeGranted(null)).toBe(false);
		expect(scopeGranted("")).toBe(false);
	});
});

interface SeenForm {
	readonly path: string;
	readonly fields: URLSearchParams;
}

/** Fake Google token server: scripted JSON per path, recording form fields. */
async function fakeTokenServer(routes: Record<string, { status: number; body: string }>) {
	const seen: SeenForm[] = [];
	const server = await startTlsServer([GOOGLE_OAUTH_HOST], (request, response) => {
		let raw = "";
		request.on("data", (chunk: Uint8Array) => {
			raw += Buffer.from(chunk).toString("utf8");
		});
		request.on("end", () => {
			const route = routes[request.url ?? ""];
			seen.push({ path: request.url ?? "", fields: new URLSearchParams(raw) });
			if (route === undefined) {
				response.writeHead(404, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			response.writeHead(route.status, { "content-type": "application/json" });
			response.end(route.body);
		});
	});
	return { server, seen };
}

function httpThrough(server: { port: number; certPem: string }): GoogleOAuthHttp {
	const http = createGoogleHttp({
		lookup: async () => [{ address: "127.0.0.1", family: 4 as const }],
		tls: { port: server.port, ca: server.certPem },
	});
	return (request) => http(request);
}

describe("token calls against a fake Google server", () => {
	it("exchanges a code with every required form field", async () => {
		const { server, seen } = await fakeTokenServer({
			"/token": {
				status: 200,
				body: '{"access_token":"at","refresh_token":"rt","scope":"S","expires_in":3600}',
			},
		});
		try {
			const exchanged = await exchangeCode(httpThrough(server), {
				clientId: "cid",
				clientSecret: "csecret",
				code: "auth-code",
				verifier: "verifier",
				redirectUri: "http://127.0.0.1:1/",
				signal: never,
			});
			expect(exchanged).toEqual(
				ok({ accessToken: "at", refreshToken: "rt", scope: "S", expiresIn: 3600 }),
			);
			expect(seen).toHaveLength(1);
			expect(seen[0]?.path).toBe("/token");
			expect(seen[0]?.fields.get("grant_type")).toBe("authorization_code");
			expect(seen[0]?.fields.get("code")).toBe("auth-code");
			expect(seen[0]?.fields.get("client_id")).toBe("cid");
			expect(seen[0]?.fields.get("client_secret")).toBe("csecret");
			expect(seen[0]?.fields.get("redirect_uri")).toBe("http://127.0.0.1:1/");
			expect(seen[0]?.fields.get("code_verifier")).toBe("verifier");
		} finally {
			await server.close();
		}
	});

	it("treats a missing refresh token as scope-missing (nothing storable)", async () => {
		const { server } = await fakeTokenServer({
			"/token": { status: 200, body: '{"access_token":"at"}' },
		});
		try {
			const exchanged = await exchangeCode(httpThrough(server), {
				clientId: "cid",
				clientSecret: "csecret",
				code: "auth-code",
				verifier: "verifier",
				redirectUri: "http://127.0.0.1:1/",
				signal: never,
			});
			expect(exchanged).toEqual(err({ code: "GOOGLE_SCOPE_MISSING", upstreamStatus: null }));
		} finally {
			await server.close();
		}
	});

	it("maps invalid_grant on refresh to auth-expired", async () => {
		const { server, seen } = await fakeTokenServer({
			"/token": { status: 400, body: '{"error":"invalid_grant"}' },
		});
		try {
			const refreshed = await refreshAccessToken(httpThrough(server), {
				clientId: "cid",
				clientSecret: "csecret",
				refreshToken: "old",
				signal: never,
			});
			// Google's 400 travels beside the code, unchanged (§4a).
			expect(refreshed).toEqual(err({ code: "GOOGLE_AUTH_EXPIRED", upstreamStatus: 400 }));
			expect(seen[0]?.fields.get("grant_type")).toBe("refresh_token");
			expect(seen[0]?.fields.get("refresh_token")).toBe("old");
		} finally {
			await server.close();
		}
	});

	it("refreshes an access token", async () => {
		const { server } = await fakeTokenServer({
			"/token": { status: 200, body: '{"access_token":"new-at","expires_in":3599}' },
		});
		try {
			const refreshed = await refreshAccessToken(httpThrough(server), {
				clientId: "cid",
				clientSecret: "csecret",
				refreshToken: "rt",
				signal: never,
			});
			expect(refreshed).toEqual(ok({ accessToken: "new-at", expiresIn: 3599 }));
		} finally {
			await server.close();
		}
	});

	it("revokes with the token form field; 200 means revoked", async () => {
		const { server, seen } = await fakeTokenServer({
			"/revoke": { status: 200, body: "{}" },
		});
		try {
			const revoked = await revokeToken(httpThrough(server), { token: "rt", signal: never });
			expect(revoked).toEqual({ revoked: true });
			expect(seen[0]?.path).toBe("/revoke");
			expect(seen[0]?.fields.get("token")).toBe("rt");
		} finally {
			await server.close();
		}
	});

	it("reports a failed revoke as not revoked (best effort)", async () => {
		const { server } = await fakeTokenServer({
			"/revoke": { status: 400, body: '{"error":"invalid_token"}' },
		});
		try {
			const revoked = await revokeToken(httpThrough(server), { token: "rt", signal: never });
			expect(revoked).toEqual({ revoked: false });
		} finally {
			await server.close();
		}
	});
});
