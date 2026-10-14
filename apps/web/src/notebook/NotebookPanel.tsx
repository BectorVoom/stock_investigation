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
import { createSignal, type JSX, Match, Show, Switch } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import {
	ActionMenu,
	BUTTON,
	ConfirmDialog,
	Empty,
	ErrorNotice,
	IconButton,
	Loading,
	Notice,
} from "../components/ui.tsx";
import { ensureHomeIconLibraries } from "../home/shoelace.ts";
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
	const selection = () => props.session.selection();
	const announcer = createMoveAnnouncer();
	const [editorId, setEditorId] = createSignal<string | null>(null);
	const [editorOpener, setEditorOpener] = createSignal<HTMLElement | null>(null);
	const [removeIds, setRemoveIds] = createSignal<readonly string[] | null>(null);
	const [removeOpener, setRemoveOpener] = createSignal<HTMLElement | null>(null);
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

	const openRemove = (ids: readonly string[]): void => {
		const active = document.activeElement;
		setRemoveOpener(active instanceof HTMLElement ? active : null);
		setRemoveIds([...ids]);
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
		if (editorId() !== null || removeIds() !== null) return;
		const target = event.target;
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

	return (
		<section
			aria-label="Notebook"
			data-panel="notebook"
			data-mode={props.mode}
			class="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
			onKeyDown={onSectionKeyDown}
		>
			<div class="flex items-center gap-1">
				<h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
					Notebook
					<span class="font-normal text-slate-600"> ({widgets().length})</span>
				</h3>
				{props.headerActions}
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
						icon="copy"
						onClick={() => duplicateMany(selection())}
					/>
					<IconButton
						label="Remove selected widgets"
						icon="trash"
						onClick={() => openRemove(selection())}
					/>
					<IconButton
						label="Clear selection"
						icon="x-lg"
						onClick={() => props.session.select(null, "replace")}
					/>
				</div>
			</Show>

			<MoveAnnouncerView message={announcer.message()} />

			{/* The widget list scrolls on its own below the fixed header and
			    toolbar (the Chat page is viewport-tall from lg up). The
			    bottom padding keeps the last frame's focus ring visible. */}
			<div
				data-notebook-scroll
				class="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2"
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
							widgets={widgets()}
							columnsFrom="container"
							variant="quiet"
							canDrag={!pending()}
							ignoreDragFrom="dialog,input,select,textarea"
							onReorder={onDrop}
						>
							{(widget, index) => (
								<WidgetFrame
									widget={widget}
									titleHidden
									selected={selection().includes(widget.widgetId)}
									onSelectChange={(id, mode) => props.session.select(id, mode)}
									actions={
										<ActionMenu
											buttonLabel={`${widget.title} actions`}
											menuLabel={`Actions for ${widget.title}`}
											iconTrigger={{
												icon: "three-dots",
												disabled: pending(),
												widgetActions: widget.widgetId,
											}}
											items={[
												{
													value: "edit",
													label: "Edit…",
													icon: "pencil",
													disabled: pending(),
													onSelect: () => openEditor(widget.widgetId),
												},
												{
													value: "size-small",
													label: "Size: Small",
													disabled: pending() || widget.size === "small",
													onSelect: () => resize(widget, "small"),
												},
												{
													value: "size-medium",
													label: "Size: Medium",
													disabled: pending() || widget.size === "medium",
													onSelect: () => resize(widget, "medium"),
												},
												{
													value: "size-large",
													label: "Size: Large",
													disabled: pending() || widget.size === "large",
													onSelect: () => resize(widget, "large"),
												},
												{
													value: "duplicate",
													label: "Duplicate",
													icon: "copy",
													disabled: pending(),
													onSelect: () => duplicateOne(widget),
												},
												{
													value: "earlier",
													label: "Move earlier",
													icon: "arrow-left",
													disabled: pending() || index() === 0,
													onSelect: () => move(widget, "earlier"),
												},
												{
													value: "later",
													label: "Move later",
													icon: "arrow-right",
													disabled: pending() || index() === widgets().length - 1,
													onSelect: () => move(widget, "later"),
												},
												{
													value: "ask",
													label: "Ask AI",
													icon: "chat",
													disabled: pending(),
													onSelect: () => props.onAskAssistant([widget.widgetId]),
												},
												...(widget.origin.messageId !== null
													? [
															{
																value: "source",
																label: "Go to source",
																disabled: pending(),
																onSelect: () => props.onOpenOrigin?.(widget.origin),
															},
														]
													: []),
												{
													value: "remove",
													label: "Remove…",
													icon: "trash",
													disabled: pending(),
													onSelect: () => openRemove([widget.widgetId]),
												},
											]}
										/>
									}
								>
									<WidgetBody
										widget={widget}
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

			<Show when={removeIds()}>
				{(ids) => (
					<RemoveWidgetsDialog
						titles={ids().map(
							(id) =>
								widgets().find((widget) => widget.widgetId === id)?.title ?? "Untitled widget",
						)}
						opener={removeOpener()}
						onConfirm={() =>
							props.session.removeWidgets(ids()).then(() => {
								setRemoveIds(null);
							})
						}
						onCancel={() => setRemoveIds(null)}
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

function RemoveWidgetsDialog(props: {
	readonly titles: readonly string[];
	readonly opener: HTMLElement | null;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}): JSX.Element {
	const single = () => props.titles.length === 1;
	return (
		<ConfirmDialog
			title={single() ? `Remove “${props.titles[0]}”?` : `Remove ${props.titles.length} widgets?`}
			opener={props.opener}
			confirmLabel="Remove"
			pending={false}
			failure={null}
			onConfirm={props.onConfirm}
			onCancel={props.onCancel}
		>
			<Show
				when={single()}
				fallback={
					<p>
						This removes the selected widgets from the notebook. This cannot be undone from here;
						use Undo to restore.
					</p>
				}
			>
				<p>
					This removes the widget from the notebook. This cannot be undone from here; use Undo to
					restore.
				</p>
			</Show>
		</ConfirmDialog>
	);
}
