import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { selectUpcomingEarnings } from "../../src/calendar/upcoming.ts";
import "../support/seededProperties.ts";

interface TestRow {
	readonly stockId: string;
	readonly announcementDate: string | null;
}

const ROWS: readonly TestRow[] = [
	{ stockId: "us:AAPL", announcementDate: "2026-10-29" },
	{ stockId: "jp:7203", announcementDate: "2026-11-05" },
	{ stockId: "us:MSFT", announcementDate: "2026-10-29" },
	{ stockId: "jp:6758", announcementDate: null },
	{ stockId: "us:OLD", announcementDate: "2026-10-01" },
	{ stockId: "us:FAR", announcementDate: "2027-06-01" },
	{ stockId: "us:BAD", announcementDate: "2026-02-30" },
];

describe("selectUpcomingEarnings", () => {
	it("keeps the window inclusive, sorted by date then stockId", () => {
		expect(selectUpcomingEarnings(ROWS, "2026-10-13", 30, 10)).toEqual([
			{ stockId: "us:AAPL", announcementDate: "2026-10-29" },
			{ stockId: "us:MSFT", announcementDate: "2026-10-29" },
			{ stockId: "jp:7203", announcementDate: "2026-11-05" },
		]);
	});

	it("includes both window edges", () => {
		const rows: readonly TestRow[] = [
			{ stockId: "us:A", announcementDate: "2026-10-13" },
			{ stockId: "us:B", announcementDate: "2026-11-12" },
		];
		expect(selectUpcomingEarnings(rows, "2026-10-13", 30, 10)).toEqual(rows);
	});

	it("caps at maxItems after sorting", () => {
		const selected = selectUpcomingEarnings(ROWS, "2026-10-13", 30, 2);
		expect(selected).toEqual([
			{ stockId: "us:AAPL", announcementDate: "2026-10-29" },
			{ stockId: "us:MSFT", announcementDate: "2026-10-29" },
		]);
	});

	it("fails closed on invalid arguments", () => {
		expect(selectUpcomingEarnings(ROWS, "not-a-date", 30, 10)).toEqual([]);
		expect(selectUpcomingEarnings(ROWS, "2026-10-13", -1, 10)).toEqual([]);
		expect(selectUpcomingEarnings(ROWS, "2026-10-13", 30, -1)).toEqual([]);
		expect(selectUpcomingEarnings(ROWS, "2026-10-13", 1.5, 10)).toEqual([]);
	});

	it("never invents dates: undecided and malformed rows are dropped", () => {
		const rows: readonly TestRow[] = [
			{ stockId: "jp:7203", announcementDate: null },
			{ stockId: "us:BAD", announcementDate: "2026-02-30" },
		];
		expect(selectUpcomingEarnings(rows, "2026-10-13", 185, 10)).toEqual([]);
	});

	it("holds the window, order and cap invariants on generated rows", () => {
		const isoDate = fc
			.tuple(
				fc.integer({ min: 2026, max: 2027 }),
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 1, max: 28 }),
			)
			.map(
				([year, month, day]) =>
					`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
			);
		const row = fc.record({
			stockId: fc.constantFrom("us:AAPL", "us:MSFT", "jp:7203", "jp:6758"),
			announcementDate: fc.oneof(fc.constant(null), isoDate),
		});
		fc.assert(
			fc.property(
				fc.array(row, { maxLength: 30 }),
				fc.integer({ min: 0, max: 185 }),
				fc.integer({ min: 0, max: 20 }),
				(rows, daysAhead, maxItems) => {
					const today = "2026-10-13";
					const selected = selectUpcomingEarnings(rows, today, daysAhead, maxItems);
					expect(selected.length).toBeLessThanOrEqual(maxItems);
					const end = new Date(Date.parse(`${today}T00:00:00.000Z`) + daysAhead * 86_400_000)
						.toISOString()
						.slice(0, 10);
					for (const entry of selected) {
						expect(entry.announcementDate).not.toBeNull();
						const date = entry.announcementDate ?? "";
						expect(date >= today && date <= end).toBe(true);
					}
					const keys = selected.map((entry) => `${entry.announcementDate ?? ""} ${entry.stockId}`);
					expect([...keys].sort()).toEqual(keys);
				},
			),
			{ numRuns: 300 },
		);
	});
});
