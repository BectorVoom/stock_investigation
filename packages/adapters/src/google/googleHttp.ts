/**
 * Narrow pinned HTTPS port for Google (FR-019 section 2.2). This is
 * deliberately NOT the shared `SafeFetcher`: that port only speaks GET to
 * allowlisted content hosts, and widening it to POST form/JSON bodies for two
 * fixed hosts would weaken every other caller. Instead this module reuses the
 * connection-layer machinery (`isSameIpAddress`, the refuse-DNS + IP-literal
 * + SNI pattern of `pinnedConnect.ts`) for exactly two hosts, four methods
 * and no redirects:
 *
 *   - `oauth2.googleapis.com` (token exchange/refresh, revocation),
 *   - `www.googleapis.com` (Calendar API).
 *
 * Per request: the host must be one of the two (anything else fails before
 * any lookup), the name is resolved ONCE through the injected lookup, the
 * socket opens to that IP literal with TLS verified against the host name,
 * and the peer address is re-checked on connect (DNS rebinding / TOCTOU has
 * nothing to influence). Redirects are never followed: a 3xx is returned to
 * the caller as a plain response and every caller maps it to a stable
 * failure. Bodies are capped at 1 MB and the whole request at 30 s.
 *
 * Test seam: production calls `createGoogleHttp()` with no argument; tests
 * point `lookup` at loopback and `tls` at a local TLS server (the
 * `localTlsServer` pattern), so no test ever contacts the real Google.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { classifyIpAddress, err, ok, type Result } from "@research/domain";
import { isSameIpAddress } from "../node/pinnedConnect.ts";
import { describeError, ResponseBodyTooLargeError } from "../worker/safeFetchCore.ts";

/** The only hosts this port will ever contact. */
export const GOOGLE_OAUTH_HOST = "oauth2.googleapis.com";
export const GOOGLE_CALENDAR_HOST = "www.googleapis.com";
const GOOGLE_HOSTS: ReadonlySet<string> = new Set([GOOGLE_OAUTH_HOST, GOOGLE_CALENDAR_HOST]);

/** Bounded response size (section 2.1): 1 MB. */
export const GOOGLE_MAX_BYTES = 1_000_000;
/** Bounded request time (section 2.1): 30 s. */
export const GOOGLE_TIMEOUT_MS = 30_000;

export type GoogleHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface GoogleHttpRequest {
	/** Must be exactly one of the two pinned hosts. */
	readonly host: string;
	readonly method: GoogleHttpMethod;
	/** Path and query, starting with "/". */
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	/** Text body (form or JSON); null for bodiless requests. */
	readonly body: string | null;
	readonly signal: AbortSignal;
}

export interface GoogleHttpResponse {
	readonly status: number;
	readonly location: string | null;
	readonly contentType: string | null;
	/** Bounded decoded text (callers parse it with zod). */
	readonly text: string;
}

export type GoogleHttpErrorCode =
	| "HOST_NOT_ALLOWED"
	| "DNS_FAILED"
	| "UNSAFE_DESTINATION"
	| "NETWORK_ERROR"
	| "TIMEOUT"
	| "RESPONSE_TOO_LARGE";

export interface GoogleHttpError {
	readonly code: GoogleHttpErrorCode;
	/** Log-safe label only (never a body, URL or address). */
	readonly detail: string;
}

export type GoogleHttpResult = Result<GoogleHttpResponse, GoogleHttpError>;

/** Resolves a host name once; the socket never resolves again. */
export type GoogleDnsLookup = (
	hostname: string,
) => Promise<readonly { address: string; family: 4 | 6 }[]>;

/**
 * Deviations from port 443 and the system trust store. They exist so tests
 * can run this exact code against a local TLS server; production passes
 * nothing. There is deliberately no way to switch verification off.
 */
export interface GoogleTlsOverrides {
	readonly port?: number;
	/** Additional trusted root, PEM. */
	readonly ca?: string;
}

export interface GoogleHttpDeps {
	readonly lookup?: GoogleDnsLookup;
	readonly tls?: GoogleTlsOverrides;
}

/** Any attempt by Node to resolve a name on this request is a bug; fail closed. */
const refuseDnsLookup: LookupFunction = (_hostname, _options, callback) => {
	callback(new Error("DNS_LOOKUP_FORBIDDEN"), "", 4);
};

const systemLookup: GoogleDnsLookup = async (hostname) => {
	const answers = await dnsLookup(hostname, { all: true, verbatim: true });
	return answers.map((answer) => ({
		address: answer.address,
		family: answer.family === 4 ? 4 : 6,
	}));
};

function headerText(value: string | readonly string[] | undefined): string | null {
	if (value === undefined) return null;
	return typeof value === "string" ? value : (value[0] ?? null);
}

function fail(code: GoogleHttpErrorCode, detail: string): GoogleHttpResult {
	return err({ code, detail });
}

/**
 * One HTTPS request to a pinned Google host. Redirects are never followed;
 * the caller sees the 3xx status and maps it to a stable failure.
 */
