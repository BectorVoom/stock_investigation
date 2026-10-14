/**
 * One-shot loopback listener for the Desktop-app OAuth callback (FR-019
 * section 2.2). Listens on `127.0.0.1` with an ephemeral port (port 0), so
 * no fixed port can be squatted in advance.
 *
 * Accepts exactly one `GET /?...` whose `Host` header is
 * `127.0.0.1:<port>` and whose `state` equals the expected value
 * (compared with `timingSafeEqual`, the login-CSRF defence); everything
 * else — including a request target that does not parse as a URL —
 * answers 404/400 WITHOUT closing and WITHOUT logging (the query
 * string carries the authorization code and is never logged — this module
 * takes no logger at all). `error=access_denied` (valid state) resolves
 * `denied`. Closes after the first accepted callback, on timeout (5
 * minutes) or on abort (job cancelled / runner shutdown).
 *
 * Answers are tiny static pages with no external resources and no reflected
 * input: `Content-Security-Policy: default-src 'none'`,
 * `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
 * `X-Content-Type-Options: nosniff`.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type LoopbackResult =
	| { readonly kind: "code"; readonly code: string }
	| { readonly kind: "denied" }
	| { readonly kind: "timeout" }
	| { readonly kind: "aborted" };

export interface LoopbackHandle {
	readonly port: number;
	readonly redirectUri: string;
	/** Resolves once: first accepted callback, timeout, or abort. */
	wait(): Promise<LoopbackResult>;
	/** Idempotent; safe to call after the listener already closed. */
	close(): Promise<void>;
}

export interface LoopbackOptions {
	/** The `state` the callback must echo (login-CSRF defence). */
	readonly expectedState: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	/**
	 * Test seam for the timeout: production omits it (real timers). Tests
	 * inject a fake clock's sleep so the 5-minute timeout needs no waiting.
	 */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Upper bound on an authorization code's length (junk guard). */
	readonly maxCodeLength?: number;
}

const SUCCESS_PAGE =
	"<!doctype html><html><head><meta charset=utf-8><title>Connected</title></head>" +
	"<body><p>Google Calendar is connected. You can close this tab.</p></body></html>";
const DENIED_PAGE =
	"<!doctype html><html><head><meta charset=utf-8><title>Not connected</title></head>" +
	"<body><p>Google Calendar was not connected: consent was denied. You can close this tab.</p></body></html>";
const FAILED_PAGE =
	"<!doctype html><html><head><meta charset=utf-8><title>Not connected</title></head>" +
	"<body><p>Google Calendar was not connected: the request failed. You can close this tab.</p></body></html>";

function answer(
	response: ServerResponse,
	status: number,
	page: string,
	flushed?: () => void,
): void {
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": "default-src 'none'",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		connection: "close",
		"content-length": Buffer.byteLength(page),
	});
	response.end(page, flushed);
}

/** The query of a request target, or null when the target is not a plain `/?...`. */
function callbackQuery(target: string | undefined): URLSearchParams | null {
	// Never `new URL(...)` on raw request input without a guard: a target
	// such as `//[` throws, and a throw inside the request listener would
	// take the whole runner down.
	if (target === undefined || !URL.canParse(target, "http://127.0.0.1/")) return null;
	const url = new URL(target, "http://127.0.0.1/");
	return url.pathname === "/" && url.host === "127.0.0.1" ? url.searchParams : null;
}

