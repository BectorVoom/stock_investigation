import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeSafeFetcher, type ResolvedAddress } from "../../src/node/index.ts";
import { DEFAULT_USER_AGENT } from "../../src/worker/safeFetchCore.ts";
import {
	createFakeNetwork,
	FETCH_LIMITS,
	PUBLIC_V4,
	PUBLIC_V4_B,
	PUBLIC_V6,
} from "./fakeNetwork.ts";
import { type LocalTlsServer, loopbackConnect, startTlsServer } from "./localTlsServer.ts";

const HOST_A = "a.synthetic-wire.org";
const HOST_B = "b.synthetic-wire.org";

/** Bytes the server had written to the endless-gzip client when that client hung up; -1 = still open. */
let endlessStreamClosedAfterBytes = -1;

function handle(request: IncomingMessage, response: ServerResponse): void {
	const host = request.headers.host ?? "";
	const url = request.url ?? "/";
	if (url === "/hello") {
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		response.end(
			`hello from ${host}; ua=${request.headers["user-agent"]}; cookie=${request.headers.cookie ?? "none"}`,
		);
	} else if (url === "/to-b") {
		response.writeHead(302, { location: `https://${HOST_B}/hello` });
		response.end();
	} else if (url === "/relative") {
		response.writeHead(301, { location: "hello" });
		response.end();
	} else if (url === "/to-loopback-literal") {
		response.writeHead(302, { location: "https://127.0.0.1/admin" });
		response.end();
	} else if (url === "/to-http") {
		response.writeHead(302, { location: `http://${HOST_A}/hello` });
		response.end();
	} else if (url === "/declared-big") {
		response.writeHead(200, { "content-length": String(50_000) });
		response.end("x".repeat(50_000));
	} else if (url === "/chunked-big") {
		response.writeHead(200, { "content-type": "text/plain" });
		const chunk = "y".repeat(1_000);
		let sent = 0;
		const timer = setInterval(() => {
			sent += 1;
			if (sent > 200 || !response.writable) {
				clearInterval(timer);
				response.end();
				return;
			}
			response.write(chunk);
		}, 1);
	} else if (url === "/gzip-bomb") {
		response.writeHead(200, { "content-encoding": "gzip" });
		response.end(gzipSync(Buffer.alloc(5_000_000)));
	} else if (url === "/gzip-empty-members") {
		// ~100 kB on the wire that decodes to nothing: every member is a valid empty gzip stream.
		response.writeHead(200, { "content-encoding": "gzip" });
		response.end(Buffer.concat(Array.from({ length: 5_001 }, () => gzipSync(""))));
	} else if (url === "/gzip-endless-empty-members") {
		response.writeHead(200, { "content-encoding": "gzip" });
		const member = gzipSync("");
		const timer = setInterval(() => {
			if (response.writable) response.write(member);
		}, 1);
		request.socket.once("close", () => {
			clearInterval(timer);
			endlessStreamClosedAfterBytes = request.socket.bytesWritten;
		});
	} else if (url === "/gzip") {
		response.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" });
		response.end(gzipSync(JSON.stringify({ text: "圧縮された応答" })));
	} else if (url === "/slow") {
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("first part");
		// Never ends: the client must give up on its own.
	} else if (url === "/never") {
		// No response at all.
	} else if (url === "/gone") {
		response.writeHead(410);
		response.end("gone");
	} else {
		response.writeHead(404);
		response.end("not found");
	}
}

