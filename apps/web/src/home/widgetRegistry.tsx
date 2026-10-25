import {
	type MarketSeries,
	type MarketWidgetCore,
	type MarketWidgetType,
	type WatchlistResponse,
	WIDGET_TYPE_META,
} from "@research/contracts";
import { type Accessor, type Component, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { EarningsCalendarWidget } from "./widgets/EarningsCalendarWidget.tsx";
import { IndicatorTableWidget } from "./widgets/IndicatorTableWidget.tsx";
import { LineChartWidget } from "./widgets/LineChartWidget.tsx";
import { MetricWidget } from "./widgets/MetricWidget.tsx";
import { StockTableWidget } from "./widgets/StockTableWidget.tsx";

export interface WidgetRendererProps {
	readonly widget: MarketWidgetCore;
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
	readonly onSaveRange: (widget: MarketWidgetCore) => void;
}

/**
 * One entry per widget type: label, description, default config, editor
 * fields and component. Adding a type is one entry here plus its component —
 * the dialog, frame grid and HomeView all read from this table. HomeView
 * renders the entry's component with `<Dynamic>`, passing the widget and the
 * live series accessor as props.
 */
export interface WidgetTypeInfo {
	readonly type: MarketWidgetType;
	readonly label: string;
	readonly description: string;
	readonly defaultSize: MarketWidgetCore["size"];
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
	const metric = (): Extract<MarketWidgetCore, { readonly type: "market-metric" }> | null =>
		props.widget.type === "market-metric" ? props.widget : null;
	return (
		<Show when={metric()} fallback={null}>
			{(current) => <MetricWidget widget={current()} seriesById={props.seriesById} />}
		</Show>
	);
}

function LineChartEntry(props: WidgetRendererProps): JSX.Element {
	const chart = (): Extract<MarketWidgetCore, { readonly type: "line-chart" }> | null =>
		props.widget.type === "line-chart" ? props.widget : null;
	return (
		<Show when={chart()} fallback={null}>
			{(current) => (
				<LineChartWidget
					widget={current()}
					seriesById={props.seriesById}
					onSaveRange={props.onSaveRange}
				/>
			)}
		</Show>
	);
}

function StockTableEntry(props: WidgetRendererProps): JSX.Element {
	const table = (): Extract<MarketWidgetCore, { readonly type: "stock-table" }> | null =>
		props.widget.type === "stock-table" ? props.widget : null;
	return (
		<Show when={table()} fallback={null}>
			{(current) => <StockTableWidget widget={current()} seriesById={props.seriesById} />}
		</Show>
	);
}

function IndicatorTableEntry(props: WidgetRendererProps): JSX.Element {
	const table = (): Extract<MarketWidgetCore, { readonly type: "indicator-table" }> | null =>
		props.widget.type === "indicator-table" ? props.widget : null;
	return (
		<Show when={table()} fallback={null}>
			{(current) => <IndicatorTableWidget widget={current()} seriesById={props.seriesById} />}
		</Show>
	);
}

function EarningsCalendarEntry(props: WidgetRendererProps): JSX.Element {
	const calendar = (): Extract<MarketWidgetCore, { readonly type: "earnings-calendar" }> | null =>
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

/** Seam placeholder (ADR-0040): the web worker replaces it with the real widget. */
function WatchlistPricesEntry(_props: WidgetRendererProps): JSX.Element {
	return null;
}

/**
 * Label, description and default size from the one shared table
 * (`WIDGET_TYPE_META` in `@research/contracts`), so they are written
 * once for the web registry and the MCP agent types alike.
 */
function sharedMeta(
	type: MarketWidgetType,
): Pick<WidgetTypeInfo, "label" | "description" | "defaultSize"> {
	const meta = WIDGET_TYPE_META[type];
	return { label: meta.label, description: meta.description, defaultSize: meta.defaultSize };
}

export const WIDGET_REGISTRY: { readonly [T in MarketWidgetType]: WidgetTypeInfo } = {
	"market-metric": {
		type: "market-metric",
		...sharedMeta("market-metric"),
		minSeries: 1,
		maxSeries: 1,
		seriesKind: "single",
		hasRange: false,
		hasDaysAhead: false,
		component: MetricEntry,
	},
	"line-chart": {
		type: "line-chart",
		...sharedMeta("line-chart"),
		minSeries: 1,
		maxSeries: 4,
		seriesKind: "multi-same-unit",
		hasRange: true,
		hasDaysAhead: false,
		component: LineChartEntry,
	},
	"stock-table": {
		type: "stock-table",
		...sharedMeta("stock-table"),
		minSeries: 1,
		maxSeries: 12,
		seriesKind: "multi",
		hasRange: false,
		hasDaysAhead: false,
		component: StockTableEntry,
	},
	"indicator-table": {
		type: "indicator-table",
		...sharedMeta("indicator-table"),
		minSeries: 1,
		maxSeries: 12,
		seriesKind: "multi",
		hasRange: false,
		hasDaysAhead: false,
		component: IndicatorTableEntry,
	},
	"earnings-calendar": {
		type: "earnings-calendar",
		...sharedMeta("earnings-calendar"),
		minSeries: 0,
		maxSeries: 0,
		seriesKind: "none",
		hasRange: false,
		hasDaysAhead: true,
		component: EarningsCalendarEntry,
	},
	"watchlist-prices": {
		type: "watchlist-prices",
		...sharedMeta("watchlist-prices"),
		minSeries: 0,
		maxSeries: 0,
		seriesKind: "none",
		hasRange: false,
		hasDaysAhead: false,
		component: WatchlistPricesEntry,
	},
};
