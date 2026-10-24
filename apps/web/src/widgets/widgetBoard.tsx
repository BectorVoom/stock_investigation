import {
	isMarketWidget,
	type MarketCatalogEntry,
	type MarketSeries,
	type MarketWidgetCore,
	type NotebookWidgetOrigin,
	WIDGET_TYPE_META,
	type WidgetCore,
	type WidgetSize,
	type WidgetType,
} from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createMoveAnnouncer, MoveAnnouncerView, type WidgetDragDrop } from "@research/widget-grid";
import { type Accessor, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ActionMenu, type ActionMenuItem, BUTTON, IconButton, Notice } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { ContentWidgetEditor } from "./ContentWidgetEditor.tsx";
import { createWidgetGridEntries } from "./gridEntries.ts";
import {
	MarketWidgetDialog,
	type MarketWidgetDialogState,
	type MarketWidgetLimits,
} from "./MarketWidgetDialog.tsx";
import { widgetBoardMessages } from "./widgetBoard.messages.ts";
import { widgetClipboardMessages } from "./widgetClipboard.messages.ts";
import {
	clipboardCountText,
	removedCountText,
	resolveClipboardPaste,
	skippedResearchNoticeText,
	type WidgetClipboardEntry,
	type WidgetClipboardStore,
} from "./widgetClipboard.ts";
import { widgetModelMessages } from "./widgetModel.messages.ts";
import {
	duplicateWidget,
	isStarterWidgetType,
	moveWidget,
	reorderWidgets,
	resizeWidget,
	starterWidget,
} from "./widgetModel.ts";
import { widgetTypeMessages } from "./widgetTypes.messages.ts";

/**
 * The one widget board of the app (ADR-0024): everything the owner can do to
 * widgets, the same on Home and in the Notebook — the per-widget menu (Edit…,
 * Size, Cut, Copy, Paste after, Duplicate, Move, the page's own items,
 * Remove), the add menu, Paste widgets and Undo, the selection toolbar, the
 * ⌘X / ⌘C / ⌘V shortcuts, drag-and-drop reorder, the editors and the polite
 * announcements. Remove acts at once (Undo restores it).
 *
 * The board owns behaviour, not layout: each page places the parts it
 * returns (header buttons, selection toolbar, announcements, the frames'
 * menus, the dialogs) where its own layout wants them, and keeps its own
 * look (Home: titled, bordered frames in viewport columns; Notebook:
 * untitled quiet frames in container columns). Saving belongs to the page's
 * session: the Notebook's server-versioned session, Home's dashboard save.
 */

/** A widget to insert, with where it came from (the clipboard's entry shape). */
export type WidgetBoardEntry = WidgetClipboardEntry;

/** What the board needs from a page's widget state. */
export interface WidgetBoardSession<W extends WidgetCore> {
	/** What is on screen (an optimistic edit while it saves). */
	readonly widgets: Accessor<readonly W[]>;
	/** True while a save or undo is in flight: actions are disabled. */
	readonly pending: Accessor<boolean>;
	/** Selected widget ids in page order. */
	readonly selection: Accessor<readonly string[]>;
	/** `replace` selects one widget alone (or clears with null); `toggle` adds or removes it. */
	readonly select: (widgetId: string | null, mode: "replace" | "toggle") => void;
	/** Applies an owner edit and saves it; resolves true when saved. */
	readonly edit: (change: (widgets: readonly W[]) => readonly W[]) => Promise<boolean>;
	/** Replaces one widget's content, title and size, keeping whatever the page stores beside them. */
	readonly replaceWidget: (core: WidgetCore) => Promise<boolean>;
	/**
	 * A page widget for a new entry (a notebook stamps its metadata and
	 * keeps the origin; Home keeps the core), or null for a type the page
	 * does not take. The board inserts it through `edit`, so every add,
	 * paste and duplicate is one save.
	 */
	readonly toWidget: (entry: WidgetBoardEntry) => W | null;
	readonly undoAvailable: Accessor<boolean>;
	readonly undo: () => Promise<boolean>;
}

