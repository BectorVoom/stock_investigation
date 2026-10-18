import type { EarningsCalendarSource, EarningsSourceRegistry } from "@research/application";
import { type EarningsEvent, earningsEventSchema } from "@research/contracts";
import { err, ok } from "@research/domain";
import { EARNINGS_FIXTURES } from "./fixtures.ts";

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

/** One fixture announcement, validated against the public contract. */
interface FixtureEntry {
	readonly periodKey: string;
	readonly offsetDays: number;
	readonly fiscalPeriodLabel: string;
	readonly fiscalPeriodEnd: string | null;
	readonly timing: string;
}

function fixtureEvent(entry: FixtureEntry): EarningsEvent {
	return earningsEventSchema.parse({
		periodKey: entry.periodKey,
		announcementDate: isoInDays(entry.offsetDays),
		fiscalPeriodLabel: entry.fiscalPeriodLabel,
		fiscalPeriodEnd: entry.fiscalPeriodEnd,
		timing: entry.timing,
	});
}

const [apple] = EARNINGS_FIXTURES.finnhub;
const [toyota] = EARNINGS_FIXTURES.jpx;
if (apple === undefined || toyota === undefined) {
	throw new Error("tests/e2e/fixtures/e2e-fixtures.json lacks the earnings fixtures");
}

const finnhub: EarningsCalendarSource = {
	sourceId: "finnhub",
	fetchEarnings: (query) =>
		Promise.resolve(
			query.stocks.map((stock) =>
				stock.symbol === apple.symbol
					? ok({ name: apple.name, events: [fixtureEvent(apple)] })
					: err({ code: "SYMBOL_NOT_FOUND" as const }),
			),
		),
};

const jpx: EarningsCalendarSource = {
	sourceId: "jpx",
	fetchEarnings: (query) =>
		Promise.resolve(
			query.stocks.map((stock) =>
				stock.symbol === toyota.symbol
					? ok({ name: toyota.name, events: [fixtureEvent(toyota)] })
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
