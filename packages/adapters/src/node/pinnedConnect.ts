/**
 * One HTTPS GET to an address the caller has ALREADY validated (SEC-002,
 * connection layer). The socket is opened to the IP literal itself, so Node
 * performs no DNS resolution of its own: there is no second lookup an attacker
 * could answer differently (DNS rebinding / TOCTOU).
 *
 * TLS stays fully verified against the host name, not the address:
 *   host        = validated IP literal   -> where the TCP connection goes
 *   servername  = host name              -> SNI and certificate identity check
 *   Host header = host name              -> virtual hosting
 * Certificate verification is forced on even if NODE_TLS_REJECT_UNAUTHORIZED=0
 * is set in the environment.
 *
 * BODY SIZE: this is where content decoding happens, so this is the only place
 * that sees the bytes on the wire. For gzip/deflate/br responses the encoded
 * bytes read from the socket are counted against `maxEncodedBytes`, and the
 * connection is destroyed the moment that ceiling is passed — independently
 * of how many bytes (possibly none) the decoder produces. The decoded bytes
 * are counted by the caller. An identity body is passed through unchanged, so
 * the caller's count IS the wire count. Any other Content-Encoding is refused.
 */
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ResponseBodyTooLargeError } from "../worker/safeFetchCore.ts";

export interface ResolvedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export interface PinnedRequest {
	/** Used for SNI, certificate verification and the Host header. Never resolved again. */
	readonly hostname: string;
	/** The validated public address the socket must connect to. */
	readonly address: ResolvedAddress;
	/** Path and query, starting with "/". */
	readonly path: string;
	readonly headers: { readonly accept: string; readonly "user-agent": string };
	/** Ceiling on body bytes read from the socket before content decoding. */
	readonly maxEncodedBytes: number;
	readonly signal: AbortSignal;
}

export interface PinnedResponse {
	readonly statusCode: number;
	readonly location: string | null;
	readonly contentType: string | null;
	/** Size as transferred (before content decoding), when declared. */
	readonly contentLength: number | null;
	/**
	 * Content-decoded body bytes. Iteration throws `ResponseBodyTooLargeError`
	 * when the encoded bytes exceed the request's `maxEncodedBytes`.
	 */
	readonly body: AsyncIterable<Uint8Array>;
	destroy(): void;
}

/** Rejects on any connection, TLS or protocol failure. */
export type PinnedConnect = (request: PinnedRequest) => Promise<PinnedResponse>;

/**
 * Deviations from port 443 and the system trust store. They exist so tests can
 * run this exact code against a local TLS server; production passes nothing.
 * Note what is deliberately absent: there is no way to switch verification off.
 */
export interface PinnedTlsOverrides {
	readonly port?: number;
	/** Additional trusted root, PEM. */
	readonly ca?: string;
}

class PinnedConnectError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "PinnedConnectError";
		this.code = code;
	}
}

/** Any attempt by Node to resolve a name on this request is a bug; fail closed. */
const refuseDnsLookup: LookupFunction = (_hostname, _options, callback) => {
	callback(new PinnedConnectError("DNS_LOOKUP_FORBIDDEN"), "", 4);
};

export function buildPinnedRequestOptions(
	request: PinnedRequest,
	tls: PinnedTlsOverrides = {},
): RequestOptions {
	return {
		method: "GET",
		host: request.address.address,
		family: request.address.family,
		port: tls.port ?? 443,
		servername: request.hostname,
		path: request.path,
		headers: {
			host: request.hostname,
			accept: request.headers.accept,
			"user-agent": request.headers["user-agent"],
			"accept-encoding": "gzip",
		},
		// A fresh socket per request: a connection validated for one host is never reused for another.
		agent: false,
		rejectUnauthorized: true,
		lookup: refuseDnsLookup,
		signal: request.signal,
		...(tls.ca === undefined ? {} : { ca: tls.ca }),
	};
}

/** Canonical text form, so "2001:DB8::1" and "2001:db8:0:0:0:0:0:1" compare equal. */
function canonicalIp(address: string): string | null {
	const family = isIP(address);
	if (family === 4) return address;
	if (family !== 6 || !URL.canParse(`http://[${address}]/`)) return null;
	return new URL(`http://[${address}]/`).hostname;
}

/** True only when both texts are valid IP addresses denoting the same address. */
export function isSameIpAddress(actual: string | undefined, expected: string): boolean {
	const canonicalActual = actual === undefined ? null : canonicalIp(actual);
	return canonicalActual !== null && canonicalActual === canonicalIp(expected);
}

