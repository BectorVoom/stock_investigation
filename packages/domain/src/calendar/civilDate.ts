import { err, ok, type Result } from "../result.ts";

export type CivilDateError = "INVALID_DATE" | "INVALID_DAYS";
export type ExcelSerialError = "INVALID_SERIAL";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** True only for a real calendar date in YYYY-MM-DD form. */
export function isValidIsoDate(value: string): boolean {
	const match = ISO_DATE_PATTERN.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const check = new Date(Date.UTC(year, month - 1, day));
	return (
		check.getUTCFullYear() === year &&
		check.getUTCMonth() === month - 1 &&
		check.getUTCDate() === day
	);
}

function formatIsoDate(timeMs: number): string {
	const date = new Date(timeMs);
	const year = String(date.getUTCFullYear()).padStart(4, "0");
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * `isoDate` plus `days` calendar days (UTC, ISO text only — no clock, no time
 * zones). `days` must be an integer; absurd magnitudes that leave the
 * representable date range fail instead of wrapping.
 */
export function addDaysIso(isoDate: string, days: number): Result<string, CivilDateError> {
	if (!isValidIsoDate(isoDate)) return err("INVALID_DATE");
	if (!Number.isInteger(days)) return err("INVALID_DAYS");
	const at = Date.parse(`${isoDate}T00:00:00.000Z`);
	if (!Number.isFinite(at)) return err("INVALID_DATE");
	const shifted = at + days * MS_PER_DAY;
	if (!Number.isFinite(shifted)) return err("INVALID_DAYS");
	const result = formatIsoDate(shifted);
	if (!isValidIsoDate(result)) return err("INVALID_DAYS");
	return ok(result);
}

/**
 * Excel 1900 date system serial to ISO date. Serial 1 is 1900-01-01 with
 * Excel's phantom 1900-02-29, so for every accepted serial (>= 61) the date
 * is `1899-12-30 + serial days`. Only integers 61..2958465 (1900-03-01 to
 * 9999-12-31) are accepted.
 */
export function excelSerialToIsoDate(serial: number): Result<string, ExcelSerialError> {
	if (!Number.isInteger(serial) || serial < 61 || serial > 2958465) {
		return err("INVALID_SERIAL");
	}
	const base = Date.UTC(1899, 11, 30);
	return ok(formatIsoDate(base + serial * MS_PER_DAY));
}