export function createGoogleHttp(
	deps: GoogleHttpDeps = {},
): (request: GoogleHttpRequest) => Promise<GoogleHttpResult> {
	const lookup = deps.lookup ?? systemLookup;
	const tls = deps.tls ?? {};

	return async (request) => {
		if (!GOOGLE_HOSTS.has(request.host)) {
			return fail("HOST_NOT_ALLOWED", `host is not a pinned Google host`);
		}
		if (!request.path.startsWith("/")) {
			return fail("HOST_NOT_ALLOWED", "request path must start with /");
		}
		let addresses: readonly { address: string; family: 4 | 6 }[];
		try {
			addresses = await lookup(request.host);
		} catch (error) {
			return fail("DNS_FAILED", describeError(error));
		}
		if (addresses.length === 0) {
			return fail("DNS_FAILED", "DNS lookup returned no addresses");
		}
		// Tests steer the lookup at loopback; production must never talk to
		// one. The seam is explicit: only a caller that passed `tls` (tests)
		// may reach a non-public address.
		const testSeam = tls.port !== undefined || tls.ca !== undefined;
		if (!testSeam) {
			for (const candidate of addresses) {
				if (classifyIpAddress(candidate.address) !== "public") {
					return fail("UNSAFE_DESTINATION", "host resolves to a non-public address");
				}
			}
		}

		// The caller's signal plus the 30 s ceiling: whichever fires first
		// ends the request. Neither carries any secret.
		const timeout = AbortSignal.timeout(GOOGLE_TIMEOUT_MS);
		const combined =
			request.signal.aborted || timeout.aborted
				? AbortSignal.abort(request.signal.reason ?? timeout.reason)
				: AbortSignal.any([request.signal, timeout]);
		const address = addresses[0];
		if (address === undefined) return fail("DNS_FAILED", "DNS lookup returned no addresses");
		const bodyBytes = request.body === null ? null : new TextEncoder().encode(request.body);

		return new Promise<GoogleHttpResult>((resolve) => {
			let settled = false;
			const settle = (result: GoogleHttpResult): void => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
			};
			let outgoing: ClientRequest;
			try {
				outgoing = httpsRequest({
					method: request.method,
					host: address.address,
					family: address.family,
					port: tls.port ?? 443,
					servername: request.host,
					path: request.path,
					headers: {
						host: request.host,
						"user-agent": "stock-investigation-runner/0.1",
						...request.headers,
						...(bodyBytes === null ? {} : { "content-length": String(bodyBytes.byteLength) }),
					},
					agent: false,
					rejectUnauthorized: true,
					lookup: refuseDnsLookup,
					signal: combined,
					...(tls.ca === undefined ? {} : { ca: tls.ca }),
				});
			} catch {
				// Node refuses a malformed path or header synchronously; the
				// message may quote the value, so only a fixed label leaves.
				settle(fail("NETWORK_ERROR", "REQUEST_NOT_SENT"));
				return;
			}
			outgoing.once("error", (error: unknown) => {
				const name = error instanceof Error ? error.name : "unknown";
				if (name === "AbortError") {
					settle(
						request.signal.aborted
							? fail("TIMEOUT", "request was aborted")
							: fail("TIMEOUT", "request timed out"),
					);
				} else {
					settle(fail("NETWORK_ERROR", describeError(error)));
				}
			});
			outgoing.once("socket", (socket) => {
				const verifyPeer = (): void => {
					if (!isSameIpAddress(socket.remoteAddress, address.address)) {
						outgoing.destroy(new Error("PINNED_ADDRESS_MISMATCH"));
					}
				};
				if (socket.connecting) socket.once("connect", verifyPeer);
				else verifyPeer();
			});
			outgoing.once("response", (response) => {
				const chunks: Uint8Array[] = [];
				let received = 0;
				response.on("data", (chunk: unknown) => {
					if (!(chunk instanceof Uint8Array)) {
						response.destroy();
						settle(fail("NETWORK_ERROR", "UNEXPECTED_BODY_CHUNK"));
						return;
					}
					received += chunk.byteLength;
					if (received > GOOGLE_MAX_BYTES) {
						response.destroy();
						settle(fail("RESPONSE_TOO_LARGE", new ResponseBodyTooLargeError().message));
						return;
					}
					chunks.push(chunk);
				});
				response.once("end", () => {
					const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
					const text = new TextDecoder().decode(
						chunks.length === 1 && chunks[0] !== undefined
							? chunks[0]
							: Buffer.concat(chunks, total),
					);
					settle(
						ok({
							status: response.statusCode ?? 0,
							location: headerText(response.headers.location),
							contentType: headerText(response.headers["content-type"]),
							text,
						}),
					);
				});
				response.once("error", (error: unknown) => {
					settle(fail("NETWORK_ERROR", describeError(error)));
				});
			});
			if (bodyBytes === null) outgoing.end();
			else outgoing.end(bodyBytes);
		});
	};
}
