import type {
	NotebookWidget,
	NotebookWidgetCore,
	NotebookWidgetOrigin,
	WorkspaceView,
} from "@research/contracts";
import {
	type HomeWidget,
	homeWidgetAsNotebookWidget,
	isNotebookMarketWidget,
	type MarketCatalogEntry,
	NOTEBOOK_MARKET_WIDGET_TYPES,
	NOTEBOOK_WIDGET_TYPE_META,
	type NotebookMarketWidgetType,
} from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import {
	createMoveAnnouncer,
	MoveAnnouncerView,
	type WidgetDragDrop,
	WidgetFrame,
	WidgetGrid,
} from "@research/widget-grid";
// The package stylesheet: without it the grid and the frames are unstyled
// markup. Home loads it in its own lazy chunk, so the Chat page imports it too.
import "@research/widget-grid/styles.css";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import {
	ActionMenu,
	BUTTON,
	Empty,
	ErrorNotice,
	IconButton,
	Loading,
	Notice,
} from "../components/ui.tsx";
import { ensureHomeIconLibraries } from "../home/shoelace.ts";
import { createNotebookGridEntries } from "./gridEntries.ts";
import { NotebookMarketDialog, type NotebookMarketDialogState } from "./MarketWidgetDialog.tsx";
import { NotebookEditor } from "./NotebookEditor.tsx";
import { createNotebookMarketContext } from "./notebookMarket.ts";
import {
	duplicateNotebookWidget,
	moveNotebookWidget,
	newNotebookWidgetId,
	reorderNotebookWidgets,
	resizeNotebookWidget,
} from "./notebookModel.ts";
import type { NotebookSession } from "./notebookSession.ts";
import type { WorkspaceMode } from "./types.ts";
import {
	clipboardCountText,
	removedCountText,
	resolveClipboardPaste,
	skippedResearchNoticeText,
	type WidgetClipboardEntry,
	type WidgetClipboardStore,
	widgetClipboard,
} from "./widgetClipboard.ts";
import { WidgetBody } from "./widgets/WidgetBody.tsx";

/**
 * The Notebook panel (ADR-0020): persistent widgets on the shared
 * `@research/widget-grid` package (container columns, quiet variant,
 * header-click selection, the standard size picker). One panel, two modes:
 * `chat` is the narrow secondary panel, `notebook` the dominant workspace.
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
	/**
	 * The widget clipboard (the app singleton by default, shared across
	 * chats; a test double in tests so clipboard state never leaks between
	 * cases through `localStorage`).
	 */
	readonly clipboard?: WidgetClipboardStore;
	/** Typed backend access for market widgets (series data, refresh, watchlist). */
	readonly api: ApiClient;
}

function ownerOrigin(): NotebookWidgetOrigin {
	return { kind: "owner", messageId: null, runId: null, componentId: null };
}

function starterOf(type: "text" | "metric" | "chart" | "table"): NotebookWidgetCore {
	const widgetId = newNotebookWidgetId();
	switch (type) {
		case "text":
			return { widgetId, type, title: "New note", size: "small", text: "New note" };
		case "metric":
			return {
				widgetId,
				type,
				title: "New metric",
				size: "small",
				value: null,
				unit: "",
				change: null,
				caption: "",
				asOf: null,
			};
		case "chart":
			return {
				widgetId,
				type,
				title: "New chart",
				size: "small",
				chartType: "line",
				unit: "",
				series: [
					{
						name: "Series 1",
						points: [
							{ x: "A", y: 1 },
							{ x: "B", y: 2 },
						],
					},
				],
			};
		case "table":
			return {
				widgetId,
				type,
				title: "New table",
				size: "small",
				columns: ["Label", "Value"],
				rows: [["Example", 1]],
			};
	}
}

