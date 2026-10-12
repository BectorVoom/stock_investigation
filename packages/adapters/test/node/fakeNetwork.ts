/**
 * A scripted DNS + connection layer for the Node SafeFetcher. No sockets are
 * opened: `lookup` answers from a table and `connect` serves pages from a map,
 * while recording every call so tests can assert which addresses the fetcher
 * tried to reach — and, above all, which it never tried.
 */
import type {
	DnsLookup,
	PinnedConnect,
	PinnedRequest,
	PinnedResponse,
	ResolvedAddress,
} from "../../src/node/index.ts";

export const PUBLIC_V4: ResolvedAddress = { address: "93.184.216.34", family: 4 };
export const PUBLIC_V4_B: ResolvedAddress = { address: "151.101.1.69", family: 4 };
export const PUBLIC_V6: ResolvedAddress = {
	address: "2606:2800:220:1:248:1893:25c8:1946",
	family: 6,
};

export interface FakePage {
	readonly status?: number;
	readonly location?: string;
	readonly contentType?: string;
	readonly contentLength?: number;
	readonly body?: string;
}

export type DnsAnswer = readonly ResolvedAddress[] | (() => readonly ResolvedAddress[]);

export interface FakeNetwork {
	readonly lookup: DnsLookup;
	readonly connect: PinnedConnect;
	readonly lookups: string[];
	readonly connections: PinnedRequest[];
	/** Addresses a connection was attempted to, in order. */
	readonly connectedAddresses: () => readonly string[];
}

export function createFakeNetwork(script: {
	/** Host name -> answers. Unlisted names resolve to one public address. */
	readonly dns?: { readonly [hostname: string]: DnsAnswer };
	/** "https://host/path?query" -> page. */
	readonly pages?: { readonly [url: string]: FakePage };
}): FakeNetwork {
	const lookups: string[] = [];
	const connections: PinnedRequest[] = [];
	const encoder = new TextEncoder();
	return {
		lookups,
		connections,
		connectedAddresses: () => connections.map((connection) => connection.address.address),
		lookup: async (hostname) => {
			lookups.push(hostname);
			const answer =
				script.dns !== undefined && Object.hasOwn(script.dns, hostname)
					? script.dns[hostname]
					: undefined;
			if (answer === undefined) return [PUBLIC_V4];
			return typeof answer === "function" ? answer() : answer;
		},
		connect: async (request): Promise<PinnedResponse> => {
			connections.push(request);
			const url = `https://${request.hostname}${request.path}`;
			const page =
				script.pages !== undefined && Object.hasOwn(script.pages, url)
					? script.pages[url]
					: undefined;
			if (page === undefined) throw new Error(`unscripted connection to ${url}`);
			const body = page.body ?? "";
			return {
				statusCode: page.status ?? 200,
				location: page.location ?? null,
				contentType: page.contentType ?? "text/plain",
				contentLength: page.contentLength ?? null,
				body: (async function* chunks() {
					yield encoder.encode(body);
				})(),
				destroy: () => {},
			};
		},
	};
}

export const FETCH_LIMITS = { maxBytes: 10_000, timeoutMs: 2_000, accept: "text/plain" } as const;
