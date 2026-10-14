import {
	type HomeWidget,
	isNotebookMarketWidget,
	NOTEBOOK_MARKET_HOME_TYPE,
	type NotebookWidget,
	notebookWidgetAsHomeWidget,
	type WorkspaceView,
} from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import { type JSX, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { WIDGET_REGISTRY } from "../../home/widgetRegistry.tsx";
import type { NotebookMarketContext } from "../marketContext.ts";
import { ChartWidget } from "./ChartWidget.tsx";
import { MetricWidget } from "./MetricWidget.tsx";
import { ResearchWidget } from "./ResearchWidget.tsx";
import { TableWidget } from "./TableWidget.tsx";
import { TextWidget } from "./TextWidget.tsx";

/**
 * One widget body by type, plus the quiet assistant line. The frame owns the
 * title and actions; bodies render only content and provenance-adjacent text.
 * Each `Match` narrows the union through its `when`, so no casts are needed.
 */
export function WidgetBody(props: {
	readonly widget: NotebookWidget;
	readonly view: WorkspaceView | null;
	readonly registry: UiRegistry;
	/** Live data for market widgets; null until the notebook's market data is wired. */
	readonly market: NotebookMarketContext | null;
	/** True while the notebook saves: in-place editors stay read-only. */
	readonly editingDisabled: boolean;
	/** Saves a text widget's new Markdown source; resolves false when the save failed. */
	readonly onSaveText: (widgetId: string, text: string) => Promise<boolean>;
	/** Saves a market widget edited through its Home component (today: the line-chart range). */
	readonly onSaveMarketWidget: (widget: HomeWidget) => void;
}): JSX.Element {
	return (
		<div>
			<Switch>
				<Match when={props.widget.type === "text" ? props.widget : null}>
					{(text) => <TextWidget widget={text()} />}
				</Match>
				<Match when={isNotebookMarketWidget(props.widget) ? props.widget : null}>
					{(market) => (
						<Show
							when={props.market}
							fallback={<output class="block text-sm text-slate-600">Loading market data…</output>}
						>
							{(context) => (
								<Dynamic
									component={WIDGET_REGISTRY[NOTEBOOK_MARKET_HOME_TYPE[market().type]].component}
									widget={notebookWidgetAsHomeWidget(market())}
									seriesById={context().seriesById}
									watchlist={context().watchlist}
									watchlistError={context().watchlistError}
									onRetryWatchlist={context().onRetryWatchlist}
									onRefreshEarnings={context().onRefreshEarnings}
									earningsRefreshBusy={context().earningsRefreshBusy}
									api={context().api}
									disabled={props.editingDisabled}
									onSaveRange={(next: HomeWidget) => props.onSaveMarketWidget(next)}
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
						<ResearchWidget widget={research()} view={props.view} registry={props.registry} />
					)}
				</Match>
			</Switch>
			<Show when={props.widget.origin.kind === "assistant"}>
				<p class="mt-2 text-2xs text-slate-600">Written by the assistant</p>
			</Show>
		</div>
	);
}
