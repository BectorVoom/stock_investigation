/**
 * Safe-fetcher extensions for FR-018: the `X-Finnhub-Token` allowlist entry
 * (first request only, never across redirects, refused before any byte when
 * malformed) and the binary twin of the hop loop. The redirect, ceiling and
 * policy behaviour itself is unchanged — see `workerSafeFetcher.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createWorkerSafeFetcher } from "../../src/worker/index.ts";
import {
	createSafeBinaryFetcher,
	type HopOutcome,
	type HopRequest,
	type HopTransport,
} from "../../src/worker/safeFetchCore.ts";
import { createFakeFetch, redirectTo, text } from "./fakeFetch.ts";

const FETCH_LIMITS = { maxBytes: 10_000, timeoutMs: 2_000, accept: "application/json" } as const;
const NEVER = new AbortController().signal;

describe("X-Finnhub-Token header", () => {
	it("sends the token on the first request only, never on redirects", async () => {
		const fake = createFakeFetch({
			"https://finnhub.io/start": redirectTo("https://finnhub.io/final"),
			"https://finnhub.io/final": text("done"),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText("https://finnhub.io/start", {
			...FETCH_LIMITS,
			finnhubToken: "synthetic-finnhub-key",
		});
		expect(result).toMatchObject({ ok: true, value: { text: "done" } });
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[0]?.headers["x-finnhub-token"]).toBe("synthetic-finnhub-key");
		expect(fake.calls[1]?.headers).not.toHaveProperty("x-finnhub-token");
		// The Authorization slot stays empty: the two allowlist entries are independent.
		expect(fake.calls[0]?.headers).not.toHaveProperty("authorization");
	});

	it("sends no token header unless the caller supplies one", async () => {
		const fake = createFakeFetch({ "https://finnhub.io/x": text("ok") });
		await createWorkerSafeFetcher(fake.fetch).fetchText("https://finnhub.io/x", FETCH_LIMITS);
		expect(fake.calls[0]?.headers).not.toHaveProperty("x-finnhub-token");
	});

	it("refuses a token value that could inject headers, before any request", async () => {
		const fake = createFakeFetch({ "https://finnhub.io/x": text("ok") });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText("https://finnhub.io/x", {
			...FETCH_LIMITS,
			finnhubToken: "key\r\nCookie: session=1",
		});
		expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_ERROR" } });
		expect(fake.calls).toHaveLength(0);
	});
});

describe("binary hop loop", () => {
	function scriptedTransport(pages: { readonly [url: string]: Uint8Array }): {
		readonly transport: HopTransport;
		readonly calls: HopRequest[];
	} {
		const calls: HopRequest[] = [];
		return {
			calls,
			transport: (request: HopRequest): Promise<HopOutcome> => {
				calls.push(request);
				const body = Object.hasOwn(pages, request.url.href) ? pages[request.url.href] : undefined;
				if (body === undefined) {
					return Promise.resolve({ kind: "network-error", detail: "unscripted hop" });
				}
				return Promise.resolve({
					kind: "response",
					status: 200,
					location: null,
					contentType: "application/octet-stream",
					// Undeclared: the streaming byte ceiling below is what stops this.
					contentLength: null,
					body: (async function* chunks(): AsyncGenerator<Uint8Array> {
						yield body;
					})(),
					discard: () => {},
				});
			},
		};
	}

	it("returns the exact bytes, including non-UTF-8 sequences", async () => {
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x89]);
		const scripted = scriptedTransport({ "https://a.synthetic-wire.org/f.xlsx": bytes });
		const result = await createSafeBinaryFetcher(scripted.transport).fetchBytes(
			"https://a.synthetic-wire.org/f.xlsx",
			{ ...FETCH_LIMITS, allowedHosts: new Set(["a.synthetic-wire.org"]), signal: NEVER },
		);
		if (!result.ok) throw new Error(`expected bytes, got ${result.error.code}`);
		expect(result.value.finalUrl).toBe("https://a.synthetic-wire.org/f.xlsx");
		expect([...result.value.bytes]).toEqual([...bytes]);
	});

	it("enforces the byte ceiling without decoding", async () => {
		const scripted = scriptedTransport({
			"https://a.synthetic-wire.org/big": new Uint8Array(100).fill(9),
		});
		const result = await createSafeBinaryFetcher(scripted.transport).fetchBytes(
			"https://a.synthetic-wire.org/big",
			{ ...FETCH_LIMITS, maxBytes: 10, signal: NEVER },
		);
		expect(result).toEqual({
			ok: false,
			error: { code: "RESPONSE_TOO_LARGE", detail: "body exceeds 10 bytes" },
		});
	});

	it("carries the Finnhub token on the first hop only", async () => {
		const scripted = scriptedTransport({
			"https://a.synthetic-wire.org/start": new Uint8Array([1]),
		});
		const result = await createSafeBinaryFetcher(scripted.transport).fetchBytes(
			"https://a.synthetic-wire.org/start",
			{ ...FETCH_LIMITS, finnhubToken: "synthetic-key", signal: NEVER },
		);
		if (!result.ok) throw new Error(`expected bytes, got ${result.error.code}`);
		expect(scripted.calls[0]?.headers.finnhubToken).toBe("synthetic-key");
	});
});
