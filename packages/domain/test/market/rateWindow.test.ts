import { describe, expect, it } from "vitest";
import { rateWindowPermit } from "../../src/market/rateWindow.ts";

describe("rateWindowPermit", () => {
	it("allows when fewer than maxPerWindow grants lie in (nowMs − windowMs, nowMs]", () => {
		// Window (0, 30]: grants at 10 and 20 count, the grant at 0 does not (exclusive floor).
		expect(rateWindowPermit([0, 10, 20], 30, 3, 30)).toEqual({ allowed: true });
		expect(rateWindowPermit([], 30, 8, 60_000)).toEqual({ allowed: true });
	});

	it("denies at the ceiling and reports when the oldest grant leaves", () => {
		// Grants at 5, 10, 20 with max 3: denied; oldest leaves at 5 + 30 = 35, now 30 → wait 5.
		expect(rateWindowPermit([5, 10, 20], 30, 3, 30)).toEqual({
			allowed: false,
			retryAfterMs: 5,
		});
	});

	it("ignores future grants and grants at exactly nowMs count", () => {
		// Grant at 40 is after now 30: ignored → only 2 in window → allowed.
		expect(rateWindowPermit([10, 20, 40], 30, 3, 30)).toEqual({ allowed: true });
		// A grant stamped exactly at nowMs is inside the closed end.
		expect(rateWindowPermit([30, 30, 30], 30, 3, 30)).toEqual({
			allowed: false,
			retryAfterMs: 30,
		});
	});

	it("treats the window floor as exclusive", () => {
		// floor = 0; grant at 0 is outside, so 2 < 3 → allowed.
		expect(rateWindowPermit([0, 15, 29], 30, 3, 30)).toEqual({ allowed: true });
		// floor = 1 (now 31); grant at 1 is outside.
		expect(rateWindowPermit([1, 15, 29], 31, 3, 30)).toEqual({ allowed: true });
	});
});
