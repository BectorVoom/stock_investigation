/**
 * Finnhub earnings calendar, fetched by the local runner with the owner's
 * `FINNHUB_API_KEY` (FR-018). Authentication is by header, so the key never
 * enters a URL; the host is pinned to `finnhub.io` through the SafeFetcher.
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/finnhub.md
 *
 * Only the date, timing, quarter, year and symbol of a calendar row are read;
 * the estimates are parsed away and never stored or shown. An empty `hour` is
 * mapped to "unknown". An empty calendar (or no row inside the requested
 * window) is `NO_SCHEDULED_DATE`.
 *
 * When `needName` the profile resolves FIRST; a profile without a ticker is
 * `SYMBOL_NOT_FOUND` — even when the calendar has no row for the symbol.
 *
 * Response text is never stored, shown or logged; every failure carries only
 * the fixed wording per code.
 */
import {
	type EarningsCalendarSource,
	type EarningsSourceResult,
	type EarningsSourceUnavailable,
	type SafeFetchError,
	type SafeFetcher,
	upstreamStatusOf,
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
import { fetchJsonDocument } from "./marketFetch.ts";

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

function unavailable(
	code: EarningsUnavailableCode,
	upstreamStatus: number | null,
): EarningsSourceUnavailable {
	return earningsUnavailable(code, "finnhub", upstreamStatus);
}

function mapFinnhubStatus(status: number | null): EarningsSourceUnavailable {
	if (status === 401) return unavailable("SOURCE_AUTH_FAILED", status);
	if (status === 403) return unavailable("PLAN_NOT_ENTITLED", status);
	if (status === 429) return unavailable("RATE_LIMITED", status);
	return unavailable("SOURCE_FAILED", status);
}

/**
 * Narrowing constructor: the mapped statuses never carry a company name.
 * Finnhub's own status travels unchanged beside the code (§4a).
 */
function statusFailure(error: SafeFetchError): EarningsSourceResult {
	const mapped = mapFinnhubStatus(upstreamStatusOf(error));
	if (mapped.code === "NO_SCHEDULED_DATE") return err({ code: mapped.code, name: null });
	return err({ code: mapped.code, upstreamStatus: mapped.upstreamStatus });
}

/** A failure Finnhub's answer status did not cause (a stopped job, an unexpected shape). */
function ownFailure(code: "SOURCE_FAILED" | "SYMBOL_NOT_FOUND"): EarningsSourceResult {
	return err({ code, upstreamStatus: null });
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
		if (!(await query.beforeRequest())) return ownFailure("SOURCE_FAILED");
		const profile = await fetchJsonDocument(
			deps.fetcher,
			profileUrl(symbol),
			fetchOptions(query.signal, deps.apiKey),
		);
		if (!profile.ok) {
			return statusFailure(profile.error);
		}
		const parsedProfile = finnhubProfileSchema.safeParse(profile.value.json);
		if (!parsedProfile.success) return ownFailure("SOURCE_FAILED");
		if (parsedProfile.data.ticker === undefined) return ownFailure("SYMBOL_NOT_FOUND");
		const trimmed = parsedProfile.data.name?.trim() ?? "";
		// The completion contract bounds `name`: an over-long provider name
		// is dropped (null), never allowed to fail the whole refresh.
		name = trimmed === "" || trimmed.length > EARNINGS_COMPANY_NAME_MAX ? null : trimmed;
	}
	if (!(await query.beforeRequest())) return ownFailure("SOURCE_FAILED");
	const calendar = await fetchJsonDocument(
		deps.fetcher,
		calendarUrl(symbol, query.fromDate, query.toDate),
		fetchOptions(query.signal, deps.apiKey),
	);
	if (!calendar.ok) {
		return statusFailure(calendar.error);
	}
	const parsed = finnhubCalendarSchema.safeParse(calendar.value.json);
	if (!parsed.success) return ownFailure("SOURCE_FAILED");
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
	// A total order on the date: equal dates compare as 0, so the stable sort
	// keeps Finnhub's row order between them, like Rust's `sort_by`.
	events.sort((a, b) => {
		const left = a.announcementDate ?? "";
		const right = b.announcementDate ?? "";
		return left < right ? -1 : left > right ? 1 : 0;
	});
	// A successful retrieval with nothing listed: the code is recorded with
	// the name (when known), and the API clears the stock's stored events.
	if (events.length === 0) return err({ code: "NO_SCHEDULED_DATE" as const, name });
	return ok({ name, events: events.slice(0, EARNINGS_LIMITS.maxEventsPerStock) });
}
