import {
	DASHBOARD_LIMITS,
	distinctDashboardSeriesIds,
	parseMarketSeriesId as parseSeriesId,
} from "@research/domain";
import { z } from "zod";
import { httpsUrlSchema, idSchema, isoDateSchema, isoDateTimeSchema } from "./primitives.ts";

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
	 * Distinct series one market refresh fetches: the Home dashboard's first,
	 * then those of the conversation notebooks' market widgets (ADR-0021).
	 */
	maxTrackedSeries: 60,
	maxObservationsPerResponse: 800,
	maxStoredObservations: 1500,
	minWidgetTitle: DASHBOARD_LIMITS.minWidgetTitle,
	maxWidgetTitle: DASHBOARD_LIMITS.maxWidgetTitle,
} as const;

export const marketProviderIdSchema = z.enum(["fred", "twelve-data"]);
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

/** Wire format is the tuple [observedOn, value] (ADR-0010: minimise payload). */
export const marketObservationSchema = z.tuple([isoDateSchema, z.number().finite()]);
export type MarketObservationTuple = z.infer<typeof marketObservationSchema>;

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
	NEVER_REFRESHED: "No data has been refreshed yet; queue a refresh.",
	SOURCE_NOT_CONFIGURED:
		"The data source is not configured; set the provider key in apps/runner/.env.",
	SOURCE_AUTH_FAILED: "The data source rejected the configured key.",
	SERIES_NOT_FOUND: "The provider has no data for this symbol on the configured plan.",
	PLAN_NOT_ENTITLED: "The provider plan does not include this symbol.",
	RATE_LIMITED: "The provider rate limit was reached; try again later.",
	NO_DATA: "The provider returned no data for this series.",
	SOURCE_FAILED: "The data source request failed.",
} as const;

export function marketUnavailableReason(
	code: MarketUnavailableCode,
	provider?: MarketProviderId,
): string {
	if (code !== "SOURCE_NOT_CONFIGURED" || provider === undefined) {
		return MARKET_UNAVAILABLE_REASONS[code];
	}
	if (provider === "fred") {
		return "The FRED source is not configured; set FRED_API_KEY in apps/runner/.env.";
	}
	return "The Twelve Data source is not configured; set TWELVE_DATA_API_KEY in apps/runner/.env.";
}

export function marketUnavailable(
	code: MarketUnavailableCode,
	provider?: MarketProviderId,
): { readonly code: MarketUnavailableCode; readonly reason: string } {
	return { code, reason: marketUnavailableReason(code, provider) };
}

