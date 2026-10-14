import type {
	NotebookResponse,
	NotebookTurn,
	NotebookWidget,
	NotebookWidgetCore,
	NotebookWidgetOrigin,
} from "@research/contracts";
import { type Accessor, createSignal } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import type { VisibilitySource } from "../lib/polling.ts";

/**
 * SEAM STUB (owned by the Notebook panel task): the interface is fixed, the
 * implementation is completed there. The Chat integration task only calls it.
 *
 * One notebook session per open conversation, created next to the workspace
 * session in `OpenWorkspace` and kept across Chat-first ↔ Notebook-first
 * switches (never re-created by a layout change).
 */
export interface NotebookSession {
	/** The last state the server confirmed; null until the first load. */
	readonly state: Accessor<NotebookResponse | null>;
	/** What is on screen: the confirmed widgets, or an optimistic edit while it saves. */
	readonly widgets: Accessor<readonly NotebookWidget[]>;
	readonly loadError: Accessor<ApiFailure | null>;
	/** The last failed save, undo or conflict, as one sentence plus the failure. */
	readonly notice: Accessor<{ readonly text: string; readonly failure: ApiFailure | null } | null>;
	readonly dismissNotice: () => void;
	/** True while a save or undo is in flight. */
	readonly pending: Accessor<boolean>;
	/** Selected widget ids in notebook order: the explicit context target for the assistant. */
	readonly selection: Accessor<readonly string[]>;
	/** `replace` selects one widget alone (or clears with null); `toggle` adds or removes it. */
	readonly select: (widgetId: string | null, mode: "replace" | "toggle") => void;
	readonly turns: Accessor<readonly NotebookTurn[]>;
	readonly reload: () => Promise<void>;
	/**
	 * Applies an owner edit optimistically and saves it with compare-and-set;
	 * on failure the confirmed state returns and `notice` says why. Resolves
	 * true when saved.
	 */
	readonly edit: (
		change: (widgets: readonly NotebookWidget[]) => readonly NotebookWidget[],
	) => Promise<boolean>;
	/** Adds one widget (at `toIndex`, default last); resolves to its id when saved. */
	readonly addWidget: (
		core: NotebookWidgetCore,
		origin: NotebookWidgetOrigin,
		toIndex?: number,
	) => Promise<string | null>;
	/** Restores the body kept before the version on screen. */
	readonly undo: () => Promise<boolean>;
	/** Owner confirmation of an assistant's proposed removals. */
	readonly removeWidgets: (widgetIds: readonly string[]) => Promise<boolean>;
}

export function createNotebookSession(
	api: ApiClient,
	workspaceId: string,
	_visibility: VisibilitySource,
): NotebookSession {
	const [state, setState] = createSignal<NotebookResponse | null>(null);
	const [loadError, setLoadError] = createSignal<ApiFailure | null>(null);
	const [selection, setSelection] = createSignal<readonly string[]>([]);
	const reload = async () => {
		const result = await api.getNotebook(workspaceId);
		if (result.ok) {
			setState(result.value);
			setLoadError(null);
		} else setLoadError(result.error);
	};
	void reload();
	return {
		state,
		widgets: () => state()?.notebook.widgets ?? [],
		loadError,
		notice: () => null,
		dismissNotice: () => undefined,
		pending: () => false,
		selection,
		select: (widgetId, mode) => {
			if (widgetId === null) return setSelection([]);
			if (mode === "replace") return setSelection([widgetId]);
			setSelection((current) =>
				current.includes(widgetId)
					? current.filter((id) => id !== widgetId)
					: [...current, widgetId],
			);
		},
		turns: () => state()?.turns ?? [],
		reload,
		edit: async () => false,
		addWidget: async () => null,
		undo: async () => false,
		removeWidgets: async () => false,
	};
}
