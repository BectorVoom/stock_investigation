import type { HomeWidget, MarketSeries, WatchlistResponse } from "@research/contracts";
import { type Accessor, type Component, type JSX, Show } from "solid-js";
import { EarningsCalendarWidget } from "./widgets/EarningsCalendarWidget.tsx";
import { IndicatorTableWidget } from "./widgets/IndicatorTableWidget.tsx";
import { LineChartWidget } from "./widgets/LineChartWidget.tsx";
import { MetricWidget } from "./widgets/MetricWidget.tsx";
import { StockTableWidget } from "./widgets/StockTableWidget.tsx";

export type HomeWidgetType = HomeWidget["type"];

export const HOME_WIDGET_TYPES: readonly HomeWidgetType[] = [
	"metric",
	"line-chart",
	"stock-table",
	"indicator-table",
	"earnings-calendar",
];

import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";

export interface WidgetRendererProps {
	readonly widget: HomeWidget;
	/**
	 * The dashboard's series as an accessor, never a snapshot: HomeView
	 * passes its `byId` memo itself, so every widget reads live data through
	 * `createMemo`/accessors and stays reactive across refreshes without its
	 * `<article>` being torn down.
	 */
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
	/**
	 * The watchlist as an accessor (same live pattern as `seriesById`):
	 * HomeView loads it only when the dashboard holds at least one
	 * earnings-calendar widget. Null until loaded; widgets without calendar
	 * content ignore it.
	 */
	readonly watchlist: Accessor<WatchlistResponse | null>;
	/** Watchlist load failure for the earnings calendar (other widgets ignore it). */
	readonly watchlistError: Accessor<ApiFailure | null>;
	/** Retries the watchlist load (the calendar widget's "Try again"). */
	readonly onRetryWatchlist: () => void;
	/** Queues an earnings-date refresh (the calendar widget's refresh button). */
	readonly onRefreshEarnings: () => void;
	/** True while an earnings-date refresh queue request is in flight. */
	readonly earningsRefreshBusy: Accessor<boolean>;
	/** Typed access to the backend (the calendar widget downloads the .ics through it). */
	readonly api: ApiClient;
	/** Line-chart range changes save the widget; other widgets ignore it. */
	readonly onSaveRange: (widget: HomeWidget) => void;
	/**
	 * V8: true while HomeView is saving. The line-chart range select is
	 * disabled so the control always reflects the server copy; other widgets
	 * ignore it (their menus are disabled by the frame).
	 */
	readonly disabled: boolean;
}

/**
 * One entry per widget type: label, description, default config, editor
 * fields and component. Adding a type is one entry here plus its component —
 * the dialog, frame grid and HomeView all read from this table. HomeView
 * renders the entry's component with `<Dynamic>`, passing the widget and the
 * live series accessor as props.
 */
export interface WidgetTypeInfo {
	readonly type: HomeWidgetType;
	readonly label: string;
	readonly description: string;
	readonly defaultSize: HomeWidget["size"];
	readonly minSeries: number;
	readonly maxSeries: number;
	/**
	 * Which series are allowed together: one id, 1..4 ids that share a unit,
	 * free multi, or none (the earnings calendar shows watchlist dates, not
	 * market series — the dialog hides the series picker for it instead of
	 * special-casing the type).
	 */
	readonly seriesKind: "single" | "multi-same-unit" | "multi" | "none";
	readonly hasRange: boolean;
	/** True for widgets with a days-ahead select instead of a series picker. */
	readonly hasDaysAhead: boolean;
	readonly component: Component<WidgetRendererProps>;
}

/**
 * Narrows the union widget to one variant without an early return on props:
 * the `<Show>` stays live when the widget is replaced by an edit.
 */
function MetricEntry(props: WidgetRendererProps): JSX.Element {
	const metric = (): Extract<HomeWidget, { readonly type: "metric" }> | null =>
		props.widget.type === "metric" ? props.widget : null;
	return (
		<Show when={metric()} fallback={null}>
			{(current) => <MetricWidget widget={current()} seriesById={props.seriesById} />}
		</Show>
	);
}

function LineChartEntry(props: WidgetRendererProps): JSX.Element {
	const chart = (): Extract<HomeWidget, { readonly type: "line-chart" }> | null =>
		props.widget.type === "line-chart" ? props.widget : null;
	return (
		<Show when={chart()} fallback={null}>
			{(current) => (
				<LineChartWidget
					widget={current()}
					seriesById={props.seriesById}
					disabled={props.disabled}
					onSaveRange={props.onSaveRange}
				/>
			)}
		</Show>
	);
}

