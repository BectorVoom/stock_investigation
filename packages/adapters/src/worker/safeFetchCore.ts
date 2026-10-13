/**
 * Runtime-neutral core of both SafeFetcher adapters (SEC-002).
 *
 * It lives next to the Worker adapter because it uses web-standard globals
 * only, and the Node adapter imports it so the redirect/validation policy has
 * exactly one implementation. It must never import `node:*` or `cloudflare:*`.
 *
 * The core owns everything that is identical in both runtimes:
 *   URL policy -> allowlist -> one hop through the transport -> redirect
 *   handling (manual, re-validated per hop) -> status -> byte cap -> decode.
 * A transport owns the one thing that differs: how a single GET reaches the
 * network, and which destination guarantees it can really give.
 *
 * BYTE LIMIT: `maxBytes` bounds the body bytes the core receives from the
 * transport, i.e. the bytes AFTER content decoding. Bytes on the wire before
 * decoding are visible only to the transport, which is handed the same
 * ceiling in `HopRequest.maxBytes` and reports a breach by throwing
 * `ResponseBodyTooLargeError` from the body. Whether a transport can count
 * encoded bytes at all is runtime-specific; each adapter's header says so.
 */
import type {
	BinaryDocument,
	FetchedDocument,
	SafeBinaryFetcher,
	SafeFetchError,
	SafeFetcher,
	SafeFetchOptions,
} from "@research/application";
import { err, ok, type Result, validateFetchUrl } from "@research/domain";

/** Redirects followed after the first request; one more is `TOO_MANY_REDIRECTS`. */
export const MAX_REDIRECT_HOPS = 5;

/** Sent unless a caller identifies itself through `SafeFetchOptions.userAgent`. */
export const DEFAULT_USER_AGENT =
	"stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)";

export interface HopRequest {
	/** Already validated: https, no credentials, default port, public-looking host name. */
	readonly url: URL;
	/** Lower-case host name without a trailing dot, as checked against policy and allowlist. */
	readonly hostname: string;
	readonly headers: {
		readonly accept: string;
		readonly "user-agent": string;
		/** Caller-supplied Authorization value, or null when the caller sent none. */
		readonly authorization: string | null;
		/** Caller-supplied Finnhub key value, or null when the caller sent none. */
		readonly finnhubToken: string | null;
	};
	/**
	 * The caller's byte ceiling. The core applies it to the decoded body; a
	 * transport that decodes content itself must also apply it to the encoded
	 * bytes it reads from the network.
	 */
	readonly maxBytes: number;
	readonly signal: AbortSignal;
}

/**
 * Thrown from a response body by a transport that stopped reading because a
 * byte ceiling was passed. The core reports it as `RESPONSE_TOO_LARGE`.
 */
export class ResponseBodyTooLargeError extends Error {
	constructor() {
		super("response body exceeds the byte limit");
		this.name = "ResponseBodyTooLargeError";
	}
}

export interface HopResponse {
	readonly kind: "response";
	readonly status: number;
	readonly location: string | null;
	readonly contentType: string | null;
	/** Declared size of the body as transferred, when the server stated one. */
	readonly contentLength: number | null;
	/** Decoded body bytes. Must be consumed or discarded. */
	readonly body: AsyncIterable<Uint8Array>;
	/** Releases the connection; safe to call more than once and after full consumption. */
	discard(): void;
}

export type HopOutcome =
	| HopResponse
	/** The transport established that the destination is not a public address. */
	| { readonly kind: "unsafe-destination"; readonly detail: string }
	| { readonly kind: "network-error"; readonly detail: string };

/** Performs exactly one GET without following redirects. Should not throw; a throw is contained. */
export type HopTransport = (request: HopRequest) => Promise<HopOutcome>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEADER_VALUE = /^[\x20-\x7e]{1,300}$/;
const ABORTED = Symbol("aborted");

/**
 * A short, log-safe label for an unexpected error: its `code` or `name` only.
 * Messages and stacks are dropped on purpose; Node puts the remote IP address
 * and port into socket error messages.
 */