function statesEqual(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	if (actualBytes.length !== expectedBytes.length) return false;
	return timingSafeEqual(actualBytes, expectedBytes);
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

export async function startLoopbackListener(options: LoopbackOptions): Promise<LoopbackHandle> {
	const maxCodeLength = options.maxCodeLength ?? 500;
	const sleep = options.sleep ?? realSleep;
	let settled = false;
	let resolveWait: ((result: LoopbackResult) => void) | null = null;
	const waited = new Promise<LoopbackResult>((resolve) => {
		resolveWait = resolve;
	});
	let server: Server | null = null;
	let expectedHost: string | null = null;
	// Ends the timeout's wait as soon as the listener settles, so no
	// five-minute timer outlives a sign-in that already finished.
	const timer = new AbortController();

	const closeServer = (): Promise<void> =>
		new Promise((resolve) => {
			const current = server;
			server = null;
			expectedHost = null;
			if (current === null) {
				resolve();
				return;
			}
			current.close(() => resolve());
			current.closeAllConnections();
		});

	/** Resolves the wait once; the server closes at once unless a page is still being written. */
	const settle = (result: LoopbackResult, closeNow: boolean): void => {
		if (settled) return;
		settled = true;
		timer.abort();
		options.signal.removeEventListener("abort", onAbort);
		resolveWait?.(result);
		if (closeNow) void closeServer();
	};

	const onAbort = (): void => settle({ kind: "aborted" }, true);

	const listening = createServer((request: IncomingMessage, response: ServerResponse) => {
		// After the first accepted callback the server is closing; a second
		// callback racing the close is rejected rather than honoured twice.
		if (settled || expectedHost === null || request.method !== "GET") {
			answer(response, 404, FAILED_PAGE);
			return;
		}
		if ((request.headers.host ?? null) !== expectedHost) {
			// Wrong Host (DNS rebinding / port-squatting probe): reveal
			// nothing, close nothing.
			answer(response, 404, FAILED_PAGE);
			return;
		}
		const query = callbackQuery(request.url);
		if (query === null) {
			answer(response, 404, FAILED_PAGE);
			return;
		}
		const state = query.get("state");
		if (state === null || !statesEqual(state, options.expectedState)) {
			// Wrong or missing state (login-CSRF attempt): 400, keep waiting.
			answer(response, 400, FAILED_PAGE);
			return;
		}
		// A terminal answer settles at once (so nothing else is accepted) and
		// closes the server only after the page went out — closing first could
		// reset the connection before the browser shows it.
		const closeAfterPage = (): void => void closeServer();
		const error = query.get("error");
		if (error !== null) {
			// The provider refused (most often `access_denied`): a denied
			// callback is terminal. The error value is never reflected.
			settle({ kind: "denied" }, false);
			answer(response, 200, error === "access_denied" ? DENIED_PAGE : FAILED_PAGE, closeAfterPage);
			response.once("close", closeAfterPage);
			return;
		}
		const code = query.get("code");
		if (code === null || code === "" || code.length > maxCodeLength) {
			answer(response, 400, FAILED_PAGE);
			return;
		}
		settle({ kind: "code", code }, false);
		answer(response, 200, SUCCESS_PAGE, closeAfterPage);
		response.once("close", closeAfterPage);
	});
	server = listening;
	// A malformed request never reaches the listener above; answer nothing
	// and drop the socket instead of letting the default handler write.
	listening.on("clientError", (_error, socket) => {
		socket.destroy();
	});
	const actualPort = await new Promise<number>((resolve, reject) => {
		const onError = (error: Error): void =>
			reject(new Error(`loopback listen failed: ${error.name}`));
		listening.once("error", onError);
		listening.listen(0, "127.0.0.1", () => {
			listening.removeListener("error", onError);
			const address = listening.address();
			if (address === null || typeof address === "string") {
				reject(new Error("loopback listener has no TCP address"));
				return;
			}
			resolve(address.port);
		});
	}).catch(async (error: unknown) => {
		await closeServer();
		throw error;
	});
	// A fault after listening (never expected on loopback) ends the wait as
	// aborted rather than escaping as an uncaught exception.
	listening.on("error", () => settle({ kind: "aborted" }, true));
	expectedHost = `127.0.0.1:${actualPort}`;

	if (options.signal.aborted) {
		settle({ kind: "aborted" }, true);
	} else {
		options.signal.addEventListener("abort", onAbort, { once: true });
		// The timeout races the callback; whichever wins settles exactly once.
		void sleep(options.timeoutMs, AbortSignal.any([options.signal, timer.signal])).then(() => {
			if (!options.signal.aborted) settle({ kind: "timeout" }, true);
		});
	}

	return {
		port: actualPort,
		redirectUri: `http://127.0.0.1:${actualPort}/`,
		wait: () => waited,
		close: async () => {
			settle({ kind: "aborted" }, false);
			await closeServer();
		},
	};
}
