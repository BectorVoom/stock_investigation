import type { HomeWidget, MarketSeries } from "@research/contracts";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createUniqueId, For, type JSX, Match, Show, Switch } from "solid-js";
import { formatInstant } from "../lib/format.ts";
import { HOME_SIZE_SPAN, widgetSeriesIds } from "./homeModel.ts";
import "./shoelace.ts";

export interface WidgetFrameProps {
	readonly widget: HomeWidget;
	readonly position: number;
	readonly total: number;
	/** V8: while a save is in flight every menu action is impossible, not silently skipped. */
	readonly actionsDisabled: boolean;
	readonly onEdit: (widget: HomeWidget) => void;
	readonly onMove: (widget: HomeWidget, direction: "earlier" | "later") => void;
	readonly onRemove: (widget: HomeWidget) => void;
	readonly children: JSX.Element;
}

/**
 * One widget on the grid: an `<article>` labelled by its `h3` title rendered
 * inside an `sl-card` (Shoelace has no table component; tables are semantic
 * `<table>`s in the card body). The header holds the title and a
 * size-independent actions menu. Provenance is rendered by each widget at the
 * end of its own output (never as a frame prop: prop elements snapshot once,
 * while children stay live).
 */
export function WidgetFrame(props: WidgetFrameProps): JSX.Element {
	const titleId = createUniqueId();
	const span = () => HOME_SIZE_SPAN[props.widget.size];
	return (
		<article
			aria-labelledby={titleId}
			data-widget-id={props.widget.widgetId}
			data-widget-type={props.widget.type}
			class={`min-w-0 ${span()}`}
		>
			<sl-card class="h-full w-full">
				<div slot="header" class="flex min-h-6 items-center justify-between gap-2">
					<h3 id={titleId} class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
						{props.widget.title}
					</h3>
					<sl-dropdown placement="bottom-end" hoist>
						<sl-button
							slot="trigger"
							caret
							size="small"
							disabled={props.actionsDisabled}
							data-widget-actions={props.widget.widgetId}
						>
							Actions
						</sl-button>
						<sl-menu
							label={`${props.widget.title} actions`}
							on:sl-select={(event) => {
								// H1: only the menu's own selection, not a bubbled nested event.
								if (event.target !== event.currentTarget) return;
								const action = event.detail.item.value;
								if (action === "edit") props.onEdit(props.widget);
								else if (action === "earlier" || action === "later") {
									props.onMove(props.widget, action);
								} else if (action === "remove") props.onRemove(props.widget);
							}}
						>
							<sl-menu-item value="edit" disabled={props.actionsDisabled}>
								Edit widget
							</sl-menu-item>
							<sl-menu-item
								value="earlier"
								disabled={props.actionsDisabled || props.position === 0}
							>
								Move earlier
							</sl-menu-item>
							<sl-menu-item
								value="later"
								disabled={props.actionsDisabled || props.position === props.total - 1}
							>
								Move later
							</sl-menu-item>
							<sl-menu-item value="remove" disabled={props.actionsDisabled}>
								Remove widget
							</sl-menu-item>
						</sl-menu>
					</sl-dropdown>
				</div>
				{props.children}
			</sl-card>
		</article>
	);
}

/** "As of <date>" for one observation date. */
export function AsOf(props: { readonly date: string }): JSX.Element {
	return (
		<span>
			as of <time dateTime={props.date}>{props.date}</time>
		</span>
	);
}

/**
 * The footer line for a single-series widget: source link (publisher name as
 * text), as-of date and retrieved time. Every displayed number carries its
 * unit (in the body), as-of date and source (here), or an explicit
 * "unavailable (reason)".
 */
export function SingleSeriesFooter(props: {
	readonly series: MarketSeries;
	readonly asOf: string | null;
}): JSX.Element {
	return (
		<span class="flex flex-wrap gap-x-2">
			<SafeLink url={props.series.sourceUrl}>{props.series.publisher}</SafeLink>
			<Show when={props.asOf} fallback={<span class="italic">as-of date not stated</span>}>
				{(date) => <AsOf date={date()} />}
			</Show>
			<span>
				retrieved{" "}
				{props.series.retrievedAt === null ? (
					<span class="italic">not stated</span>
				) : (
					formatInstant(props.series.retrievedAt)
				)}
			</span>
		</span>
	);
}

/** Tables carry per-row provenance; their footer says so. */
export function TableFooter(): JSX.Element {
	return <span>Sources and as-of dates are in each row.</span>;
}

/**
 * D4: Twelve Data serves daily bars, and the newest bar can be a session
 * still in progress. Shown beside any stock table or metric widget that
 * includes a Twelve Data series; the "Last close" column keeps its name.
 */
export function TwelveDataSessionNote(props: {
	readonly seriesIds: readonly string[];
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const show = () => props.seriesIds.some((id) => props.byId().get(id)?.provider === "twelve-data");
	return (
		<Show when={show()}>
			<p class="mt-1 text-2xs text-slate-600">
				Twelve Data daily bars: the newest daily bar can be an unfinished session.
			</p>
		</Show>
	);
}

/**
 * Provenance for one widget, rendered at the end of the widget's own output
 * (its tracked subtree) — never passed through a frame prop. Single-series
 * widgets get the source link, as-of date and retrieved time; line charts get
 * one line per series; tables point at their per-row provenance. The series
 * arrive through an accessor so the lines stay live across refreshes: no
 * early returns on props, no top-level prop reads — only `<Show>`/`<For>`
 * over memoized lookups.
 */
export function WidgetProvenance(props: {
	readonly widget: HomeWidget;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	return (
		<div
			data-field="widget-footer"
			class="mt-2 border-t border-slate-200 pt-1 text-2xs text-slate-600"
		>
			<WidgetProvenanceLines widget={props.widget} byId={props.byId} />
		</div>
	);
}

function WidgetProvenanceLines(props: {
	readonly widget: HomeWidget;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const metricSeries = () =>
		props.widget.type === "metric" ? (props.byId().get(props.widget.seriesId) ?? null) : null;
	const chartIds = () =>
		props.widget.type === "line-chart" ? [...widgetSeriesIds(props.widget)] : [];
	return (
		<Switch fallback={<TableFooter />}>
			<Match when={props.widget.type === "metric"}>
				<Show when={metricSeries()} fallback={<span class="italic">source not stated</span>}>
					{(series) => (
						<SingleSeriesFooter
							series={series()}
							asOf={series().observations.at(-1)?.[0] ?? null}
						/>
					)}
				</Show>
			</Match>
			<Match when={props.widget.type === "line-chart"}>
				<ul class="space-y-0.5">
					<For each={chartIds()}>{(id) => <ChartSeriesLine seriesId={id} byId={props.byId} />}</For>
				</ul>
			</Match>
		</Switch>
	);
}

function ChartSeriesLine(props: {
	readonly seriesId: string;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const series = () => props.byId().get(props.seriesId) ?? null;
	return (
		<Show when={series()} fallback={null}>
			{(entry) => (
				<li>
					{entry().title}:{" "}
					<SingleSeriesFooter series={entry()} asOf={entry().observations.at(-1)?.[0] ?? null} />
				</li>
			)}
		</Show>
	);
}
