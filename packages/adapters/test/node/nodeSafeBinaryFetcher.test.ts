/**
 * Node SafeBinaryFetcher tests: exact bytes through the DNS-pinning hop
 * transport, with the same redirect validation and ceilings as `fetchText`.
 * No sockets are opened (scripted DNS + connection).
 */
import { describe, expect, it } from "vitest";
import {
	createNodeSafeBinaryFetcher,
	type DnsLookup,
	type PinnedConnect,
	type PinnedRequest,
	type ResolvedAddress,
} from "../../src/node/index.ts";

const PUBLIC_V4: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const PRIVATE_V4: ResolvedAddress = { address: "10.0.0.9", family: 4 };
const NEVER = new AbortController().signal;

interface BinaryPage {
	readonly status?: number;
	readonly location?: string;
	readonly contentType?: string;
	readonly body: Uint8Array;
}

function binaryNetwork(
	pages: { readonly [url: string]: BinaryPage },
	dns: readonly ResolvedAddress[] = [PUBLIC_V4],
): {
	readonly lookup: DnsLookup;
	readonly connect: PinnedConnect;
	readonly connections: PinnedRequest[];
} {
	const connections: PinnedRequest[] = [];
	return {
		connections,
		lookup: () => Promise.resolve(dns),
		connect: (request) => {
			connections.push(request);
			const url = `https://${request.hostname}${request.path}`;
			const page = Object.hasOwn(pages, url) ? pages[url] : undefined;
			if (page === undefined) return Promise.reject(new Error(`unscripted connection to ${url}`));
			return Promise.resolve({
				statusCode: page.status ?? 200,
				location: page.location ?? null,
				contentType: page.contentType ?? "application/octet-stream",
				contentLength: null,
				body: (async function* chunks() {
					yield page.body;
				})(),
				destroy: () => {},
			});
		},
	};
}

const XLSX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x89]);

describe("Node SafeBinaryFetcher", () => {
	it("returns the exact response bytes without text decoding", async () => {
		const network = binaryNetwork({
			"https://www.jpx.co.jp/kessan09_1009.xlsx": { body: XLSX_MAGIC },
		});
		const fetcher = createNodeSafeBinaryFetcher(network);
		const result = await fetcher.fetchBytes("https://www.jpx.co.jp/kessan09_1009.xlsx", {
			maxBytes: 4_194_304,
			timeoutMs: 5_000,
			accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			allowedHosts: new Set(["www.jpx.co.jp"]),
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`expected bytes, got ${result.error.code}`);
		expect(result.value.finalUrl).toBe("https://www.jpx.co.jp/kessan09_1009.xlsx");
		expect([...result.value.bytes]).toEqual([...XLSX_MAGIC]);
	});

	it("refuses non-public destinations before connecting", async () => {
		const network = binaryNetwork({}, [PRIVATE_V4]);
		const fetcher = createNodeSafeBinaryFetcher(network);
		const result = await fetcher.fetchBytes("https://internal.example.com/admin", {
			maxBytes: 1_000,
			timeoutMs: 5_000,
			accept: "application/octet-stream",
			signal: NEVER,
		});
		expect(result).toEqual({
			ok: false,
			error: { code: "UNSAFE_URL", detail: "host resolves to a non-public address" },
		});
		expect(network.connections).toHaveLength(0);
	});

	it("enforces the byte ceiling on binary bodies", async () => {
		const network = binaryNetwork({
			"https://www.jpx.co.jp/big.xlsx": { body: new Uint8Array(100).fill(7) },
		});
		const fetcher = createNodeSafeBinaryFetcher(network);
		const result = await fetcher.fetchBytes("https://www.jpx.co.jp/big.xlsx", {
			maxBytes: 10,
			timeoutMs: 5_000,
			accept: "application/octet-stream",
			signal: NEVER,
		});
		expect(result).toEqual({
			ok: false,
			error: { code: "RESPONSE_TOO_LARGE", detail: "body exceeds 10 bytes" },
		});
	});

	it("follows a same-host redirect and validates every hop", async () => {
		const network = binaryNetwork({
			"https://www.jpx.co.jp/start": {
				status: 302,
				location: "/final.xlsx",
				body: new Uint8Array(),
			},
			"https://www.jpx.co.jp/final.xlsx": { body: XLSX_MAGIC },
		});
		const fetcher = createNodeSafeBinaryFetcher(network);
		const result = await fetcher.fetchBytes("https://www.jpx.co.jp/start", {
			maxBytes: 1_000,
			timeoutMs: 5_000,
			accept: "application/octet-stream",
			allowedHosts: new Set(["www.jpx.co.jp"]),
			signal: NEVER,
		});
		if (!result.ok) throw new Error(`expected bytes, got ${result.error.code}`);
		expect(result.value.finalUrl).toBe("https://www.jpx.co.jp/final.xlsx");
		expect([...result.value.bytes]).toEqual([...XLSX_MAGIC]);

		const offHost = binaryNetwork({
			"https://www.jpx.co.jp/start": {
				status: 302,
				location: "https://evil.example.com/x.xlsx",
				body: new Uint8Array(),
			},
		});
		const rejected = await createNodeSafeBinaryFetcher(offHost).fetchBytes(
			"https://www.jpx.co.jp/start",
			{
				maxBytes: 1_000,
				timeoutMs: 5_000,
				accept: "application/octet-stream",
				allowedHosts: new Set(["www.jpx.co.jp"]),
				signal: NEVER,
			},
		);
		expect(rejected).toEqual({
			ok: false,
			error: {
				code: "UNSAFE_REDIRECT",
				detail: "redirect 1 rejected: host is not on the allowlist for this request",
			},
		});
	});

	it("forwards the Finnhub token header to the pinned connection", async () => {
		const network = binaryNetwork({
			"https://finnhub.io/api/v1/x": { body: new Uint8Array([1, 2, 3]) },
		});
		const fetcher = createNodeSafeBinaryFetcher(network);
		await fetcher.fetchBytes("https://finnhub.io/api/v1/x", {
			maxBytes: 1_000,
			timeoutMs: 5_000,
			accept: "application/json",
			allowedHosts: new Set(["finnhub.io"]),
			finnhubToken: "synthetic-key",
			signal: NEVER,
		});
		expect(network.connections[0]?.headers.finnhubToken).toBe("synthetic-key");
	});
});
