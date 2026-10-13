import type { EarningsCalendarSource, EarningsSourceRegistry } from "@research/application";
import { err, ok } from "@research/domain";

/**
 * Fixture earnings dates for the browser E2E run: canned Finnhub/JPX answers
 * beside `fixtureMarketSources` — no keys, no network. Known symbols answer
 * dated events (labelled as fixtures in the report); anything else
 * reports the fixed unavailable wording, so the suite only ever shows
 * fixture dates. Later browser tests (watchlist.spec.ts) register these two
 * stocks and see these dates.
 *
 * The dates are offsets from the request day, not fixed strings: the
 * Watchlist page and the Home widget compare stored dates against the real
 * current date, so fixed dates would start failing once they pass. The spec
 * reads the displayed dates back instead of recomputing them, so no clock
 * coupling remains.
 */
const DAY_MS = 86_400_000;

/** A UTC date `days` from today, so fixtures stay upcoming on any day. */
function isoInDays(days: number): string {
	return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

const APPLE_OFFSET_DAYS = 16;
const TOYOTA_OFFSET_DAYS = 23;

const AAPL_EVENT_BASE = {
	periodKey: "2026-q4",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
} as const;

const TOYOTA_EVENT_BASE = {
	periodKey: "fy2027-03-31-second-quarter",
	fiscalPeriodLabel: "Second quarter",
	fiscalPeriodEnd: "2027-03-31",
	timing: "unknown",
} as const;

const finnhub: EarningsCalendarSource = {
	sourceId: "finnhub",
	fetchEarnings: (query) =>
		Promise.resolve(
			query.stocks.map((stock) =>
				stock.symbol === "AAPL"
					? ok({
							name: "Apple Inc",
							events: [{ ...AAPL_EVENT_BASE, announcementDate: isoInDays(APPLE_OFFSET_DAYS) }],
						})
					: err({ code: "SYMBOL_NOT_FOUND" as const }),
			),
		),
};

const jpx: EarningsCalendarSource = {
	sourceId: "jpx",
	fetchEarnings: (query) =>
		Promise.resolve(
			query.stocks.map((stock) =>
				stock.symbol === "7203"
					? ok({
							name: "Toyota Motor Corp.",
							events: [{ ...TOYOTA_EVENT_BASE, announcementDate: isoInDays(TOYOTA_OFFSET_DAYS) }],
						})
					: err({ code: "NO_SCHEDULED_DATE" as const, name: null }),
			),
		),
};

export function fixtureEarningsSources(): EarningsSourceRegistry {
	return new Map([
		["finnhub", finnhub],
		["jpx", jpx],
	]);
}
