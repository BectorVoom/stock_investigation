import type { WorkspaceView } from "@research/contracts";
import { type RenderContext, type UiRegistry, WorkspaceComponentView } from "@research/ui-registry";
import { createMemo, For, type JSX, Show } from "solid-js";
import { Empty } from "../components/ui.tsx";
import type { UiOperation } from "./commands.ts";

/**
 * The component canvas, rendered from `state.layout.order` through the
 * registry. A canvas card is just the rendered component: the owner cannot
 * focus, reorder or remove components here (owner's decision of 2026-10-13) —
 * the agent arranges the canvas through commands, and item selection inside
 * a component (e.g. a table row, `component.select`) still dispatches a
 * command. A component the agent focused is marked by its ring together with
 * `aria-current`/`data-focused` and the visible "Focused by the agent" line,
 * never by colour alone. The surrounding panel (title, count, collapse)
 * lives in the Chat page so the Canvas panel and the panel header stay one
 * shared part. The panel is one narrow column, so components always lay out
 * in one column; the stored `layout.columns` value is preserved untouched
 * but never switches the grid.
 */
export function Canvas(props: {
	readonly view: WorkspaceView;
	readonly registry: UiRegistry;
	readonly busy: boolean;
	readonly onOperation: (operation: UiOperation) => void;
}): JSX.Element {
	const state = () => props.view.state;
	const componentsById = createMemo(
		() => new Map(state().components.map((item) => [item.componentId, item] as const)),
	);
	const context = createMemo(
		(): RenderContext => ({
			datasets: new Map(
				props.view.datasets.map((dataset) => [dataset.datasetId, dataset] as const),
			),
			sources: new Map(props.view.sources.map((source) => [source.evidenceId, source] as const)),
			assets: new Map(props.view.assets.map((asset) => [asset.assetId, asset] as const)),
			selection: state().selection,
			onSelect: (componentId, itemKey) =>
				props.onOperation({ operation: "component.select", componentId, itemKey }),
		}),
	);

	return (
		<div aria-busy={props.busy}>
			<Show
				when={state().layout.order.length > 0}
				fallback={
					<div class="mt-2">
						<Empty>
							No canvas content yet. Ask a research question and the agent will add tables, charts
							and reports here.
						</Empty>
					</div>
				}
			>
				<ul aria-label="Workspace components" class="mt-2 grid grid-cols-1 gap-3">
					<For each={state().layout.order}>
						{(componentId) => (
							<Show when={componentsById().get(componentId)}>
								{(item) => {
									const focused = () => state().focusedComponentId === componentId;
									return (
										<li
											data-focused={focused()}
											aria-current={focused() ? "true" : undefined}
											class="min-w-0 rounded bg-slate-100 p-2"
											classList={{
												"ring-2 ring-blue-700": focused(),
											}}
										>
											<Show when={focused()}>
												<p
													data-focused-label="true"
													class="mb-1 inline-block rounded bg-blue-700 px-1.5 py-px text-2xs font-semibold text-white"
												>
													Focused by the agent
												</p>
											</Show>
											<WorkspaceComponentView
												component={item()}
												context={context()}
												registry={props.registry}
											/>
										</li>
									);
								}}
							</Show>
						)}
					</For>
				</ul>
			</Show>
		</div>
	);
}
