/**
 * What the shared hop loop (`safeFetchCore.ts`) hands back from an answer:
 * a body decoded by its declared charset (the API Worker's source preview
 * reads feeds through it too) and an error answer's `Retry-After`.
 */
import { describe, expect, it } from "vitest";
import { createWorkerSafeFetcher } from "../../src/worker/index.ts";
import { createFakeFetch } from "./fakeFetch.ts";

const LIMITS = { maxBytes: 10_000, timeoutMs: 2_000, accept: "application/rss+xml" } as const;
/** "日本語" in Shift_JIS. */
const SJIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

describe("safe fetch: charset and Retry-After", () => {
	it("decodes a Shift_JIS feed named by its header or its XML declaration", async () => {
		const declaration = new TextEncoder().encode('<?xml version="1.0" encoding="Shift_JIS"?><t>');
		const fake = createFakeFetch({
			"https://www.example.jp/header.xml": () =>
				new Response(SJIS, { headers: { "content-type": "text/xml; charset=Shift_JIS" } }),
			"https://www.example.jp/declared.xml": () =>
				new Response(new Uint8Array([...declaration, ...SJIS]), {
					headers: { "content-type": "text/xml" },
				}),
		});
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		expect(await fetcher.fetchText("https://www.example.jp/header.xml", LIMITS)).toMatchObject({
			ok: true,
			value: { text: "日本語" },
		});
		const declared = await fetcher.fetchText("https://www.example.jp/declared.xml", LIMITS);
		expect(declared.ok && declared.value.text.endsWith("<t>日本語")).toBe(true);
	});

	it("keeps the byte ceiling on the bytes, before decoding", async () => {
		const fake = createFakeFetch({
			"https://www.example.jp/big.xml": () =>
				new Response(new Uint8Array(12).fill(0x41), {
					headers: { "content-type": "text/xml; charset=Shift_JIS" },
				}),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://www.example.jp/big.xml",
			{ ...LIMITS, maxBytes: 10 },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
	});

	it("carries an error answer's Retry-After, and nothing when none was sent", async () => {
		const fake = createFakeFetch({
			"https://api.tavily.com/limited": () =>
				new Response("{}", { status: 429, headers: { "retry-after": "7" } }),
			"https://api.tavily.com/broken": () => new Response("{}", { status: 500 }),
		});
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		expect(await fetcher.fetchText("https://api.tavily.com/limited", LIMITS)).toEqual({
			ok: false,
			error: { code: "HTTP_ERROR", detail: "HTTP 429", status: 429, retryAfter: "7" },
		});
		expect(await fetcher.fetchText("https://api.tavily.com/broken", LIMITS)).toEqual({
			ok: false,
			error: { code: "HTTP_ERROR", detail: "HTTP 500", status: 500 },
		});
	});
});