export interface WidgetBoardOptions<W extends WidgetCore> {
	readonly session: WidgetBoardSession<W>;
	/**
	 * The types the page takes, in add-menu order (Home: all but `research`).
	 * A paste leaves out any other type; the add menu never offers `research`.
	 */
	readonly types: readonly WidgetType[];
	readonly clipboard: WidgetClipboardStore;
	/** The page's clipboard scope: its conversation id, or Home's; null until loaded. */
	readonly scope: Accessor<string | null>;
	/** Loads the series catalog for the market dialog on first use. */
	readonly api: ApiClient;
	/** The page's live series, for the market dialog's unit checks. */
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
	readonly marketLimits: MarketWidgetLimits;
	/** Items only this page has (Notebook: Ask AI, Go to source), placed before Remove. */
	readonly pageItems?: (widget: W) => readonly ActionMenuItem[];
	/** Called after widgets were added and saved (Home queues a refresh for new series). */
	readonly onAdded?: (widgets: readonly WidgetCore[]) => void;
}

/** A new widget made on the page: owner-made, no chat provenance. */
export function ownerOrigin(): NotebookWidgetOrigin {
	return { kind: "owner", messageId: null, runId: null, componentId: null };
}

/** The widget's core alone: page metadata (a notebook's stamps, origin) never travels. */
export function widgetCoreOf(widget: WidgetCore): WidgetCore {
	return duplicateWidget(widget, widget.widgetId);
}

/**
 * Targets a clipboard shortcut must never steal: text fields, the in-place
 * rich-text editor, dialogs and menus.
 */
const CLIPBOARD_GUARD_SELECTOR =
	'input,textarea,select,[contenteditable],[data-rich-text-editor],dialog,sl-dialog,[role="menu"]';

