import type { WorkspaceView } from "@research/contracts";
import { type RenderContext, type UiRegistry, WorkspaceComponentView } from "@research/ui-registry";
import { createMemo, For, type JSX, Show } from "solid-js";
import { BUTTON, BUTTON_DANGER, Empty } from "../components/ui.tsx";
import { moveOperation, toggleColumnsOperation, type UiOperation } from "./commands.ts";

/**
 * The component canvas, rendered from `state.layout.order` through the
 * registry. Owner controls only emit typed UI operations; the canvas re-renders
 * from whatever state the server returns (UI-001 / UI-009). The surrounding
 * panel (title, count, collapse) lives in the Chat page so the Canvas panel
 * and the panel header stay one shared part.
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
	const move = (componentId: string, direction: "up" | "down") => {
		const operation = moveOperation(state().layout, componentId, direction);
		if (operation !== null) props.onOperation(operation);
	};

	return (
		<div aria-busy={props.busy}>
			<p class="flex flex-wrap items-center gap-2 text-xs text-slate-700">
				<span data-field="workspace-version">Workspace version {state().version}</span>
				<button
					type="button"
					class={BUTTON}
					disabled={props.busy}
					onClick={() => props.onOperation(toggleColumnsOperation(state().layout))}
				>
					{state().layout.columns === 1 ? "Use 2 columns" : "Use 1 column"}
				</button>
			</p>
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
				<ul
					aria-label="Workspace components"
					data-columns={state().layout.columns}
					class="mt-2 grid grid-cols-1 gap-3"
					classList={{ "xl:grid-cols-2": state().layout.columns === 2 }}
				>
					<For each={state().layout.order}>
						{(componentId, index) => (
							<Show when={componentsById().get(componentId)}>
								{(item) => (
									<li
										data-focused={state().focusedComponentId === componentId}
										aria-current={state().focusedComponentId === componentId ? "true" : undefined}
										class="min-w-0 rounded border p-2"
										classList={{
											"border-blue-600 ring-2 ring-blue-200":
												state().focusedComponentId === componentId,
											"border-slate-200": state().focusedComponentId !== componentId,
										}}
									>
										<div
											role="toolbar"
											aria-label={`Controls for ${componentId}`}
											class="mb-1 flex flex-wrap items-center gap-1"
										>
											<span class="mr-auto font-mono text-2xs text-slate-600">
												{item().componentType} · {componentId}
											</span>
											<button
												type="button"
												class={BUTTON}
												aria-label={`Move ${componentId} up`}
												disabled={props.busy || index() === 0}
												onClick={() => move(componentId, "up")}
											>
												Up
											</button>
											<button
												type="button"
												class={BUTTON}
												aria-label={`Move ${componentId} down`}
												disabled={props.busy || index() === state().layout.order.length - 1}
												onClick={() => move(componentId, "down")}
											>
												Down
											</button>
											<button
												type="button"
												class={BUTTON}
												aria-label={`Focus ${componentId}`}
												aria-pressed={state().focusedComponentId === componentId}
												disabled={props.busy}
												onClick={() =>
													props.onOperation({ operation: "component.focus", componentId })
												}
											>
												Focus
											</button>
											<button
												type="button"
												class={BUTTON_DANGER}
												aria-label={`Remove ${componentId}`}
												disabled={props.busy}
												onClick={() =>
													props.onOperation({ operation: "component.remove", componentId })
												}
											>
												Remove
											</button>
										</div>
										<WorkspaceComponentView
											component={item()}
											context={context()}
											registry={props.registry}
										/>
									</li>
								)}
							</Show>
						)}
					</For>
				</ul>
			</Show>
		</div>
	);
}
