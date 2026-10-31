import { upstreamStatusOf } from "@research/application";
import { describe, expect, it } from "vitest";
import { datePrefixOf, fetchJsonDocument, isIsoDate } from "../../src/finance/marketFetch.ts";
import { createScriptedFetcher } from "../tools/support.ts";

const URL = "https://api.synthetic-wire.org/x";
const LIMITS = { maxBytes: 1000, timeoutMs: 2000, accept: "application/json" } as const;

describe("market HTTP helpers", () => {
	it("reads the upstream status from the status field, never from the detail text", () => {
		expect(upstreamStatusOf({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 })).toBe(404);
		expect(upstreamStatusOf({ code: "HTTP_ERROR", detail: "HTTP 429", status: 429 })).toBe(429);
		// The detail is for people: a different number in it is ignored.
		expect(upstreamStatusOf({ code: "HTTP_ERROR", detail: "HTTP 500", status: 529 })).toBe(529);
		expect(upstreamStatusOf({ code: "TIMEOUT", detail: "no complete response" })).toBeNull();
		expect(upstreamStatusOf({ code: "NETWORK_ERROR", detail: "404 in a message" })).toBeNull();
	});

	it("parses a JSON document and keeps the final URL", async () => {
		const fetcher = createScriptedFetcher({ [URL]: { text: '{"a":1}' } });
		const result = await fetchJsonDocument(fetcher, URL, LIMITS);
		expect(result).toEqual({ ok: true, value: { finalUrl: URL, json: { a: 1 } } });
	});

	it("reports non-JSON as NETWORK_ERROR with a fixed detail", async () => {
		const fetcher = createScriptedFetcher({ [URL]: { text: "{oops" } });
		const result = await fetchJsonDocument(fetcher, URL, LIMITS);
		expect(result).toEqual({
			ok: false,
			error: { code: "NETWORK_ERROR", detail: "response is not valid JSON" },
		});
	});

	it("passes transport failures through untouched, error body included", async () => {
		const failure = {
			code: "HTTP_ERROR",
			detail: "HTTP 400",
			status: 400,
			body: '{"error_code":400}',
		} as const;
		const fetcher = createScriptedFetcher({ [URL]: { error: failure } });
		const result = await fetchJsonDocument(fetcher, URL, LIMITS);
		expect(result).toEqual({ ok: false, error: failure });
	});
});

describe("market ISO date helpers", () => {
	it("validates real calendar dates only", () => {
		expect(isIsoDate("2026-10-01")).toBe(true);
		expect(isIsoDate("2024-02-29")).toBe(true);
		for (const bad of [
			"2026-13-01",
			"2026-02-30",
			"2026-1-1",
			"10/01/2026",
			"",
			"2026-10-01T00:00",
		]) {
			expect(isIsoDate(bad)).toBe(false);
		}
	});

	it("takes the leading date of a provider timestamp", () => {
		expect(datePrefixOf("2026-10-09 00:00:00")).toBe("2026-10-09");
		expect(datePrefixOf("2026-10-09")).toBe("2026-10-09");
		expect(datePrefixOf("not-a-date")).toBeNull();
	});
});
