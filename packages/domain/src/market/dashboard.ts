import { err, ok, type Result } from "../result.ts";

export type DashboardWidgetSize = "small" | "medium" | "large";

/**
 * One widget on a Home dashboard. A discriminated union on `type`: each
 * variant carries exactly the fields it needs, so a missing `seriesId` or an
 * extra `range` is a type error rather than a silent mis-read.
 */
export type DashboardWidget =
	| {
			readonly type: "metric";
			readonly widgetId: string;
			readonly title: string;
			readonly size: DashboardWidgetSize;
			readonly seriesId: string;
	  }
	| {
			readonly type: "line-chart";
			readonly widgetId: string;
			readonly title: string;
			readonly size: DashboardWidgetSize;
			readonly seriesIds: readonly string[];
			readonly range: string;
	  }
	| {
			readonly type: "stock-table";
			readonly widgetId: string;
			readonly title: string;
			readonly size: DashboardWidgetSize;
			readonly seriesIds: readonly string[];
	  }
	| {
			readonly type: "indicator-table";
			readonly widgetId: string;
			readonly title: string;
			readonly size: DashboardWidgetSize;
			readonly seriesIds: readonly string[];
	  }
	| {
			/**
			 * Earnings-date calendar (FR-018): shows the watchlist's upcoming
			 * announcements within `daysAhead`. It carries no market series —
			 * every series walk treats it as zero series. The Lean `Dashboard`
			 * model abstracts widget props, so its vectors are unaffected.
			 */
			readonly type: "earnings-calendar";
			readonly widgetId: string;
			readonly title: string;
			readonly size: DashboardWidgetSize;
			readonly daysAhead: number;
	  };

/** Days-ahead choices the earnings-calendar widget offers (SPEC section 2). */
export const EARNINGS_CALENDAR_DAYS_AHEAD: readonly number[] = [30, 60, 90, 180];

/**
 * The single definition of every dashboard bound (section 2). Contracts
 * builds `MARKET_LIMITS` from this object, so the two can never drift; the
 * observation bounds live there too.
 */
export const DASHBOARD_LIMITS = {
	maxWidgets: 24,
	maxSeries: 30,
	maxLineChartSeries: 4,
	maxTableSeries: 12,
	minWidgetTitle: 1,
	maxWidgetTitle: 80,
} as const;

export interface Dashboard<W extends DashboardWidget = DashboardWidget> {
	readonly schemaVersion: 1;
	readonly widgets: readonly W[];
}

export type DashboardEdit<W extends DashboardWidget = DashboardWidget> =
	| { readonly kind: "add"; readonly widget: W }
	| { readonly kind: "remove"; readonly widgetId: string }
	| { readonly kind: "move"; readonly widgetId: string; readonly direction: "earlier" | "later" }
	| { readonly kind: "replace"; readonly widget: W }
	| { readonly kind: "reset"; readonly dashboard: Dashboard<W> };

export type DashboardEditError =
	| "DUPLICATE_WIDGET_ID"
	| "WIDGET_NOT_FOUND"
	| "MOVE_AT_END"
	| "TOO_MANY_WIDGETS"
	| "TOO_MANY_SERIES"
	| "DUPLICATE_SERIES_IN_WIDGET"
	| "INVALID_WIDGET";

function seriesOf(widget: DashboardWidget): readonly string[] {
	if (widget.type === "metric") return [widget.seriesId];
	if (widget.type === "earnings-calendar") return [];
	return widget.seriesIds;
}

/**
 * Distinct series of a dashboard, in widget order. The ONE implementation:
 * the contract refinements, the home service and the runner claim path all
 * call this instead of keeping their own copy.
 */
export function distinctDashboardSeriesIds(widgets: readonly DashboardWidget[]): string[] {
	const ids: string[] = [];
	for (const widget of widgets) {
		if (widget.type === "metric") ids.push(widget.seriesId);
		else if (widget.type !== "earnings-calendar") ids.push(...widget.seriesIds);
	}
	return [...new Set(ids)];
}

