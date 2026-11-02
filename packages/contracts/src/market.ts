import {
	DASHBOARD_LIMITS,
	parseMarketSeriesId as parseSeriesId,
	WATCHLIST_LIMITS,
} from "@research/domain";
import { z } from "zod";
import { equityDecimalSchema, materialsSourceUpdatedAtSchema } from "./exactDecimal.ts";
import {
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	lastRefreshFailureSchema,
	upstreamStatusSchema,
} from "./primitives.ts";

/**
 * Bounds used everywhere a dashboard, series or refresh is handled (section 2).
 * The dashboard numbers are the domain's `DASHBOARD_LIMITS` by reference, so
 * the two can never drift; the observation bounds live here.
 */
export const MARKET_LIMITS = {
	maxWidgets: DASHBOARD_LIMITS.maxWidgets,
	maxSeries: DASHBOARD_LIMITS.maxSeries,
	maxLineChartSeries: DASHBOARD_LIMITS.maxLineChartSeries,
	maxTableSeries: DASHBOARD_LIMITS.maxTableSeries,
	/**
	 * Distinct series the pages' market widgets track: the Home dashboard's
	 * first, then those of the conversation notebooks (ADR-0021).
	 */
	maxPageTrackedSeries: 60,
	/**
	 * Bound on the distinct series of one market-refresh claim or
	 * completion. The API sends at most `maxPageTrackedSeries` (ADR-0058
	 * §2); the bound keeps the former Watchlist headroom (ADR-0058 §9.1).
	 */
	maxTrackedSeries: 60 + WATCHLIST_LIMITS.maxStocks,
	maxObservationsPerResponse: 800,
	maxStoredObservations: 1500,
	minWidgetTitle: DASHBOARD_LIMITS.minWidgetTitle,
	maxWidgetTitle: DASHBOARD_LIMITS.maxWidgetTitle,
} as const;

export const marketProviderIdSchema = z.enum(["fred", "twelve-data", "materials"]);
export type MarketProviderId = z.infer<typeof marketProviderIdSchema>;

export const marketSeriesIdSchema = z
	.string()
	.max(64)
	.refine((value) => parseMarketSeriesId(value) !== null, {
		message: "invalid market series id",
	});
export type MarketSeriesId = z.infer<typeof marketSeriesIdSchema>;

/**
 * Splits "<provider>:<symbol>" and checks the provider-specific symbol shape.
 * The pure parser lives in the domain (`parseMarketSeriesId` there returns a
 * `Result`); this re-uses it so the two never drift.
 */
export function parseMarketSeriesId(value: string): {
	readonly provider: MarketProviderId;
	readonly symbol: string;
} | null {
	const parsed = parseSeriesId(value);
	return parsed.ok ? parsed.value : null;
}

export function formatMarketSeriesId(provider: MarketProviderId, symbol: string): string {
	return `${provider}:${symbol}`;
}

export const marketRangeSchema = z.enum(["1m", "3m", "6m", "1y", "3y", "max"]);
export type MarketRange = z.infer<typeof marketRangeSchema>;

export const marketFrequencySchema = z.enum([
	"daily",
	"weekly",
	"monthly",
	"quarterly",
	"annual",
	"unknown",
]);
export type MarketFrequency = z.infer<typeof marketFrequencySchema>;

/**
 * A daily bar's open, high, low and traded volume, beside the close that is
 * the observation's value (ADR-0056): `[open, high, low, volume]`. Volume is
 * null when the provider reports none (currency and metal pairs).
 */
export const marketBarSchema = z.tuple([
	z.number().finite(),
	z.number().finite(),
	z.number().finite(),
	z.number().finite().nonnegative().nullable(),
]);
export type MarketBarTuple = z.infer<typeof marketBarSchema>;

/**
 * True when a bar is consistent with its close: low ≤ open, close ≤ high.
 * A provider bar that is not is never stored or sent — the runners keep the
 * close and drop the bar (ADR-0056).
 */
export function isConsistentBar(close: number, bar: MarketBarTuple): boolean {
	const [open, high, low] = bar;
	return low <= open && low <= close && open <= high && close <= high;
}

/**
 * Wire format is the tuple [observedOn, value] (ADR-0010: minimise payload),
 * or [observedOn, value, [open, high, low, volume]] when the provider gave
 * the day's bar (ADR-0056; `value` is then the close). Readers that unpack
 * `[observedOn, value]` keep working unchanged.
 */
export const marketObservationSchema = z
	.tuple([isoDateSchema, z.number().finite(), marketBarSchema.optional()])
	.refine(([, close, bar]) => bar === undefined || isConsistentBar(close, bar), {
		message: "a bar needs low ≤ open, close ≤ high",
	});
export type MarketObservationTuple = z.infer<typeof marketObservationSchema>;

/**
 * The stored observation a window refresh must reproduce (ADR-0044, domain
 * `HistoryRefreshRequest.anchor`): the `HISTORY_OVERLAP_OBSERVATIONS`-th
 * newest stored observation of the series.
 */
