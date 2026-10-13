import { err, ok, type Result } from "../result.ts";

export interface MarketPoint {
	readonly observedOn: string;
	readonly value: number;
}

export type ChangeError = "NOT_ENOUGH_OBSERVATIONS" | "NON_FINITE";

export interface MarketChange {
	readonly previous: MarketPoint;
	readonly latest: MarketPoint;
	readonly absoluteChange: number;
	/** Null when the base is zero (a percent of zero is undefined, never 0 or infinity). */
	readonly percentChange: number | null;
}

function toChange<E>(
	previous: MarketPoint,
	latest: MarketPoint,
	nonFinite: E,
): Result<MarketChange, E> {
	if (!Number.isFinite(previous.value) || !Number.isFinite(latest.value)) {
		return err(nonFinite);
	}
	const absoluteChange = latest.value - previous.value;
	if (!Number.isFinite(absoluteChange)) return err(nonFinite);
	if (previous.value === 0) {
		return ok({ previous, latest, absoluteChange, percentChange: null });
	}
	const percentChange = (absoluteChange / Math.abs(previous.value)) * 100;
	if (!Number.isFinite(percentChange)) return err(nonFinite);
	return ok({ previous, latest, absoluteChange, percentChange });
}

/**
 * Change of the newest observation against the one before it. Percent change
 * is (latest − previous) / |previous| × 100; a zero base is success with
 * `percentChange: null` (a percent of zero is undefined, never 0, infinity
 * or an error). Requires finite inputs and at least 2 observations.
 */
export function latestChange(
	observations: readonly MarketPoint[],
): Result<MarketChange, ChangeError> {
	if (observations.length < 2) return err("NOT_ENOUGH_OBSERVATIONS");
	const previous = observations[observations.length - 2];
	const latest = observations[observations.length - 1];
	if (previous === undefined || latest === undefined) return err("NOT_ENOUGH_OBSERVATIONS");
	return toChange(previous, latest, "NON_FINITE");
}

export type YearChangeError = "NO_BASE_OBSERVATION" | "BASE_TOO_OLD" | "NON_FINITE";

function isoToDays(iso: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
	const ms = Date.UTC(year, month - 1, day);
	const check = new Date(ms);
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day
	) {
		return null;
	}
	return Math.floor(ms / 86_400_000);
}

function subtractOneYear(iso: string): string | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	// Clamp Feb 29 to Feb 28 when the target year is not a leap year.
	const daysInTargetMonth = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
	const clampedDay = Math.min(day, daysInTargetMonth);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${year - 1}-${pad(month)}-${pad(clampedDay)}`;
}

/**
 * Newest observation against the newest observation dated on or before
 * (latest date − 1 calendar year). Typed error when that base does not exist
 * or is more than 45 days older than the 1-year mark. Same percent rule as
 * `latestChange`: a zero base is success with `percentChange: null`, never an
 * error code.
 */
export function changeOverOneYear(
	observations: readonly MarketPoint[],
): Result<MarketChange, YearChangeError> {
	if (observations.length < 2) return err("NO_BASE_OBSERVATION");
	const latest = observations[observations.length - 1];
	if (latest === undefined) return err("NO_BASE_OBSERVATION");
	const mark = subtractOneYear(latest.observedOn);
	if (mark === null) return err("NON_FINITE");
	const markDays = isoToDays(mark);
	if (markDays === null) return err("NON_FINITE");
	let base: MarketPoint | null = null;
	for (let index = observations.length - 2; index >= 0; index -= 1) {
		const candidate = observations[index];
		if (candidate !== undefined && candidate.observedOn <= latest.observedOn) {
			if (candidate.observedOn <= mark) {
				base = candidate;
				break;
			}
		}
	}
	// Fallback: newest observation strictly before latest when none is on/before the mark
	// is still "no base" unless within tolerance — spec requires base on or before the mark.
	if (base === null) return err("NO_BASE_OBSERVATION");
	const baseDays = isoToDays(base.observedOn);
	if (baseDays === null) return err("NON_FINITE");
	if (markDays - baseDays > 45) return err("BASE_TOO_OLD");
	return toChange(base, latest, "NON_FINITE");
}

export type MarketRange = "1m" | "3m" | "6m" | "1y" | "3y" | "max";

function subtractMonths(iso: string, months: number): string | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const totalMonths = year * 12 + (month - 1) - months;
	const targetYear = Math.floor(totalMonths / 12);
	const targetMonth = (totalMonths % 12) + 1;
	const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
	const clampedDay = Math.min(day, daysInTargetMonth);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${targetYear}-${pad(targetMonth)}-${pad(clampedDay)}`;
}

/**
 * Suffix whose dates fall in the range counted back from the newest
 * observation's date (`max` = all). Calendar arithmetic on ISO dates only —
 * no `Date.now()`, no time zones.
 */
export function selectRange(
	observations: readonly MarketPoint[],
	range: MarketRange,
): readonly MarketPoint[] {
	if (observations.length === 0 || range === "max") return observations;
	const latest = observations[observations.length - 1];
	if (latest === undefined) return observations;
	const months =
		range === "1m" ? 1 : range === "3m" ? 3 : range === "6m" ? 6 : range === "1y" ? 12 : 36;
	const cutoff = subtractMonths(latest.observedOn, months);
	if (cutoff === null) return observations;
	return observations.filter((point) => point.observedOn >= cutoff);
}