export function NotebookPanel(props: NotebookPanelProps): JSX.Element {
	// Market widgets reuse Home's Shoelace controls (range select, add/edit
	// form): point the icon libraries at the shipped SVGs like Home does, so
	// no `data:` fetch ever hits `connect-src`. Idempotent.
	ensureHomeIconLibraries();
	const widgets = () => props.session.widgets();
	const gridEntries = createNotebookGridEntries(widgets);
	const selection = () => props.session.selection();
	const announcer = createMoveAnnouncer();
	const [editorId, setEditorId] = createSignal<string | null>(null);
	const [editorOpener, setEditorOpener] = createSignal<HTMLElement | null>(null);
	/**
	 * Live market data for the notebook's market widgets (ADR-0021): the
	 * Home components in `WidgetBody` read their series through this, the
	 * same shape HomeView passes them. Loads nothing until the notebook
	 * holds a market widget.
	 */
	const market = createNotebookMarketContext({
		api: props.api,
		workspaceId: () => props.session.state()?.workspaceId ?? null,
		widgets,
	});
	const [marketDialog, setMarketDialog] = createSignal<NotebookMarketDialogState | null>(null);
	const [marketOpener, setMarketOpener] = createSignal<HTMLElement | null>(null);
	const [catalog, setCatalog] = createSignal<readonly MarketCatalogEntry[] | null>(null);
	const [catalogState, setCatalogState] = createSignal<"loading" | "ready" | "error">("loading");
	let catalogLoading = false;

	const editing = (): NotebookWidget | null => {
		const id = editorId();
		if (id === null) return null;
		return widgets().find((widget) => widget.widgetId === id) ?? null;
	};

	/** Home's series catalog for the market-widget form, loaded on first use. */
	const ensureCatalog = (): void => {
		if (catalog() !== null || catalogLoading) return;
		catalogLoading = true;
		setCatalogState("loading");
		void props.api.listMarketCatalog().then((result) => {
			if (result.ok) {
				setCatalog(result.value);
				setCatalogState("ready");
			} else {
				catalogLoading = false;
				setCatalogState("error");
			}
		});
	};

	const openMarketDialog = (state: NotebookMarketDialogState): void => {
		const active = document.activeElement;
		setMarketOpener(active instanceof HTMLElement ? active : null);
		setMarketDialog(state);
		ensureCatalog();
	};

	const openEditor = (widgetId: string): void => {
		const widget = widgets().find((entry) => entry.widgetId === widgetId);
		const active = document.activeElement;
		// Market widgets are edited in Home's form (series, range, days
		// ahead); the other types use the notebook editor.
		if (widget !== undefined && isNotebookMarketWidget(widget)) {
			setMarketOpener(active instanceof HTMLElement ? active : null);
			setMarketDialog({ mode: "edit", widget });
			ensureCatalog();
			return;
		}
		setEditorOpener(active instanceof HTMLElement ? active : null);
		setEditorId(widgetId);
	};

	const addStarter = (type: "text" | "metric" | "chart" | "table"): void => {
		const active = document.activeElement;
		const opener = active instanceof HTMLElement ? active : null;
		void props.session.addWidget(starterOf(type), ownerOrigin()).then((id) => {
			if (id !== null) {
				setEditorOpener(opener);
				setEditorId(id);
			}
		});
	};

	const duplicateOne = (widget: NotebookWidget): void => {
		const index = widgets().findIndex((entry) => entry.widgetId === widget.widgetId);
		const core = duplicateNotebookWidget(widget);
		void props.session.addWidget(core, ownerOrigin(), index < 0 ? undefined : index + 1);
	};

	const duplicateMany = (ids: readonly string[]): void => {
		const snapshot = widgets();
		// Duplicates land directly after their original, in notebook order.
		const ordered = [...ids].sort(
			(a, b) =>
				snapshot.findIndex((widget) => widget.widgetId === a) -
				snapshot.findIndex((widget) => widget.widgetId === b),
		);
		let offset = 0;
		for (const id of ordered) {
			const original = snapshot.find((widget) => widget.widgetId === id);
			if (original === undefined) continue;
			const index = snapshot.findIndex((widget) => widget.widgetId === id);
			const core = duplicateNotebookWidget(original);
			void props.session.addWidget(core, ownerOrigin(), index + 1 + offset);
			offset += 1;
		}
	};

	const move = (widget: NotebookWidget, direction: "earlier" | "later"): void => {
		const next = moveNotebookWidget(widgets(), widget.widgetId, direction);
		if (next === widgets()) return;
		void props.session
			.edit(() => next)
			.then((saved) => {
				if (!saved) return;
				const position = next.findIndex((entry) => entry.widgetId === widget.widgetId);
				announcer.announceMove(widget.title, position + 1, next.length);
			});
	};

	const resize = (widget: NotebookWidget, size: NotebookWidget["size"]): void => {
		if (widget.size === size) return;
		void props.session.edit((current) => resizeNotebookWidget(current, widget.widgetId, size));
	};

	const onDrop = (drop: WidgetDragDrop): Promise<void> => {
		const target = widgets().find((widget) => widget.widgetId === drop.widgetId);
		if (target === undefined) return Promise.resolve();
		const next = reorderNotebookWidgets(widgets(), drop.widgetId, drop.toIndex);
		return props.session
			.edit(() => next)
			.then((saved) => {
				if (!saved) return;
				const position = next.findIndex((entry) => entry.widgetId === drop.widgetId);
				announcer.announceMove(target.title, position + 1, next.length);
			});
	};

	const onSectionKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		if (editorId() !== null) return;
		const target = event.target;
		// The in-place text editor leaves itself on Escape first (it stops
		// propagation); anything from inside it never reaches for selection.
		if (target instanceof HTMLElement && target.closest("[data-rich-text-editor]") !== null) return;
		if (target instanceof HTMLElement && target.closest('[role="menu"],dialog') !== null) return;
		if (selection().length > 0) props.session.select(null, "replace");
	};

	/** In-place text edits (the rich-text widget) save like any owner edit. */
	const saveText = (widgetId: string, text: string): Promise<boolean> =>
		props.session.edit((current) =>
			current.map((entry) =>
				entry.widgetId === widgetId && entry.type === "text" && entry.text !== text
					? { ...entry, text }
					: entry,
			),
		);

	/**
	 * A market widget edited through its Home component (today: the
	 * line-chart range select) saves like any owner edit, keeping the
	 * server-stamped metadata.
	 */
	const saveMarketWidget = (widget: HomeWidget): void => {
		void props.session.edit((current) =>
			current.map((entry) => {
				if (entry.widgetId !== widget.widgetId || !isNotebookMarketWidget(entry)) return entry;
				const core = homeWidgetAsNotebookWidget(widget);
				return {
					...core,
					createdAt: entry.createdAt,
					updatedAt: entry.updatedAt,
					revision: entry.revision,
					origin: entry.origin,
				};
			}),
		);
	};

	/** Saves the market-widget dialog: an edit keeps the metadata, an add is owner-made. */
	const saveMarketDialog = (core: NotebookWidgetCore): void => {
		const current = marketDialog();
		setMarketDialog(null);
		if (current?.mode === "edit") {
			void props.session.edit((widgets) =>
				widgets.map((entry) =>
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
			);
		} else {
			void props.session.addWidget(core, ownerOrigin());
		}
	};

	const undoAvailable = () => props.session.state()?.undoAvailable ?? false;
	const pending = () => props.session.pending();
	const notice = () => props.session.notice();

	const clipboardStore = props.clipboard ?? widgetClipboard();
	/** The conversation on screen; null until the notebook loads. */
	const workspaceId = () => props.session.state()?.workspaceId ?? null;
	const clipboardEmpty = () => clipboardStore.isEmpty();

	/** Polite announcements for completed cut / copy / paste / remove (moves have their own). */
	const [actionMessage, setActionMessage] = createSignal("");
	let announcerDisposed = false;
	onCleanup(() => {
		announcerDisposed = true;
	});
	const announceAction = (text: string): void => {
		// A live region announces nothing when the same text is set twice:
		// clear first and set on a later task, like the move announcer.
		setActionMessage("");
		window.setTimeout(() => {
			if (!announcerDisposed) setActionMessage(text);
		}, 0);
	};

	/** The skipped-research notice of the last paste, until dismissed. */
	const [pasteNotice, setPasteNotice] = createSignal<string | null>(null);

	/** The selection in notebook order (the session already keeps it ordered). */
	const orderedSelection = (): readonly string[] => {
		const selected = new Set(props.session.selection());
		return widgets()
			.filter((widget) => selected.has(widget.widgetId))
			.map((widget) => widget.widgetId);
	};

	/** Clipboard entries for widgets, in notebook order (skips unknown ids). */
	const clipboardEntriesOf = (ids: readonly string[]): WidgetClipboardEntry[] => {
		const wanted = new Set(ids);
		const entries: WidgetClipboardEntry[] = [];
		for (const widget of widgets()) {
			if (!wanted.has(widget.widgetId)) continue;
			// The core keeps no metadata: the contract schema is strict, so a
			// stowaway `origin` inside `core` would fail the storage re-read
			// (an empty clipboard after every reload) while pasting from
			// memory still worked.
			const { createdAt, updatedAt, revision, origin, ...core } = widget;
			void createdAt;
			void updatedAt;
			void revision;
			entries.push({ core, origin });
		}
		return entries;
	};

	const copyToClipboard = (ids: readonly string[]): number => {
		const target = workspaceId();
		if (target === null) return 0;
		const entries = clipboardEntriesOf(ids);
		if (entries.length === 0) return 0;
		clipboardStore.set(target, entries);
		return entries.length;
	};

	const copyIds = (ids: readonly string[]): void => {
		const count = copyToClipboard(ids);
		if (count > 0) announceAction(clipboardCountText(count, "Copied"));
	};

	/**
	 * Cut fills the clipboard first and removes the widgets in one owner
	 * edit — no confirmation, because Undo restores them and the clipboard
	 * still holds them.
	 */
	const cutIds = (ids: readonly string[]): void => {
		if (pending()) return;
		const target = workspaceId();
		if (target === null) return;
		const entries = clipboardEntriesOf(ids);
		if (entries.length === 0) return;
		clipboardStore.set(target, entries);
		const wanted = new Set(entries.map((entry) => entry.core.widgetId));
		const count = entries.length;
		void props.session
			.edit((current) => current.filter((widget) => !wanted.has(widget.widgetId)))
			.then((saved) => {
				if (saved) announceAction(clipboardCountText(count, "Cut"));
			});
	};

	/**
	 * Remove takes the widgets out in one owner edit with no confirmation,
	 * like Cut and like Home's Remove: Undo restores them.
	 */
	const removeIds = (ids: readonly string[]): void => {
		if (pending()) return;
		const wanted = new Set(ids);
		const count = widgets().filter((widget) => wanted.has(widget.widgetId)).length;
		if (count === 0) return;
		void props.session.removeWidgets([...wanted]).then((saved) => {
			if (saved) announceAction(removedCountText(count));
		});
	};

	const pasteEntries = (
		entries: readonly WidgetClipboardEntry[],
		toIndex: number,
		skippedResearch: number,
	): void => {
		void props.session.addWidgets(entries, toIndex).then((ids) => {
			if (ids === null) return;
			props.session.select(null, "replace");
			for (const id of ids) props.session.select(id, "toggle");
			announceAction(clipboardCountText(ids.length, "Pasted"));
			setPasteNotice(skippedResearch > 0 ? skippedResearchNoticeText(skippedResearch) : null);
		});
	};

	/**
	 * Paste after one widget (its menu), else after the last selected widget
	 * (header, ⌘V), else at the end — as one owner edit, selecting exactly
	 * the pasted widgets. The clipboard keeps its content for another paste.
	 */
	const pasteAfter = (afterWidgetId: string | null): void => {
		const target = workspaceId();
		if (target === null || pending()) return;
		const resolved = resolveClipboardPaste(clipboardStore.content(), target);
		if (resolved.entries.length === 0) {
			// Everything on the clipboard belongs to another chat: say so.
			if (resolved.skippedResearch > 0)
				setPasteNotice(skippedResearchNoticeText(resolved.skippedResearch));
			return;
		}
		const current = widgets();
		const fallback = orderedSelection();
		const anchorId = afterWidgetId ?? fallback[fallback.length - 1] ?? null;
		let toIndex = current.length;
		if (anchorId !== null) {
			const anchor = current.findIndex((widget) => widget.widgetId === anchorId);
			if (anchor >= 0) toIndex = anchor + 1;
		}
		pasteEntries(resolved.entries, toIndex, resolved.skippedResearch);
	};

	/**
	 * Targets a clipboard shortcut must never steal: text fields, the
	 * in-place rich-text editor, dialogs and menus.
	 */
	const CLIPBOARD_GUARD_SELECTOR =
		'input,textarea,select,[contenteditable],[data-rich-text-editor],dialog,[role="menu"]';
	let sectionElement: HTMLElement | undefined;

	/**
	 * ⌘X / ⌘C / ⌘V (Ctrl on other systems) on the selected widgets. A
	 * document-level listener, not the section's keydown: selecting a widget
	 * by clicking its header leaves focus on `<body>` (the header strip is
	 * not focusable, and it belongs to `packages/widget-grid`, which this
	 * task must not touch), so the section would never see the key. It acts
	 * only when focus is inside this panel or on `<body>` itself — never
	 * from another panel's control — and `preventDefault`s only when it
	 * acts, so a text copy stays the browser's.
	 */
	const onDocumentKeyDown = (event: KeyboardEvent): void => {
		if (event.defaultPrevented) return;
		if (!event.metaKey && !event.ctrlKey) return;
		if (event.altKey) return;
		const key = event.key.toLowerCase();
		if (key !== "x" && key !== "c" && key !== "v") return;
		const target = event.target;
		if (target instanceof HTMLElement && target.closest(CLIPBOARD_GUARD_SELECTOR) !== null) return;
		const inScope =
			target === document.body ||
			target === document.documentElement ||
			(target instanceof Node && sectionElement !== undefined && sectionElement.contains(target));
		if (!inScope) return;
		if (key === "v") {
			if (clipboardEmpty() || pending()) return;
			event.preventDefault();
			pasteAfter(null);
			return;
		}
		const selected = orderedSelection();
		if (selected.length === 0) return;
		// A non-empty text selection belongs to the browser (quoting text).
		const textSelection = window.getSelection();
		if (textSelection !== null && !textSelection.isCollapsed) return;
		event.preventDefault();
		if (key === "x") cutIds(selected);
		else copyIds(selected);
	};

	onMount(() => {
		document.addEventListener("keydown", onDocumentKeyDown);
		onCleanup(() => document.removeEventListener("keydown", onDocumentKeyDown));
	});

	return (
		<section
			aria-label="Notebook"
			data-panel="notebook"
			data-mode={props.mode}
			class="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
			ref={(element) => {
				sectionElement = element;
			}}
			onKeyDown={onSectionKeyDown}
		>
			<div class="flex items-center gap-1">
				<h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
					Notebook
					<span class="font-normal text-slate-600"> ({widgets().length})</span>
				</h3>
				{props.headerActions}
				<IconButton
					label="Paste widgets"
					icon="clipboard"
					disabled={clipboardEmpty() || pending()}
					onClick={() => pasteAfter(null)}
				/>
				<IconButton
					label="Undo"
					icon="arrow-counterclockwise"
					disabled={!undoAvailable() || pending()}
					onClick={() => void props.session.undo()}
				/>
				<ActionMenu
					buttonLabel="Add widget"
					menuLabel="Add widget"
					iconTrigger={{ icon: "plus-lg", disabled: pending() }}
					items={[
						{ value: "text", label: "Text", onSelect: () => addStarter("text") },
						{ value: "metric", label: "Metric", onSelect: () => addStarter("metric") },
						{ value: "chart", label: "Chart", onSelect: () => addStarter("chart") },
						{ value: "table", label: "Table", onSelect: () => addStarter("table") },
						// Live market widgets (ADR-0021), reusing Home's components
						// and form; each needs a series, so adding opens the form.
						...(NOTEBOOK_MARKET_WIDGET_TYPES as readonly NotebookMarketWidgetType[]).map(
							(type) => ({
								value: type,
								label: NOTEBOOK_WIDGET_TYPE_META[type].label,
								onSelect: () => openMarketDialog({ mode: "add", notebookType: type }),
							}),
						),
					]}
				/>
			</div>

			<Show when={notice()}>
				{(item) => (
					<Notice tone={item().failure?.code === "VERSION_CONFLICT" ? "warning" : "error"}>
						<span class="flex flex-wrap items-center gap-2">
							<span>{item().text}</span>
							<button type="button" class={BUTTON} onClick={() => props.session.dismissNotice()}>
								Dismiss
							</button>
						</span>
					</Notice>
				)}
			</Show>

			<Show when={pasteNotice()}>
				{(text) => (
					<Notice tone="info">
						<span class="flex flex-wrap items-center gap-2">
							<span>{text()}</span>
							<button type="button" class={BUTTON} onClick={() => setPasteNotice(null)}>
								Dismiss
							</button>
						</span>
					</Notice>
				)}
			</Show>

			<Show when={selection().length > 0}>
				<div
					role="toolbar"
					aria-label="Selected widgets"
					class="flex flex-wrap items-center gap-1 rounded bg-slate-100 p-1"
				>
					<span class="px-1 text-xs text-slate-700">{selection().length} selected</span>
					<IconButton
						label="Ask AI about the selected widgets"
						icon="chat"
						onClick={() => props.onAskAssistant(selection())}
					/>
					<IconButton
						label="Duplicate selected widgets"
						icon="plus-square"
						onClick={() => duplicateMany(selection())}
					/>
					<IconButton
						label="Cut selected widgets"
						icon="scissors"
						disabled={pending()}
						onClick={() => cutIds(selection())}
					/>
					<IconButton
						label="Copy selected widgets"
						icon="copy"
						onClick={() => copyIds(selection())}
					/>
					<IconButton
						label="Remove selected widgets"
						icon="trash"
						disabled={pending()}
						onClick={() => removeIds(selection())}
					/>
					<IconButton
						label="Clear selection"
						icon="x-lg"
						onClick={() => props.session.select(null, "replace")}
					/>
				</div>
			</Show>

			<MoveAnnouncerView message={announcer.message()} />
			<output aria-live="polite" class="sr-only">
				{actionMessage()}
			</output>

			{/* The widget list scrolls on its own below the fixed header and
			    toolbar (the Chat page is viewport-tall from lg up). The
			    bottom padding keeps the last frame's focus ring visible. */}
			<div
				data-notebook-scroll
				class="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pt-3 pb-2"
			>
				<Switch>
					<Match when={props.session.state() === null && props.session.loadError() === null}>
						<Loading label="notebook" />
					</Match>
					<Match when={props.session.loadError()}>
						{(error) => (
							<ErrorNotice
								failure={error()}
								title="Could not load the notebook."
								onRetry={() => void props.session.reload()}
							/>
						)}
					</Match>
					<Match when={widgets().length === 0}>
						<Empty>Save answers, charts and tables from Chat to build your notebook.</Empty>
					</Match>
					<Match when={widgets().length > 0}>
						<WidgetGrid
							widgets={gridEntries()}
							columnsFrom="container"
							variant="quiet"
							canDrag={!pending()}
							ignoreDragFrom="dialog,input,select,textarea,[data-rich-text-editor]"
							onReorder={onDrop}
						>
							{(entry, index) => (
								<WidgetFrame
									widget={entry}
									titleHidden
									selected={selection().includes(entry.widgetId)}
									onSelectChange={(id, mode) => props.session.select(id, mode)}
									actions={
										<ActionMenu
											buttonLabel={`${entry.title} actions`}
											menuLabel={`Actions for ${entry.title}`}
											iconTrigger={{
												icon: "three-dots",
												disabled: pending(),
												widgetActions: entry.widgetId,
											}}
											items={[
												{
													value: "edit",
													label: "Edit…",
													icon: "pencil",
													disabled: pending(),
													onSelect: () => openEditor(entry.widgetId),
												},
												{
													value: "size-small",
													label: "Size: Small",
													disabled: pending() || entry.size === "small",
													onSelect: () => resize(entry.widget, "small"),
												},
												{
													value: "size-medium",
													label: "Size: Medium",
													disabled: pending() || entry.size === "medium",
													onSelect: () => resize(entry.widget, "medium"),
												},
												{
													value: "size-large",
													label: "Size: Large",
													disabled: pending() || entry.size === "large",
													onSelect: () => resize(entry.widget, "large"),
												},
												{
													value: "cut",
													label: "Cut",
													icon: "scissors",
													disabled: pending(),
													onSelect: () => cutIds([entry.widgetId]),
												},
												{
													value: "copy",
													label: "Copy",
													icon: "copy",
													onSelect: () => copyIds([entry.widgetId]),
												},
												{
													value: "paste-after",
													label: "Paste after",
													icon: "clipboard",
													disabled: clipboardEmpty() || pending(),
													onSelect: () => pasteAfter(entry.widgetId),
												},
												{
													value: "duplicate",
													label: "Duplicate",
													icon: "plus-square",
													disabled: pending(),
													onSelect: () => duplicateOne(entry.widget),
												},
												{
													value: "earlier",
													label: "Move earlier",
													icon: "arrow-left",
													disabled: pending() || index() === 0,
													onSelect: () => move(entry.widget, "earlier"),
												},
												{
													value: "later",
													label: "Move later",
													icon: "arrow-right",
													disabled: pending() || index() === widgets().length - 1,
													onSelect: () => move(entry.widget, "later"),
												},
												{
													value: "ask",
													label: "Ask AI",
													icon: "chat",
													disabled: pending(),
													onSelect: () => props.onAskAssistant([entry.widgetId]),
												},
												...(entry.widget.origin.messageId !== null
													? [
															{
																value: "source",
																label: "Go to source",
																disabled: pending(),
																onSelect: () => props.onOpenOrigin?.(entry.widget.origin),
															},
														]
													: []),
												{
													value: "remove",
													label: "Remove",
													icon: "trash",
													disabled: pending(),
													onSelect: () => removeIds([entry.widgetId]),
												},
											]}
										/>
									}
								>
									<WidgetBody
										widget={entry.widget}
										view={props.view}
										registry={props.registry}
										market={market}
										editingDisabled={pending()}
										onSaveText={saveText}
										onSaveMarketWidget={saveMarketWidget}
									/>
								</WidgetFrame>
							)}
						</WidgetGrid>
					</Match>
				</Switch>
			</div>

			<Show when={editing()}>
				{(widget) => (
					<NotebookEditor
						widget={widget()}
						opener={editorOpener()}
						onSave={(core) =>
							props.session.edit((current) =>
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
							)
						}
						onClose={() => {
							setEditorId(null);
						}}
					/>
				)}
			</Show>

			<NotebookMarketDialog
				state={marketDialog()}
				opener={marketOpener()}
				widgets={widgets()}
				catalog={catalog()}
				catalogState={catalogState()}
				seriesById={market.seriesById()}
				onSave={saveMarketDialog}
				onClose={() => setMarketDialog(null)}
			/>
		</section>
	);
}
