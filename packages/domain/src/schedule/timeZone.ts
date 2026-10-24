import { type LocalMinute, nextLocalSlot, type TaskSchedule } from "./schedule.ts";

/**
 * Local wall-clock minutes ↔ UTC instants in an IANA time zone, through the
 * runtime's `Intl` time-zone data (the same in the Worker and Node). The
 * only part of scheduling outside the Lean model (ADR-0033); unit tests pin
 * it over fixed zones and daylight-saving transitions.
 */

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;
/** Formatters are costly to build; one per zone, bounded so stray input cannot grow it. */
const MAX_CACHED_ZONES = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	const cached = formatters.get(timeZone);
	if (cached !== undefined) return cached;
	const created = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	if (formatters.size >= MAX_CACHED_ZONES) formatters.clear();
	formatters.set(timeZone, created);
	return created;
}

/**
 * Whether the runtime knows `timeZone` as an IANA zone. A `RangeError` from
 * the constructor is the runtime's only answer to "unknown zone", so it is
 * translated into `false` here, at the one place it can occur.
 */
export function isValidTimeZone(timeZone: string): boolean {
	if (timeZone.length === 0 || timeZone.length > 64) return false;
	try {
		formatterFor(timeZone);
		return true;
	} catch (error) {
		if (error instanceof RangeError) return false;
		throw error;
	}
}

/** The local minute in `timeZone` at a UTC instant (seconds dropped). */
export function utcMsToLocalMinute(utcMs: number, timeZone: string): LocalMinute {
	const fields = new Map<string, number>();
	for (const part of formatterFor(timeZone).formatToParts(utcMs)) {
		if (part.type !== "literal") fields.set(part.type, Number(part.value));
	}
	const localAsUtcMs = Date.UTC(
		fields.get("year") ?? 1970,
		(fields.get("month") ?? 1) - 1,
		fields.get("day") ?? 1,
		fields.get("hour") ?? 0,
		fields.get("minute") ?? 0,
	);
	return Math.floor(localAsUtcMs / MS_PER_MINUTE);
}

/** Minutes the zone is ahead of UTC at a UTC instant (whole minutes; every zone in use is). */
function offsetMinutesAt(utcMs: number, timeZone: string): number {
	return utcMsToLocalMinute(utcMs, timeZone) - Math.floor(utcMs / MS_PER_MINUTE);
}

/**
 * The UTC instant of a local minute, with Temporal's `compatible`
 * disambiguation: a minute skipped by a forward jump resolves with the
 * offset before the jump (so it lands that many minutes later), and a
 * minute that occurs twice resolves to its first occurrence.
 */
export function localMinuteToUtcMs(local: LocalMinute, timeZone: string): number {
	const localAsUtcMs = local * MS_PER_MINUTE;
	const dayMs = MINUTES_PER_DAY * MS_PER_MINUTE;
	const offsetBefore = offsetMinutesAt(localAsUtcMs - dayMs, timeZone);
	const offsetAfter = offsetMinutesAt(localAsUtcMs + dayMs, timeZone);
	const candidates = [offsetBefore, offsetAfter]
		.map((offset) => (local - offset) * MS_PER_MINUTE)
		.filter((utcMs) => utcMsToLocalMinute(utcMs, timeZone) === local);
	if (candidates.length === 0) return (local - offsetBefore) * MS_PER_MINUTE;
	return Math.min(...candidates);
}

/** Enough steps for a daylight-saving overlap to move past the occurrence it already ran. */
const MAX_RESOLVE_STEPS = 4;

/**
 * The schedule's first UTC instant strictly after `afterMs` in `timeZone`,
 * or null when it has none (a `once` that passed).
 */
export function nextRunAtMs(
	schedule: TaskSchedule,
	timeZone: string,
	afterMs: number,
): number | null {
	const afterLocal = utcMsToLocalMinute(afterMs, timeZone);
	// A slot skipped by a forward jump within the last day resolves after its
	// wall-clock minute (02:30 in a 02:00→03:00 gap runs at 03:30), so it can
	// still lie ahead of `afterMs` while its wall-clock minute is behind
	// `afterLocal`. Starting the local search the jump's size earlier keeps such
	// a slot; every slot before that start resolves at or before `afterMs`.
	const offsetNow = afterLocal - Math.floor(afterMs / MS_PER_MINUTE);
	const jump = offsetNow - offsetMinutesAt(afterMs - MINUTES_PER_DAY * MS_PER_MINUTE, timeZone);
	let local = afterLocal - Math.max(0, jump);
	for (let step = 0; step < MAX_RESOLVE_STEPS; step += 1) {
		const slot = nextLocalSlot(schedule, local);
		if (slot === null) return null;
		const utcMs = localMinuteToUtcMs(slot, timeZone);
		if (utcMs > afterMs) return utcMs;
		local = slot;
	}
	return null;
}
