import { err, ok, type Result } from "../result.ts";
import { isoToDayNumber } from "./chartWindow.ts";

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

/** Why a change against an earlier date (one month, one year) has no value. */
export type PeriodChangeError = "NO_BASE_OBSERVATION" | "BASE_TOO_OLD" | "NON_FINITE";
export type YearChangeError = PeriodChangeError;
export type MonthChangeError = PeriodChangeError;

/**
 * How far before the mark the base may lie, in days. A year-ago base may be
 * a quarter's observation (45 days); a month-ago base must be within half a
 * month, so a weekly or semi-monthly series still has one and a quarterly
 * series has none (its previous observation is about 2 months before the
 * mark, not a month-ago value).
 */
export const YEAR_BASE_TOLERANCE_DAYS = 45;
export const MONTH_BASE_TOLERANCE_DAYS = 15;

function isoToDays(iso: string): number | null {
	// Same civil arithmetic as the chart viewer day numbers (chartWindow.ts).
	const day = isoToDayNumber(iso);
	return day.ok ? day.value : null;
}

/**
 * Newest observation against the base: the newest earlier observation (by
 * position) dated on or before the mark, the latest date `months` calendar
 * months back with the day clamped (31 March − 1 month = 28/29 February;
 * 29 February − 1 year = 28 February). Typed error when no earlier
 * observation is on or before the mark (`NO_BASE_OBSERVATION`) or the base
 * is more than `toleranceDays` before it (`BASE_TOO_OLD`). Same percent rule
 * as `latestChange`: a zero base is success with `percentChange: null`.
 * Lean model: `formal/ResearchFormal/PeriodChange.lean`.
 */
export function changeOverMonths(
	observations: readonly MarketPoint[],
	months: number,
	toleranceDays: number,
): Result<MarketChange, PeriodChangeError> {
	if (observations.length < 2) return err("NO_BASE_OBSERVATION");
	const latest = observations[observations.length - 1];
	if (latest === undefined) return err("NO_BASE_OBSERVATION");
	const mark = subtractMonths(latest.observedOn, months);
	if (mark === null) return err("NON_FINITE");
	const markDays = isoToDays(mark);
	if (markDays === null) return err("NON_FINITE");
	// ISO dates order as text, so the mark compares with the dates directly.
	let base: MarketPoint | null = null;
	for (let index = observations.length - 2; index >= 0; index -= 1) {
		const candidate = observations[index];
		if (candidate !== undefined && candidate.observedOn <= mark) {
			base = candidate;
			break;
		}
	}
	if (base === null) return err("NO_BASE_OBSERVATION");
	const baseDays = isoToDays(base.observedOn);
	if (baseDays === null) return err("NON_FINITE");
	if (markDays - baseDays > toleranceDays) return err("BASE_TOO_OLD");
	return toChange(base, latest, "NON_FINITE");
}

/** 前年比: the newest observation against the one a calendar year before it (45 days' tolerance). */
export function changeOverOneYear(
	observations: readonly MarketPoint[],
): Result<MarketChange, YearChangeError> {
	return changeOverMonths(observations, 12, YEAR_BASE_TOLERANCE_DAYS);
}

/**
 * 前月比: the newest observation against the one a calendar month before it
 * (15 days' tolerance). For a monthly series dated on the same day of each
 * month this is the previous observation, so it equals `latestChange`.
 */
export function changeOverOneMonth(
	observations: readonly MarketPoint[],
): Result<MarketChange, MonthChangeError> {
	return changeOverMonths(observations, 1, MONTH_BASE_TOLERANCE_DAYS);
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
