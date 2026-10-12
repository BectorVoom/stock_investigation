import { describe, expect, it } from "vitest";
import { err, ok } from "../src/result.ts";
import { epochMsToIso, isoToEpochMs } from "../src/time.ts";
import { deepFreeze } from "./support/deepFreeze.ts";

describe("Result constructors", () => {
	it("tags success and failure distinctly", () => {
		expect(ok(3)).toEqual({ ok: true, value: 3 });
		expect(err("NOPE")).toEqual({ ok: false, error: "NOPE" });
	});

	it("keeps falsy payloads instead of confusing them with absence", () => {
		expect(ok(0)).toEqual({ ok: true, value: 0 });
		expect(ok(null)).toEqual({ ok: true, value: null });
		expect(err("")).toEqual({ ok: false, error: "" });
	});
});

describe("time conversion", () => {
	// 2026-10-11T00:00:00Z: 20_737 days after the epoch (56 years incl. 14 leap days = 20_454
	// days to 2026-01-01, plus 283 days Jan..Oct 10) x 86_400_000 ms = 1_791_676_800_000.
	const MIDNIGHT_UTC_MS = 1_791_676_800_000;

	it("converts an ISO instant to epoch milliseconds", () => {
		expect(isoToEpochMs("2026-10-11T00:00:00Z")).toBe(MIDNIGHT_UTC_MS);
		expect(isoToEpochMs("1970-01-01T00:00:00.000Z")).toBe(0);
	});

	it("honours explicit UTC offsets", () => {
		// 09:00 at +09:00 is midnight UTC.
		expect(isoToEpochMs("2026-10-11T09:00:00+09:00")).toBe(MIDNIGHT_UTC_MS);
	});

	it("returns null rather than NaN for text that is not an instant", () => {
		expect(isoToEpochMs("not a date")).toBeNull();
		expect(isoToEpochMs("")).toBeNull();
		expect(isoToEpochMs("2026-13-45T99:99:99Z")).toBeNull();
	});

	it("formats epoch milliseconds as a UTC ISO instant", () => {
		expect(epochMsToIso(MIDNIGHT_UTC_MS)).toBe("2026-10-11T00:00:00.000Z");
		expect(epochMsToIso(0)).toBe("1970-01-01T00:00:00.000Z");
	});
});

describe("deepFreeze test helper", () => {
	it("makes nested mutation throw, so mutation tests cannot pass vacuously", () => {
		const frozen = deepFreeze({ list: [{ n: 1 }] });
		expect(() => {
			frozen.list.push({ n: 2 });
		}).toThrow(TypeError);
		expect(() => {
			const first = frozen.list[0];
			if (first !== undefined) first.n = 5;
		}).toThrow(TypeError);
	});
});
