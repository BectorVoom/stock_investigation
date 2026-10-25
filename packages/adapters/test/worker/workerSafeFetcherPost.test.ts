/**
 * The JSON POST of `SafeFetchOptions.jsonBody` through the Worker fetcher
 * (and so through the shared core): request shape, the allowlist and size
 * preconditions (refused before any request), no redirects, and unchanged
 * response handling.
 */
import { MAX_JSON_BODY_BYTES } from "@research/application";
import { describe, expect, it } from "vitest";
import { createWorkerSafeFetcher } from "../../src/worker/index.ts";
import { DEFAULT_USER_AGENT } from "../../src/worker/safeFetchCore.ts";
import { createFakeFetch, redirectTo, text } from "./fakeFetch.ts";

const URL_SEARCH = "https://api.synthetic-search.org/search";
const ALLOWED = new Set(["api.synthetic-search.org"]);
const LIMITS = { maxBytes: 10_000, timeoutMs: 2_000, accept: "application/json" } as const;
const QUERY = JSON.stringify({ query: "半導体 受注 outlook", max_results: 5 });

describe("worker SafeFetcher: JSON POST", () => {
	it("sends POST with the exact body, Content-Type and the caller's Authorization", async () => {
		const fake = createFakeFetch({ [URL_SEARCH]: text('{"results":[]}') });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(URL_SEARCH, {
			...LIMITS,
			allowedHosts: ALLOWED,
			authorization: "Bearer tvly-synthetic",
			jsonBody: QUERY,
		});
		expect(result).toMatchObject({ ok: true, value: { text: '{"results":[]}' } });
		expect(fake.calls).toHaveLength(1);
		const [call] = fake.calls;
		expect(call?.method).toBe("POST");
		expect(call?.redirect).toBe("manual");
		expect(call?.body).toBe(QUERY);
		expect(call?.headers).toEqual({
			accept: "application/json",
			"user-agent": DEFAULT_USER_AGENT,
			authorization: "Bearer tvly-synthetic",
			"content-type": "application/json",
		});
	});

	it("keeps a GET without body or Content-Type", async () => {
		const fake = createFakeFetch({ [URL_SEARCH]: text("{}") });
		await createWorkerSafeFetcher(fake.fetch).fetchText(URL_SEARCH, LIMITS);
		expect(fake.calls[0]?.method).toBe("GET");
		expect(fake.calls[0]?.body).toBeNull();
		expect(fake.calls[0]?.headers).not.toHaveProperty("content-type");
	});

	it("refuses a POST without an allowlist before any request", async () => {
		const fake = createFakeFetch({ [URL_SEARCH]: text("{}") });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(URL_SEARCH, {
			...LIMITS,
			jsonBody: QUERY,
		});
		expect(result).toEqual({
			ok: false,
			error: { code: "HOST_NOT_ALLOWED", detail: "a POST request requires an allowlist of hosts" },
		});
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses a POST to a host outside the allowlist before any request", async () => {
		const fake = createFakeFetch({ "https://other.synthetic-search.org/search": text("{}") });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://other.synthetic-search.org/search",
			{ ...LIMITS, allowedHosts: ALLOWED, jsonBody: QUERY },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "HOST_NOT_ALLOWED" } });
		expect(fake.calls).toHaveLength(0);
	});

	it("counts the 64 KiB limit in UTF-8 bytes and refuses one byte more before any request", async () => {
		const fake = createFakeFetch({ [URL_SEARCH]: text("{}") });
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		const kana = Math.floor((MAX_JSON_BODY_BYTES - 2) / 3);
		const padding = " ".repeat(MAX_JSON_BODY_BYTES - 2 - 3 * kana);
		const atLimit = `"${"あ".repeat(kana)}${padding}"`;
		expect(new TextEncoder().encode(atLimit).byteLength).toBe(MAX_JSON_BODY_BYTES);
		const refused = await fetcher.fetchText(URL_SEARCH, {
			...LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: `${atLimit} `,
		});
		expect(refused).toEqual({
			ok: false,
			error: { code: "NETWORK_ERROR", detail: `request body exceeds ${MAX_JSON_BODY_BYTES} bytes` },
		});
		expect(fake.calls).toHaveLength(0);
		const sent = await fetcher.fetchText(URL_SEARCH, {
			...LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: atLimit,
		});
		expect(sent).toMatchObject({ ok: true });
		expect(fake.calls[0]?.body).toBe(atLimit);
	});

	it.each([
		301, 302, 303, 307, 308,
	])("ends the fetch on a %i without following it", async (code) => {
		const fake = createFakeFetch({
			[URL_SEARCH]: redirectTo("https://api.synthetic-search.org/elsewhere", code),
			"https://api.synthetic-search.org/elsewhere": text("{}"),
		});
		let consulted = false;
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(URL_SEARCH, {
			...LIMITS,
			allowedHosts: ALLOWED,
			jsonBody: QUERY,
			authorizeRedirect: async () => {
				consulted = true;
				return true;
			},
		});
		expect(result).toEqual({
			ok: false,
			error: {
				code: "REDIRECT_NOT_AUTHORIZED",
				detail: `HTTP ${code}: a POST request is never redirected`,
			},
		});
		expect(fake.urls()).toEqual([URL_SEARCH]);
		expect(consulted).toBe(false);
	});

	it("handles the response exactly as for a GET (error body opt-in, byte cap)", async () => {
		const fake = createFakeFetch({
			[URL_SEARCH]: () => new Response('{"detail":"bad key"}', { status: 401 }),
			"https://api.synthetic-search.org/big": text("x".repeat(200)),
		});
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		expect(
			await fetcher.fetchText(URL_SEARCH, {
				...LIMITS,
				allowedHosts: ALLOWED,
				jsonBody: QUERY,
				includeErrorBody: true,
			}),
		).toEqual({
			ok: false,
			error: { code: "HTTP_ERROR", detail: "HTTP 401", status: 401, body: '{"detail":"bad key"}' },
		});
		expect(
			await fetcher.fetchText("https://api.synthetic-search.org/big", {
				...LIMITS,
				maxBytes: 100,
				allowedHosts: ALLOWED,
				jsonBody: QUERY,
			}),
		).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
	});
});
