import { describe, expect, it } from "vitest";
import {
	buildMonthGrid,
	groupEventsByDate,
	shiftMonth,
	weekdayOf,
} from "../../src/calendar/monthGrid.ts";

describe("weekdayOf", () => {
	it("knows 1970-01-01 was a Thursday and 2026-10-13 a Tuesday", () => {
		expect(weekdayOf(1970, 1, 1)).toBe(4);
		expect(weekdayOf(2026, 10, 13)).toBe(2);
		expect(weekdayOf(2024, 2, 29)).toBe(4);
	});
});

describe("buildMonthGrid", () => {
	it("builds October 2026 with a Sunday start: 5 rows, first cell 2026-09-27", () => {
		const grid = buildMonthGrid(2026, 10, 0);
		expect(grid.ok).toBe(true);
		if (!grid.ok) return;
		expect(grid.value.year).toBe(2026);
		expect(grid.value.month).toBe(10);
		expect(grid.value.weeks).toHaveLength(5);
		for (const week of grid.value.weeks) expect(week).toHaveLength(7);
		const flat = grid.value.weeks.flat();
		expect(flat).toHaveLength(35);
		expect(flat[0]).toEqual({ date: "2026-09-27", inMonth: false });
		expect(flat[4]).toEqual({ date: "2026-10-01", inMonth: true });
		expect(flat[flat.length - 1]).toEqual({ date: "2026-10-31", inMonth: true });
		// Every day of October exactly once, in order.
		const inMonth = flat.filter((cell) => cell.inMonth).map((cell) => cell.date);
		expect(inMonth).toHaveLength(31);
		expect(inMonth[0]).toBe("2026-10-01");
		expect(inMonth[30]).toBe("2026-10-31");
		// Consecutive civil dates.
		for (let index = 1; index < flat.length; index += 1) {
			const previous = flat[index - 1]?.date ?? "";
			const current = flat[index]?.date ?? "";
			expect(current > previous).toBe(true);
		}
	});

	it("starts the first column on weekStart (Monday start: 2026-10-26 … 2026-11-01)", () => {
		const grid = buildMonthGrid(2026, 10, 1);
		expect(grid.ok).toBe(true);
		if (!grid.ok) return;
		const flat = grid.value.weeks.flat();
		expect(flat[0]).toEqual({ date: "2026-09-28", inMonth: false });
		expect(weekdayOf(2026, 9, 28)).toBe(1);
	});

	it("renders February 2024 (leap year) with 29 in-month days", () => {
		const grid = buildMonthGrid(2024, 2, 0);
		expect(grid.ok).toBe(true);
		if (!grid.ok) return;
		const inMonth = grid.value.weeks.flat().filter((cell) => cell.inMonth);
		expect(inMonth).toHaveLength(29);
		expect(inMonth[28]?.date).toBe("2024-02-29");
	});

	it("renders February 2026 over exactly 4 rows of 28 in-month days", () => {
		// 2026-02-01 is a Sunday, so with weekStart 0 the month fills 4 weeks exactly.
		const grid = buildMonthGrid(2026, 2, 0);
		expect(grid.ok).toBe(true);
		if (!grid.ok) return;
		expect(grid.value.weeks).toHaveLength(4);
		expect(grid.value.weeks.flat().filter((cell) => cell.inMonth)).toHaveLength(28);
	});

	it("renders a 6-row month (August 2026, Sunday start)", () => {
		const grid = buildMonthGrid(2026, 8, 0);
		expect(grid.ok).toBe(true);
		if (!grid.ok) return;
		expect(grid.value.weeks).toHaveLength(6);
		expect(grid.value.weeks.flat()).toHaveLength(42);
	});

	it("fails closed on out-of-range inputs", () => {
		expect(buildMonthGrid(1969, 1, 0)).toEqual({ ok: false, error: "INVALID_YEAR" });
		expect(buildMonthGrid(10000, 1, 0)).toEqual({ ok: false, error: "INVALID_YEAR" });
		expect(buildMonthGrid(2026, 0, 0)).toEqual({ ok: false, error: "INVALID_MONTH" });
		expect(buildMonthGrid(2026, 13, 0)).toEqual({ ok: false, error: "INVALID_MONTH" });
		expect(buildMonthGrid(2026, 10, 7)).toEqual({ ok: false, error: "INVALID_WEEK_START" });
		expect(buildMonthGrid(2026.5, 10, 0)).toEqual({ ok: false, error: "INVALID_YEAR" });
	});
});

describe("shiftMonth", () => {
	it("carries across years in both directions", () => {
		expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
		expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
		expect(shiftMonth(2026, 10, 0)).toEqual({ year: 2026, month: 10 });
		expect(shiftMonth(2026, 10, 3)).toEqual({ year: 2027, month: 1 });
		expect(shiftMonth(2026, 3, -14)).toEqual({ year: 2025, month: 1 });
		expect(shiftMonth(2026, 6, 24)).toEqual({ year: 2028, month: 6 });
	});
});

describe("groupEventsByDate", () => {
	const events = [
		{ stockId: "us:MSFT", symbol: "MSFT", announcementDate: "2026-11-05" },
		{ stockId: "us:AAPL", symbol: "AAPL", announcementDate: "2026-11-05" },
		{ stockId: "jp:7203", symbol: "7203", announcementDate: "2026-10-29" },
		{ stockId: "us:TSLA", symbol: "TSLA", announcementDate: null },
		{ stockId: "us:BAD", symbol: "BAD", announcementDate: "10/29/2026" },
	];

	it("groups dated events by date ascending with symbols ascending inside", () => {
		expect(groupEventsByDate(events)).toEqual([
			{
				date: "2026-10-29",
				events: [{ stockId: "jp:7203", symbol: "7203", announcementDate: "2026-10-29" }],
			},
			{
				date: "2026-11-05",
				events: [
					{ stockId: "us:AAPL", symbol: "AAPL", announcementDate: "2026-11-05" },
					{ stockId: "us:MSFT", symbol: "MSFT", announcementDate: "2026-11-05" },
				],
			},
		]);
	});

	it("drops undecided and malformed dates and returns [] for none", () => {
		expect(
			groupEventsByDate([
				{ stockId: "us:A", symbol: "A", announcementDate: null },
				{ stockId: "us:B", symbol: "B", announcementDate: "2026-02-30" },
			]),
		).toEqual([]);
		expect(groupEventsByDate([])).toEqual([]);
	});
});
