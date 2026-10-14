/**
 * Loopback listener (FR-019 section 2.2, security check 2): the listener
 * rejects a wrong `Host`, a wrong `state`, a non-GET, a non-root path, and
 * a second callback after the first accepted one — while answering the one
 * accepted callback. Attacker input is never reflected and the query string
 * is never logged (the module takes no logger).
 */
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startLoopbackListener } from "../../src/google/googleLoopback.ts";

const STATE = "expected-state-value";
const SHORT_TIMEOUT = 5_000;

function rawRequest(options: {
	port: number;
	method: string;
	path: string;
	host?: string;
}): Promise<{ status: number; body: string; headers: Record<string, string | undefined> }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port: options.port,
				method: options.method,
				path: options.path,
				headers: options.host === undefined ? {} : { host: options.host },
			},
			(response) => {
				let body = "";
				response.on("data", (chunk: Uint8Array) => {
					body += Buffer.from(chunk).toString("utf8");
				});
				response.on("end", () => {
					const headers: Record<string, string | undefined> = {};
					for (const [name, value] of Object.entries(response.headers)) {
						headers[name] = Array.isArray(value) ? value.join(", ") : value;
					}
					resolve({ status: response.statusCode ?? 0, body, headers });
				});
			},
		);
		request.once("error", reject);
		request.end();
	});
}

describe("loopback listener rejections (security check 2)", () => {
	it("rejects a wrong Host without closing", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		try {
			const wrong = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=abc&state=${STATE}`,
				host: `evil.example.com`,
			});
			expect(wrong.status).toBe(404);
			// Still listening: the real callback afterwards is accepted.
			const good = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(good.status).toBe(200);
			expect(good.body).toContain("Google Calendar is connected");
			expect(await listener.wait()).toEqual({ kind: "code", code: "auth-code" });
		} finally {
			await listener.close();
		}
	});

	it("rejects a wrong state without closing", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		try {
			const wrong = await rawRequest({
				port: listener.port,
				method: "GET",
				path: "/?code=attacker-code&state=attacker-state",
				host: `127.0.0.1:${listener.port}`,
			});
			expect(wrong.status).toBe(400);
			const good = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(good.status).toBe(200);
			expect(await listener.wait()).toEqual({ kind: "code", code: "auth-code" });
		} finally {
			await listener.close();
		}
	});

	it("rejects a non-GET without closing", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		try {
			const post = await rawRequest({
				port: listener.port,
				method: "POST",
				path: `/?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(post.status).toBe(404);
			const good = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(good.status).toBe(200);
			expect(await listener.wait()).toEqual({ kind: "code", code: "auth-code" });
		} finally {
			await listener.close();
		}
	});

	it("rejects a non-root path without closing", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		try {
			const other = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/callback?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(other.status).toBe(404);
			const good = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(good.status).toBe(200);
			expect(await listener.wait()).toEqual({ kind: "code", code: "auth-code" });
		} finally {
			await listener.close();
		}
	});

	it("closes after the first accepted callback: a second callback finds no listener", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		const first = await rawRequest({
			port: listener.port,
			method: "GET",
			path: `/?code=first-code&state=${STATE}`,
			host: `127.0.0.1:${listener.port}`,
		});
		expect(first.status).toBe(200);
		expect(await listener.wait()).toEqual({ kind: "code", code: "first-code" });
		// The server is closed: a second callback cannot be delivered.
		await expect(
			rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=second-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			}),
		).rejects.toThrow();
		await listener.close();
	});
});

describe("loopback listener answers", () => {
	it("resolves denied on access_denied with a fixed page and security headers", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		try {
			const denied = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?error=access_denied&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(denied.status).toBe(200);
			expect(denied.body).toContain("was not connected");
			expect(denied.headers["content-security-policy"]).toBe("default-src 'none'");
			expect(denied.headers["cache-control"]).toBe("no-store");
			expect(denied.headers["referrer-policy"]).toBe("no-referrer");
			expect(denied.headers["x-content-type-options"]).toBe("nosniff");
			expect(await listener.wait()).toEqual({ kind: "denied" });
		} finally {
			await listener.close();
		}
	});

	it("never reflects attacker input", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		try {
			const evil = "<script>alert(1)</script>";
			const response = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=${encodeURIComponent(evil)}&state=wrong`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(response.status).toBe(400);
			expect(response.body).not.toContain(evil);
			expect(response.body).not.toContain("alert");
			await listener.close();
		} finally {
			await listener.close();
		}
	});

	it("resolves aborted when the signal fires and closes the port", async () => {
		const abort = new AbortController();
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: abort.signal,
		});
		abort.abort();
		expect(await listener.wait()).toEqual({ kind: "aborted" });
		await expect(
			rawRequest({
				port: listener.port,
				method: "GET",
				path: "/",
				host: `127.0.0.1:${listener.port}`,
			}),
		).rejects.toThrow();
		await listener.close();
	});

	it("answers a request target that is not a URL without crashing, and keeps listening", async () => {
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
		});
		try {
			// `//[` passes the HTTP parser but is not a parsable URL: sent raw,
			// since a well-behaved client would refuse to build it.
			const status = await new Promise<string>((resolve, reject) => {
				const socket = connect(listener.port, "127.0.0.1", () => {
					socket.write(
						`GET //[?state=${STATE}&code=abc HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\n\r\n`,
					);
				});
				let received = "";
				socket.on("data", (chunk: Uint8Array) => {
					received += Buffer.from(chunk).toString("utf8");
				});
				socket.once("close", () => resolve(received.split("\r\n")[0] ?? ""));
				socket.once("error", reject);
			});
			expect(status).toBe("HTTP/1.1 404 Not Found");
			const good = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			expect(good.status).toBe(200);
			expect(await listener.wait()).toEqual({ kind: "code", code: "auth-code" });
		} finally {
			await listener.close();
		}
	});

	it("releases the timeout's wait as soon as the callback is accepted", async () => {
		let released = false;
		const listener = await startLoopbackListener({
			expectedState: STATE,
			timeoutMs: SHORT_TIMEOUT,
			signal: new AbortController().signal,
			sleep: (_ms, signal) =>
				new Promise((resolve) => {
					signal.addEventListener(
						"abort",
						() => {
							released = true;
							resolve();
						},
						{ once: true },
					);
				}),
		});
		try {
			const good = await rawRequest({
				port: listener.port,
				method: "GET",
				path: `/?code=auth-code&state=${STATE}`,
				host: `127.0.0.1:${listener.port}`,
			});
			// The whole page arrives although the listener closes right after.
			expect(good.body).toContain("Google Calendar is connected");
			expect(await listener.wait()).toEqual({ kind: "code", code: "auth-code" });
			expect(released).toBe(true);
		} finally {
			await listener.close();
		}
	});
});
