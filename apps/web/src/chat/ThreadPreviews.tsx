import type { NotebookWidgetOrigin, WidgetCore, WorkspaceView } from "@research/contracts";
import type { RenderContext, UiRegistry, WorkspaceComponent } from "@research/ui-registry";
import { WorkspaceComponentView } from "@research/ui-registry";
import { WidgetFrame } from "@research/widget-grid";
// The package stylesheet: without it a frame is unstyled markup. Home loads
// it in its own lazy chunk, so every page that renders a frame imports it.
import "@research/widget-grid/styles.css";
import { createMemo, For, type JSX, Show } from "solid-js";
import { IconButton } from "../components/ui.tsx";
import { widgetFromComponent } from "../notebook/notebookModel.ts";

type ThreadComponent = WorkspaceComponent;

/**
 * Research output lives in the thread (ADR-0020): each canvas component of
 * the open conversation renders directly after the assistant answer of the
 * run that produced it, as a widget-styled preview — the package
 * `WidgetFrame` inside a fixed-height container, so Chat previews and
 * Notebook widgets look like the same component. The body is
 * `WorkspaceComponentView`, exactly as the old Canvas panel rendered it
 * (item selection still dispatches through the session).
 *
 * Ownership follows the component id prefix `${runId}_` (the pipeline also
 * renames model-created components into it). Components no visible run owns
 * are not shown in the thread: they stay on the canvas, where the notebook
 * assistant can still use them.
 */

/** Components grouped by their producing run, in layout order; unowned ones are left out. */
export function groupThreadComponents(
	components: readonly ThreadComponent[],
	order: readonly string[],
	runIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly ThreadComponent[]> {
	const byId = new Map(components.map((component) => [component.componentId, component] as const));
	const byRun = new Map<string, ThreadComponent[]>();
	const seen = new Set<string>();
	const place = (component: ThreadComponent) => {
		for (const runId of runIds) {
			if (!component.componentId.startsWith(`${runId}_`)) continue;
			const group = byRun.get(runId);
			if (group === undefined) byRun.set(runId, [component]);
			else group.push(component);
			return;
		}
	};
	for (const componentId of order) {
		if (seen.has(componentId)) continue;
		seen.add(componentId);
		const component = byId.get(componentId);
		if (component !== undefined) place(component);
	}
	// Components missing from the layout order still show, after the ordered ones.
	for (const component of components) {
		if (!seen.has(component.componentId)) place(component);
	}
	return byRun;
}

function previewTitle(component: ThreadComponent): string {
	const raw: unknown = component.props.title;
	return typeof raw === "string" && raw.trim().length > 0 ? raw : component.componentType;
}

/**
 * One component as a widget-styled preview. The action saves a copy into
 * the Notebook (`widgetFromComponent` + `addWidget` with a `chat` origin);
 * once a widget with that `origin.componentId` exists the preview says "In
 * notebook" and offers no second click.
 */
export function ComponentPreview(props: {
	readonly component: ThreadComponent;
	readonly context: RenderContext;
	readonly registry: UiRegistry;
	readonly view: WorkspaceView;
	readonly runId: string | null;
	readonly messageId: string | null;
	readonly inNotebook: boolean;
	readonly saving: boolean;
	readonly onAdd: (core: WidgetCore, origin: NotebookWidgetOrigin) => void;
}): JSX.Element {
	// One conversion per component and view (it parses, guards and round-trips
	// the dataset), not one per read of the action's `when`.
	const core = createMemo(() => widgetFromComponent(props.component, props.view));
	const add = () => {
		const widget = core();
		if (widget === null) return;
		props.onAdd(widget, {
			kind: "chat",
			messageId: props.messageId,
			runId: props.runId,
			componentId: props.component.componentId,
		});
	};
	return (
		<li
			data-preview-component={props.component.componentId}
			class="min-w-0 rounded bg-slate-100 p-2 pt-5"
		>
			{/* pt-5: the untitled frame's control cluster straddles its top edge
			    by 0.75rem; the card keeps room so a scroller never clips it. */}
			<WidgetFrame
				widget={{
					widgetId: props.component.componentId,
					type: props.component.componentType,
					title: previewTitle(props.component),
					size: "large",
				}}
				titleHidden
				actions={
					<Show when={core() !== null}>
						<Show
							when={!props.inNotebook}
							fallback={<span class="px-1 text-xs text-slate-600">In notebook</span>}
						>
							<IconButton
								label="Add to Notebook"
								icon="plus-lg"
								disabled={props.saving}
								onClick={add}
							/>
						</Show>
					</Show>
				}
			>
				{/* At most the body of a Large notebook widget (2 rows): a chart gets
				    its natural height and a short component leaves no blank frame. */}
				<div class="max-h-[33rem] overflow-y-auto">
					<WorkspaceComponentView
						component={props.component}
						context={props.context}
						registry={props.registry}
					/>
				</div>
			</WidgetFrame>
		</li>
	);
}

/** The previews owned by one run, rendered after its assistant answer. */
export function ThreadPreviewsForRun(props: {
	readonly runId: string;
	readonly components: readonly ThreadComponent[];
	readonly context: RenderContext;
	readonly registry: UiRegistry;
	readonly view: WorkspaceView;
	readonly messageId: string | null;
	readonly isInNotebook: (componentId: string) => boolean;
	readonly savingIds: readonly string[];
	readonly onAdd: (core: WidgetCore, origin: NotebookWidgetOrigin) => void;
}): JSX.Element {
	return (
		<Show when={props.components.length > 0}>
			<ul aria-label="Results" data-preview-run={props.runId} class="mt-2 space-y-2">
				<For each={props.components}>
					{(component) => (
						<ComponentPreview
							component={component}
							context={props.context}
							registry={props.registry}
							view={props.view}
							runId={props.runId}
							messageId={props.messageId}
							inNotebook={props.isInNotebook(component.componentId)}
							saving={props.savingIds.includes(component.componentId)}
							onAdd={props.onAdd}
						/>
					)}
				</For>
			</ul>
		</Show>
	);
}
