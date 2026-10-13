/**
 * SafeFetcher for the Cloudflare Worker runtime (SEC-002).
 *
 * WHAT THIS ADAPTER ENFORCES
 *  - the string-level URL policy on the target and on every redirect hop
 *    (https only, no credentials, default port, no IP literals, no internal or
 *    single-label names), via the shared core;
 *  - the caller's host allowlist on the target and on every redirect hop;
 *  - manual redirect handling (never the runtime's automatic following), at
 *    most five hops, loop detection;
 *  - the caller's `authorizeRedirect` callback before each redirect hop is
 *    contacted (shared core, so both runtimes honour it; a refusal ends the
 *    fetch with `REDIRECT_NOT_AUTHORIZED`);
 *  - GET only, no cookies, byte and time limits. At most two caller-supplied
 *    headers (`Authorization`, `X-Finnhub-Token`), each sent on the first
 *    request only (the core strips them from every redirect hop).
 *
 * RESPONSE SIZE — what is and is not bounded here
 *  `fetch` decodes Content-Encoding inside the runtime and exposes only the
 *  decoded stream, so this adapter cannot count the bytes on the wire.
 *   - bounded: decoded body bytes (streamed, cancelled once `maxBytes` is
 *     passed), and a declared Content-Length larger than `maxBytes` whenever
 *     the runtime still exposes that header on a decoded response;
 *   - NOT bounded by bytes: encoded input that decodes to little or nothing
 *     and declares no Content-Length. The runtime keeps reading it; the only
 *     limit is `timeoutMs`, after which the request is aborted (`TIMEOUT`).
 *     That decoding happens in the runtime, not in this isolate's memory.
 *
 * WHAT IT CANNOT ENFORCE — read before relying on it
 *  A Worker has no DNS API and cannot choose or inspect the IP address a
 *  `fetch` connects to. This adapter therefore does NOT verify the resolved
 *  address, and it has no defence of its own against a public-looking name
 *  that resolves to a non-public address (DNS rebinding included).
 *  What limits the damage is environmental, not code in this file:
 *  the request leaves from Cloudflare's network, so the owner's home LAN and
 *  the runner's loopback are not reachable from here. Whatever Cloudflare's
 *  egress can reach under a hostname IS reachable, including other
 *  Cloudflare-hosted origins.
 *  Consequently: for owner-submitted URLs this adapter relies on the string
 *  policy plus Cloudflare egress; where a caller knows the hosts in advance it
 *  should pass `allowedHosts` (ARCHITECTURE section 9.5: "use an approved-host
 *  allowlist rather than relying on string checks").
 */
import type { SafeFetcher } from "@research/application";
import { createSafeFetcher, describeError, type HopOutcome } from "./safeFetchCore.ts";

function headerInteger(value: string | null): number | null {
	if (value === null || !/^\d{1,15}$/.test(value.trim())) return null;
	return Number(value.trim());
}

/** A cancel that fails has nothing left to release; the hop's result is already decided. */
function ignoreCancelFailure(): void {}

function responseBody(response: Response): {
	readonly body: AsyncIterable<Uint8Array>;
	readonly discard: () => void;
} {
	const stream = response.body;
	if (stream === null) {
		return { body: (async function* empty() {})(), discard: () => {} };
	}
	const reader = stream.getReader();
	let released = false;
	async function* chunks(): AsyncGenerator<Uint8Array> {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	}
	return {
		body: chunks(),
		discard: () => {
			if (released) return;
			released = true;
			reader.cancel().catch(ignoreCancelFailure);
		},
	};
}

/**
 * @param fetchImpl injected for tests; defaults to the runtime's global `fetch`.
 */
export function createWorkerSafeFetcher(fetchImpl?: typeof fetch): SafeFetcher {
	// Wrapped so the global is always called unbound, as the Workers runtime requires.
	const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
	return createSafeFetcher(async (request): Promise<HopOutcome> => {
		let response: Response;
		try {
			response = await doFetch(request.url.href, {
				method: "GET",
				// The core validates each Location itself; the runtime must not follow anything.
				redirect: "manual",
				headers: {
					accept: request.headers.accept,
					"user-agent": request.headers["user-agent"],
					...(request.headers.authorization === null
						? {}
						: { authorization: request.headers.authorization }),
					...(request.headers.finnhubToken === null
						? {}
						: { "x-finnhub-token": request.headers.finnhubToken }),
				},
				signal: request.signal,
			});
		} catch (error) {
			return { kind: "network-error", detail: describeError(error) };
		}
		const { body, discard } = responseBody(response);
		return {
			kind: "response",
			status: response.status,
			location: response.headers.get("location"),
			contentType: response.headers.get("content-type"),
			contentLength: headerInteger(response.headers.get("content-length")),
			body,
			discard,
		};
	});
}
