import {
	formatStockId as formatDomainStockId,
	parseStockId as parseDomainStockId,
	WATCHLIST_LIMITS,
} from "@research/domain";
import { z } from "zod";
import { googleCalendarStateSchema } from "./googleCalendar.ts";
import {
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	upstreamStatusSchema,
} from "./primitives.ts";

/**
 * Bounds used everywhere a watchlist stock, earnings event list or refresh
 * window is handled (SPEC section 1). Built from the domain's
 * `WATCHLIST_LIMITS` by reference, so the two can never drift.
 */
export const EARNINGS_LIMITS = {
	maxStocks: WATCHLIST_LIMITS.maxStocks,
	maxEventsPerStock: WATCHLIST_LIMITS.maxEventsPerStock,
	horizonDays: WATCHLIST_LIMITS.horizonDays,
} as const;

export const watchMarketSchema = z.enum(["US", "JP"]);
export type WatchMarket = z.infer<typeof watchMarketSchema>;

export const watchlistStockIdSchema = z
	.string()
	.max(64)
	.refine((value) => parseStockId(value) !== null, {
		message: "invalid watchlist stock id",
	});
export type WatchlistStockId = z.infer<typeof watchlistStockIdSchema>;

/**
 * Splits "<market lowercased>:<symbol>" and checks the market-specific symbol
 * shape. The pure parser lives in the domain (`parseStockId` there returns a
 * `Result`); this re-uses it so the two never drift.
 */
export function parseStockId(value: string): {
	readonly market: WatchMarket;
	readonly symbol: string;
} | null {
	const parsed = parseDomainStockId(value);
	return parsed.ok ? parsed.value : null;
}

export function formatStockId(market: WatchMarket, symbol: string): string {
	return formatDomainStockId(market, symbol);
}

export const earningsSourceIdSchema = z.enum(["finnhub", "jpx"]);
export type EarningsSourceId = z.infer<typeof earningsSourceIdSchema>;

/**
 * Longest company name the API stores (SPEC section 1: the completion and
 * response schemas bound `name` to this). Adapters send `null` for a longer
 * name instead of failing the whole refresh.
 */
export const EARNINGS_COMPANY_NAME_MAX = 200;

export const earningsTimingSchema = z.enum([
	"before-open",
	"after-close",
	"during-session",
	"unknown",
]);
export type EarningsTiming = z.infer<typeof earningsTimingSchema>;

export const EARNINGS_UNAVAILABLE_CODES = [
	"NEVER_REFRESHED",
	"SOURCE_NOT_CONFIGURED",
	"SOURCE_AUTH_FAILED",
	"SYMBOL_NOT_FOUND",
	"PLAN_NOT_ENTITLED",
	"RATE_LIMITED",
	"NO_SCHEDULED_DATE",
	"SOURCE_FAILED",
] as const;

export const earningsUnavailableCodeSchema = z.enum(EARNINGS_UNAVAILABLE_CODES);
export type EarningsUnavailableCode = z.infer<typeof earningsUnavailableCodeSchema>;

/**
 * Fixed wording per code (provider message text is untrusted and is never
 * stored, shown or logged). `SOURCE_NOT_CONFIGURED` names the variable to
 * set for the keyed source; use `earningsUnavailableReason` for the
 * source-specific variant.
 */
export const EARNINGS_UNAVAILABLE_REASONS: {
	readonly [C in EarningsUnavailableCode]: string;
} = {
	NEVER_REFRESHED: "No earnings dates have been refreshed yet; queue a refresh.",
	SOURCE_NOT_CONFIGURED:
		"The earnings source is not configured; set the provider key in apps/runner/.env.",
	SOURCE_AUTH_FAILED: "The earnings source rejected the configured key.",
	SYMBOL_NOT_FOUND: "The earnings source has no listing for this symbol.",
	PLAN_NOT_ENTITLED: "The provider plan does not include earnings dates for this symbol.",
	RATE_LIMITED: "The provider rate limit was reached; try again later.",
	NO_SCHEDULED_DATE: "The source lists no upcoming announcement for this stock.",
	SOURCE_FAILED: "The earnings source request failed.",
} as const;

export function earningsUnavailableReason(
	code: EarningsUnavailableCode,
	sourceId?: EarningsSourceId,
): string {
	if (code !== "SOURCE_NOT_CONFIGURED" || sourceId === undefined) {
		return EARNINGS_UNAVAILABLE_REASONS[code];
	}
	if (sourceId === "finnhub") {
		return "The Finnhub source is not configured; set FINNHUB_API_KEY in apps/runner/.env.";
	}
	return "The JPX source is not configured.";
}

/** `upstreamStatus`: the provider's answer status, unchanged (docs/rule/error_handling.md §4a). */
export function earningsUnavailable(
	code: EarningsUnavailableCode,
	sourceId?: EarningsSourceId,
	upstreamStatus: number | null = null,
): {
	readonly code: EarningsUnavailableCode;
	readonly reason: string;
	readonly upstreamStatus: number | null;
} {
	return { code, reason: earningsUnavailableReason(code, sourceId), upstreamStatus };
}

export const earningsUnavailableSchema = z.strictObject({
	code: earningsUnavailableCodeSchema,
	reason: z.string().min(1).max(300),
	/** The status the provider answered with, unchanged; null when no provider answer caused it. */
	upstreamStatus: upstreamStatusSchema.nullable(),
});
export type EarningsUnavailable = z.infer<typeof earningsUnavailableSchema>;

