import type {
	EarningsEvent,
	EarningsUnavailableCode,
	StockEarningsCalendarView,
	WatchlistStock,
} from "@research/contracts";

/**
 * The Financial statements tab's next earnings announcement (ADR-0067,
 * ADR-0068): a pure derivation over what the page already read — the
 * stock's Watchlist entry (dates fetched per stock for the Watchlist) and
 * its market's stored earnings calendar from the profile read (every listed
 * stock). Both lists come ordered dated ascending, then undecided, so the
 * next one is the first dated on or after today, else the first undecided.
 * A stored date before today is past and never shown as next. The
 * Watchlist's answer comes first; the market calendar fills in for any
 * other stock, and for a Watchlist stock whose own fetch has no date.
 */

/** Where a shown date comes from (Finnhub or JPX). */
export interface EarningsSourceLink {
	readonly publisher: string;
	readonly sourceUrl: string;
}

export type NextEarnings =
	| {
			readonly kind: "scheduled";
			readonly event: EarningsEvent;
			/** The announcement date, validated as `YYYY-MM-DD`. */
			readonly date: string;
			/** Whole days from today to the announcement; 0 is today. */
			readonly daysUntil: number;
			readonly source: EarningsSourceLink;
	  }
	/** The source lists the next period's announcement without a date yet. */
	| {
			readonly kind: "undecided";
			readonly event: EarningsEvent;
			readonly source: EarningsSourceLink;
	  }
	/** The Watchlist has no date and the market calendar is still being read. */
	| { readonly kind: "loading" }
	/** Neither the stock's Watchlist entry nor its market calendar was fetched yet. */
	| { readonly kind: "not-fetched" }
	/** Fetched, and the source lists no upcoming announcement. */
	| { readonly kind: "none"; readonly source: EarningsSourceLink }
	/** The Watchlist fetch failed, no calendar is stored, and no upcoming date is. */
	| { readonly kind: "unavailable"; readonly code: EarningsFailureCode };

/** A fetch failure that leaves a stock without dates (not "never fetched", not "none scheduled"). */
export type EarningsFailureCode = Exclude<
	EarningsUnavailableCode,
	"NEVER_REFRESHED" | "NO_SCHEDULED_DATE"
>;

const DAY_MS = 86_400_000;

/**
 * `calendar` is the profile read's `earningsCalendar`: undefined while the
 * profile is being read, null when the market's calendar was never stored.
 */
export function nextEarnings(
	watch: WatchlistStock | null,
	calendar: StockEarningsCalendarView | null | undefined,
	today: string,
): NextEarnings {
	if (watch !== null) {
		const found = upcoming(watch.events, today, watch);
		if (found !== null) return found;
	}
	if (calendar === undefined) return { kind: "loading" };
	if (calendar !== null) {
		const found = upcoming(calendar.events, today, calendar);
		if (found !== null) return found;
		// The market's whole calendar lists nothing upcoming for the stock.
		return { kind: "none", source: link(calendar) };
	}
	if (watch === null) return { kind: "not-fetched" };
	const code = watch.unavailable?.code ?? null;
	if (code === "NEVER_REFRESHED") return { kind: "not-fetched" };
	if (code !== null && code !== "NO_SCHEDULED_DATE") return { kind: "unavailable", code };
	return watch.retrievedAt === null
		? { kind: "not-fetched" }
		: { kind: "none", source: link(watch) };
}

function link(source: EarningsSourceLink): EarningsSourceLink {
	return { publisher: source.publisher, sourceUrl: source.sourceUrl };
}

/** The first dated event on or after today, else the first undecided one; null when neither. */
function upcoming(
	events: readonly EarningsEvent[],
	today: string,
	source: EarningsSourceLink,
): NextEarnings | null {
	const todayMs = isoDateMs(today);
	if (todayMs !== null) {
		for (const event of events) {
			const date = event.announcementDate;
			if (date === null || date < today) continue;
			const dateMs = isoDateMs(date);
			if (dateMs === null) continue;
			return {
				kind: "scheduled",
				event,
				date,
				daysUntil: Math.round((dateMs - todayMs) / DAY_MS),
				source: link(source),
			};
		}
	}
	const undecided = events.find((event) => event.announcementDate === null);
	return undecided === undefined
		? null
		: { kind: "undecided", event: undecided, source: link(source) };
}

/** Midnight UTC of a `YYYY-MM-DD` date, or null when it is not one. */
function isoDateMs(date: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const ms = Date.parse(`${date}T00:00:00.000Z`);
	return Number.isNaN(ms) ? null : ms;
}

/** The weekday of a `YYYY-MM-DD` date, 0 = Sunday. */
export function isoWeekday(date: string): number {
	return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}
