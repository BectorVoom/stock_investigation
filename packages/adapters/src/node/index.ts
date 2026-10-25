/**
 * SafeFetcher for the local Node runner (SEC-002).
 *
 * The runner sits on the owner's PC, so the threat is a URL that reaches the
 * home network: a router admin page, a NAS, a service on loopback, a cloud
 * metadata address. String checks on the URL cannot stop that, because DNS
 * may map any innocent-looking name to such an address.
 *
 * Enforcement, per hop (the target and every redirect):
 *  1. string policy + allowlist (shared core);
 *  2. the caller's `authorizeRedirect` callback before each redirect hop is
 *     contacted (shared core; a refusal ends the fetch with
 *     `REDIRECT_NOT_AUTHORIZED` before the hop is requested);
 *  3. resolve the host name ONCE, taking every A/AAAA answer;
 *  4. refuse the hop unless EVERY answer is a public address. A single
 *     non-public answer rejects the name, so a mixed answer cannot be used to
 *     win a race for the private one;
 *  5. connect to one of those validated addresses as an IP literal
 *     (`pinnedConnect.ts`), with TLS verified against the host name. Node never
 *     resolves the name again, so a second, different DNS answer (rebinding)
 *     has nothing to influence.
 *
 * Response size: `maxBytes` is enforced twice — on the bytes read from the
 * socket before content decoding (`pinnedConnect.ts`) and on the decoded bytes
 * (shared core) — and the connection is destroyed when either is exceeded.
 *
 * RESIDUAL RISK
 *  - "Public" is decided by `classifyIpAddress`; a range it wrongly treats as
 *    public would be reachable. Addresses that are public but routed back into
 *    the owner's network by their own router/VPN (hairpin NAT, split-horizon
 *    VPN ranges using public space) are indistinguishable from the Internet.
 *  - The resolver itself is trusted to report what it resolved.
 *  - This adapter is the only guard in the process: code that calls the global
 *    `fetch` or `node:https` directly bypasses it. OS-level egress filtering
 *    remains the stronger control and is out of scope here.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { SafeBinaryFetcher, SafeFetcher } from "@research/application";
import { classifyIpAddress, describeThrown } from "@research/domain";
import {
	createSafeBinaryFetcher,
	createSafeFetcher,
	type HopOutcome,
	type HopRequest,
	type HopTransport,
	RequestBodySentError,
} from "../worker/safeFetchCore.ts";
import {
	createPinnedHttpsConnect,
	type PinnedConnect,
	type PinnedResponse,
	type ResolvedAddress,
} from "./pinnedConnect.ts";

export { createFilePageArchive, type FilePageArchiveOptions } from "./pageArchive.ts";
export type {
	PinnedConnect,
	PinnedRequest,
	PinnedResponse,
	ResolvedAddress,
} from "./pinnedConnect.ts";
export {
	MAX_ZIP_ARCHIVE_BYTES,
	MAX_ZIP_ENTRY_BYTES,
	readZipEntries,
	type ZipReaderError,
} from "./zipReader.ts";

/** Returns every address the name resolves to. Rejecting means "could not resolve". */
export type DnsLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/**
 * Test seams only. Production code calls `createNodeSafeFetcher()` with no
 * argument; an override replaces system DNS or the pinned TLS connection, so
 * passing one outside tests removes the corresponding guarantee.
 */
export interface NodeSafeFetcherOverrides {
	readonly lookup?: DnsLookup;
	readonly connect?: PinnedConnect;
}

/** Validated addresses tried in order before giving up on a hop. */
const MAX_CONNECT_ATTEMPTS = 3;

const systemLookup: DnsLookup = async (hostname) => {
	const answers = await dnsLookup(hostname, { all: true, verbatim: true });
	return answers.map((answer) => ({
		address: answer.address,
		// Anything that is not plainly IPv4 is classified as IPv6 text and must pass that check.
		family: answer.family === 4 ? 4 : 6,
	}));
};

function toOutcome(response: PinnedResponse): HopOutcome {
	return {
		kind: "response",
		status: response.statusCode,
		location: response.location,
		contentType: response.contentType,
		contentLength: response.contentLength,
		body: response.body,
		discard: () => response.destroy(),
	};
}

/** Describes the first non-public answer by class only; the address itself is never echoed. */
function firstUnsafeClass(addresses: readonly ResolvedAddress[]): "non-public" | "invalid" | null {
	for (const { address } of addresses) {
		const addressClass = classifyIpAddress(address);
		if (addressClass !== "public") return addressClass;
	}
	return null;
}

export function createNodeSafeFetcher(overrides: NodeSafeFetcherOverrides = {}): SafeFetcher {
	return createSafeFetcher(createNodeHopTransport(overrides));
}

/**
 * Binary twin of `createNodeSafeFetcher` (FR-018: JPX workbooks). Same
 * DNS-pinning hop transport, same redirect validation and ceilings — only the
 * UTF-8 decode is skipped so the caller receives exact bytes. The runner is
 * the only caller. Same test-seam caveat as `createNodeSafeFetcher`.
 */
export function createNodeSafeBinaryFetcher(
	overrides: NodeSafeFetcherOverrides = {},
): SafeBinaryFetcher {
	return createSafeBinaryFetcher(createNodeHopTransport(overrides));
}

function createNodeHopTransport(overrides: NodeSafeFetcherOverrides): HopTransport {
	const lookup = overrides.lookup ?? systemLookup;
	const connect = overrides.connect ?? createPinnedHttpsConnect();

	return async (request: HopRequest): Promise<HopOutcome> => {
		let addresses: readonly ResolvedAddress[];
		try {
			addresses = await lookup(request.hostname);
		} catch (error) {
			return { kind: "network-error", detail: `DNS lookup failed: ${describeThrown(error)}` };
		}
		if (addresses.length === 0) {
			return { kind: "network-error", detail: "DNS lookup returned no addresses" };
		}
		const unsafeClass = firstUnsafeClass(addresses);
		if (unsafeClass !== null) {
			return {
				kind: "unsafe-destination",
				detail: `host resolves to a ${unsafeClass} address`,
			};
		}

		let lastFailure = "no connection attempted";
		for (const address of addresses.slice(0, MAX_CONNECT_ATTEMPTS)) {
			if (request.signal.aborted) break;
			try {
				const response = await connect({
					hostname: request.hostname,
					address,
					path: `${request.url.pathname}${request.url.search}`,
					headers: request.headers,
					maxEncodedBytes: request.maxBytes,
					signal: request.signal,
					jsonBody: request.jsonBody,
				});
				return toOutcome(response);
			} catch (error) {
				// The body may have reached the server: sending it again elsewhere
				// would repeat a non-idempotent request.
				if (error instanceof RequestBodySentError) {
					return { kind: "network-error", detail: describeThrown(error) };
				}
				// Typically an unreachable address family; the next validated address may work.
				lastFailure = describeThrown(error);
			}
		}
		return { kind: "network-error", detail: lastFailure };
	};
}