/**
 * One scheduled earnings announcement of one stock. `periodKey` identifies
 * the fiscal period, never the announcement date, so a rescheduled
 * announcement keeps its identity (and its calendar UID).
 */
export const earningsEventSchema = z.strictObject({
	periodKey: z.string().regex(/^[a-z0-9-]{1,48}$/, "period key must match [a-z0-9-]{1,48}"),
	/** Null when the source lists the announcement with the date undecided. */
	announcementDate: isoDateSchema.nullable(),
	fiscalPeriodLabel: z.string().trim().min(1).max(80),
	fiscalPeriodEnd: isoDateSchema.nullable(),
	timing: earningsTimingSchema,
});
export type EarningsEvent = z.infer<typeof earningsEventSchema>;

/** Dated events ascending, undecided last. */
function isOrderedEvents(events: readonly EarningsEvent[]): boolean {
	const dated = events.filter((event) => event.announcementDate !== null);
	for (let index = 1; index < dated.length; index += 1) {
		const previous = dated[index - 1]?.announcementDate ?? "";
		const current = dated[index]?.announcementDate ?? "";
		if (previous > current) return false;
	}
	const firstUndecided = events.findIndex((event) => event.announcementDate === null);
	if (firstUndecided === -1) return true;
	return events.slice(firstUndecided).every((event) => event.announcementDate === null);
}

export const watchlistStockSchema = z
	.strictObject({
		stockId: watchlistStockIdSchema,
		market: watchMarketSchema,
		symbol: z.string().min(1).max(16),
		/** The provider's company name once a refresh has returned one. */
		name: z.string().trim().min(1).max(EARNINGS_COMPANY_NAME_MAX).nullable(),
		addedAt: isoDateTimeSchema,
		source: earningsSourceIdSchema,
		publisher: z.string().trim().min(1).max(200),
		sourceUrl: httpsUrlSchema,
		/** Last refresh attempt; null when never attempted. */
		lastRefreshedAt: isoDateTimeSchema.nullable(),
		/** Last successful refresh; null when none has succeeded. */
		retrievedAt: isoDateTimeSchema.nullable(),
		unavailable: earningsUnavailableSchema.nullable(),
		events: z.array(earningsEventSchema).max(EARNINGS_LIMITS.maxEventsPerStock),
	})
	.refine((stock) => stock.stockId === formatStockId(stock.market, stock.symbol), {
		message: "stockId must be the market and symbol",
		path: ["stockId"],
	})
	.refine((stock) => isOrderedEvents(stock.events), {
		message: "events must be dated ascending then undecided last",
		path: ["events"],
	});
export type WatchlistStock = z.infer<typeof watchlistStockSchema>;

/** Same shape and semantics as `homeDataResponseSchema.refresh`. */
export const watchlistRefreshSchema = z.strictObject({
	activeRunId: idSchema.nullable(),
	activeRunState: z.string().nullable(),
	lastSucceededAt: isoDateTimeSchema.nullable(),
	lastFailure: z
		.strictObject({
			state: z.string(),
			code: z.string().min(1).max(80),
			at: isoDateTimeSchema,
		})
		.nullable(),
});
export type WatchlistRefresh = z.infer<typeof watchlistRefreshSchema>;

export const watchlistFeedSchema = z.strictObject({
	enabled: z.boolean(),
	createdAt: isoDateTimeSchema.nullable(),
});
export type WatchlistFeed = z.infer<typeof watchlistFeedSchema>;

export const watchlistResponseSchema = z.strictObject({
	/** In the order the stocks were added. */
	stocks: z.array(watchlistStockSchema).max(EARNINGS_LIMITS.maxStocks),
	refresh: watchlistRefreshSchema,
	feed: watchlistFeedSchema,
	/**
	 * Google Calendar sync state (FR-019). Phase G1 is a constant
	 * disconnected placeholder (see `DISCONNECTED_GOOGLE_CALENDAR_STATE`);
	 * the next phase replaces it with repository-backed state. The watchlist
	 * ETag digest covers every field of it, so both views see changes
	 * through the poll they already run.
	 */
	googleCalendar: googleCalendarStateSchema,
});
export type WatchlistResponse = z.infer<typeof watchlistResponseSchema>;

/**
 * Strict `{ market, symbol }`. The symbol is trimmed and upper-cased before
 * validation, then checked against the market's shape via the domain parser.
 */
export const addWatchlistStockRequestSchema = z
	.strictObject({
		market: watchMarketSchema,
		symbol: z.preprocess(
			(value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
			z.string().min(1).max(16),
		),
	})
	.refine((request) => parseStockId(formatStockId(request.market, request.symbol)) !== null, {
		message: "symbol does not match the market shape",
		path: ["symbol"],
	});
export type AddWatchlistStockRequest = z.infer<typeof addWatchlistStockRequestSchema>;

/** Returned exactly once when a calendar feed token is issued or rotated. */
export const calendarFeedIssuedSchema = z.strictObject({
	token: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/, "invalid feed token"),
	path: z
		.string()
		.regex(/^\/api\/v1\/calendar-feed\/[A-Za-z0-9_-]{40,200}\/earnings\.ics$/, "invalid feed path"),
	createdAt: isoDateTimeSchema,
});
export type CalendarFeedIssued = z.infer<typeof calendarFeedIssuedSchema>;
