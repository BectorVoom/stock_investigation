import type { NotebookWidget, WorkspaceView } from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import type { JSX } from "solid-js";
import { Match, Show, Switch } from "solid-js";
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
}): JSX.Element {
	return (
		<div>
			<Switch>
				<Match when={props.widget.type === "text" ? props.widget : null}>
					{(text) => <TextWidget widget={text()} />}
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