export function describeError(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		if ("code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,60}$/.test(error.code)) {
			return error.code;
		}
		if (
			"name" in error &&
			typeof error.name === "string" &&
			/^[A-Za-z0-9_]{1,60}$/.test(error.name)
		) {
			return error.name;
		}
	}
	return "unknown error";
}

function fail(code: SafeFetchError["code"], detail: string): Result<never, SafeFetchError> {
	return err({ code, detail });
}

/** Resolves to `ABORTED` as soon as the signal fires, without leaving a listener behind. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
	if (signal.aborted) return ABORTED;
	let onAbort: (() => void) | null = null;
	const aborted = new Promise<typeof ABORTED>((resolve) => {
		onAbort = () => resolve(ABORTED);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		if (onAbort !== null) signal.removeEventListener("abort", onAbort);
	}
}

function normalizeHost(host: string): string {
	return host.toLowerCase().replace(/\.$/, "");
}

interface HopTarget {
	readonly url: URL;
	readonly hostname: string;
}

type HopRejection = { readonly code: "UNSAFE_URL" | "HOST_NOT_ALLOWED"; readonly detail: string };

function validateHop(
	rawUrl: string,
	allowedHosts: ReadonlySet<string> | null,
): Result<HopTarget, HopRejection> {
	const validated = validateFetchUrl(rawUrl);
	if (!validated.ok) return err({ code: "UNSAFE_URL", detail: validated.error });
	if (allowedHosts !== null && !allowedHosts.has(validated.value.hostname)) {
		return err({
			code: "HOST_NOT_ALLOWED",
			detail: "host is not on the allowlist for this request",
		});
	}
	return ok({ url: new URL(validated.value.href), hostname: validated.value.hostname });
}

function resolveUserAgent(options: SafeFetchOptions): string | null {
	if (options.userAgent === undefined) return DEFAULT_USER_AGENT;
	return HEADER_VALUE.test(options.userAgent) ? options.userAgent : null;
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

type BodyRead =
	| { readonly kind: "complete"; readonly bytes: Uint8Array }
	| { readonly kind: "too-large" }
	| { readonly kind: "aborted" }
	| { readonly kind: "failed"; readonly detail: string };

/** Streams the body and stops the moment it exceeds `maxBytes`; never buffers more than that. */
async function readBounded(
	body: AsyncIterable<Uint8Array>,
	maxBytes: number,
	signal: AbortSignal,
): Promise<BodyRead> {
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	const iterator = body[Symbol.asyncIterator]();
	try {
		for (;;) {
			const next = await untilAborted(iterator.next(), signal);
			if (next === ABORTED) return { kind: "aborted" };
			if (next.done === true) return { kind: "complete", bytes: concatChunks(chunks, totalBytes) };
			totalBytes += next.value.byteLength;
			if (totalBytes > maxBytes) return { kind: "too-large" };
			chunks.push(next.value);
		}
	} catch (error) {
		if (error instanceof ResponseBodyTooLargeError) return { kind: "too-large" };
		return signal.aborted ? { kind: "aborted" } : { kind: "failed", detail: describeError(error) };
	}
}

/** Builds a SafeFetcher from a single-hop transport. The result never throws. */
export function createSafeFetcher(transport: HopTransport): SafeFetcher {
	async function fetchText(
		url: string,
		options: SafeFetchOptions,
	): Promise<Result<FetchedDocument, SafeFetchError>> {
		const raw = await fetchRawBytes(transport, url, options);
		if (!raw.ok) return raw;
		return ok({
			finalUrl: raw.value.finalUrl,
			contentType: raw.value.contentType,
			text: new TextDecoder("utf-8").decode(raw.value.bytes),
		});
	}

	return {
		fetchText: async (url, options) => {
			try {
				return await fetchText(url, options);
			} catch (error) {
				// Nothing above is expected to throw; if it does, the port contract still holds.
				return fail("NETWORK_ERROR", describeError(error));
			}
		},
	};
}

