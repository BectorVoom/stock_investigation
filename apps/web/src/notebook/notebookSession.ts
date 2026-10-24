import {
	type NotebookCapacityProblem,
	type NotebookResponse,
	type NotebookTurn,
	type NotebookWidget,
	type NotebookWidgetOrigin,
	notebookCapacityProblem,
	type WidgetCore,
} from "@research/contracts";
import type { MessagesOf } from "@research/i18n";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import type { notebookSessionMessages } from "./notebook.messages.ts";

/** The words of the session's notices (`notebookSessionMessages`). */
export type NotebookSessionWords = MessagesOf<typeof notebookSessionMessages>;

/**
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
		core: WidgetCore,
		origin: NotebookWidgetOrigin,
		toIndex?: number,
	) => Promise<string | null>;
	/**
	 * Inserts every entry (at `toIndex`, default last) in ONE `edit`, so a
	 * paste is one save, not N parallel saves. Resolves to the new ids in
	 * entry order when saved, null when not. An empty entry list resolves to
	 * `[]` without saving.
	 */
	readonly addWidgets: (
		entries: readonly {
			readonly core: WidgetCore;
			readonly origin: NotebookWidgetOrigin;
		}[],
		toIndex?: number,
	) => Promise<readonly string[] | null>;
	/** A stored widget for a new entry: the metadata stamped like any add (the server re-stamps it). */
	readonly toWidget: (entry: {
		readonly core: WidgetCore;
		readonly origin: NotebookWidgetOrigin;
	}) => NotebookWidget;
	/** Replaces one widget's content, title and size, keeping its metadata. */
	readonly replaceWidget: (core: WidgetCore) => Promise<boolean>;
	/** True when the server keeps an earlier body, so `undo` restores it. */
	readonly undoAvailable: Accessor<boolean>;
	/** Restores the body kept before the version on screen. */
	readonly undo: () => Promise<boolean>;
	/** Owner confirmation of an assistant's proposed removals. */
	readonly removeWidgets: (widgetIds: readonly string[]) => Promise<boolean>;
}

/** Why the session shows a notice; worded when read, so it follows a language change. */
type NoticeCause =
	| { readonly kind: "conflict" | "notSaved" | "notRestored"; readonly failure: ApiFailure }
	| { readonly kind: "capacity"; readonly problem: NotebookCapacityProblem };

function noticeText(cause: NoticeCause, words: NotebookSessionWords): string {
	switch (cause.kind) {
		case "conflict":
			return words.conflict;
		case "notSaved":
			return words.notSaved(cause.failure);
		case "notRestored":
			return words.notRestored(cause.failure);
		case "capacity":
			return words.capacity(cause.problem);
	}
}

function confirmedWidgets(state: NotebookResponse | null): readonly NotebookWidget[] {
	return state?.notebook.widgets ?? [];
}

/**
 * Reuses the previous object for every widget whose `widgetId` and `revision`
 * are unchanged (and whose size and position did not change), so `<For>`
 * keeps its DOM and charts are not re-mounted.
 */
export function adoptWidgetIdentity(
	previous: readonly NotebookWidget[],
	next: readonly NotebookWidget[],
): readonly NotebookWidget[] {
	const previousById = new Map(previous.map((widget) => [widget.widgetId, widget] as const));
	const previousIndex = new Map(previous.map((widget, index) => [widget.widgetId, index] as const));
	return next.map((widget, index) => {
		const old = previousById.get(widget.widgetId);
		if (old === undefined) return widget;
		if (old.revision !== widget.revision) return widget;
		if (old.size !== widget.size) return widget;
		if (previousIndex.get(widget.widgetId) !== index) return widget;
		return old;
	});
}

function orderSelection(
	selection: readonly string[],
	widgets: readonly NotebookWidget[],
): readonly string[] {
	const order = new Map(widgets.map((widget, index) => [widget.widgetId, index] as const));
	return [...selection]
		.filter((id) => order.has(id))
		.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * `words` gives the notices' words in the current language (the caller
 * passes `useMessages(notebookSessionMessages)`); English without it.
 */
