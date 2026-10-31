import { type MarketSeries, type MarketWidgetCore, widgetSeriesIds } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, For, type JSX, Match, Show, Switch } from "solid-js";
import { formatInstant } from "../lib/format.ts";
import { homeFrameMessages } from "./homeFrame.messages.tsx";
import { MaterialDetails } from "./widgets/MaterialDetails.tsx";

/*
 * Provenance parts of the market widgets (the frame and its menu are the
 * shared board's since ADR-0024).
 */

/** "As of <date>" for one observation date. */
export function AsOf(props: { readonly date: string }): JSX.Element {
	const m = useMessages(homeFrameMessages);
	return <span>{m().asOf(<time dateTime={props.date}>{props.date}</time>)}</span>;
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
	const m = useMessages(homeFrameMessages);
	return (
		<>
			<span class="flex flex-wrap gap-x-2">
				<SafeLink url={props.series.sourceUrl}>{props.series.publisher}</SafeLink>
				<Show when={props.asOf} fallback={<span class="italic">{m().asOfNotStated}</span>}>
					{(date) => <AsOf date={date()} />}
				</Show>
				<span>
					{m().retrieved(
						props.series.retrievedAt === null ? (
							<span class="italic">{m().notStated}</span>
						) : (
							formatInstant(props.series.retrievedAt)
						),
					)}
				</span>
			</span>
			<MaterialDetails series={props.series} />
		</>
	);
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
	const m = useMessages(homeFrameMessages);
	const show = () => props.seriesIds.some((id) => props.byId().get(id)?.provider === "twelve-data");
	return (
		<Show when={show()}>
			<p class="mt-1 text-2xs text-slate-600">{m().twelveDataSession}</p>
		</Show>
	);
}

/**
 * Provenance for one widget, rendered at the end of the widget's own output
 * (its tracked subtree) — never passed through a frame prop. Single-series
 * widgets get the source link, as-of date and retrieved time; line charts get
 * one line per series. Tables carry provenance in each row, so they get no
 * footer (nor does the earnings calendar, which has its own line). The series
 * arrive through an accessor so the lines stay live across refreshes: no
 * early returns on props, no top-level prop reads — only `<Show>`/`<For>`
 * over memoized lookups.
 */
export function WidgetProvenance(props: {
	readonly widget: MarketWidgetCore;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	// Only single-series widgets and line charts need a footer: tables show
	// source and as-of date in each row, and the earnings calendar carries its
	// own provenance line in its body (publishers + retrieved dates from the
	// watchlist, which the frame never sees).
	return (
		<Show
			when={props.widget.type === "market-metric" || props.widget.type === "line-chart"}
			fallback={null}
		>
			<div
				data-field="widget-footer"
				class="mt-2 border-t border-slate-200 pt-1 text-2xs text-slate-600"
			>
				<WidgetProvenanceLines widget={props.widget} byId={props.byId} />
			</div>
		</Show>
	);
}

function WidgetProvenanceLines(props: {
	readonly widget: MarketWidgetCore;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const m = useMessages(homeFrameMessages);
	const metricSeries = () =>
		props.widget.type === "market-metric"
			? (props.byId().get(props.widget.seriesId) ?? null)
			: null;
	const chartIds = () =>
		props.widget.type === "line-chart" ? [...widgetSeriesIds(props.widget)] : [];
	return (
		<Switch fallback={null}>
			<Match when={props.widget.type === "market-metric"}>
				<Show when={metricSeries()} fallback={<span class="italic">{m().sourceNotStated}</span>}>
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
	const m = useMessages(homeFrameMessages);
	const series = () => props.byId().get(props.seriesId) ?? null;
	return (
		<Show when={series()} fallback={null}>
			{(entry) => (
				<li>
					{m().seriesLabel(entry().title)}
					<SingleSeriesFooter series={entry()} asOf={entry().observations.at(-1)?.[0] ?? null} />
				</li>
			)}
		</Show>
	);
}