function StockTableEntry(props: WidgetRendererProps): JSX.Element {
	const table = (): Extract<HomeWidget, { readonly type: "stock-table" }> | null =>
		props.widget.type === "stock-table" ? props.widget : null;
	return (
		<Show when={table()} fallback={null}>
			{(current) => <StockTableWidget widget={current()} seriesById={props.seriesById} />}
		</Show>
	);
}

function IndicatorTableEntry(props: WidgetRendererProps): JSX.Element {
	const table = (): Extract<HomeWidget, { readonly type: "indicator-table" }> | null =>
		props.widget.type === "indicator-table" ? props.widget : null;
	return (
		<Show when={table()} fallback={null}>
			{(current) => <IndicatorTableWidget widget={current()} seriesById={props.seriesById} />}
		</Show>
	);
}

function EarningsCalendarEntry(props: WidgetRendererProps): JSX.Element {
	const calendar = (): Extract<HomeWidget, { readonly type: "earnings-calendar" }> | null =>
		props.widget.type === "earnings-calendar" ? props.widget : null;
	return (
		<Show when={calendar()} fallback={null}>
			{(current) => (
				<EarningsCalendarWidget
					widget={current()}
					watchlist={props.watchlist}
					watchlistError={props.watchlistError}
					onRetryWatchlist={props.onRetryWatchlist}
					onRefreshEarnings={props.onRefreshEarnings}
					earningsRefreshBusy={props.earningsRefreshBusy}
					api={props.api}
				/>
			)}
		</Show>
	);
}

export const WIDGET_REGISTRY: { readonly [T in HomeWidgetType]: WidgetTypeInfo } = {
	metric: {
		type: "metric",
		label: "Metric",
		description: "One series: latest value, change, one-year change and a sparkline.",
		defaultSize: "small",
		minSeries: 1,
		maxSeries: 1,
		seriesKind: "single",
		hasRange: false,
		hasDaysAhead: false,
		component: MetricEntry,
	},
	"line-chart": {
		type: "line-chart",
		label: "Line chart",
		description: "One to four series that share one unit, over a range, with a data table.",
		defaultSize: "medium",
		minSeries: 1,
		maxSeries: 4,
		seriesKind: "multi-same-unit",
		hasRange: true,
		hasDaysAhead: false,
		component: LineChartEntry,
	},
	"stock-table": {
		type: "stock-table",
		label: "Stock table",
		description: "One row per series: last close, change and as-of date.",
		defaultSize: "medium",
		minSeries: 1,
		maxSeries: 12,
		seriesKind: "multi",
		hasRange: false,
		hasDaysAhead: false,
		component: StockTableEntry,
	},
	"indicator-table": {
		type: "indicator-table",
		label: "Indicator table",
		description: "One row per series: latest, unit, previous, change and one-year change.",
		defaultSize: "large",
		minSeries: 1,
		maxSeries: 12,
		seriesKind: "multi",
		hasRange: false,
		hasDaysAhead: false,
		component: IndicatorTableEntry,
	},
	"earnings-calendar": {
		type: "earnings-calendar",
		label: "Earnings calendar",
		description:
			"Upcoming earnings announcement dates of the stocks on the Watchlist page, with calendar links.",
		defaultSize: "large",
		minSeries: 0,
		maxSeries: 0,
		seriesKind: "none",
		hasRange: false,
		hasDaysAhead: true,
		component: EarningsCalendarEntry,
	},
};

let widgetSeq = 0;

/** A fresh widget id, unique within this page visit (the server copy is canonical afterwards). */
export function newWidgetId(): string {
	widgetSeq += 1;
	return `w-new-${Date.now().toString(36)}-${widgetSeq}`;
}

export function defaultWidgetOf(type: HomeWidgetType): HomeWidget {
	const info = WIDGET_REGISTRY[type];
	switch (type) {
		case "metric":
			return {
				type,
				widgetId: newWidgetId(),
				title: "",
				size: info.defaultSize,
				seriesId: "",
			};
		case "line-chart":
			return {
				type,
				widgetId: newWidgetId(),
				title: "",
				size: info.defaultSize,
				seriesIds: [],
				range: "1y",
			};
		case "stock-table":
		case "indicator-table":
			return {
				type,
				widgetId: newWidgetId(),
				title: "",
				size: info.defaultSize,
				seriesIds: [],
			};
		case "earnings-calendar":
			return {
				type,
				widgetId: newWidgetId(),
				title: "",
				size: info.defaultSize,
				daysAhead: 90,
			};
	}
}
