import type { NotebookWidgetCore, NotebookWidgetOrigin, WorkspaceView } from "@research/contracts";
import type { RenderContext, UiRegistry, WorkspaceComponent } from "@research/ui-registry";
import { WorkspaceComponentView } from "@research/ui-registry";
import { WidgetFrame } from "@research/widget-grid";
import { For, type JSX, Show } from "solid-js";
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
 * Ownership follows the component id prefix `${runId}_`: components no
 * visible run owns are listed after the thread under "Other results".
 */

/** Components grouped by their producing run, in layout order; the rest are orphans. */
export function groupThreadComponents(
	components: readonly ThreadComponent[],
	order: readonly string[],
	runIds: ReadonlySet<string>,
): {
	readonly byRun: ReadonlyMap<string, readonly ThreadComponent[]>;
	readonly orphans: readonly ThreadComponent[];
} {
	const byId = new Map(components.map((component) => [component.componentId, component] as const));
	const byRun = new Map<string, ThreadComponent[]>();
	const orphans: ThreadComponent[] = [];
	const seen = new Set<string>();
	for (const componentId of order) {
		if (seen.has(componentId)) continue;
		seen.add(componentId);
		const component = byId.get(componentId);
		if (component === undefined) continue;
		let owner: string | null = null;
		for (const runId of runIds) {
			if (componentId.startsWith(`${runId}_`)) {
				owner = runId;
				break;
			}
		}
		if (owner === null) orphans.push(component);
		else {
			const group = byRun.get(owner);
			if (group === undefined) byRun.set(owner, [component]);
			else group.push(component);
		}
	}
	// Components missing from the layout order still show, after the ordered ones.
	for (const component of components) {
		if (seen.has(component.componentId)) continue;
		orphans.push(component);
	}
	return { byRun, orphans };
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
	readonly onAdd: (core: NotebookWidgetCore, origin: NotebookWidgetOrigin) => void;
}): JSX.Element {
	const core = () => widgetFromComponent(props.component, props.view);
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
		<li data-preview-component={props.component.componentId} class="min-w-0 rounded bg-slate-100 p-2">
			<WidgetFrame
				widget={{
					widgetId: props.component.componentId,
					type: props.component.componentType,
					title: previewTitle(props.component),
					size: "large",
				}}
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
				<div class="h-72 overflow-y-auto">
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
	readonly onAdd: (core: NotebookWidgetCore, origin: NotebookWidgetOrigin) => void;
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

/** Components no visible run owns, listed after the thread. */
export function OtherResults(props: {
	readonly components: readonly ThreadComponent[];
	readonly context: RenderContext;
	readonly registry: UiRegistry;
	readonly view: WorkspaceView;
	readonly isInNotebook: (componentId: string) => boolean;
	readonly savingIds: readonly string[];
	readonly onAdd: (core: NotebookWidgetCore, origin: NotebookWidgetOrigin) => void;
}): JSX.Element {
	return (
		<Show when={props.components.length > 0}>
			<section aria-label="Other results" class="mx-auto w-full max-w-3xl px-1 pb-2">
				<h4 class="text-xs font-semibold text-slate-700">Other results</h4>
				<ul aria-label="Results" class="mt-1 space-y-2">
					<For each={props.components}>
						{(component) => (
							<ComponentPreview
								component={component}
								context={props.context}
								registry={props.registry}
								view={props.view}
								runId={null}
								messageId={null}
								inNotebook={props.isInNotebook(component.componentId)}
								saving={props.savingIds.includes(component.componentId)}
								onAdd={props.onAdd}
							/>
						)}
					</For>
				</ul>
			</section>
		</Show>
	);
}
