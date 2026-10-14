import type { NotebookWidgetOrigin, WorkspaceView } from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import { For, type JSX, Show } from "solid-js";
import type { NotebookSession } from "./notebookSession.ts";
import type { WorkspaceMode } from "./types.ts";

/**
 * SEAM STUB (owned by the Notebook panel task): the props are fixed, the
 * panel is completed there. The Chat integration task renders it.
 */
export interface NotebookPanelProps {
	readonly session: NotebookSession;
	readonly registry: UiRegistry;
	/** The conversation's workspace view, for `research` widgets (null while loading). */
	readonly view: WorkspaceView | null;
	/** Chat-first renders the narrow secondary panel; Notebook-first the dominant one. */
	readonly mode: WorkspaceMode;
	/** "Ask AI" on widgets: selects them and moves focus to the composer. */
	readonly onAskAssistant: (widgetIds: readonly string[]) => void;
	/** Host controls in the panel header (the mode switch, collapse). */
	readonly headerActions?: JSX.Element;
	/** Navigates to where a widget came from (its chat message). */
	readonly onOpenOrigin?: (origin: NotebookWidgetOrigin) => void;
}

export function NotebookPanel(props: NotebookPanelProps): JSX.Element {
	return (
		<section aria-label="Notebook" data-panel="notebook" data-mode={props.mode}>
			<div class="flex items-center gap-2">
				<h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">Notebook</h3>
				{props.headerActions}
			</div>
			<Show
				when={props.session.widgets().length > 0}
				fallback={<p class="text-sm text-slate-600">Nothing saved yet.</p>}
			>
				<ul>
					<For each={props.session.widgets()}>{(widget) => <li>{widget.title}</li>}</For>
				</ul>
			</Show>
		</section>
	);
}
