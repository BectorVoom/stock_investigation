/**
 * Finnhub earnings calendar (https://finnhub.io), fetched by the local runner
 * with the owner's `FINNHUB_API_KEY` (FR-018).
 *
 * EXERCISED LIVE on 2026-10-13 with the owner's free-plan key (see
 * `earningsLive.test.ts` and `tests/real/watchlistReal.spec.ts`): the
 * calendar and profile shapes below, header authentication, the empty
 * calendar and `{}` profile of an unknown symbol, and HTTP 401 for an invalid
 * key were observed; `hour` can be the empty string (mapped to "unknown").
 * The 403 and 429 mappings stay documentation-derived. Finnhub's docs (read
 * 2026-10-13) describe
 *   GET /api/v1/calendar/earnings?from=<ISO>&to=<ISO>&symbol=<S>
 * answering `{ "earningsCalendar": [ { "date": "2026-10-29",
 * "epsActual": null, "epsEstimate": 1.9, "hour": "amc", "quarter": 4,
 * "revenueActual": null, "revenueEstimate": 1.0e11, "symbol": "AAPL",
 * "year": 2026 } ] }`.
 * Only `date`, `hour`, `quarter`, `year` and `symbol` are read; the estimates
 * are parsed away and never stored or shown. An empty array (or no row inside
 * the requested window) is `NO_SCHEDULED_DATE`.
 *
 * When `needName` the profile resolves FIRST:
 *   GET /api/v1/stock/profile2?symbol=<S> -> `{ "name": "Apple Inc",
 *   "ticker": "AAPL", ... }`; `{}` (no ticker) is `SYMBOL_NOT_FOUND` — even
 *   when the calendar has no row for the symbol.
 *
 * Authentication is the header `X-Finnhub-Token: <KEY>` — the key never
 * enters a URL. The host is pinned to `finnhub.io` through the SafeFetcher.
 *
 * Error mapping: HTTP 401 -> `SOURCE_AUTH_FAILED`, 403 ->
 * `PLAN_NOT_ENTITLED`, 429 -> `RATE_LIMITED`, anything else ->
 * `SOURCE_FAILED`. Response text is never stored, shown or logged; every
 * failure carries only the fixed wording per code.
 */
import type {
	EarningsCalendarSource,
	EarningsSourceResult,
	EarningsSourceUnavailable,
	SafeFetcher,
} from "@research/application";
import {
	EARNINGS_COMPANY_NAME_MAX,
	EARNINGS_LIMITS,
	type EarningsEvent,
	type EarningsUnavailableCode,
	earningsEventSchema,
	earningsUnavailable,
} from "@research/contracts";
import { EARNINGS_SOURCE_INFO, err, isValidIsoDate, ok } from "@research/domain";
import { z } from "zod";
import { fetchJsonDocument, httpStatusOf } from "./marketFetch.ts";

export const FINNHUB_HOST = "finnhub.io";
const FINNHUB_ALLOWED_HOSTS: ReadonlySet<string> = new Set([FINNHUB_HOST]);
const FINNHUB_TIMEOUT_MS = 30_000;
const FINNHUB_MAX_BYTES = 1_000_000;

export const FINNHUB_PUBLISHER = EARNINGS_SOURCE_INFO.finnhub.publisher;
export const FINNHUB_SOURCE_URL = EARNINGS_SOURCE_INFO.finnhub.sourceUrl;

export interface FinnhubEarningsDeps {
	readonly apiKey: string;
	readonly fetcher: SafeFetcher;
}

const finnhubCalendarRowSchema = z.object({
	date: z.string(),
	hour: z.string().nullish(),
	quarter: z.number().nullish(),
	year: z.number().nullish(),
	symbol: z.string().nullish(),
});

const finnhubCalendarSchema = z.object({
	earningsCalendar: z.array(finnhubCalendarRowSchema),
});

const finnhubProfileSchema = z.object({
	name: z.string().optional(),
	ticker: z.string().optional(),
});

type FinnhubTiming = EarningsEvent["timing"];

function toTiming(hour: string | undefined): FinnhubTiming {
	if (hour === "bmo") return "before-open";
	if (hour === "amc") return "after-close";
	if (hour === "dmh") return "during-session";
	return "unknown";
}

function unavailable(code: EarningsUnavailableCode): EarningsSourceUnavailable {
	return earningsUnavailable(code, "finnhub");
}

function mapFinnhubStatus(status: number | null): EarningsSourceUnavailable {
	if (status === 401) return unavailable("SOURCE_AUTH_FAILED");
	if (status === 403) return unavailable("PLAN_NOT_ENTITLED");
	if (status === 429) return unavailable("RATE_LIMITED");
	return unavailable("SOURCE_FAILED");
}

/** Narrowing constructor: the mapped statuses never carry a company name. */
function statusFailure(status: number | null): EarningsSourceResult {
	const code = mapFinnhubStatus(status).code;
	if (code === "NO_SCHEDULED_DATE") return err({ code, name: null });
	return err({ code });
}

