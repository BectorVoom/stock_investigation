import { z } from "zod";
import { MARKET_LIMITS } from "./market.ts";
import { isoDateTimeSchema } from "./primitives.ts";
import {
	distinctWidgetSeriesIds,
	type HomeWidget,
	homeWidgetSchema,
	WIDGET_LIMITS,
	widgetContentBytes,
} from "./widgets.ts";

/**
 * The Home dashboard: an ordered list of widgets of the one widget
 * specification (ADR-0024). Version 2: Home's live single-series widget is
 * `market-metric` (version 1 called it `metric`, which is now the static
 * number). Home holds at most `MARKET_LIMITS.maxWidgets` widgets (the bound
 * the Lean `Dashboard` model is proved against); series and content bytes
 * are bounded like a notebook's.
 */
export const homeDashboardSchema = z
	.strictObject({
		schemaVersion: z.literal(2),
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
		(dashboard) => distinctWidgetSeriesIds(dashboard.widgets).length <= MARKET_LIMITS.maxSeries,
		{ message: "too many distinct series", path: ["widgets"] },
	)
	.refine((dashboard) => widgetContentBytes(dashboard.widgets) <= WIDGET_LIMITS.maxContentBytes, {
		message: `the widgets hold more than ${Math.floor(WIDGET_LIMITS.maxContentBytes / 1000)} KB of content`,
		path: ["widgets"],
	});
export type HomeDashboard = z.infer<typeof homeDashboardSchema>;

export interface HomeCapacityProblem {
	readonly code: "TOO_MANY_WIDGETS" | "TOO_MANY_SERIES" | "DASHBOARD_TOO_LARGE";
	readonly message: string;
}

/**
 * Why `next` cannot be stored on Home, or null: the same three bounds a
 * notebook has (`notebookCapacityProblem`), with Home's widget count. The
 * client refuses at once with the reason; the server's schema enforces the
 * same bounds.
 */
export function homeCapacityProblem(next: readonly HomeWidget[]): HomeCapacityProblem | null {
	if (next.length > MARKET_LIMITS.maxWidgets) {
		return {
			code: "TOO_MANY_WIDGETS",
			message: `The dashboard holds at most ${MARKET_LIMITS.maxWidgets} widgets. Remove one before adding another.`,
		};
	}
	if (distinctWidgetSeriesIds(next).length > MARKET_LIMITS.maxSeries) {
		return {
			code: "TOO_MANY_SERIES",
			message: `The dashboard's market widgets name at most ${MARKET_LIMITS.maxSeries} distinct series. Remove a series before adding another.`,
		};
	}
	if (widgetContentBytes(next) > WIDGET_LIMITS.maxContentBytes) {
		return {
			code: "DASHBOARD_TOO_LARGE",
			message: `The dashboard holds at most ${Math.floor(WIDGET_LIMITS.maxContentBytes / 1000)} KB of widget content. Remove a widget or shorten a large table, chart or text first.`,
		};
	}
	return null;
}

/**
 * A version-1 document as version 2: its `metric` widgets (then the live
 * single-series widget) become `market-metric`; everything else is already
 * valid. Anything that is not a version-1 dashboard passes through
 * unchanged, so the version-2 schema decides.
 */
function upgradeHomeDashboard(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const document: Readonly<Record<string, unknown>> = { ...raw };
	if (document.schemaVersion !== 1 || !Array.isArray(document.widgets)) return raw;
	const widgets: unknown[] = document.widgets;
	return {
		...document,
		schemaVersion: 2,
		widgets: widgets.map((widget) =>
			typeof widget === "object" && widget !== null && "type" in widget && widget.type === "metric"
				? { ...widget, type: "market-metric" }
				: widget,
		),
	};
}

/**
 * How a stored dashboard is read: version 2 as is, version 1 upgraded on
 * read (no migration runs; the next save writes version 2). The API accepts
 * only version 2 (`putHomeDashboardRequestSchema`).
 */
export const storedHomeDashboardSchema = z.preprocess(upgradeHomeDashboard, homeDashboardSchema);

const DEFAULT_WIDGETS: readonly HomeWidget[] = [
	{
		type: "market-metric",
		widgetId: "w-vix",
		title: "VIX",
		size: "small",
		seriesId: "fred:VIXCLS",
	},
	{
		type: "market-metric",
		widgetId: "w-gold",
		title: "Gold",
		size: "small",
		seriesId: "twelve-data:XAU/USD",
	},
	{
		type: "market-metric",
		widgetId: "w-dgs10",
		title: "US 10-year Treasury yield",
		size: "small",
		seriesId: "fred:DGS10",
	},
	{
		type: "market-metric",
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
];

export const DEFAULT_HOME_DASHBOARD: HomeDashboard = {
	schemaVersion: 2,
	widgets: DEFAULT_WIDGETS,
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