export const marketHistoryAnchorSchema = z.strictObject({
	observedOn: isoDateSchema,
	value: z.number().finite(),
});
export type MarketHistoryAnchor = z.infer<typeof marketHistoryAnchorSchema>;

/**
 * How a refresh's points are stored (ADR-0044, domain `HistoryWrite`):
 * stored rows on or after `replaceFrom` that the answer does not hold are
 * deleted, older rows are kept; a null `replaceFrom` (full fetch only)
 * replaces every stored row of the series.
 */
export const marketHistoryWriteSchema = z.discriminatedUnion("mode", [
	z.strictObject({ mode: z.literal("window"), replaceFrom: isoDateSchema }),
	z.strictObject({ mode: z.literal("full"), replaceFrom: isoDateSchema.nullable() }),
]);
export type MarketHistoryWrite = z.infer<typeof marketHistoryWriteSchema>;

export const MARKET_UNAVAILABLE_CODES = [
	"NEVER_REFRESHED",
	"SOURCE_NOT_CONFIGURED",
	"SOURCE_AUTH_FAILED",
	"SERIES_NOT_FOUND",
	"PLAN_NOT_ENTITLED",
	"RATE_LIMITED",
	"NO_DATA",
	"SOURCE_FAILED",
] as const;

export const marketUnavailableCodeSchema = z.enum(MARKET_UNAVAILABLE_CODES);
export type MarketUnavailableCode = z.infer<typeof marketUnavailableCodeSchema>;

/**
 * Fixed wording per code (provider message text is untrusted and is never
 * stored, shown or logged). `SOURCE_NOT_CONFIGURED` names the variable to set;
 * use `marketUnavailableReason` for the provider-specific variant.
 */
export const MARKET_UNAVAILABLE_REASONS: {
	readonly [C in MarketUnavailableCode]: string;
} = {
	NEVER_REFRESHED: "No data yet; it appears after the next automatic refresh.",
	SOURCE_NOT_CONFIGURED:
		"The data source is not configured; set the provider key in apps/runner/.env.",
	SOURCE_AUTH_FAILED: "The data source rejected the configured key.",
	SERIES_NOT_FOUND: "The provider has no data for this symbol on the configured plan.",
	PLAN_NOT_ENTITLED: "The provider plan does not include this symbol.",
	RATE_LIMITED: "The provider rate limit was reached; try again later.",
	NO_DATA: "The provider returned no data for this series.",
	SOURCE_FAILED: "The data source request failed.",
} as const;

/**
 * The source that answers for a series' data: the id's provider, except a
 * directory stock's price series, whose bars Massive (US) or J-Quants (JP)
 * write under the legacy `twelve-data:` id (ADR-0058 §2). Told by the
 * stored publisher, and for a Japanese listing (`:JPX`, which Twelve Data
 * never fetches any more) by the id alone.
 */
export type MarketSourceId = MarketProviderId | "massive" | "jquants";

/** `market_series.publisher` of the stock-price providers (ADR-0058 §2). */
export const STOCK_PRICE_PUBLISHERS = { massive: "Massive", jquants: "J-Quants" } as const;

export function marketSourceOf(series: {
	readonly seriesId: string;
	readonly provider: MarketProviderId;
	readonly publisher: string;
}): MarketSourceId {
	if (series.publisher === STOCK_PRICE_PUBLISHERS.massive) return "massive";
	if (series.publisher === STOCK_PRICE_PUBLISHERS.jquants) return "jquants";
	if (series.provider === "twelve-data" && series.seriesId.endsWith(":JPX")) return "jquants";
	return series.provider;
}

/** The runner variable each source's key lives in, and its name as shown. */
const SOURCE_KEYS: {
	readonly [S in MarketSourceId]: { readonly name: string; readonly key: string };
} = {
	fred: { name: "FRED", key: "FRED_API_KEY" },
	"twelve-data": { name: "Twelve Data", key: "TWELVE_DATA_API_KEY" },
	// Materials are imported, never fetched; listed so every source has an entry.
	materials: { name: "materials", key: "" },
	massive: { name: "Massive", key: "MASSIVE_API_KEY" },
	jquants: { name: "J-Quants", key: "JQUANTS_API_KEY" },
};

/** The variable that configures a source's key (empty for materials). */
export function marketSourceKey(source: MarketSourceId): {
	readonly name: string;
	readonly key: string;
} {
	return SOURCE_KEYS[source];
}

export function marketUnavailableReason(
	code: MarketUnavailableCode,
	source?: MarketSourceId,
): string {
	if (code !== "SOURCE_NOT_CONFIGURED" || source === undefined || source === "materials") {
		return MARKET_UNAVAILABLE_REASONS[code];
	}
	const { name, key } = SOURCE_KEYS[source];
	return `The ${name} source is not configured; set ${key} in apps/runner/.env.`;
}

/**
 * The stored "why there is no data" of a series. `upstreamStatus` is the
 * status the provider answered with, unchanged (docs/rule/error_handling.md
 * §4a); null when no provider answer caused it (not configured, never
 * refreshed, a timeout).
 */