export function createNotebookSession(
	api: ApiClient,
	workspaceId: string,
	visibility: VisibilitySource,
	words: Accessor<NotebookSessionWords>,
): NotebookSession {
	const [state, setState] = createSignal<NotebookResponse | null>(null);
	const [optimistic, setOptimistic] = createSignal<readonly NotebookWidget[] | null>(null);
	const [loadError, setLoadError] = createSignal<ApiFailure | null>(null);
	const [noticeCause, setNotice] = createSignal<NoticeCause | null>(null);
	const notice: NotebookSession["notice"] = () => {
		const cause = noticeCause();
		if (cause === null) return null;
		return {
			text: noticeText(cause, words()),
			failure: cause.kind === "capacity" ? null : cause.failure,
		};
	};
	const [pending, setPending] = createSignal(false);
	const [selection, setSelection] = createSignal<readonly string[]>([]);

	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	/** Changes waiting to be saved, in the order they were made. */
	let queue: {
		readonly change: (widgets: readonly NotebookWidget[]) => readonly NotebookWidget[];
		readonly resolve: (saved: boolean) => void;
	}[] = [];
	let saving = false;
	let pendingUndo = false;

	const displayed = (): readonly NotebookWidget[] => optimistic() ?? confirmedWidgets(state());

	const pruneSelection = (widgets: readonly NotebookWidget[]): void => {
		setSelection((current) => orderSelection(current, widgets));
	};

	/** Installs a server state, reusing unchanged widget objects and pruning the selection. */
	const installConfirmed = (next: NotebookResponse): void => {
		setState((previous) => {
			const prevWidgets = previous === null ? [] : previous.notebook.widgets;
			const widgets = adoptWidgetIdentity(prevWidgets, next.notebook.widgets);
			return { ...next, notebook: { widgets: [...widgets] } };
		});
		pruneSelection(next.notebook.widgets);
	};

	const reload = async (): Promise<void> => {
		// A visibility catch-up never clobbers a save in flight (like Home's
		// re-read, which is skipped while busy); an explicit retry while idle
		// still goes through.
		if (saving || pendingUndo) return;
		const result = await api.getNotebook(workspaceId);
		if (disposed) return;
		if (result.ok) {
			installConfirmed(result.value);
			setOptimistic(null);
			setLoadError(null);
		} else {
			setLoadError(result.error);
		}
	};

	const pump = async (): Promise<void> => {
		if (saving || disposed) return;
		if (queue.length === 0) return;
		// Takes everything queued so far as one save; edits made meanwhile
		// stay queued and are applied to the confirmed result afterwards.
		const batch = queue;
		queue = [];
		saving = true;
		setPending(true);
		try {
			const payload = optimistic() ?? confirmedWidgets(state());
			const expectedVersion = state()?.version ?? 0;
			const result = await api.saveNotebook(
				workspaceId,
				{ widgets: [...payload] },
				expectedVersion,
			);
			if (disposed) return;
			if (result.ok) {
				installConfirmed(result.value);
				if (queue.length === 0) {
					setOptimistic(null);
				} else {
					// Re-applies the edits that arrived meanwhile to the
					// confirmed result, in order, and saves them next.
					let next = confirmedWidgets(state());
					for (const entry of queue) next = entry.change(next);
					setOptimistic(next);
					pruneSelection(next);
				}
				for (const entry of batch) entry.resolve(true);
			} else if (result.error.code === "VERSION_CONFLICT") {
				// Adopts the latest server state; the conflicting batch is
				// dropped, queued edits are re-applied on top of it.
				const latest = await api.getNotebook(workspaceId);
				if (disposed) return;
				if (latest.ok) {
					installConfirmed(latest.value);
					if (queue.length === 0) {
						setOptimistic(null);
					} else {
						let next = confirmedWidgets(state());
						for (const entry of queue) next = entry.change(next);
						setOptimistic(next);
						pruneSelection(next);
					}
				} else {
					setOptimistic(null);
					pruneSelection(confirmedWidgets(state()));
				}
				setNotice({ kind: "conflict", failure: result.error });
				for (const entry of batch) entry.resolve(false);
			} else {
				// Rolls back the failed batch; queued edits stay queued.
				if (queue.length === 0) {
					setOptimistic(null);
				} else {
					let next = confirmedWidgets(state());
					for (const entry of queue) next = entry.change(next);
					setOptimistic(next);
				}
				pruneSelection(displayed());
				setNotice({ kind: "notSaved", failure: result.error });
				for (const entry of batch) entry.resolve(false);
			}
		} finally {
			saving = false;
			if (!disposed) setPending(queue.length > 0 || pendingUndo);
		}
		// A save that queued more work chains the next save outside the
		// `finally` (a throwing call inside `finally` would mask the outcome).
		if (!disposed && queue.length > 0) void pump();
	};

	const edit = (
		change: (widgets: readonly NotebookWidget[]) => readonly NotebookWidget[],
	): Promise<boolean> => {
		const current = displayed();
		const next = change(current);
		// The server applies the same rule; refusing here says why at once
		// instead of flashing the widget in and rolling it back.
		const capacity = notebookCapacityProblem(next, current);
		if (capacity !== null) {
			setNotice({ kind: "capacity", problem: capacity });
			return Promise.resolve(false);
		}
		setOptimistic(next);
		pruneSelection(next);
		return new Promise<boolean>((resolve) => {
			queue.push({ change, resolve });
			void pump();
		});
	};

	const stopWatching = visibility.subscribe(() => {
		if (visibility.isVisible()) void reload();
	});
	onCleanup(() => stopWatching());

	void reload();

	const toWidget: NotebookSession["toWidget"] = ({ core, origin }) => {
		const now = new Date().toISOString();
		return { ...core, createdAt: now, updatedAt: now, revision: 1, origin };
	};

	const addWidgets: NotebookSession["addWidgets"] = async (entries, toIndex) => {
		if (entries.length === 0) return [];
		const placeholders: NotebookWidget[] = entries.map(toWidget);
		const insert = (widgets: readonly NotebookWidget[]): readonly NotebookWidget[] => {
			const index =
				toIndex === undefined ? widgets.length : Math.max(0, Math.min(toIndex, widgets.length));
			return [...widgets.slice(0, index), ...placeholders, ...widgets.slice(index)];
		};
		const saved = await edit(insert);
		return saved ? placeholders.map((placeholder) => placeholder.widgetId) : null;
	};

	return {
		state,
		widgets: displayed,
		loadError,
		notice,
		dismissNotice: () => setNotice(null),
		pending,
		selection,
		select: (widgetId, mode) => {
			if (widgetId === null) {
				setSelection([]);
				return;
			}
			const widgets = displayed();
			if (mode === "replace") {
				setSelection(widgets.some((widget) => widget.widgetId === widgetId) ? [widgetId] : []);
				return;
			}
			setSelection((current) => {
				const next = current.includes(widgetId)
					? current.filter((id) => id !== widgetId)
					: [...current, widgetId];
				return orderSelection(next, widgets);
			});
		},
		turns: () => state()?.turns ?? [],
		reload,
		edit,
		toWidget,
		replaceWidget: (core) =>
			edit((current) =>
				current.map((entry) =>
					entry.widgetId === core.widgetId
						? {
								...core,
								createdAt: entry.createdAt,
								updatedAt: entry.updatedAt,
								revision: entry.revision,
								origin: entry.origin,
							}
						: entry,
				),
			),
		undoAvailable: () => state()?.undoAvailable ?? false,
		addWidgets,
		addWidget: async (core, origin, toIndex) => {
			const ids = await addWidgets([{ core, origin }], toIndex);
			return ids?.[0] ?? null;
		},
		undo: async () => {
			const version = state()?.version ?? 0;
			if (version <= 0 || pending() || disposed) return false;
			pendingUndo = true;
			setPending(true);
			try {
				const result = await api.undoNotebook(workspaceId, version);
				if (disposed) return false;
				if (result.ok) {
					installConfirmed(result.value);
					setOptimistic(null);
					setNotice(null);
					return true;
				}
				setNotice({ kind: "notRestored", failure: result.error });
				return false;
			} finally {
				pendingUndo = false;
				if (queue.length === 0) setPending(false);
			}
		},
		removeWidgets: (widgetIds) =>
			edit((widgets) => widgets.filter((widget) => !widgetIds.includes(widget.widgetId))),
	};
}
