import {
	isMarketWidget,
	type MarketWidgetCore,
	type NotebookWidget,
	type WidgetCore,
	type WorkspaceView,
} from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import { type JSX, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { WIDGET_REGISTRY } from "../home/widgetRegistry.tsx";
import { ChartWidget } from "../notebook/widgets/ChartWidget.tsx";
import { MetricWidget } from "../notebook/widgets/MetricWidget.tsx";
import { ResearchWidget } from "../notebook/widgets/ResearchWidget.tsx";
import { TableWidget } from "../notebook/widgets/TableWidget.tsx";
import { TextWidget } from "../notebook/widgets/TextWidget.tsx";
import type { WidgetMarketContext } from "./marketContext.ts";

/**
 * One widget body by type, for Home and the Notebook alike (ADR-0024), plus
 * the quiet assistant line for a notebook widget an assistant wrote. The
 * frame owns the title and actions; bodies render only content and
 * provenance-adjacent text. Each `Match` narrows the union through its
 * `when`, so no casts are needed.
 */
export function WidgetBody(props: {
	/** A Home widget (a bare core) or a notebook widget (a core with its metadata). */
	readonly widget: WidgetCore | NotebookWidget;
	/** The conversation's workspace view, for `research` widgets (null on Home or while loading). */
	readonly view: WorkspaceView | null;
	/** The component registry `research` widgets render through (absent on Home, which has none). */
	readonly registry?: UiRegistry;
	/** Live data for market widgets; null until the page's market data is wired. */
	readonly market: WidgetMarketContext | null;
	/** True while the page saves: in-place editors stay read-only. */
	readonly editingDisabled: boolean;
	/** Saves a text widget's new Markdown source; resolves false when the save failed. */
	readonly onSaveText: (widgetId: string, text: string) => Promise<boolean>;
	/** Saves a market widget edited through its own component (today: the line-chart range). */
	readonly onSaveMarketWidget: (widget: MarketWidgetCore) => void;
}): JSX.Element {
	const assistantWritten = () =>
		"origin" in props.widget && props.widget.origin.kind === "assistant";
	return (
		<div>
			<Switch>
				<Match when={props.widget.type === "text" ? props.widget : null}>
					{(text) => (
						<TextWidget
							widget={text()}
							editingDisabled={props.editingDisabled}
							onSaveText={props.onSaveText}
						/>
					)}
				</Match>
				<Match when={isMarketWidget(props.widget) ? props.widget : null}>
					{(market) => (
						<Show
							when={props.market}
							fallback={<output class="block text-sm text-slate-600">Loading market data…</output>}
						>
							{(context) => (
								<Dynamic
									component={WIDGET_REGISTRY[market().type].component}
									widget={market()}
									seriesById={context().seriesById}
									watchlist={context().watchlist}
									watchlistError={context().watchlistError}
									onRetryWatchlist={context().onRetryWatchlist}
									onRefreshEarnings={context().onRefreshEarnings}
									earningsRefreshBusy={context().earningsRefreshBusy}
									api={context().api}
									onSaveRange={(next: MarketWidgetCore) => props.onSaveMarketWidget(next)}
								/>
							)}
						</Show>
					)}
				</Match>
				<Match when={props.widget.type === "metric" ? props.widget : null}>
					{(metric) => <MetricWidget widget={metric()} />}
				</Match>
				<Match when={props.widget.type === "chart" ? props.widget : null}>
					{(chart) => <ChartWidget widget={chart()} />}
				</Match>
				<Match when={props.widget.type === "table" ? props.widget : null}>
					{(table) => <TableWidget widget={table()} />}
				</Match>
				<Match when={props.widget.type === "research" ? props.widget : null}>
					{(research) => (
						<Show
							when={props.registry}
							fallback={
								<p class="text-sm text-slate-600">
									This research result belongs to a conversation and shows only there.
								</p>
							}
						>
							{(registry) => (
								<ResearchWidget widget={research()} view={props.view} registry={registry()} />
							)}
						</Show>
					)}
				</Match>
			</Switch>
			<Show when={assistantWritten()}>
				<p class="mt-2 text-2xs text-slate-600">Written by the assistant</p>
			</Show>
		</div>
	);
}