function headerText(value: string | readonly string[] | undefined): string | null {
	if (value === undefined) return null;
	return typeof value === "string" ? value : (value[0] ?? null);
}

function headerInteger(value: string | null): number | null {
	if (value === null || !/^\d{1,15}$/.test(value.trim())) return null;
	return Number(value.trim());
}

async function* byteChunks(stream: Readable): AsyncGenerator<Uint8Array> {
	const chunks: AsyncIterable<unknown> = stream;
	for await (const chunk of chunks) {
		if (!(chunk instanceof Uint8Array)) throw new PinnedConnectError("UNEXPECTED_BODY_CHUNK");
		yield chunk;
	}
}

/** Passes the wire bytes on while counting them; exceeding the ceiling ends the response. */
async function* boundedWireBytes(
	response: IncomingMessage,
	maxEncodedBytes: number,
): AsyncGenerator<Uint8Array> {
	let wireBytes = 0;
	// Leaving this loop by throwing destroys `response`, and with it the socket.
	for await (const chunk of byteChunks(response)) {
		wireBytes += chunk.byteLength;
		if (wireBytes > maxEncodedBytes) throw new ResponseBodyTooLargeError();
		yield chunk;
	}
}

/** The pipeline already destroyed both ends; the failure reaches the reader through the decoder. */
function pipelineSettled(): void {}

function decodedBody(
	response: IncomingMessage,
	maxEncodedBytes: number,
): { stream: Readable; destroy: () => void } | null {
	const encoding = (headerText(response.headers["content-encoding"]) ?? "identity")
		.trim()
		.toLowerCase();
	if (encoding === "identity" || encoding === "") {
		// Not decoded here: the caller's byte count is the wire count.
		return { stream: response, destroy: () => response.destroy() };
	}
	const decoder =
		encoding === "gzip" || encoding === "x-gzip"
			? createGunzip()
			: encoding === "deflate"
				? createInflate()
				: encoding === "br"
					? createBrotliDecompress()
					: null;
	if (decoder === null) return null;
	// Two independent ceilings: wire bytes are counted here, decoded bytes by the caller, who
	// pulls the decoder chunk by chunk. Neither a compression bomb nor input that decodes to
	// nothing can run past its limit.
	const wire = Readable.from(boundedWireBytes(response, maxEncodedBytes), { objectMode: false });
	pipeline(wire, decoder, pipelineSettled);
	return {
		stream: decoder,
		destroy: () => {
			response.destroy();
			wire.destroy();
			decoder.destroy();
		},
	};
}

function toPinnedResponse(response: IncomingMessage, maxEncodedBytes: number): PinnedResponse {
	const statusCode = response.statusCode ?? 0;
	const base = {
		statusCode,
		location: headerText(response.headers.location),
		contentType: headerText(response.headers["content-type"]),
		contentLength: headerInteger(headerText(response.headers["content-length"])),
	};
	// Only a success body is ever read; anything else is dropped without decoding.
	if (statusCode < 200 || statusCode > 299) {
		return {
			...base,
			body: (async function* empty() {})(),
			destroy: () => response.destroy(),
		};
	}
	const decoded = decodedBody(response, maxEncodedBytes);
	if (decoded === null) {
		response.destroy();
		throw new PinnedConnectError("UNSUPPORTED_CONTENT_ENCODING");
	}
	return { ...base, body: byteChunks(decoded.stream), destroy: decoded.destroy };
}

export function createPinnedHttpsConnect(tls: PinnedTlsOverrides = {}): PinnedConnect {
	return (request) =>
		new Promise<PinnedResponse>((resolve, reject) => {
			const outgoing = httpsRequest(buildPinnedRequestOptions(request, tls));
			outgoing.once("error", reject);
			outgoing.once("socket", (socket) => {
				// Belt and braces: whatever happened below us (proxy agent, future Node behaviour),
				// refuse to speak to a peer that is not the address that was validated.
				const verifyPeer = (): void => {
					if (!isSameIpAddress(socket.remoteAddress, request.address.address)) {
						outgoing.destroy(new PinnedConnectError("PINNED_ADDRESS_MISMATCH"));
					}
				};
				if (socket.connecting) socket.once("connect", verifyPeer);
				else verifyPeer();
			});
			outgoing.once("response", (response) => {
				try {
					resolve(toPinnedResponse(response, request.maxEncodedBytes));
				} catch (error) {
					reject(error);
				}
			});
			outgoing.end();
		});
}
