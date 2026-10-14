import type { ChatMessage, NotebookWidgetCore, WorkspaceView } from "@research/contracts";

/**
 * SEAM STUB (owned by the Notebook panel task): signatures are fixed, the
 * bodies are completed there. Pure functions: Chat output → notebook widgets.
 */

type WorkspaceComponent = WorkspaceView["state"]["components"][number];

/** A fresh widget id (`nb-` + random), unique within one notebook. */
export function newNotebookWidgetId(): string {
	return `nb-${crypto.randomUUID()}`;
}

/**
 * A self-contained widget from a canvas component: tables and charts become
 * `table` / `chart` widgets carrying a copy of their dataset rows (so they
 * stay editable); every other component becomes a `research` widget that
 * renders the component itself. Null when the component cannot be saved
 * (its dataset is not in `view`).
 */
export function widgetFromComponent(
	component: WorkspaceComponent,
	_view: WorkspaceView,
): NotebookWidgetCore | null {
	return {
		widgetId: newNotebookWidgetId(),
		type: "research",
		title: component.componentType,
		size: "large",
		componentId: component.componentId,
	};
}

/** An editable text widget from an assistant answer (citation chips become `[n]` text). */
export function widgetFromAnswer(message: ChatMessage): NotebookWidgetCore {
	return {
		widgetId: newNotebookWidgetId(),
		type: "text",
		title: "Answer",
		size: "medium",
		text: message.text.length > 0 ? message.text : "(empty answer)",
	};
}