function calendarUrl(symbol: string, fromDate: string, toDate: string): string {
	const url = new URL(`https://${FINNHUB_HOST}/api/v1/calendar/earnings`);
	url.searchParams.set("from", fromDate);
	url.searchParams.set("to", toDate);
	url.searchParams.set("symbol", symbol);
	return url.href;
}

function profileUrl(symbol: string): string {
	const url = new URL(`https://${FINNHUB_HOST}/api/v1/stock/profile2`);
	url.searchParams.set("symbol", symbol);
	return url.href;
}

function fetchOptions(signal: AbortSignal, apiKey: string) {
	return {
		maxBytes: FINNHUB_MAX_BYTES,
		timeoutMs: FINNHUB_TIMEOUT_MS,
		accept: "application/json",
		allowedHosts: FINNHUB_ALLOWED_HOSTS,
		finnhubToken: apiKey,
		signal,
	};
}

export function createFinnhubEarningsSource(deps: FinnhubEarningsDeps): EarningsCalendarSource {
	return {
		sourceId: "finnhub",
		async fetchEarnings(query) {
			const results = [];
			for (const stock of query.stocks) {
				results.push(await fetchOne(deps, stock.symbol, stock.needName, query));
			}
			return results;
		},
	};
}

async function fetchOne(
	deps: FinnhubEarningsDeps,
	symbol: string,
	needName: boolean,
	query: {
		readonly fromDate: string;
		readonly toDate: string;
		readonly signal: AbortSignal;
		readonly beforeRequest: () => Promise<boolean>;
	},
) {
	// One grant per request start, taken immediately before the request is
	// sent (API-007). A false hook ends this stock (and, as the caller
	// stops too, the batch) without sending anything further.
	let name: string | null = null;
	if (needName) {
		// The profile resolves FIRST: an unknown symbol is SYMBOL_NOT_FOUND
		// even when the calendar has no row for it (an empty calendar alone
		// must not mask it), and a listed stock without an upcoming date
		// still gets its name.
		if (!(await query.beforeRequest())) return err({ code: "SOURCE_FAILED" as const });
		const profile = await fetchJsonDocument(
			deps.fetcher,
			profileUrl(symbol),
			fetchOptions(query.signal, deps.apiKey),
		);
		if (!profile.ok) {
			return statusFailure(httpStatusOf(profile.error));
		}
		const parsedProfile = finnhubProfileSchema.safeParse(profile.value.json);
		if (!parsedProfile.success) return err({ code: "SOURCE_FAILED" as const });
		if (parsedProfile.data.ticker === undefined) return err({ code: "SYMBOL_NOT_FOUND" as const });
		const trimmed = parsedProfile.data.name?.trim() ?? "";
		// The completion contract bounds `name`: an over-long provider name
		// is dropped (null), never allowed to fail the whole refresh.
		name = trimmed === "" || trimmed.length > EARNINGS_COMPANY_NAME_MAX ? null : trimmed;
	}
	if (!(await query.beforeRequest())) return err({ code: "SOURCE_FAILED" as const });
	const calendar = await fetchJsonDocument(
		deps.fetcher,
		calendarUrl(symbol, query.fromDate, query.toDate),
		fetchOptions(query.signal, deps.apiKey),
	);
	if (!calendar.ok) {
		return statusFailure(httpStatusOf(calendar.error));
	}
	const parsed = finnhubCalendarSchema.safeParse(calendar.value.json);
	if (!parsed.success) return err({ code: "SOURCE_FAILED" as const });
	const events: EarningsEvent[] = [];
	for (const row of parsed.data.earningsCalendar) {
		if (!isValidIsoDate(row.date)) continue;
		if (row.date < query.fromDate || row.date > query.toDate) continue;
		// A row for another symbol is not this stock's announcement; a null
		// in any shaping field skips the row, never the response.
		if (row.symbol !== undefined && row.symbol !== null && row.symbol !== symbol) continue;
		if (
			row.year === undefined ||
			row.year === null ||
			row.quarter === undefined ||
			row.quarter === null ||
			!Number.isInteger(row.year) ||
			!Number.isInteger(row.quarter) ||
			row.quarter < 1 ||
			row.quarter > 4
		) {
			continue;
		}
		const candidate = {
			periodKey: `${row.year}-q${row.quarter}`,
			announcementDate: row.date,
			fiscalPeriodLabel: `Q${row.quarter} ${row.year}`,
			fiscalPeriodEnd: null,
			timing: toTiming(row.hour ?? undefined),
		};
		const validated = earningsEventSchema.safeParse(candidate);
		if (!validated.success) continue;
		events.push(validated.data);
	}
	events.sort((a, b) => ((a.announcementDate ?? "") < (b.announcementDate ?? "") ? -1 : 1));
	// A successful retrieval with nothing listed: the code is recorded with
	// the name (when known), and the API clears the stock's stored events.
	if (events.length === 0) return err({ code: "NO_SCHEDULED_DATE" as const, name });
	return ok({ name, events: events.slice(0, EARNINGS_LIMITS.maxEventsPerStock) });
}