export const marketUnavailableSchema = z.strictObject({
	code: marketUnavailableCodeSchema,
	reason: z.string().min(1).max(300),
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

export const marketSeriesSchema = z.strictObject({
	seriesId: marketSeriesIdSchema,
	provider: marketProviderIdSchema,
	symbol: z.string().min(1).max(32),
	title: z.string().trim().min(1).max(200),
	unit: z.string().max(80),
	frequency: marketFrequencySchema,
	publisher: z.string().max(200),
	sourceUrl: httpsUrlSchema,
	lastRefreshedAt: isoDateTimeSchema.nullable(),
	retrievedAt: isoDateTimeSchema.nullable(),
	unavailable: marketUnavailableSchema.nullable(),
	observations: z.array(marketObservationSchema).max(MARKET_LIMITS.maxObservationsPerResponse),
});
export type MarketSeries = z.infer<typeof marketSeriesSchema>;

export const marketWidgetSizeSchema = z.enum(["small", "medium", "large"]);
export type MarketWidgetSize = z.infer<typeof marketWidgetSizeSchema>;

export const earningsCalendarDaysAheadSchema = z.union([
	z.literal(30),
	z.literal(60),
	z.literal(90),
	z.literal(180),
]);
export type EarningsCalendarDaysAhead = z.infer<typeof earningsCalendarDaysAheadSchema>;

const widgetBase = {
	widgetId: idSchema,
	title: z.string().trim().min(MARKET_LIMITS.minWidgetTitle).max(MARKET_LIMITS.maxWidgetTitle),
	size: marketWidgetSizeSchema,
};

/**
 * The type-specific fields of each Home widget type, written once: the Home
 * dashboard schema below and the Notebook's market widget types (ADR-0021)
 * are both built from these shapes, so the two can never drift.
 */
export const HOME_WIDGET_CONFIG_SHAPES = {
	metric: { seriesId: marketSeriesIdSchema },
	"line-chart": {
		seriesIds: z.array(marketSeriesIdSchema).min(1).max(MARKET_LIMITS.maxLineChartSeries),
		range: marketRangeSchema,
	},
	"stock-table": {
		seriesIds: z.array(marketSeriesIdSchema).min(1).max(MARKET_LIMITS.maxTableSeries),
	},
	"indicator-table": {
		seriesIds: z.array(marketSeriesIdSchema).min(1).max(MARKET_LIMITS.maxTableSeries),
	},
	/**
	 * Earnings-date calendar (FR-018): the watchlist's upcoming announcements
	 * within `daysAhead`. No market series — every series walk treats it as
	 * zero series. Additive: stored `schemaVersion: 1` dashboards stay valid.
	 */
	"earnings-calendar": { daysAhead: earningsCalendarDaysAheadSchema },
} as const;

export const homeWidgetSchema = z.discriminatedUnion("type", [
	z.strictObject({ ...widgetBase, type: z.literal("metric"), ...HOME_WIDGET_CONFIG_SHAPES.metric }),
	z.strictObject({
		...widgetBase,
		type: z.literal("line-chart"),
		...HOME_WIDGET_CONFIG_SHAPES["line-chart"],
	}),
	z.strictObject({
		...widgetBase,
		type: z.literal("stock-table"),
		...HOME_WIDGET_CONFIG_SHAPES["stock-table"],
	}),
	z.strictObject({
		...widgetBase,
		type: z.literal("indicator-table"),
		...HOME_WIDGET_CONFIG_SHAPES["indicator-table"],
	}),
	z.strictObject({
		...widgetBase,
		type: z.literal("earnings-calendar"),
		...HOME_WIDGET_CONFIG_SHAPES["earnings-calendar"],
	}),
]);
export type HomeWidget = z.infer<typeof homeWidgetSchema>;

/** Market series of one widget: the earnings calendar carries none. */
export function homeWidgetSeriesIds(widget: HomeWidget): readonly string[] {
	if (widget.type === "metric") return [widget.seriesId];
	if (widget.type === "earnings-calendar") return [];
	return widget.seriesIds;
}

export type HomeWidgetType = HomeWidget["type"];

export const HOME_WIDGET_TYPES: readonly HomeWidgetType[] = [
	"metric",
	"line-chart",
	"stock-table",
	"indicator-table",
	"earnings-calendar",
];

/** Every size every Home widget type may take (ADR-0019: the agent layer allows all three). */
export const HOME_WIDGET_SIZES: readonly MarketWidgetSize[] = ["small", "medium", "large"];

export interface HomeWidgetTypeMeta {
	readonly label: string;
	readonly description: string;
	readonly defaultSize: MarketWidgetSize;
	readonly sizes: readonly MarketWidgetSize[];
}

/**
 * The one table of per-type presentation facts (ADR-0019): the web widget
 * registry and the MCP agent types both read their label, description and
 * default size from here, so neither is written twice.
 */
export const HOME_WIDGET_TYPE_META: { readonly [T in HomeWidgetType]: HomeWidgetTypeMeta } = {
	metric: {
		label: "Metric",
		description: "One series: latest value, change, one-year change and a sparkline.",
		defaultSize: "small",
		sizes: HOME_WIDGET_SIZES,
	},
	"line-chart": {
		label: "Line chart",
		description: "One to four series that share one unit, over a range, with a data table.",
		defaultSize: "medium",
		sizes: HOME_WIDGET_SIZES,
	},
	"stock-table": {
		label: "Stock table",
		description: "One row per series: last close, change and as-of date.",
		defaultSize: "medium",
		sizes: HOME_WIDGET_SIZES,
	},
	"indicator-table": {
		label: "Indicator table",
		description: "One row per series: latest, unit, previous, change and one-year change.",
		defaultSize: "large",
		sizes: HOME_WIDGET_SIZES,
	},
	"earnings-calendar": {
		label: "Earnings calendar",
		description:
			"A glanceable month grid of the Watchlist page's upcoming earnings announcement dates, with a short next list; the full calendar lives on the Watchlist page.",
		defaultSize: "large",
		sizes: HOME_WIDGET_SIZES,
	},
};

export const homeDashboardSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		widgets: z.array(homeWidgetSchema).max(MARKET_LIMITS.maxWidgets).readonly(),
	})
	.refine(
		(dashboard) => {
			const ids = dashboard.widgets.map((widget) => widget.widgetId);
			return new Set(ids).size === ids.length;
		},
		{ message: "widget ids must be unique", path: ["widgets"] },
	)
	.refine(
		(dashboard) => {
			const all = distinctDashboardSeriesIds(dashboard.widgets);
			return new Set(all).size <= MARKET_LIMITS.maxSeries;
		},
		{ message: "too many distinct series", path: ["widgets"] },
	)
	.refine(
		(dashboard) =>
			dashboard.widgets.every((widget) => {
				const raw = homeWidgetSeriesIds(widget);
				return distinctDashboardSeriesIds([widget]).length === raw.length;
			}),
		{ message: "a widget must not repeat a series", path: ["widgets"] },
	);
