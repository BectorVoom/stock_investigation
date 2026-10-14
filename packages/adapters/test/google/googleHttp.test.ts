/**
 * Narrow pinned Google port (FR-019 section 2.2/2.6 security checks 5):
 * only the two Google hosts can be contacted, and redirects are not
 * followed. Every test runs against a local TLS server through the real
 * pinned code path — never the real Google endpoints.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
	createGoogleHttp,
	GOOGLE_CALENDAR_HOST,
	GOOGLE_OAUTH_HOST,
} from "../../src/google/googleHttp.ts";
import { startTlsServer } from "../node/localTlsServer.ts";

const never = new AbortController().signal;

function textHandler(body: string, status = 200) {
	return (_request: IncomingMessage, response: ServerResponse) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(body);
	};
}

describe("narrow pinned Google port", () => {
	it("posts a form to the OAuth host through verified TLS", async () => {
		const seen: { method: string | undefined; url: string | undefined; body: string }[] = [];
		const server = await startTlsServer([GOOGLE_OAUTH_HOST], (request, response) => {
			let body = "";
			request.on("data", (chunk: Uint8Array) => {
				body += Buffer.from(chunk).toString("utf8");
			});
			request.on("end", () => {
				seen.push({ method: request.method, url: request.url, body });
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"access_token":"at","refresh_token":"rt"}');
			});
		});
		try {
			const http = createGoogleHttp({
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
				tls: { port: server.port, ca: server.certPem },
			});
			const response = await http({
				host: GOOGLE_OAUTH_HOST,
				method: "POST",
				path: "/token",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "grant_type=refresh_token",
				signal: never,
			});
			expect(response.ok).toBe(true);
			if (!response.ok) return;
			expect(response.value.status).toBe(200);
			expect(response.value.text).toContain("access_token");
			expect(seen).toHaveLength(1);
			expect(seen[0]?.method).toBe("POST");
			expect(seen[0]?.url).toBe("/token");
			expect(seen[0]?.body).toBe("grant_type=refresh_token");
		} finally {
			await server.close();
		}
	});

	it("refuses any other host before any lookup (security check 5)", async () => {
		let lookups = 0;
		const http = createGoogleHttp({
			lookup: async (_hostname) => {
				lookups += 1;
				return [{ address: "127.0.0.1", family: 4 as const }];
			},
		});
		for (const host of ["accounts.google.com", "evil.example.com", "googleapis.com", ""]) {
			const response = await http({
				host,
				method: "GET",
				path: "/",
				headers: {},
				body: null,
				signal: never,
			});
			expect(response.ok).toBe(false);
			if (response.ok) continue;
			expect(response.error.code).toBe("HOST_NOT_ALLOWED");
		}
		expect(lookups).toBe(0);
	});

	it("does not follow redirects (security check 5)", async () => {
		let hits = 0;
		const server = await startTlsServer([GOOGLE_CALENDAR_HOST], (request, response) => {
			hits += 1;
			if (request.url === "/calendar/v3/calendars/abc") {
				response.writeHead(302, { location: "https://evil.example.com/x" });
				response.end();
				return;
			}
			textHandler("{}")(request, response);
		});
		try {
			const http = createGoogleHttp({
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
				tls: { port: server.port, ca: server.certPem },
			});
			const response = await http({
				host: GOOGLE_CALENDAR_HOST,
				method: "GET",
				path: "/calendar/v3/calendars/abc",
				headers: {},
				body: null,
				signal: never,
			});
			expect(response.ok).toBe(true);
			if (!response.ok) return;
			expect(response.value.status).toBe(302);
			expect(response.value.location).toBe("https://evil.example.com/x");
			// Exactly one request reached the network: the redirect target
			// was never contacted.
			expect(hits).toBe(1);
		} finally {
			await server.close();
		}
	});

	it("caps response bodies at 1 MB", async () => {
		const server = await startTlsServer([GOOGLE_CALENDAR_HOST], (_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(`{"pad":"${"x".repeat(1_100_000)}"}`);
		});
		try {
			const http = createGoogleHttp({
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
				tls: { port: server.port, ca: server.certPem },
			});
			const response = await http({
				host: GOOGLE_CALENDAR_HOST,
				method: "GET",
				path: "/calendar/v3/calendars/abc/events",
				headers: {},
				body: null,
				signal: never,
			});
			expect(response.ok).toBe(false);
			if (response.ok) return;
			expect(response.error.code).toBe("RESPONSE_TOO_LARGE");
		} finally {
			await server.close();
		}
	});
});