describe("node SafeFetcher over a real TLS connection", () => {
	let server: LocalTlsServer;

	beforeAll(async () => {
		server = await startTlsServer([HOST_A, HOST_B], handle);
	});
	afterAll(async () => {
		await server.close();
	});

	function fetcherWith(dns: { readonly [hostname: string]: readonly ResolvedAddress[] } = {}) {
		const loopback = loopbackConnect(server);
		const lookups: string[] = [];
		const fetcher = createNodeSafeFetcher({
			lookup: async (hostname) => {
				lookups.push(hostname);
				return dns[hostname] ?? [PUBLIC_V4];
			},
			connect: loopback.connect,
		});
		return { fetcher, lookups, requested: loopback.requested };
	}

	it("fetches text, connecting to the address it validated", async () => {
		const { fetcher, lookups, requested } = fetcherWith({ [HOST_A]: [PUBLIC_V4_B] });
		const result = await fetcher.fetchText(`https://${HOST_A}/hello`, FETCH_LIMITS);
		expect(result).toEqual({
			ok: true,
			value: {
				finalUrl: `https://${HOST_A}/hello`,
				contentType: "text/plain; charset=utf-8",
				text: `hello from ${HOST_A}; ua=${DEFAULT_USER_AGENT}; cookie=none`,
			},
		});
		expect(lookups).toEqual([HOST_A]);
		expect(requested.map((request) => [request.hostname, request.address.address])).toEqual([
			[HOST_A, PUBLIC_V4_B.address],
		]);
	});

	it("resolves and validates every redirect hop separately", async () => {
		const { fetcher, lookups, requested } = fetcherWith({
			[HOST_A]: [PUBLIC_V4],
			[HOST_B]: [PUBLIC_V6],
		});
		const result = await fetcher.fetchText(`https://${HOST_A}/to-b`, FETCH_LIMITS);
		expect(result).toMatchObject({ ok: true, value: { finalUrl: `https://${HOST_B}/hello` } });
		expect(lookups).toEqual([HOST_A, HOST_B]);
		expect(requested.map((request) => request.address.address)).toEqual([
			PUBLIC_V4.address,
			PUBLIC_V6.address,
		]);
	});

	it("resolves a relative Location against the current URL", async () => {
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST_A}/relative`, FETCH_LIMITS);
		expect(result).toMatchObject({ ok: true, value: { finalUrl: `https://${HOST_A}/hello` } });
	});

	it("refuses a redirect to a loopback literal or to http after one connection", async () => {
		for (const path of ["/to-loopback-literal", "/to-http"]) {
			const { fetcher, requested } = fetcherWith();
			const result = await fetcher.fetchText(`https://${HOST_A}${path}`, FETCH_LIMITS);
			expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_REDIRECT" } });
			expect(requested).toHaveLength(1);
		}
	});

	it("refuses a redirect whose host resolves to a private address", async () => {
		const { fetcher, requested } = fetcherWith({
			[HOST_B]: [{ address: "192.168.1.10", family: 4 }],
		});
		const result = await fetcher.fetchText(`https://${HOST_A}/to-b`, FETCH_LIMITS);
		expect(result).toEqual({
			ok: false,
			error: {
				code: "UNSAFE_REDIRECT",
				detail: "redirect 1 rejected: host resolves to a non-public address",
			},
		});
		expect(requested.map((request) => request.hostname)).toEqual([HOST_A]);
	});

	it("enforces the allowlist on redirect hops", async () => {
		const { fetcher, lookups } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST_A}/to-b`, {
			...FETCH_LIMITS,
			allowedHosts: new Set([HOST_A]),
		});
		expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_REDIRECT" } });
		// The off-list host is not even resolved.
		expect(lookups).toEqual([HOST_A]);
	});

	it("rejects an oversized body declared by Content-Length", async () => {
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST_A}/declared-big`, FETCH_LIMITS);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "RESPONSE_TOO_LARGE", detail: "declared size exceeds 10000 bytes" },
		});
	});

	it("cuts off an oversized chunked body while streaming", async () => {
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST_A}/chunked-big`, FETCH_LIMITS);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "RESPONSE_TOO_LARGE", detail: "body exceeds 10000 bytes" },
		});
	});

	it("applies the byte limit to the decompressed size (compression bomb)", async () => {
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST_A}/gzip-bomb`, {
			...FETCH_LIMITS,
			maxBytes: 100_000,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
	});

	it("bounds the encoded bytes too: gzip that decodes to nothing cannot be streamed without limit", async () => {
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST_A}/gzip-empty-members`, {
			...FETCH_LIMITS,
			maxBytes: 32,
		});
		expect(result).toEqual({
			ok: false,
			error: { code: "RESPONSE_TOO_LARGE", detail: "body exceeds 32 bytes" },
		});
	});

	it("drops the connection as soon as the encoded ceiling is passed", async () => {
		const { fetcher } = fetcherWith();
		const startedAt = performance.now();
		const result = await fetcher.fetchText(`https://${HOST_A}/gzip-endless-empty-members`, {
			...FETCH_LIMITS,
			maxBytes: 2_000,
			timeoutMs: 10_000,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
		// Cut off by the byte ceiling, long before the 10 s timeout would have ended it.
		expect(performance.now() - startedAt).toBeLessThan(3_000);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(endlessStreamClosedAfterBytes).toBeGreaterThan(2_000);
		expect(endlessStreamClosedAfterBytes).toBeLessThan(200_000);
	});

	it("decodes a gzip response as UTF-8", async () => {
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST_A}/gzip`, FETCH_LIMITS);
		expect(result).toMatchObject({ ok: true, value: { text: '{"text":"圧縮された応答"}' } });
	});

	it("times out on a stalled body and on a server that never answers", async () => {
		for (const path of ["/slow", "/never"]) {
			const { fetcher } = fetcherWith();
			const startedAt = performance.now();
			const result = await fetcher.fetchText(`https://${HOST_A}${path}`, {
				...FETCH_LIMITS,
				timeoutMs: 150,
			});
			expect(result).toEqual({
				ok: false,
				error: { code: "TIMEOUT", detail: "no complete response within 150 ms" },
			});
			expect(performance.now() - startedAt).toBeLessThan(1_500);
		}
	});

	it("stops when the caller aborts", async () => {
		const { fetcher } = fetcherWith();
		const controller = new AbortController();
		const pending = fetcher.fetchText(`https://${HOST_A}/slow`, {
			...FETCH_LIMITS,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		expect(await pending).toEqual({
			ok: false,
			error: { code: "TIMEOUT", detail: "aborted by the caller" },
		});
	});

	it("reports non-2xx responses with their status", async () => {
		const { fetcher } = fetcherWith();
		expect(await fetcher.fetchText(`https://${HOST_A}/gone`, FETCH_LIMITS)).toEqual({
			ok: false,
			error: { code: "HTTP_ERROR", detail: "HTTP 410" },
		});
		expect(await fetcher.fetchText(`https://${HOST_A}/nothing-here`, FETCH_LIMITS)).toEqual({
			ok: false,
			error: { code: "HTTP_ERROR", detail: "HTTP 404" },
		});
	});

	it("fails TLS verification when the server's certificate does not cover the host", async () => {
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(
			"https://uncovered.synthetic-wire.org/hello",
			FETCH_LIMITS,
		);
		expect(result).toEqual({
			ok: false,
			error: { code: "NETWORK_ERROR", detail: "ERR_TLS_CERT_ALTNAME_INVALID" },
		});
	});
});

