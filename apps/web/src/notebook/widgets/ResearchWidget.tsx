import type { WidgetCore, WorkspaceView } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { type UiRegistry, WorkspaceComponentView } from "@research/ui-registry";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { notebookWidgetMessages } from "./notebookWidgets.messages.tsx";

/**
 * A research component of the same conversation rendered through the
 * registry with its verification badges intact. Read-only content; title,
 * size and position are the owner's.
 */
export function ResearchWidget(props: {
	readonly widget: Extract<WidgetCore, { readonly type: "research" }>;
	readonly view: WorkspaceView | null;
	readonly registry: UiRegistry;
}): JSX.Element {
	const m = useMessages(notebookWidgetMessages);
	const component = createMemo(() => {
		const view = props.view;
		if (view === null) return null;
		return (
			view.state.components.find((entry) => entry.componentId === props.widget.componentId) ?? null
		);
	});
	const context = createMemo(() => {
		const view = props.view;
		return {
			datasets: new Map(
				(view?.datasets ?? []).map((dataset) => [dataset.datasetId, dataset] as const),
			),
			sources: new Map((view?.sources ?? []).map((source) => [source.evidenceId, source] as const)),
			selection: view?.state.selection ?? null,
			onSelect: () => undefined,
		};
	});
	return (
		<div data-widget-body="research">
			<Show
				when={component() ?? undefined}
				fallback={<p class="text-sm italic text-slate-600">{m().researchGone}</p>}
			>
				{(found) => (
					<WorkspaceComponentView
						component={found()}
						context={context()}
						registry={props.registry}
					/>
				)}
			</Show>
		</div>
	);
}
