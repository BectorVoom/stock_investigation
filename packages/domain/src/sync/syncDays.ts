/**
 * The shared day planner of the per-date syncs (ADR-0058 §2, §4): which
 * days of a window a job asks the provider for. `stock-prices-sync` plans
 * one market's trading dates with it.
 *
 * Candidate days are the weekdays (Monday–Friday) of `[oldest, newest]`,
 * by the calendar date — no time zone inside: callers pass market-local
 * dates. They are taken **newest first**, so the first request of a walk
 * gives every stock its latest data and older days fill the history.
 *
 * A day the store already has an outcome for (`known`) is left out when it
 * is final (never asked again) or when its retry time has not come
 * (`nowMs < retryAtMs`); a day absent from `known` is due. Should `known`
 * name one day twice, the day is due only when every entry for it is due
 * (the conservative reading — the store's primary key makes it moot).
 * Entries whose `day` is not a real YYYY-MM-DD date are ignored. At most
 * `max` days are returned.
 *
 * Guarantees (ADR-0058 §8: to be modelled in `formal/ResearchFormal/SyncDays.lean`
 * and replayed against this code from `formal/vectors.json`): the output is a subset of the
 * window's weekdays, strictly decreasing, holds no final day and no day
 * before its retry time, has at most `max` days, and is complete — a due
 * day is left out only when `max` newer due days were chosen.
 *
 * Cost: O(known) to index the known days, then O(window) integer steps
 * (no Date object per step); it runs at claim time.
 */
import { isoDateOfDayNumber, isoDayNumber } from "../finance/financialStatements.ts";

/** A day the store already has an outcome for. `final`: never asked again; else asked again from `retryAtMs`. */
export interface KnownSyncDay {
	readonly day: string; // YYYY-MM-DD
	readonly final: boolean;
	readonly retryAtMs: number;
}

export interface SyncDaysInput {
	readonly newest: string; // newest candidate day, inclusive (YYYY-MM-DD)
	readonly oldest: string; // oldest candidate day, inclusive
	readonly known: readonly KnownSyncDay[];
	readonly nowMs: number;
	readonly max: number; // ≥ 0
}

/** True for Monday–Friday of a day number (days since 1970-01-01, a Thursday). */
function isWeekdayNumber(dayNumber: number): boolean {
	const weekday = (((dayNumber + 4) % 7) + 7) % 7; // 0 = Sunday … 6 = Saturday
	return weekday !== 0 && weekday !== 6;
}

/** The weekdays (Mon–Fri) of [oldest, newest], newest first, without final days and without days whose retry time has not come, at most `max`. */
export function planSyncDays(input: SyncDaysInput): string[] {
	const newest = isoDayNumber(input.newest);
	const oldest = isoDayNumber(input.oldest);
	const max = Math.floor(input.max);
	if (newest === null || oldest === null || newest < oldest || !(max > 0)) return [];
	// The days a known entry keeps out of this plan.
	const blocked = new Set<number>();
	for (const entry of input.known) {
		if (!entry.final && input.nowMs >= entry.retryAtMs) continue;
		const dayNumber = isoDayNumber(entry.day);
		if (dayNumber !== null && dayNumber >= oldest && dayNumber <= newest) blocked.add(dayNumber);
	}
	const days: string[] = [];
	for (let dayNumber = newest; dayNumber >= oldest && days.length < max; dayNumber -= 1) {
		if (isWeekdayNumber(dayNumber) && !blocked.has(dayNumber)) {
			days.push(isoDateOfDayNumber(dayNumber));
		}
	}
	return days;
}