/**
 * Builds a SafeBinaryFetcher from a single-hop transport (FR-018: workbooks).
 * The same hop loop as `fetchText` — URL policy, allowlist, redirect
 * validation, byte and time ceilings — minus the UTF-8 decode, so the caller
 * receives the exact response bytes. The result never throws.
 */
export function createSafeBinaryFetcher(transport: HopTransport): SafeBinaryFetcher {
	return {
		fetchBytes: async (url, options) => {
			try {
				const raw = await fetchRawBytes(transport, url, options);
				if (!raw.ok) return raw;
				const document: BinaryDocument = {
					finalUrl: raw.value.finalUrl,
					contentType: raw.value.contentType,
					bytes: raw.value.bytes,
				};
				return ok(document);
			} catch (error) {
				// Nothing above is expected to throw; if it does, the port contract still holds.
				return fail("NETWORK_ERROR", describeError(error));
			}
		},
	};
}

interface RawDocument {
	readonly finalUrl: string;
	readonly contentType: string | null;
	readonly bytes: Uint8Array;
}

/** The shared hop loop behind `fetchText` and `fetchBytes`. */
async function fetchRawBytes(
	transport: HopTransport,
	url: string,
	options: SafeFetchOptions,
): Promise<Result<RawDocument, SafeFetchError>> {
	if (!(Number.isFinite(options.maxBytes) && options.maxBytes > 0)) {
		return fail("RESPONSE_TOO_LARGE", "maxBytes must be a positive number");
	}
	if (!(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)) {
		return fail("TIMEOUT", "timeoutMs must be a positive number");
	}
	const userAgent = resolveUserAgent(options);
	if (userAgent === null || !HEADER_VALUE.test(options.accept)) {
		return fail("NETWORK_ERROR", "request header value contains unsupported characters");
	}
	// The fixed header allowlist (provider API keys). A value outside
	// printable ASCII fails the request before any byte is sent.
	const authorization =
		options.authorization === undefined
			? null
			: HEADER_VALUE.test(options.authorization)
				? options.authorization
				: null;
	if (options.authorization !== undefined && authorization === null) {
		return fail("NETWORK_ERROR", "request header value contains unsupported characters");
	}
	const finnhubToken =
		options.finnhubToken === undefined
			? null
			: HEADER_VALUE.test(options.finnhubToken)
				? options.finnhubToken
				: null;
	if (options.finnhubToken !== undefined && finnhubToken === null) {
		return fail("NETWORK_ERROR", "request header value contains unsupported characters");
	}
	const includeErrorBody = options.includeErrorBody === true;
	const allowedHosts =
		options.allowedHosts === undefined
			? null
			: new Set([...options.allowedHosts].map(normalizeHost));

	const deadline = AbortSignal.timeout(options.timeoutMs);
	const signal =
		options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
	const timedOut = (): Result<never, SafeFetchError> =>
		fail(
			"TIMEOUT",
			options.signal?.aborted === true
				? "aborted by the caller"
				: `no complete response within ${options.timeoutMs} ms`,
		);

	const visited = new Set<string>();
	let currentUrl = url;
	// hop 0 is the original request; hops 1..MAX_REDIRECT_HOPS are redirects. A further
	// redirect ends the loop and is reported below without being validated or requested.
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
		const isRedirectHop = hop > 0;
		if (isRedirectHop && options.authorizeRedirect !== undefined) {
			// Robots/allowlist approval precedes every page request: a refusal
			// (or a throw, treated as a refusal) ends the fetch before the hop
			// is contacted. Terminates: one awaited call per hop, at most
			// MAX_REDIRECT_HOPS + 1 hops.
			let authorized = false;
			try {
				authorized = await options.authorizeRedirect(currentUrl);
			} catch {
				authorized = false;
			}
			if (!authorized) {
				return fail("REDIRECT_NOT_AUTHORIZED", `redirect ${hop} was not authorized`);
			}
		}
		const target = validateHop(currentUrl, allowedHosts);
		if (!target.ok) {
			return isRedirectHop
				? fail("UNSAFE_REDIRECT", `redirect ${hop} rejected: ${target.error.detail}`)
				: fail(target.error.code, target.error.detail);
		}
		if (visited.has(target.value.url.href)) {
			return fail("TOO_MANY_REDIRECTS", "redirect loop");
		}
		visited.add(target.value.url.href);
		if (signal.aborted) return timedOut();

		let outcome: HopOutcome | typeof ABORTED;
		try {
			outcome = await untilAborted(
				transport({
					url: target.value.url,
					hostname: target.value.hostname,
					headers: {
						accept: options.accept,
						"user-agent": userAgent,
						// A key must never travel to a host the caller did not
						// address: redirects get neither header.
						authorization: hop === 0 ? authorization : null,
						finnhubToken: hop === 0 ? finnhubToken : null,
					},
					maxBytes: options.maxBytes,
					signal,
				}),
				signal,
			);
		} catch (error) {
			outcome = { kind: "network-error", detail: describeError(error) };
		}
		if (outcome === ABORTED || signal.aborted) {
			if (outcome !== ABORTED && outcome.kind === "response") outcome.discard();
			return timedOut();
		}
		if (outcome.kind === "network-error") return fail("NETWORK_ERROR", outcome.detail);
		if (outcome.kind === "unsafe-destination") {
			return isRedirectHop
				? fail("UNSAFE_REDIRECT", `redirect ${hop} rejected: ${outcome.detail}`)
				: fail("UNSAFE_URL", outcome.detail);
		}

		if (REDIRECT_STATUSES.has(outcome.status)) {
			outcome.discard();
			if (outcome.location === null) {
				return fail("HTTP_ERROR", `HTTP ${outcome.status} without a Location header`);
			}
			if (!URL.canParse(outcome.location, target.value.url.href)) {
				return fail("UNSAFE_REDIRECT", `redirect ${hop + 1} rejected: MALFORMED_URL`);
			}
			// Relative locations resolve against the hop that issued them, then get the full policy.
			currentUrl = new URL(outcome.location, target.value.url).href;
			continue;
		}
		if (outcome.status < 200 || outcome.status > 299) {
			// Opt-in only (FRED's 400 carries the error code in JSON): read
			// the bounded error body so the adapter can map it. The body is
			// untrusted provider text; only the adapter ever sees it.
			if (includeErrorBody) {
				const errorBody = await readBounded(outcome.body, options.maxBytes, signal);
				outcome.discard();
				if (errorBody.kind === "aborted") return timedOut();
				if (errorBody.kind === "complete") {
					return err({
						code: "HTTP_ERROR",
						detail: `HTTP ${outcome.status}`,
						body: new TextDecoder("utf-8").decode(errorBody.bytes),
					});
				}
				return fail("HTTP_ERROR", `HTTP ${outcome.status}`);
			}
			outcome.discard();
			return fail("HTTP_ERROR", `HTTP ${outcome.status}`);
		}
		if (outcome.contentLength !== null && outcome.contentLength > options.maxBytes) {
			outcome.discard();
			return fail("RESPONSE_TOO_LARGE", `declared size exceeds ${options.maxBytes} bytes`);
		}
		const body = await readBounded(outcome.body, options.maxBytes, signal);
		outcome.discard();
		if (body.kind === "aborted") return timedOut();
		if (body.kind === "too-large") {
			return fail("RESPONSE_TOO_LARGE", `body exceeds ${options.maxBytes} bytes`);
		}
		if (body.kind === "failed") return fail("NETWORK_ERROR", body.detail);
		return ok({
			finalUrl: target.value.url.href,
			contentType: outcome.contentType,
			bytes: body.bytes,
		});
	}
	return fail("TOO_MANY_REDIRECTS", `more than ${MAX_REDIRECT_HOPS} redirects`);
}
