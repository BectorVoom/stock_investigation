import { err, ok, type Result } from "../result.ts";
import { isValidIsoDate } from "./civilDate.ts";

export type MonthGridError = "INVALID_YEAR" | "INVALID_MONTH" | "INVALID_WEEK_START";
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface MonthGridCell {
	readonly date: string;
	readonly inMonth: boolean;
}

export interface MonthGrid {
	readonly year: number;
	readonly month: number;
	readonly weekStart: WeekStart;
	/** Whole weeks (4–6 rows × 7); first column is `weekStart`. */
	readonly weeks: readonly (readonly MonthGridCell[])[];
}

/** Dated-event input for `groupEventsByDate`: dated events only enter the grid. */
export interface MonthGridEventInput {
	readonly announcementDate: string | null;
	readonly symbol: string;
}

export interface EventsByDate<Row> {
	readonly date: string;
	readonly events: readonly Row[];
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Days in a civil month (proleptic Gregorian; month 1–12). */
export function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 1:
		case 3:
		case 5:
		case 7:
		case 8:
		case 10:
		case 12:
			return 31;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		default:
			return isLeapYear(year) ? 29 : 28;
	}
}

function floorDiv(a: number, b: number): number {
	const quotient = Math.trunc(a / b);
	return a % b < 0 ? quotient - 1 : quotient;
}

/**
 * Days since 1970-01-01 (Howard Hinnant's `days_from_civil`, integer
 * arithmetic only — no `Date` objects in this module). Valid for the whole
 * 1970–9999 grid range.
 */
function daysFromCivil(year: number, month: number, day: number): number {
	const adjustedYear = month <= 2 ? year - 1 : year;
	const era = floorDiv(adjustedYear >= 0 ? adjustedYear : adjustedYear - 399, 400);
	const yearOfEra = adjustedYear - era * 400;
	const monthPrime = month > 2 ? month - 3 : month + 9;
	const dayOfYear = Math.trunc((153 * monthPrime + 2) / 5) + day - 1;
	const dayOfEra =
		yearOfEra * 365 + Math.trunc(yearOfEra / 4) - Math.trunc(yearOfEra / 100) + dayOfYear;
	return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): {
	readonly year: number;
	readonly month: number;
	readonly day: number;
} {
	const shifted = days + 719468;
	const era = floorDiv(shifted >= 0 ? shifted : shifted - 146096, 146097);
	const dayOfEra = shifted - era * 146097;
	const yearOfEra = Math.trunc(
		(dayOfEra -
			Math.trunc(dayOfEra / 1460) +
			Math.trunc(dayOfEra / 36524) -
			Math.trunc(dayOfEra / 146096)) /
			365,
	);
	const year = yearOfEra + era * 400;
	const dayOfYear =
		dayOfEra - (365 * yearOfEra + Math.trunc(yearOfEra / 4) - Math.trunc(yearOfEra / 100));
	const monthPrime = Math.trunc((5 * dayOfYear + 2) / 153);
	const day = dayOfYear - Math.trunc((153 * monthPrime + 2) / 5) + 1;
	const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
	return { year: month <= 2 ? year + 1 : year, month, day };
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function pad4(value: number): string {
	return String(value).padStart(4, "0");
}

function formatCivil(year: number, month: number, day: number): string {
	return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

/** Weekday of a civil date (0 = Sunday … 6 = Saturday); 1970-01-01 was a Thursday. */
export function weekdayOf(year: number, month: number, day: number): WeekStart {
	const days = daysFromCivil(year, month, day);
	return ((((4 + days) % 7) + 7) % 7) as WeekStart;
}

/**
 * Whole-week month grid: 4–6 rows × 7 consecutive civil dates whose first
 * column is `weekStart` and whose in-month cells are exactly days 1..n in
 * order. Years 1970–9999 (matches the stored earnings window and keeps the
 * Lean model over `Nat` day offsets).
 */
export function buildMonthGrid(
	year: number,
	month: number,
	weekStart: number,
): Result<MonthGrid, MonthGridError> {
	if (!Number.isInteger(year) || year < 1970 || year > 9999) return err("INVALID_YEAR");
	if (!Number.isInteger(month) || month < 1 || month > 12) return err("INVALID_MONTH");
	if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6)
		return err("INVALID_WEEK_START");
	const start = weekStart as WeekStart;
	const totalDays = daysInMonth(year, month);
	const firstWeekday = weekdayOf(year, month, 1);
	const leading = (firstWeekday - start + 7) % 7;
	const totalCells = Math.ceil((leading + totalDays) / 7) * 7;
	const firstVisible = daysFromCivil(year, month, 1) - leading;
	const cells: MonthGridCell[] = [];
	for (let index = 0; index < totalCells; index += 1) {
		const civil = civilFromDays(firstVisible + index);
		const date = formatCivil(civil.year, civil.month, civil.day);
		cells.push({ date, inMonth: civil.year === year && civil.month === month });
	}
	const weeks: MonthGridCell[][] = [];
	for (let row = 0; row < cells.length; row += 7) {
		weeks.push(cells.slice(row, row + 7));
	}
	return ok({ year, month, weekStart: start, weeks });
}

/**
 * Carries a month by `delta` across years (`delta` may be negative or larger
 * than 12). Preconditions: `year`/`month` valid, `delta` an integer; the
 * result is the unique civil month that far away (may leave 1970–9999 — the
 * caller re-validates through `buildMonthGrid`).
 */
export function shiftMonth(
	year: number,
	month: number,
	delta: number,
): { readonly year: number; readonly month: number } {
	const total = year * 12 + (month - 1) + Math.trunc(delta);
	const nextYear = floorDiv(total, 12);
	return { year: nextYear, month: total - nextYear * 12 + 1 };
}

/**
 * Groups dated events by `announcementDate` for the grid: one entry per date
 * ascending (ISO strings order chronologically on validated dates), each
 * group's events ordered by `symbol` ascending with input order breaking ties
 * (stable). Rows with a `null` or malformed date never enter the grid — they
 * are dropped, not guessed.
 */
export function groupEventsByDate<Row extends MonthGridEventInput>(
	events: readonly Row[],
): readonly EventsByDate<Row>[] {
	const byDate = new Map<string, { readonly row: Row; readonly index: number }[]>();
	events.forEach((row, index) => {
		const date = row.announcementDate;
		if (date === null || !isValidIsoDate(date)) return;
		const list = byDate.get(date) ?? [];
		list.push({ row, index });
		byDate.set(date, list);
	});
	const dates = [...byDate.keys()].sort();
	return dates.map((date) => {
		const list = byDate.get(date) ?? [];
		const ordered = [...list].sort((a, b) => {
			if (a.row.symbol !== b.row.symbol) return a.row.symbol < b.row.symbol ? -1 : 1;
			return a.index - b.index;
		});
		return { date, events: ordered.map((entry) => entry.row) };
	});
}
