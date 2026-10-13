import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDaysIso, excelSerialToIsoDate, isValidIsoDate } from "../../src/calendar/civilDate.ts";
import { expectErr, expectOk } from "../support/result.ts";
import "../support/seededProperties.ts";

describe("isValidIsoDate", () => {
	it("accepts real calendar dates only", () => {
		expect(isValidIsoDate("2026-10-13")).toBe(true);
		expect(isValidIsoDate("2024-02-29")).toBe(true);
		for (const bad of [
			"2026-13-01",
			"2026-00-10",
			"2026-02-30",
			"2023-02-29",
			"2026-10-13T00:00:00Z",
			"10/13/2026",
			"",
			"2026-1-1",
		]) {
			expect(isValidIsoDate(bad)).toBe(false);
		}
	});
});

describe("addDaysIso", () => {
	it("adds and subtracts calendar days", () => {
		expect(expectOk(addDaysIso("2026-10-13", 0))).toBe("2026-10-13");
		expect(expectOk(addDaysIso("2026-10-13", 185))).toBe("2027-04-16");
		expect(expectOk(addDaysIso("2026-10-13", -13))).toBe("2026-09-30");
		expect(expectOk(addDaysIso("2024-02-28", 1))).toBe("2024-02-29");
		expect(expectOk(addDaysIso("2023-02-28", 1))).toBe("2023-03-01");
		expect(expectOk(addDaysIso("2026-12-31", 1))).toBe("2027-01-01");
	});

	it("rejects bad inputs", () => {
		expect(expectErr(addDaysIso("2026-02-30", 1))).toBe("INVALID_DATE");
		expect(expectErr(addDaysIso("not-a-date", 1))).toBe("INVALID_DATE");
		expect(expectErr(addDaysIso("2026-10-13", 1.5))).toBe("INVALID_DAYS");
		expect(expectErr(addDaysIso("2026-10-13", Number.NaN))).toBe("INVALID_DAYS");
	});

	it("is invertible: adding n then -n returns the input", () => {
		const isoDate = fc
			.tuple(
				fc.integer({ min: 2000, max: 2030 }),
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 1, max: 28 }),
			)
			.map(
				([year, month, day]) =>
					`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
			);
		fc.assert(
			fc.property(isoDate, fc.integer({ min: -1000, max: 1000 }), (date, days) => {
				const shifted = expectOk(addDaysIso(date, days));
				expect(expectOk(addDaysIso(shifted, -days))).toBe(date);
			}),
			{ numRuns: 300 },
		);
	});
});

describe("excelSerialToIsoDate", () => {
	it("converts the SPEC worked examples", () => {
		expect(expectOk(excelSerialToIsoDate(46331))).toBe("2026-11-05");
		expect(expectOk(excelSerialToIsoDate(46477))).toBe("2027-03-31");
		expect(expectOk(excelSerialToIsoDate(46300))).toBe("2026-10-05");
		expect(expectOk(excelSerialToIsoDate(45658))).toBe("2025-01-01");
	});

	it("covers the range ends", () => {
		expect(expectOk(excelSerialToIsoDate(61))).toBe("1900-03-01");
		expect(expectOk(excelSerialToIsoDate(2958465))).toBe("9999-12-31");
	});

	it("rejects non-integers, the phantom-february zone and out-of-range serials", () => {
		for (const bad of [0, 1, 59, 60, -5, 2958466, 46331.5, Number.NaN]) {
			expect(expectErr(excelSerialToIsoDate(bad))).toBe("INVALID_SERIAL");
		}
	});

	it("agrees with addDaysIso off the 1899-12-30 epoch and is strictly increasing", () => {
		fc.assert(
			fc.property(fc.integer({ min: 61, max: 2958465 }), (serial) => {
				expect(expectOk(excelSerialToIsoDate(serial))).toBe(
					expectOk(addDaysIso("1899-12-30", serial)),
				);
			}),
			{ numRuns: 300 },
		);
		fc.assert(
			fc.property(fc.integer({ min: 61, max: 2958464 }), (serial) => {
				const lower = expectOk(excelSerialToIsoDate(serial));
				const upper = expectOk(excelSerialToIsoDate(serial + 1));
				expect(upper > lower).toBe(true);
			}),
			{ numRuns: 300 },
		);
	});
});
