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
 * The market calendar (ADR-0068, `fetchCalendar`) asks the same endpoint
 * WITHOUT a symbol: every company announcing in a window. An answer stops
 * at `finnhubRowCap` rows, so the window is walked `windowDays` at a time
 * and a capped week is asked again one day at a time; a day still capped is
 * kept and reported in `truncatedDates`. Any failed request fails the whole
 * calendar (nothing partial is stored).
 *
 * Response text is never stored, shown or logged; every failure carries only
 * the fixed wording per code.
 */
import {
	type EarningsCalendarSource,
	type EarningsMarketCalendarFailure,
	type EarningsMarketCalendarSource,
	type EarningsSourceResult,
	type EarningsSourceUnavailable,
	type SafeFetchError,
	type SafeFetcher,
	upstreamStatusOf,
} from "@research/application";
import {
	EARNINGS_CALENDAR_LIMITS,
	EARNINGS_COMPANY_NAME_MAX,
	EARNINGS_LIMITS,
	type EarningsCalendarEvent,
	type EarningsEvent,
	type EarningsUnavailableCode,
	earningsEventSchema,
	earningsUnavailable,
	stockPriceSymbolSchema,
} from "@research/contracts";
import {
	addDaysIso,
	EARNINGS_SOURCE_INFO,
	err,
	isValidIsoDate,
	ok,
	type Result,
} from "@research/domain";
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
type FinnhubCalendarRow = z.infer<typeof finnhubCalendarRowSchema>;

/**
 * A calendar row's event: its fiscal quarter names the period
 * (`2026-q3`, `Q3 2026`); a row without a whole year and a quarter 1–4 is
 * skipped (null), never the response. Finnhub states no period end.
 */
function rowEvent(row: FinnhubCalendarRow): EarningsEvent | null {
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
		return null;
	}
	const validated = earningsEventSchema.safeParse({
		periodKey: `${row.year}-q${row.quarter}`,
		announcementDate: row.date,
		fiscalPeriodLabel: `Q${row.quarter} ${row.year}`,
		fiscalPeriodEnd: null,
		timing: toTiming(row.hour ?? undefined),
	});
	return validated.success ? validated.data : null;
}

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