export function marketUnavailable(
	code: MarketUnavailableCode,
	provider?: MarketSourceId,
	upstreamStatus: number | null = null,
): {
	readonly code: MarketUnavailableCode;
	readonly reason: string;
	readonly upstreamStatus: number | null;
} {
	return { code, reason: marketUnavailableReason(code, provider), upstreamStatus };
}

export const marketUnavailableSchema = z.strictObject({
	code: marketUnavailableCodeSchema,
	reason: z.string().min(1).max(300),
	upstreamStatus: upstreamStatusSchema.nullable(),
});
export type MarketUnavailable = z.infer<typeof marketUnavailableSchema>;

export const marketSeriesMetaSchema = z.strictObject({
	title: z.string().trim().min(1).max(200),
	unit: z.string().trim().min(1).max(80),
	frequency: marketFrequencySchema,
	publisher: z.string().trim().min(1).max(200),
	sourceUrl: httpsUrlSchema,
});
export type MarketSeriesMeta = z.infer<typeof marketSeriesMetaSchema>;

export const materialDetailsSchema = z.strictObject({
	product: z.string().max(200),
	grade: z.string().max(200),
	basis: z.string().max(200),
	sourceId: z.string().max(64),
});
export const materialPointSchema = z.strictObject({
	observedOn: isoDateSchema,
	valueDecimal: equityDecimalSchema,
	materialsSourceUpdatedAt: materialsSourceUpdatedAtSchema.nullable(),
});
export const marketSeriesSchema = z
	.strictObject({
		seriesId: marketSeriesIdSchema,
		provider: marketProviderIdSchema,
		symbol: z.string().min(1).max(32),
		title: z.string().trim().min(1).max(200),
		unit: z.string().max(80),
		frequency: marketFrequencySchema,
		publisher: z.string().max(200),
		sourceUrl: z.union([httpsUrlSchema, z.literal("")]),
		lastRefreshedAt: isoDateTimeSchema.nullable(),
		retrievedAt: isoDateTimeSchema.nullable(),
		unavailable: marketUnavailableSchema.nullable(),
		materialDetails: materialDetailsSchema.optional(),
		materialObservations: z
			.array(materialPointSchema)
			.max(MARKET_LIMITS.maxObservationsPerResponse)
			.optional(),
		observations: z.array(marketObservationSchema).max(MARKET_LIMITS.maxObservationsPerResponse),
	})
	.refine(
		(series) =>
			series.sourceUrl !== "" || (series.unavailable !== null && series.observations.length === 0),
		"only unavailable series without observations may omit their source URL",
	);
export type MarketSeries = z.infer<typeof marketSeriesSchema>;

export const earningsCalendarDaysAheadSchema = z.union([
	z.literal(30),
	z.literal(60),
	z.literal(90),
	z.literal(180),
]);
export type EarningsCalendarDaysAhead = z.infer<typeof earningsCalendarDaysAheadSchema>;

export const homeDataResponseSchema = z.strictObject({
	series: z.array(marketSeriesSchema).max(MARKET_LIMITS.maxSeries),
	refresh: z.strictObject({
		activeRunId: idSchema.nullable(),
		/**
		 * Pending/leased state of the active run; null when no run is active
		 * (V7: the status line and the polling cadence read this instead of
		 * GETting the run separately; V6: "pending" polls slow, leased polls
		 * fast — the same queued/active convention as session polling).
		 * A plain string (not jobStateSchema: jobs.ts imports this module).
		 */
		activeRunState: z.string().nullable(),
		/**
		 * Last SUCCESSFUL (completed) refresh; null when none has succeeded
		 * (S2: a failed or cancelled refresh is never presented as a success).
		 */
		lastSucceededAt: isoDateTimeSchema.nullable(),
		/**
		 * Latest terminal run that did not succeed (failed/cancelled), with
		 * its stable failure code and time; null when none (S2: Home shows
		 * "Last refresh failed (CODE) at …" beside the last success).
		 */
		lastFailure: lastRefreshFailureSchema.nullable(),
	}),
});
export type HomeDataResponse = z.infer<typeof homeDataResponseSchema>;

export const marketCatalogCategorySchema = z.enum([
	"volatility",
	"rates",
	"inflation",
	"labour",
	"growth",
	"equity-index",
	"fx",
	"commodity",
	"equity",
]);
export type MarketCatalogCategory = z.infer<typeof marketCatalogCategorySchema>;

export const marketCatalogEntrySchema = z.strictObject({
	seriesId: marketSeriesIdSchema,
	label: z.string().trim().min(1).max(120),
	category: marketCatalogCategorySchema,
	description: z.string().trim().min(1).max(300),
});
export type MarketCatalogEntry = z.infer<typeof marketCatalogEntrySchema>;

export const marketCatalogResponseSchema = z.strictObject({
	entries: z.array(marketCatalogEntrySchema),
});
export type MarketCatalogResponse = z.infer<typeof marketCatalogResponseSchema>;