describe("node SafeFetcher: resolution failures and address fallback", () => {
	it("reports a DNS failure without connecting", async () => {
		const network = createFakeNetwork({});
		const fetcher = createNodeSafeFetcher({
			lookup: async () => {
				throw Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.synthetic-wire.org"), {
					code: "ENOTFOUND",
				});
			},
			connect: network.connect,
		});
		expect(await fetcher.fetchText("https://nowhere.synthetic-wire.org/", FETCH_LIMITS)).toEqual({
			ok: false,
			error: { code: "NETWORK_ERROR", detail: "DNS lookup failed: ENOTFOUND" },
		});
		expect(network.connections).toHaveLength(0);
	});

	it("treats an empty DNS answer as a failure, not as permission", async () => {
		const network = createFakeNetwork({ dns: { "empty.synthetic-wire.org": [] } });
		const result = await createNodeSafeFetcher(network).fetchText(
			"https://empty.synthetic-wire.org/",
			FETCH_LIMITS,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_ERROR" } });
		expect(network.connections).toHaveLength(0);
	});

	it("falls back to the next validated address when one is unreachable", async () => {
		const network = createFakeNetwork({
			dns: { "dual.synthetic-wire.org": [PUBLIC_V6, PUBLIC_V4] },
			pages: { "https://dual.synthetic-wire.org/": { body: "reached" } },
		});
		const attempted: string[] = [];
		const fetcher = createNodeSafeFetcher({
			lookup: network.lookup,
			connect: async (request) => {
				attempted.push(request.address.address);
				if (request.address.family === 6) {
					throw Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
				}
				return network.connect(request);
			},
		});
		const result = await fetcher.fetchText("https://dual.synthetic-wire.org/", FETCH_LIMITS);
		expect(result).toMatchObject({ ok: true, value: { text: "reached" } });
		expect(attempted).toEqual([PUBLIC_V6.address, PUBLIC_V4.address]);
		expect(network.lookups).toEqual(["dual.synthetic-wire.org"]);
	});

	it("reports the connection error code, never the message with the address", async () => {
		const fetcher = createNodeSafeFetcher({
			lookup: async () => [PUBLIC_V4],
			connect: async () => {
				throw Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), {
					code: "ECONNREFUSED",
				});
			},
		});
		expect(await fetcher.fetchText("https://refused.synthetic-wire.org/", FETCH_LIMITS)).toEqual({
			ok: false,
			error: { code: "NETWORK_ERROR", detail: "ECONNREFUSED" },
		});
	});
});
