/**
 * The shared Retry-After reader (`src/runtime/retryAfter.ts`), used by the model
 * providers, Google Calendar and Tavily. Runtime-neutral; it sits with the
 * Node tests because the runner is its main user. Rust twin:
 * `research_net::retry_after` (same cases).
 */
import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "../../src/runtime/retryAfter.ts";

describe("parseRetryAfterMs", () => {
	const now = Date.parse("2026-10-31T07:00:00.000Z");

	it("reads delay-seconds", () => {
		expect(parseRetryAfterMs("7", now)).toBe(7_000);
		expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
		expect(parseRetryAfterMs("3600", now)).toBe(3_600_000);
	});

	it("reads an HTTP date relative to now; a past date is no wait", () => {
		expect(parseRetryAfterMs("Sat, 31 Oct 2026 07:00:12 GMT", now)).toBe(12_000);
		expect(parseRetryAfterMs("Sat, 31 Oct 2026 06:00:00 GMT", now)).toBe(0);
	});

	it("is null when absent or unreadable", () => {
		for (const value of [null, "", "-5", "1.5", "soon", "12 s", "Sat 31 Oct 2026"]) {
			expect(parseRetryAfterMs(value, now)).toBeNull();
		}
	});
});
