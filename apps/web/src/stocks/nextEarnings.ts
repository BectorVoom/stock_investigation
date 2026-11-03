import type { EarningsEvent, EarningsUnavailableCode, WatchlistStock } from "@research/contracts";

/**
 * The Financial statements tab's next earnings announcement (ADR-0067): a
 * pure derivation over the stock's Watchlist entry — the server syncs
 * earnings dates for Watchlist stocks only (ADR-0051, ADR-0054). The
 * contract orders a stock's events dated ascending, then undecided, so the
 * next one is the first dated on or after today, else the first undecided.
 * A stored date before today is past and never shown as next.
 */
export type NextEarnings =
	/** The stock is not on the Watchlist: no earnings dates are synced for it. */
	| { readonly kind: "not-watched" }
	| {
			readonly kind: "scheduled";
			readonly event: EarningsEvent;
			/** The announcement date, validated as `YYYY-MM-DD`. */
			readonly date: string;
			/** Whole days from today to the announcement; 0 is today. */
			readonly daysUntil: number;
	  }
	/** The source lists the next period's announcement without a date yet. */
	| { readonly kind: "undecided"; readonly event: EarningsEvent }
	/** The server has not fetched this stock's dates yet. */
	| { readonly kind: "not-fetched" }
	/** Fetched, and the source lists no upcoming announcement. */
	| { readonly kind: "none" }
	/** The last fetch failed and no upcoming date is stored. */
	| { readonly kind: "unavailable"; readonly code: EarningsFailureCode };

/** A fetch failure that leaves a stock without dates (not "never fetched", not "none scheduled"). */
export type EarningsFailureCode = Exclude<
	EarningsUnavailableCode,
	"NEVER_REFRESHED" | "NO_SCHEDULED_DATE"
>;

const DAY_MS = 86_400_000;

export function nextEarnings(stock: WatchlistStock | null, today: string): NextEarnings {
	if (stock === null) return { kind: "not-watched" };
	const todayMs = isoDateMs(today);
	if (todayMs !== null) {
		for (const event of stock.events) {
			const date = event.announcementDate;
			if (date === null || date < today) continue;
			const dateMs = isoDateMs(date);
			if (dateMs === null) continue;
			return { kind: "scheduled", event, date, daysUntil: Math.round((dateMs - todayMs) / DAY_MS) };
		}
	}
	const undecided = stock.events.find((event) => event.announcementDate === null);
	if (undecided !== undefined) return { kind: "undecided", event: undecided };
	const code = stock.unavailable?.code ?? null;
	if (code === "NEVER_REFRESHED") return { kind: "not-fetched" };
	if (code !== null && code !== "NO_SCHEDULED_DATE") return { kind: "unavailable", code };
	return stock.retrievedAt === null ? { kind: "not-fetched" } : { kind: "none" };
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