export type HomeDashboard = z.infer<typeof homeDashboardSchema>;

export const DEFAULT_HOME_DASHBOARD: HomeDashboard = {
	schemaVersion: 1,
	widgets: [
		{ type: "metric", widgetId: "w-vix", title: "VIX", size: "small", seriesId: "fred:VIXCLS" },
		{
			type: "metric",
			widgetId: "w-gold",
			title: "Gold",
			size: "small",
			seriesId: "twelve-data:XAU/USD",
		},
		{
			type: "metric",
			widgetId: "w-dgs10",
			title: "US 10-year Treasury yield",
			size: "small",
			seriesId: "fred:DGS10",
		},
		{
			type: "metric",
			widgetId: "w-sp500",
			title: "S&P 500",
			size: "small",
			seriesId: "fred:SP500",
		},
		{
			type: "line-chart",
			widgetId: "w-vix-chart",
			title: "VIX",
			size: "medium",
			seriesIds: ["fred:VIXCLS"],
			range: "1y",
		},
		{
			type: "stock-table",
			widgetId: "w-watchlist",
			title: "Watchlist",
			size: "medium",
			seriesIds: ["twelve-data:AAPL", "twelve-data:MSFT", "twelve-data:NVDA"],
		},
		{
			type: "indicator-table",
			widgetId: "w-us-economy",
			title: "US economy",
			size: "large",
			seriesIds: [
				"fred:CPIAUCSL",
				"fred:UNRATE",
				"fred:FEDFUNDS",
				"fred:GDPC1",
				"fred:PAYEMS",
				"fred:DGS10",
				"fred:T10Y2Y",
			],
		},
	],
};

export const homeDashboardResponseSchema = z.strictObject({
	dashboard: homeDashboardSchema,
	version: z.number().int().nonnegative(),
	updatedAt: isoDateTimeSchema.nullable(),
	origin: z.enum(["saved", "defaults"]),
});
export type HomeDashboardResponse = z.infer<typeof homeDashboardResponseSchema>;

export const putHomeDashboardRequestSchema = z.strictObject({
	dashboard: homeDashboardSchema,
	expectedVersion: z.number().int().nonnegative(),
});
export type PutHomeDashboardRequest = z.infer<typeof putHomeDashboardRequestSchema>;

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
		lastFailure: z
			.strictObject({
				state: z.string(),
				code: z.string().min(1).max(80),
				at: isoDateTimeSchema,
			})
			.nullable(),
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
