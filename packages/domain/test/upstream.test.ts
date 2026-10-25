import { describe, expect, it } from "vitest";
import {
	isUpstreamStatus,
	responseStatusForUpstream,
	upstreamStatusOrNull,
} from "../src/upstream.ts";

describe("external-service status (docs/rule/error_handling.md §4a)", () => {
	it("accepts every three-digit HTTP status and nothing else", () => {
		for (const status of [100, 200, 302, 404, 418, 429, 503, 520, 529, 599]) {
			expect(isUpstreamStatus(status)).toBe(true);
		}
		for (const value of [99, 600, 0, -404, 404.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(isUpstreamStatus(value)).toBe(false);
		}
	});

	it("keeps a parsed status unchanged and drops what is not one, never correcting it", () => {
		expect(upstreamStatusOrNull(529)).toBe(529);
		expect(upstreamStatusOrNull(418)).toBe(418);
		expect(upstreamStatusOrNull("429")).toBeNull();
		expect(upstreamStatusOrNull(4290)).toBeNull();
		expect(upstreamStatusOrNull(null)).toBeNull();
		expect(upstreamStatusOrNull(undefined)).toBeNull();
	});

	it("answers with the upstream's own error status, else the code's", () => {
		expect(responseStatusForUpstream(404, 502)).toBe(404);
		expect(responseStatusForUpstream(418, 502)).toBe(418);
		expect(responseStatusForUpstream(529, 502)).toBe(529);
		expect(responseStatusForUpstream(400, 502)).toBe(400);
		// A 1xx–3xx is not an error status line a browser would read as a failure.
		expect(responseStatusForUpstream(302, 502)).toBe(502);
		expect(responseStatusForUpstream(200, 502)).toBe(502);
		// No answer, or not a status: the code's own.
		expect(responseStatusForUpstream(null, 502)).toBe(502);
		expect(responseStatusForUpstream(undefined, 502)).toBe(502);
		expect(responseStatusForUpstream(700, 502)).toBe(502);
	});
});
