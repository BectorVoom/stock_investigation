/**
 * The examples in docs/external-apis/apis/google-oauth.md, fed through the
 * OAuth functions the TypeScript runner uses (conventions §4). Each documented
 * body is the answer of a scripted `GoogleOAuthHttp`, which also records the
 * request the code built — no test contacts Google.
 */
import { ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { GOOGLE_OAUTH_HOST } from "../../src/google/googleHttp.ts";
import {
	exchangeCode,
	type GoogleOAuthHttp,
	mapTokenFailure,
	refreshAccessToken,
	revokeToken,
	scopeGranted,
} from "../../src/google/googleOAuth.ts";
import { docExampleText } from "../docExamples.ts";

const NEVER = new AbortController().signal;

interface SeenRequest {
	readonly host: string;
	readonly method: string;
	readonly path: string;
	readonly body: string | null;
}

/** A Google that answers every request with `status` and `text`. */
function answering(status: number, text: string): { http: GoogleOAuthHttp; seen: SeenRequest[] } {
	const seen: SeenRequest[] = [];
	const http: GoogleOAuthHttp = async (request) => {
		seen.push({
			host: request.host,
			method: request.method,
			path: request.path,
			body: request.body,
		});
		return ok({ status, location: null, text });
	};
	return { http, seen };
}

const CLIENT = { clientId: "doc-client-id", clientSecret: "doc-client-secret" };

describe("Google OAuth document examples", () => {
	it("accepts this app's documented code-exchange answer, scope included", async () => {
		const { http } = answering(
			200,
			docExampleText("google-oauth", "google-oauth-token-exchange-app"),
		);
		const result = await exchangeCode(http, {
			...CLIENT,
			code: "doc-code",
			verifier: "doc-verifier",
			redirectUri: "http://127.0.0.1:51234/",
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`exchange rejected the example: ${result.error.code}`);
		expect(result.value.refreshToken).toBe("<redacted>");
		expect(result.value.expiresIn).toBe(3599);
		expect(scopeGranted(result.value.scope)).toBe(true);
	});

	it("accepts this app's documented refresh answer", async () => {
		const { http } = answering(
			200,
			docExampleText("google-oauth", "google-oauth-token-refresh-app"),
		);
		const result = await refreshAccessToken(http, {
			...CLIENT,
			refreshToken: "doc-refresh",
			signal: NEVER,
		});
		expect(result).toEqual({
			ok: true,
			value: { accessToken: "<redacted>", expiresIn: 3599, refreshToken: null },
		});
	});

	it("parses Google's provider sample but refuses its scopes", async () => {
		const { http, seen } = answering(
			200,
			docExampleText("google-oauth", "google-oauth-token-exchange"),
		);
		const result = await exchangeCode(http, {
			...CLIENT,
			code: "doc-code",
			verifier: "doc-verifier",
			redirectUri: "http://127.0.0.1:51234/",
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`exchange rejected the example: ${result.error.code}`);
		expect(result.value.accessToken).toBe("1/fFAGRNJru1FTz70BzhT3Zg");
		expect(result.value.refreshToken).toBe("1//xEoDL4iW3cxlI7yDbSRFYNG01kVKM2C-259HOF2aQbI");
		expect(result.value.expiresIn).toBe(3920);
		// Google's sample grants other scopes, so the runner would refuse it.
		expect(scopeGranted(result.value.scope)).toBe(false);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.host).toBe(GOOGLE_OAUTH_HOST);
		expect(seen[0]?.path).toBe("/token");
		expect([...new URLSearchParams(seen[0]?.body ?? "").keys()]).toEqual([
			"grant_type",
			"code",
			"client_id",
			"client_secret",
			"redirect_uri",
			"code_verifier",
		]);
	});

	it("refreshes an access token with the documented success body", async () => {
		const { http, seen } = answering(
			200,
			docExampleText("google-oauth", "google-oauth-token-refresh"),
		);
		const result = await refreshAccessToken(http, {
			...CLIENT,
			refreshToken: "doc-refresh",
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`refresh rejected the example: ${result.error.code}`);
		expect(result.value).toEqual({
			accessToken: "1/fFAGRNJru1FTz70BzhT3Zg",
			expiresIn: 3920,
			refreshToken: null,
		});
		expect(new URLSearchParams(seen[0]?.body ?? "").get("grant_type")).toBe("refresh_token");
	});

	it("maps the documented token errors and keeps Google's status", async () => {
		const invalidClient = docExampleText("google-oauth", "google-oauth-error-invalid-client");
		// The client is unknown: the owner must fix the runner's client values.
		expect(mapTokenFailure(401, invalidClient)).toBe("GOOGLE_CLIENT_REJECTED");
		const { http } = answering(401, invalidClient);
		const refreshed = await refreshAccessToken(http, {
			...CLIENT,
			refreshToken: "doc-refresh",
			signal: NEVER,
		});
		expect(refreshed.ok ? null : refreshed.error).toEqual({
			code: "GOOGLE_CLIENT_REJECTED",
			upstreamStatus: 401,
		});
		expect(
			mapTokenFailure(400, docExampleText("google-oauth", "google-oauth-error-invalid-request")),
		).toBe("GOOGLE_REQUEST_FAILED");
	});

	it("reports a revocation answered with the documented error as not revoked", async () => {
		const { http, seen } = answering(
			400,
			docExampleText("google-oauth", "google-oauth-error-revoke-invalid-token"),
		);
		expect(await revokeToken(http, { token: "doc-refresh", signal: NEVER })).toEqual({
			revoked: false,
		});
		expect(seen[0]?.path).toBe("/revoke");
		expect(seen[0]?.body).toBe("token=doc-refresh");
	});
});
