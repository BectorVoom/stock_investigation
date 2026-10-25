/**
 * The JSON POST of `SafeFetchOptions.jsonBody` through the Node runner's
 * fetcher: request shape on the wire (real TLS), the allowlist and size
 * preconditions (refused before any byte), no redirects, and no second send
 * once the body may have reached a server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_JSON_BODY_BYTES } from "@research/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeSafeFetcher, type ResolvedAddress } from "../../src/node/index.ts";
import { buildPinnedRequestOptions } from "../../src/node/pinnedConnect.ts";
import { RequestBodySentError } from "../../src/worker/safeFetchCore.ts";
import {
	createFakeNetwork,
	FETCH_LIMITS,
	PUBLIC_V4,
	PUBLIC_V4_B,
	PUBLIC_V6,
} from "./fakeNetwork.ts";
import { type LocalTlsServer, loopbackConnect, startTlsServer } from "./localTlsServer.ts";

const HOST = "search.synthetic-wire.org";
const ALLOWED = new Set([HOST]);
const QUERY = JSON.stringify({ query: "半導体 受注 outlook", max_results: 5 });

interface SeenPost {
	readonly url: string;
	readonly method: string;
	readonly contentType: string | undefined;
	readonly contentLength: string | undefined;
	readonly authorization: string | undefined;
	readonly body: string;
}

const seen: SeenPost[] = [];

function handle(request: IncomingMessage, response: ServerResponse): void {
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => {
		const body = Buffer.concat(chunks).toString("utf8");
		seen.push({
			url: request.url ?? "/",
			method: request.method ?? "",
			contentType: request.headers["content-type"],
			contentLength: request.headers["content-length"],
			authorization: request.headers.authorization,
			body,
		});
		if (request.url === "/search") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ echoed: body }));
		} else if (request.url === "/moved") {
			response.writeHead(307, { location: `https://${HOST}/search` });
			response.end();
		} else if (request.url === "/hang-up") {
			// The body arrived; the connection dies before any response.
			request.socket.destroy();
		} else {
			response.writeHead(404);
			response.end();
		}
	});
}

describe("JSON POST request options", () => {
	it("sends POST with an exact Content-Length of the UTF-8 bytes; a GET has neither header", () => {
		const jsonBody = new TextEncoder().encode(QUERY);
		const options = buildPinnedRequestOptions({
			hostname: HOST,
			address: PUBLIC_V4,
			path: "/search",
			headers: {
				accept: "application/json",
				"user-agent": "u",
				authorization: null,
				finnhubToken: null,
			},
			maxEncodedBytes: 1_000,
			signal: new AbortController().signal,
			jsonBody,
		});
		expect(options.method).toBe("POST");
		expect(options.agent).toBe(false);
		expect(options.headers).toMatchObject({
			"content-type": "application/json",
			"content-length": String(jsonBody.byteLength),
		});
		expect(jsonBody.byteLength).toBeGreaterThan(QUERY.length);
	});
});

describe("node SafeFetcher: JSON POST over a real TLS connection", () => {
	let server: LocalTlsServer;

	beforeAll(async () => {
		server = await startTlsServer([HOST], handle);
	});
	afterAll(async () => {
		await server.close();
	});

	function fetcherWith(addresses: readonly ResolvedAddress[] = [PUBLIC_V4]) {
		const loopback = loopbackConnect(server);
		const lookups: string[] = [];
		const fetcher = createNodeSafeFetcher({
			lookup: async (hostname) => {
				lookups.push(hostname);
				return addresses;
			},
			connect: loopback.connect,
		});
		return { fetcher, lookups, requested: loopback.requested };
	}

	it("sends the body once, with method, Content-Type, Content-Length and Authorization", async () => {
		seen.length = 0;
		const { fetcher } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST}/search`, {
			...FETCH_LIMITS,
			accept: "application/json",
			allowedHosts: ALLOWED,
			authorization: "Bearer tvly-synthetic",
			jsonBody: QUERY,
		});
		expect(result).toEqual({
			ok: true,
			value: {
				finalUrl: `https://${HOST}/search`,
				contentType: "application/json",
				text: JSON.stringify({ echoed: QUERY }),
			},
		});
		expect(seen).toEqual([
			{
				url: "/search",
				method: "POST",
				contentType: "application/json",
				contentLength: String(new TextEncoder().encode(QUERY).byteLength),
				authorization: "Bearer tvly-synthetic",
				body: QUERY,
			},
		]);
	});

	it("never follows a redirect from a POST: the body goes nowhere else", async () => {
		seen.length = 0;
		const authorized: string[] = [];
		const { fetcher, requested } = fetcherWith();
		const result = await fetcher.fetchText(`https://${HOST}/moved`, {
			...FETCH_LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: QUERY,
			authorizeRedirect: async (url) => {
				authorized.push(url);
				return true;
			},
		});
		expect(result).toEqual({
			ok: false,
			error: {
				code: "REDIRECT_NOT_AUTHORIZED",
				detail: "HTTP 307: a POST request is never redirected",
			},
		});
		expect(seen.map((post) => post.url)).toEqual(["/moved"]);
		expect(requested).toHaveLength(1);
		expect(authorized).toEqual([]);
	});

	it("does not re-send the body to the next address once a connection carried it", async () => {
		seen.length = 0;
		const post = fetcherWith([PUBLIC_V4, PUBLIC_V4_B]);
		const result = await post.fetcher.fetchText(`https://${HOST}/hang-up`, {
			...FETCH_LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: QUERY,
		});
		expect(result).toEqual({ ok: false, error: { code: "NETWORK_ERROR", detail: "ECONNRESET" } });
		expect(post.requested.map((request) => request.address.address)).toEqual([PUBLIC_V4.address]);
		expect(seen).toHaveLength(1);

		// The same failure on a GET still tries the next validated address.
		const get = fetcherWith([PUBLIC_V4, PUBLIC_V4_B]);
		await get.fetcher.fetchText(`https://${HOST}/hang-up`, FETCH_LIMITS);
		expect(get.requested.map((request) => request.address.address)).toEqual([
			PUBLIC_V4.address,
			PUBLIC_V4_B.address,
		]);
	});
});

describe("node SafeFetcher: JSON POST preconditions and address fallback", () => {
	it("refuses a POST without an allowlist before resolving or connecting", async () => {
		const network = createFakeNetwork({});
		const result = await createNodeSafeFetcher(network).fetchText(`https://${HOST}/search`, {
			...FETCH_LIMITS,
			jsonBody: QUERY,
		});
		expect(result).toEqual({
			ok: false,
			error: { code: "HOST_NOT_ALLOWED", detail: "a POST request requires an allowlist of hosts" },
		});
		expect(network.lookups).toEqual([]);
		expect(network.connections).toEqual([]);
	});

	it("refuses a body over 64 KiB of UTF-8 before any byte is sent; exactly 64 KiB is sent", async () => {
		const network = createFakeNetwork({ pages: { [`https://${HOST}/search`]: { body: "{}" } } });
		const fetcher = createNodeSafeFetcher(network);
		// "あ" is three UTF-8 bytes: the limit counts bytes, not characters.
		const kana = Math.floor((MAX_JSON_BODY_BYTES - 2) / 3);
		const padding = " ".repeat(MAX_JSON_BODY_BYTES - 2 - 3 * kana);
		const atLimit = `"${"あ".repeat(kana)}${padding}"`;
		const overLimit = `"${"あ".repeat(kana)}${padding} "`;
		expect(new TextEncoder().encode(atLimit).byteLength).toBe(MAX_JSON_BODY_BYTES);
		expect(
			await fetcher.fetchText(`https://${HOST}/search`, {
				...FETCH_LIMITS,
				allowedHosts: ALLOWED,
				jsonBody: overLimit,
			}),
		).toEqual({
			ok: false,
			error: { code: "NETWORK_ERROR", detail: `request body exceeds ${MAX_JSON_BODY_BYTES} bytes` },
		});
		expect(network.connections).toEqual([]);

		const sent = await fetcher.fetchText(`https://${HOST}/search`, {
			...FETCH_LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: atLimit,
		});
		expect(sent).toMatchObject({ ok: true });
		expect(network.connections.map((request) => request.jsonBody?.byteLength)).toEqual([
			MAX_JSON_BODY_BYTES,
		]);
	});

	it("still falls back to the next address when a connection failed before carrying the body", async () => {
		const network = createFakeNetwork({
			dns: { [HOST]: [PUBLIC_V6, PUBLIC_V4] },
			pages: { [`https://${HOST}/search`]: { body: "{}" } },
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
		const result = await fetcher.fetchText(`https://${HOST}/search`, {
			...FETCH_LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: QUERY,
		});
		expect(result).toMatchObject({ ok: true, value: { text: "{}" } });
		expect(attempted).toEqual([PUBLIC_V6.address, PUBLIC_V4.address]);
		expect(network.connections.map((request) => request.jsonBody)).toEqual([
			new TextEncoder().encode(QUERY),
		]);
	});

	it("reports a body-sent failure from the connection layer without trying another address", async () => {
		const attempted: string[] = [];
		const fetcher = createNodeSafeFetcher({
			lookup: async () => [PUBLIC_V4, PUBLIC_V4_B],
			connect: async (request) => {
				attempted.push(request.address.address);
				throw new RequestBodySentError("ECONNRESET");
			},
		});
		const result = await fetcher.fetchText(`https://${HOST}/search`, {
			...FETCH_LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: QUERY,
		});
		expect(result).toEqual({ ok: false, error: { code: "NETWORK_ERROR", detail: "ECONNRESET" } });
		expect(attempted).toEqual([PUBLIC_V4.address]);
	});

	it("sends a GET without a body", async () => {
		const network = createFakeNetwork({ pages: { [`https://${HOST}/search`]: { body: "{}" } } });
		await createNodeSafeFetcher(network).fetchText(`https://${HOST}/search`, FETCH_LIMITS);
		expect(network.connections.map((request) => request.jsonBody)).toEqual([null]);
	});
});