export function createWidgetBoard<W extends WidgetCore>(options: WidgetBoardOptions<W>) {
	const session = options.session;
	const widgets = session.widgets;
	const pending = session.pending;
	const entries = createWidgetGridEntries(widgets);
	const announcer = createMoveAnnouncer();
	const m = useMessages(widgetBoardMessages);
	const common = useMessages(commonMessages);
	const typeWords = useMessages(widgetTypeMessages);
	const clipboardWords = useMessages(widgetClipboardMessages);
	const starterWords = useMessages(widgetModelMessages);

	const [editorId, setEditorId] = createSignal<string | null>(null);
	const [editorOpener, setEditorOpener] = createSignal<HTMLElement | null>(null);
	const [marketDialog, setMarketDialog] = createSignal<MarketWidgetDialogState | null>(null);
	const [marketOpener, setMarketOpener] = createSignal<HTMLElement | null>(null);
	const [catalog, setCatalog] = createSignal<readonly MarketCatalogEntry[] | null>(null);
	const [catalogState, setCatalogState] = createSignal<"loading" | "ready" | "error">("loading");
	let catalogLoading = false;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	/* ---------- Announcements ---------- */

	/** Polite announcements for completed cut / copy / paste / remove (moves have their own). */
	const [actionMessage, setActionMessage] = createSignal("");
	const announceAction = (text: string): void => {
		// A live region announces nothing when the same text is set twice:
		// clear first and set on a later task, like the move announcer.
		setActionMessage("");
		window.setTimeout(() => {
			if (!disposed) setActionMessage(text);
		}, 0);
	};
	/** The skipped-research notice of the last paste, until dismissed. */
	const [pasteNotice, setPasteNotice] = createSignal<string | null>(null);

	/* ---------- Lookups ---------- */

	const activeOpener = (): HTMLElement | null => {
		const active = document.activeElement;
		return active instanceof HTMLElement ? active : null;
	};
	const indexOf = (widgetId: string): number =>
		widgets().findIndex((widget) => widget.widgetId === widgetId);
	/**
	 * Inserts entries as one save: `at(current)` says where (re-read when the
	 * save applies, so an edit queued before it never shifts the place).
	 * Resolves to the new ids, or null when not saved.
	 */
	const insert = (
		added: readonly WidgetBoardEntry[],
		at: (current: readonly W[]) => number,
	): Promise<readonly string[] | null> => {
		const made = added.flatMap((entry) => {
			const widget = session.toWidget(entry);
			return widget === null ? [] : [widget];
		});
		if (made.length === 0) return Promise.resolve([]);
		return session
			.edit((current) => {
				const index = Math.max(0, Math.min(at(current), current.length));
				return [...current.slice(0, index), ...made, ...current.slice(index)];
			})
			.then((saved) => (saved ? made.map((widget) => widget.widgetId) : null));
	};
	const atEnd = (current: readonly W[]): number => current.length;

	/** The selection in page order (the session keeps it ordered; this re-checks). */
	const orderedSelection = (): readonly string[] => {
		const selected = new Set(session.selection());
		return widgets()
			.filter((widget) => selected.has(widget.widgetId))
			.map((widget) => widget.widgetId);
	};
	const editing = (): W | null => {
		const id = editorId();
		if (id === null) return null;
		return widgets().find((widget) => widget.widgetId === id) ?? null;
	};

	/* ---------- Editors ---------- */

	const ensureCatalog = (): void => {
		if (catalog() !== null || catalogLoading) return;
		catalogLoading = true;
		setCatalogState("loading");
		void options.api.listMarketCatalog().then((result) => {
			if (disposed) return;
			if (result.ok) {
				setCatalog(result.value);
				setCatalogState("ready");
			} else {
				catalogLoading = false;
				setCatalogState("error");
			}
		});
	};

	/** Edit…: the market dialog for a live market widget, the content editor for the rest. */
	const openEditor = (widgetId: string, opener: HTMLElement | null = activeOpener()): void => {
		const widget = widgets().find((entry) => entry.widgetId === widgetId);
		if (widget === undefined) return;
		if (isMarketWidget(widget)) {
			setMarketOpener(opener);
			setMarketDialog({ mode: "edit", widget: marketCoreOf(widget) });
			ensureCatalog();
			return;
		}
		setEditorOpener(opener);
		setEditorId(widgetId);
	};

	const marketCoreOf = (widget: MarketWidgetCore): MarketWidgetCore => {
		const core = widgetCoreOf(widget);
		return isMarketWidget(core) ? core : widget;
	};

	/**
	 * The add menu: a content type is added as a starter and opened in its
	 * editor; a market type needs a series first, so its dialog opens.
	 */
	const addType = (type: WidgetType): void => {
		const opener = activeOpener();
		if (isStarterWidgetType(type)) {
			const core = starterWidget(type, undefined, starterWords());
			void insert([{ core, origin: ownerOrigin() }], atEnd).then((ids) => {
				if (ids === null || disposed) return;
				options.onAdded?.([core]);
				openEditor(core.widgetId, opener);
			});
			return;
		}
		if (type === "research") return;
		setMarketOpener(opener);
		setMarketDialog({ mode: "add", type });
		ensureCatalog();
	};

	/**
	 * Saves the market dialog. The dialog stays open until the save
	 * succeeds, so a refused save (busy, over a bound) shows its reason
	 * beside the dialog instead of losing the owner's input.
	 */
	const saveMarketDialog = (core: MarketWidgetCore): void => {
		const current = marketDialog();
		const saving =
			current?.mode === "edit"
				? session.replaceWidget(core)
				: insert([{ core, origin: ownerOrigin() }], atEnd).then((ids) => ids !== null);
		void saving.then((saved) => {
			if (!saved || disposed) return;
			setMarketDialog(null);
			marketOpener()?.focus();
			options.onAdded?.([core]);
		});
	};

	/* ---------- Edits ---------- */

	/** Duplicate: one save; each copy lands directly after its own original. */
	const duplicateIds = (ids: readonly string[]): void => {
		if (pending()) return;
		const wanted = new Set(ids);
		const copies = new Map<string, W>();
		for (const widget of widgets()) {
			if (!wanted.has(widget.widgetId)) continue;
			const copy = session.toWidget({ core: duplicateWidget(widget), origin: ownerOrigin() });
			if (copy !== null) copies.set(widget.widgetId, copy);
		}
		if (copies.size === 0) return;
		void session.edit((current) =>
			current.flatMap((widget) => {
				const copy = copies.get(widget.widgetId);
				return copy === undefined ? [widget] : [widget, copy];
			}),
		);
	};

	const move = (widget: W, direction: "earlier" | "later"): void => {
		const next = moveWidget(widgets(), widget.widgetId, direction);
		if (next === widgets()) return;
		void session
			.edit(() => next)
			.then((saved) => {
				if (!saved) return;
				const position = next.findIndex((entry) => entry.widgetId === widget.widgetId);
				announcer.announceMove(widget.title, position + 1, next.length);
			});
	};

	const resize = (widget: W, size: WidgetSize): void => {
		if (widget.size === size) return;
		void session.edit((current) => resizeWidget(current, widget.widgetId, size));
	};

	/** A drop saves exactly one reorder; the previewed order stays until the save settles. */
	const onDrop = (drop: WidgetDragDrop): Promise<void> => {
		const target = widgets().find((widget) => widget.widgetId === drop.widgetId);
		if (target === undefined) return Promise.resolve();
		const next = reorderWidgets(widgets(), drop.widgetId, drop.toIndex);
		return session
			.edit(() => next)
			.then((saved) => {
				if (!saved) return;
				const position = next.findIndex((entry) => entry.widgetId === drop.widgetId);
				announcer.announceMove(target.title, position + 1, next.length);
			});
	};

	/**
	 * Remove takes the widgets out in one save with no confirmation, like
	 * Cut: Undo restores them.
	 */
	const removeIds = (ids: readonly string[]): void => {
		if (pending()) return;
		const wanted = new Set(ids);
		const count = widgets().filter((widget) => wanted.has(widget.widgetId)).length;
		if (count === 0) return;
		void session
			.edit((current) => current.filter((widget) => !wanted.has(widget.widgetId)))
			.then((saved) => {
				if (saved) announceAction(removedCountText(count, clipboardWords()));
			});
	};

	/* ---------- Clipboard ---------- */

	const clipboardEntriesOf = (ids: readonly string[]): WidgetBoardEntry[] => {
		const wanted = new Set(ids);
		const found: WidgetBoardEntry[] = [];
		for (const widget of widgets()) {
			if (!wanted.has(widget.widgetId)) continue;
			// The core keeps no metadata: the contract schema is strict, so a
			// stowaway `origin` inside `core` would fail the storage re-read.
			const origin = "origin" in widget && isOrigin(widget.origin) ? widget.origin : ownerOrigin();
			found.push({ core: widgetCoreOf(widget), origin });
		}
		return found;
	};

	const copyToClipboard = (ids: readonly string[]): number => {
		const scope = options.scope();
		if (scope === null) return 0;
		const found = clipboardEntriesOf(ids);
		if (found.length === 0) return 0;
		options.clipboard.set(scope, found);
		return found.length;
	};

	const copyIds = (ids: readonly string[]): void => {
		const count = copyToClipboard(ids);
		if (count > 0) announceAction(clipboardCountText(count, "Copied", clipboardWords()));
	};

	/**
	 * Cut fills the clipboard first and removes the widgets in one save — no
	 * confirmation, because Undo restores them and the clipboard still holds
	 * them.
	 */
	const cutIds = (ids: readonly string[]): void => {
		if (pending()) return;
		const count = copyToClipboard(ids);
		if (count === 0) return;
		const wanted = new Set(ids);
		void session
			.edit((current) => current.filter((widget) => !wanted.has(widget.widgetId)))
			.then((saved) => {
				if (saved) announceAction(clipboardCountText(count, "Cut", clipboardWords()));
			});
	};

	/**
	 * Paste after one widget (its menu), else after the last selected widget
	 * (header, ⌘V), else at the end — as one save, selecting exactly the
	 * pasted widgets. The clipboard keeps its content for another paste.
	 */
	const pasteAfter = (afterWidgetId: string | null): void => {
		const scope = options.scope();
		if (scope === null || pending()) return;
		const resolved = resolveClipboardPaste(options.clipboard.content(), scope);
		const accepted = resolved.entries.filter((entry) => options.types.includes(entry.core.type));
		const skipped = resolved.skippedResearch + (resolved.entries.length - accepted.length);
		if (accepted.length === 0) {
			// Everything on the clipboard belongs to another chat: say so.
			if (skipped > 0) setPasteNotice(skippedResearchNoticeText(skipped, clipboardWords()));
			return;
		}
		const current = widgets();
		const fallback = orderedSelection();
		const anchorId = afterWidgetId ?? fallback[fallback.length - 1] ?? null;
		let toIndex = current.length;
		if (anchorId !== null) {
			const anchor = indexOf(anchorId);
			if (anchor >= 0) toIndex = anchor + 1;
		}
		void insert(accepted, () => toIndex).then((ids) => {
			if (ids === null || disposed) return;
			session.select(null, "replace");
			for (const id of ids) session.select(id, "toggle");
			announceAction(clipboardCountText(ids.length, "Pasted", clipboardWords()));
			setPasteNotice(skipped > 0 ? skippedResearchNoticeText(skipped, clipboardWords()) : null);
			options.onAdded?.(accepted.map((entry) => entry.core));
		});
	};

	/* ---------- In-body edits ---------- */

	/** In-place text edits (the rich-text widget) save like any owner edit. */
	const saveText = (widgetId: string, text: string): Promise<boolean> => {
		const widget = widgets().find((entry) => entry.widgetId === widgetId);
		if (widget === undefined || widget.type !== "text" || widget.text === text) {
			return Promise.resolve(true);
		}
		return session.replaceWidget({ ...widgetCoreOf(widget), type: "text", text });
	};

	/** A market widget edited through its own component (the line-chart range). */
	const saveMarketWidget = (widget: MarketWidgetCore): void => {
		void session.replaceWidget(widget);
	};

	/* ---------- Keyboard ---------- */

	let scopeElement: HTMLElement | undefined;

	/**
	 * ⌘X / ⌘C / ⌘V (Ctrl on other systems) on the selected widgets. A
	 * document-level listener: selecting a widget by clicking its header
	 * leaves focus on `<body>` (the header strip is not focusable), so the
	 * page section would never see the key. It acts only when focus is inside
	 * the page section or on `<body>` itself — never from another panel's
	 * control — and `preventDefault`s only when it acts, so a text copy stays
	 * the browser's.
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
			(target instanceof Node && scopeElement !== undefined && scopeElement.contains(target));
		if (!inScope) return;
		if (key === "v") {
			if (options.clipboard.isEmpty() || pending()) return;
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

	/** Escape on the page section clears the selection (not from editors, menus or dialogs). */
	const onSectionKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		if (editorId() !== null || marketDialog() !== null) return;
		const target = event.target;
		if (target instanceof HTMLElement && target.closest("[data-rich-text-editor]") !== null) return;
		if (target instanceof HTMLElement && target.closest('[role="menu"],dialog,sl-dialog') !== null)
			return;
		if (session.selection().length > 0) session.select(null, "replace");
	};

	/* ---------- Menus ---------- */

	const menuItems = (widget: W, index: number): readonly ActionMenuItem[] => {
		const busy = pending();
		const sizes = WIDGET_TYPE_META[widget.type].sizes;
		return [
			{
				value: "edit",
				label: m().edit,
				icon: "pencil",
				disabled: busy,
				onSelect: () => openEditor(widget.widgetId),
			},
			...sizes.map(
				(size): ActionMenuItem => ({
					value: `size-${size}`,
					label: m().size(size),
					disabled: busy || widget.size === size,
					onSelect: () => resize(widget, size),
				}),
			),
			{
				value: "cut",
				label: common().cut,
				icon: "scissors",
				disabled: busy,
				onSelect: () => cutIds([widget.widgetId]),
			},
			{
				value: "copy",
				label: common().copy,
				icon: "copy",
				onSelect: () => copyIds([widget.widgetId]),
			},
			{
				value: "paste-after",
				label: m().pasteAfter,
				icon: "clipboard",
				disabled: options.clipboard.isEmpty() || busy,
				onSelect: () => pasteAfter(widget.widgetId),
			},
			{
				value: "duplicate",
				label: common().duplicate,
				icon: "plus-square",
				disabled: busy,
				onSelect: () => duplicateIds([widget.widgetId]),
			},
			{
				value: "earlier",
				label: m().moveEarlier,
				icon: "arrow-left",
				disabled: busy || index === 0,
				onSelect: () => move(widget, "earlier"),
			},
			{
				value: "later",
				label: m().moveLater,
				icon: "arrow-right",
				disabled: busy || index === widgets().length - 1,
				onSelect: () => move(widget, "later"),
			},
			...(options.pageItems?.(widget) ?? []),
			{
				value: "remove",
				label: common().remove,
				icon: "trash",
				disabled: busy,
				onSelect: () => removeIds([widget.widgetId]),
			},
		];
	};

	/** The add menu's types: a research result is only ever saved from Chat, never made here. */
	const addableTypes = (): readonly WidgetType[] =>
		options.types.filter((type) => type !== "research");

	/* ---------- Parts ---------- */

	/** The frame's actions button and menu (`data-widget-actions` names the widget). */
	const ActionsMenu = (props: { readonly widget: W; readonly index: number }): JSX.Element => (
		<ActionMenu
			buttonLabel={m().actionsButton(props.widget.title)}
			menuLabel={m().actionsMenu(props.widget.title)}
			iconTrigger={{
				icon: "three-dots",
				disabled: pending(),
				widgetActions: props.widget.widgetId,
			}}
			items={menuItems(props.widget, props.index)}
		/>
	);

	/** Paste widgets, Undo and the add menu, for the page's header or toolbar. */
	const HeaderButtons = (): JSX.Element => (
		<>
			<IconButton
				label={m().pasteWidgets}
				icon="clipboard"
				disabled={options.clipboard.isEmpty() || pending()}
				onClick={() => pasteAfter(null)}
			/>
			<IconButton
				label={common().undo}
				icon="arrow-counterclockwise"
				disabled={!session.undoAvailable() || pending()}
				onClick={() => void session.undo()}
			/>
			<ActionMenu
				buttonLabel={m().addWidget}
				menuLabel={m().addWidget}
				iconTrigger={{ icon: "plus-lg", disabled: pending() }}
				items={addableTypes().map(
					(type): ActionMenuItem => ({
						value: type,
						label: typeWords().typeLabel(type),
						onSelect: () => addType(type),
					}),
				)}
			/>
		</>
	);

	/** The toolbar over a selection; `children` adds the page's own actions first (Ask AI). */
	const SelectionToolbar = (props: { readonly children?: JSX.Element }): JSX.Element => (
		<Show when={session.selection().length > 0}>
			<div
				role="toolbar"
				aria-label={m().selectedWidgets}
				class="flex flex-wrap items-center gap-1 rounded bg-slate-100 p-1"
			>
				<span class="px-1 text-xs text-slate-700">
					{m().selectedCount(session.selection().length)}
				</span>
				{props.children}
				<IconButton
					label={m().duplicateSelected}
					icon="plus-square"
					disabled={pending()}
					onClick={() => duplicateIds(orderedSelection())}
				/>
				<IconButton
					label={m().cutSelected}
					icon="scissors"
					disabled={pending()}
					onClick={() => cutIds(orderedSelection())}
				/>
				<IconButton
					label={m().copySelected}
					icon="copy"
					onClick={() => copyIds(orderedSelection())}
				/>
				<IconButton
					label={m().removeSelected}
					icon="trash"
					disabled={pending()}
					onClick={() => removeIds(orderedSelection())}
				/>
				<IconButton
					label={m().clearSelection}
					icon="x-lg"
					onClick={() => session.select(null, "replace")}
				/>
			</div>
		</Show>
	);

	/** The move announcer, the action live region and the paste notice. */
	const Announcements = (): JSX.Element => (
		<>
			<Show when={pasteNotice()}>
				{(text) => (
					<Notice tone="info">
						<span class="flex flex-wrap items-center gap-2">
							<span>{text()}</span>
							<button type="button" class={BUTTON} onClick={() => setPasteNotice(null)}>
								{m().dismiss}
							</button>
						</span>
					</Notice>
				)}
			</Show>
			<MoveAnnouncerView message={announcer.message()} />
			<output aria-live="polite" class="sr-only">
				{actionMessage()}
			</output>
		</>
	);

	/** The content editor and the market dialog. */
	const Dialogs = (): JSX.Element => (
		<>
			<Show when={editing()}>
				{(widget) => (
					<ContentWidgetEditor
						widget={widgetCoreOf(widget())}
						opener={editorOpener()}
						onSave={(core) => session.replaceWidget(core)}
						onClose={() => setEditorId(null)}
					/>
				)}
			</Show>
			<MarketWidgetDialog
				state={marketDialog()}
				opener={marketOpener()}
				widgets={widgets()}
				limits={options.marketLimits}
				catalog={catalog()}
				catalogState={catalogState()}
				seriesById={options.seriesById()}
				onSave={saveMarketDialog}
				onClose={() => setMarketDialog(null)}
			/>
		</>
	);

	return {
		/** Stable per-id grid entries (an autosave never re-creates a frame). */
		entries,
		pending,
		/** True while one of the board's dialogs is open. */
		dialogOpen: (): boolean => editorId() !== null || marketDialog() !== null,
		isSelected: (widgetId: string): boolean => session.selection().includes(widgetId),
		select: session.select,
		onDrop,
		onSectionKeyDown,
		/** Registers the page section: the clipboard shortcuts act inside it. */
		attach: (element: HTMLElement): void => {
			scopeElement = element;
		},
		saveText,
		saveMarketWidget,
		ActionsMenu,
		HeaderButtons,
		SelectionToolbar,
		Announcements,
		Dialogs,
	};
}

export type WidgetBoard<W extends WidgetCore> = ReturnType<typeof createWidgetBoard<W>>;

function isOrigin(value: unknown): value is NotebookWidgetOrigin {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		(value.kind === "owner" || value.kind === "assistant" || value.kind === "chat")
	);
}