/** The calendar request; without `symbol` it lists every company in the window (ADR-0068). */
function calendarUrl(symbol: string | null, fromDate: string, toDate: string): string {
	const url = new URL(`https://${FINNHUB_HOST}/api/v1/calendar/earnings`);
	url.searchParams.set("from", fromDate);
	url.searchParams.set("to", toDate);
	if (symbol !== null) url.searchParams.set("symbol", symbol);
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

export function createFinnhubEarningsSource(
	deps: FinnhubEarningsDeps,
): EarningsCalendarSource & EarningsMarketCalendarSource {
	return {
		sourceId: "finnhub",
		async fetchEarnings(query) {
			const results = [];
			for (const stock of query.stocks) {
				results.push(await fetchOne(deps, stock.symbol, stock.needName, query));
			}
			return results;
		},
		fetchCalendar: (query) => fetchMarketCalendar(deps, query),
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
		const event = rowEvent(row);
		if (event !== null) events.push(event);
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

/* ---------- The market calendar (ADR-0068) ---------- */

/**
 * Finnhub's US ticker in the stock list's form: share classes are written
 * with a dot by Finnhub (`BH.A`) and with a hyphen by SEC (`BH-A`). Null
 * when the result is no stock-list symbol.
 */
export function finnhubCalendarSymbol(symbol: string): string | null {
	const mapped = symbol.trim().replaceAll(".", "-");
	return stockPriceSymbolSchema.safeParse(mapped).success ? mapped : null;
}

/** One request's dates, inclusive. */
export interface CalendarWindow {
	readonly from: string;
	readonly to: string;
}

/**
 * `[fromDate, toDate]` cut into consecutive windows of `days` days (the last
 * may be shorter), in date order: together they hold every day once.
 * Empty when the dates are not valid or `fromDate` is after `toDate`.
 */
export function calendarWindows(fromDate: string, toDate: string, days: number): CalendarWindow[] {
	if (!isValidIsoDate(fromDate) || !isValidIsoDate(toDate) || fromDate > toDate) return [];
	if (!Number.isInteger(days) || days < 1) return [];
	const windows: CalendarWindow[] = [];
	let start = fromDate;
	while (start <= toDate) {
		const end = addDaysIso(start, days - 1);
		if (!end.ok) return [];
		const to = end.value < toDate ? end.value : toDate;
		windows.push({ from: start, to });
		const next = addDaysIso(to, 1);
		if (!next.ok) return [];
		start = next.value;
	}
	return windows;
}

type CalendarFetch = Result<readonly FinnhubCalendarRow[], EarningsMarketCalendarFailure>;

function calendarFailure(error: SafeFetchError): CalendarFetch {
	const mapped = mapFinnhubStatus(upstreamStatusOf(error));
	const code =
		mapped.code === "NO_SCHEDULED_DATE" || mapped.code === "NEVER_REFRESHED"
			? "SOURCE_FAILED"
			: mapped.code;
	return err({ code, upstreamStatus: mapped.upstreamStatus });
}

async function fetchMarketCalendar(
	deps: FinnhubEarningsDeps,
	query: {
		readonly fromDate: string;
		readonly toDate: string;
		readonly signal: AbortSignal;
		readonly beforeRequest: () => Promise<boolean>;
	},
): Promise<
	Result<
		{ events: EarningsCalendarEvent[]; truncatedDates: string[] },
		EarningsMarketCalendarFailure
	>
> {
	const cap = EARNINGS_CALENDAR_LIMITS.finnhubRowCap;
	const ask = async (window: CalendarWindow): Promise<CalendarFetch> => {
		// One grant per request start (API-007); a false hook stops the walk.
		if (!(await query.beforeRequest())) return err({ code: "SOURCE_FAILED", upstreamStatus: null });
		const answer = await fetchJsonDocument(
			deps.fetcher,
			calendarUrl(null, window.from, window.to),
			fetchOptions(query.signal, deps.apiKey),
		);
		if (!answer.ok) return calendarFailure(answer.error);
		const parsed = finnhubCalendarSchema.safeParse(answer.value.json);
		if (!parsed.success) return err({ code: "SOURCE_FAILED", upstreamStatus: null });
		return ok(parsed.data.earningsCalendar);
	};
	const events: EarningsCalendarEvent[] = [];
	const seen = new Set<string>();
	const truncatedDates: string[] = [];
	const keep = (rows: readonly FinnhubCalendarRow[], window: CalendarWindow): void => {
		for (const row of rows) {
			if (!isValidIsoDate(row.date) || row.date < window.from || row.date > window.to) continue;
			const symbol =
				row.symbol === undefined || row.symbol === null ? null : finnhubCalendarSymbol(row.symbol);
			if (symbol === null) continue;
			const event = rowEvent(row);
			if (event === null) continue;
			// One row per stock and period: the first answer's wins.
			const key = `${symbol}\u0000${event.periodKey}`;
			if (seen.has(key) || events.length >= EARNINGS_CALENDAR_LIMITS.maxEvents) continue;
			seen.add(key);
			events.push({ symbol, ...event });
		}
	};
	for (const window of calendarWindows(
		query.fromDate,
		query.toDate,
		EARNINGS_CALENDAR_LIMITS.windowDays,
	)) {
		const rows = await ask(window);
		if (!rows.ok) return rows;
		if (rows.value.length < cap || window.from === window.to) {
			if (rows.value.length >= cap) truncatedDates.push(window.from);
			keep(rows.value, window);
			continue;
		}
		// The week hit the cap: ask each of its days instead.
		for (const day of calendarWindows(window.from, window.to, 1)) {
			const dayRows = await ask(day);
			if (!dayRows.ok) return dayRows;
			if (dayRows.value.length >= cap) truncatedDates.push(day.from);
			keep(dayRows.value, day);
		}
	}
	return ok({ events, truncatedDates });
}