function validWidget(widget: DashboardWidget): boolean {
	if (
		widget.widgetId.length === 0 ||
		widget.title.length < DASHBOARD_LIMITS.minWidgetTitle ||
		widget.title.length > DASHBOARD_LIMITS.maxWidgetTitle
	) {
		return false;
	}
	const series = [...seriesOf(widget)];
	if (widget.type === "earnings-calendar") {
		return EARNINGS_CALENDAR_DAYS_AHEAD.includes(widget.daysAhead);
	}
	if (widget.type === "metric" && series.length !== 1) return false;
	if (
		widget.type === "line-chart" &&
		(series.length < 1 || series.length > DASHBOARD_LIMITS.maxLineChartSeries)
	) {
		return false;
	}
	if (
		(widget.type === "stock-table" || widget.type === "indicator-table") &&
		(series.length < 1 || series.length > DASHBOARD_LIMITS.maxTableSeries)
	) {
		return false;
	}
	return new Set(series).size === series.length;
}

/**
 * Pure dashboard transition. Enforces id uniqueness and the section-2 limits;
 * `move` at an end is a typed error. Never mutates its input.
 *
 * Generic over the widget type so a contracts `HomeDashboard` goes in and a
 * dashboard of the same widgets comes out — the caller can store the result
 * without a cast or a re-parse.
 */
export function applyDashboardEdit<W extends DashboardWidget>(
	dashboard: Dashboard<W>,
	edit: DashboardEdit<W>,
): Result<Dashboard<W>, DashboardEditError> {
	switch (edit.kind) {
		case "reset": {
			return ok({
				schemaVersion: 1,
				widgets: [...edit.dashboard.widgets],
			});
		}
		case "add": {
			if (!validWidget(edit.widget)) {
				const ids = [...seriesOf(edit.widget)];
				if (new Set(ids).size !== ids.length) return err("DUPLICATE_SERIES_IN_WIDGET");
				return err("INVALID_WIDGET");
			}
			if (dashboard.widgets.some((widget) => widget.widgetId === edit.widget.widgetId)) {
				return err("DUPLICATE_WIDGET_ID");
			}
			const next = [...dashboard.widgets, edit.widget];
			if (next.length > DASHBOARD_LIMITS.maxWidgets) return err("TOO_MANY_WIDGETS");
			if (distinctDashboardSeriesIds(next).length > DASHBOARD_LIMITS.maxSeries) {
				return err("TOO_MANY_SERIES");
			}
			return ok({ schemaVersion: 1, widgets: next });
		}
		case "remove": {
			const index = dashboard.widgets.findIndex((widget) => widget.widgetId === edit.widgetId);
			if (index === -1) return err("WIDGET_NOT_FOUND");
			return ok({
				schemaVersion: 1,
				widgets: dashboard.widgets.filter((widget) => widget.widgetId !== edit.widgetId),
			});
		}
		case "move": {
			const index = dashboard.widgets.findIndex((widget) => widget.widgetId === edit.widgetId);
			if (index === -1) return err("WIDGET_NOT_FOUND");
			const target = edit.direction === "earlier" ? index - 1 : index + 1;
			if (target < 0 || target >= dashboard.widgets.length) return err("MOVE_AT_END");
			const next = [...dashboard.widgets];
			const current = next[index];
			const other = next[target];
			if (current === undefined || other === undefined) return err("WIDGET_NOT_FOUND");
			next[index] = other;
			next[target] = current;
			return ok({ schemaVersion: 1, widgets: next });
		}
		case "replace": {
			if (!validWidget(edit.widget)) {
				const ids = [...seriesOf(edit.widget)];
				if (new Set(ids).size !== ids.length) return err("DUPLICATE_SERIES_IN_WIDGET");
				return err("INVALID_WIDGET");
			}
			const index = dashboard.widgets.findIndex(
				(widget) => widget.widgetId === edit.widget.widgetId,
			);
			if (index === -1) return err("WIDGET_NOT_FOUND");
			const next = dashboard.widgets.map((widget, position) =>
				position === index ? edit.widget : widget,
			);
			if (distinctDashboardSeriesIds(next).length > DASHBOARD_LIMITS.maxSeries) {
				return err("TOO_MANY_SERIES");
			}
			return ok({ schemaVersion: 1, widgets: next });
		}
	}
}
