import {
	NOTEBOOK_LIMITS,
	NOTEBOOK_WIDGET_TYPE_META,
	type NotebookWidget,
	type NotebookWidgetCore,
	type NotebookWidgetOrigin,
	notebookWidgetCoreSchema,
	type WorkspaceView,
} from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import {
	createMoveAnnouncer,
	MoveAnnouncerView,
	type WidgetDragDrop,
	WidgetFrame,
	WidgetGrid,
	WidgetSizePicker,
} from "@research/widget-grid";
import {
	createSignal,
	createUniqueId,
	For,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import {
	ActionMenu,
	BUTTON,
	BUTTON_PRIMARY,
	ConfirmDialog,
	Empty,
	ErrorNotice,
	IconButton,
	INPUT,
	LABEL,
	Loading,
	Notice,
} from "../components/ui.tsx";
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
	const widgets = () => props.session.widgets();
	const selection = () => props.session.selection();
	const announcer = createMoveAnnouncer();
	const [editorId, setEditorId] = createSignal<string | null>(null);
	const [editorOpener, setEditorOpener] = createSignal<HTMLElement | null>(null);
	const [removeIds, setRemoveIds] = createSignal<readonly string[] | null>(null);
	const [removeOpener, setRemoveOpener] = createSignal<HTMLElement | null>(null);

	const editing = (): NotebookWidget | null => {
		const id = editorId();
		if (id === null) return null;
		return widgets().find((widget) => widget.widgetId === id) ?? null;
	};

	const openEditor = (widgetId: string): void => {
		const active = document.activeElement;
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

	const undoAvailable = () => props.session.state()?.undoAvailable ?? false;
	const pending = () => props.session.pending();
	const notice = () => props.session.notice();

	return (
		<section
			aria-label="Notebook"
			data-panel="notebook"
			data-mode={props.mode}
			class="min-w-0 space-y-2"
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
								<WidgetBody widget={widget} view={props.view} registry={props.registry} />
							</WidgetFrame>
						)}
					</WidgetGrid>
				</Match>
			</Switch>

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

interface ChartSeriesDraft {
	name: string;
	points: { x: string; y: number }[];
}

/** One native-dialog editor per widget type; validates with the contract schemas before saving. */
function NotebookEditor(props: {
	readonly widget: NotebookWidget;
	readonly opener: HTMLElement | null;
	readonly onSave: (core: NotebookWidgetCore) => Promise<boolean>;
	readonly onClose: () => void;
}): JSX.Element {
	const headingId = createUniqueId();
	let dialog: HTMLDialogElement | undefined;
	const [title, setTitle] = createSignal(props.widget.title);
	const [size, setSize] = createSignal<NotebookWidget["size"]>(props.widget.size);
	const [problems, setProblems] = createSignal<readonly string[]>([]);
	const [saveError, setSaveError] = createSignal<string | null>(null);
	const [saving, setSaving] = createSignal(false);

	// Per-type drafts, initialised once from the widget being edited.
	const [text, setText] = createSignal(props.widget.type === "text" ? props.widget.text : "");
	const [metricValue, setMetricValue] = createSignal(
		props.widget.type === "metric" && props.widget.value !== null ? String(props.widget.value) : "",
	);
	const [metricUnit, setMetricUnit] = createSignal(
		props.widget.type === "metric" ? props.widget.unit : "",
	);
	const [metricChange, setMetricChange] = createSignal(
		props.widget.type === "metric" && props.widget.change !== null
			? String(props.widget.change)
			: "",
	);
	const [metricCaption, setMetricCaption] = createSignal(
		props.widget.type === "metric" ? props.widget.caption : "",
	);
	const [metricAsOf, setMetricAsOf] = createSignal(
		props.widget.type === "metric" ? (props.widget.asOf ?? "") : "",
	);
	const [chartType, setChartType] = createSignal<"line" | "bar">(
		props.widget.type === "chart" ? props.widget.chartType : "line",
	);
	const [chartUnit, setChartUnit] = createSignal(
		props.widget.type === "chart" ? props.widget.unit : "",
	);
	const [chartText, setChartText] = createSignal(
		props.widget.type === "chart" ? seriesToText(props.widget.series) : "",
	);
	const [tableColumns, setTableColumns] = createSignal(
		props.widget.type === "table" ? props.widget.columns.join(", ") : "",
	);
	const [tableRows, setTableRows] = createSignal(
		props.widget.type === "table"
			? props.widget.rows
					.map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join(", "))
					.join("\n")
			: "",
	);

	const closeToOpener = () => {
		props.opener?.focus();
	};

	onMount(() => {
		dialog?.showModal();
	});
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});

	const describeIssues = (
		issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
	): readonly string[] =>
		issues.map((issue) => `${issue.path.map(String).join(".") || "widget"}: ${issue.message}`);

	const save = async (): Promise<void> => {
		setSaveError(null);
		const core = buildCore();
		if (core === null) return;
		const parsed = notebookWidgetCoreSchema.safeParse(core);
		if (!parsed.success) {
			setProblems(describeIssues(parsed.error.issues));
			return;
		}
		setProblems([]);
		setSaving(true);
		try {
			const saved = await props.onSave(parsed.data);
			if (saved) {
				props.onClose();
				closeToOpener();
			} else {
				setSaveError("The widget was not saved. The notebook notice says why.");
			}
		} finally {
			setSaving(false);
		}
	};

	/** Builds the edited core, or null after recording structural parse problems. */
	const buildCore = (): NotebookWidgetCore | null => {
		const widgetId = props.widget.widgetId;
		const trimmedTitle = title().trim();
		const widgetSize = size();
		const widget = props.widget;
		if (widget.type === "text") {
			return { widgetId, type: "text", title: trimmedTitle, size: widgetSize, text: text() };
		}
		if (widget.type === "metric") {
			const value = parseOptionalNumber(metricValue(), "Value");
			if (value === undefined) return null;
			const change = parseOptionalNumber(metricChange(), "Change");
			if (change === undefined) return null;
			const asOf = metricAsOf().trim() === "" ? null : metricAsOf().trim();
			return {
				widgetId,
				type: "metric",
				title: trimmedTitle,
				size: widgetSize,
				value,
				unit: metricUnit(),
				change,
				caption: metricCaption(),
				asOf,
			};
		}
		if (widget.type === "chart") {
			const series = parseSeriesText(chartText());
			if (series === null) return null;
			return {
				widgetId,
				type: "chart",
				title: trimmedTitle,
				size: widgetSize,
				chartType: chartType(),
				unit: chartUnit(),
				series,
			};
		}
		if (widget.type === "table") {
			const parsed = parseTableText(tableColumns(), tableRows());
			if (parsed === null) return null;
			return { widgetId, type: "table", title: trimmedTitle, size: widgetSize, ...parsed };
		}
		// Research widgets are read-only: only the title and size are editable.
		return {
			widgetId,
			type: "research",
			title: trimmedTitle,
			size: widgetSize,
			componentId: (widget as Extract<NotebookWidget, { readonly type: "research" }>).componentId,
		};
	};

	const parseOptionalNumber = (raw: string, field: string): number | null | undefined => {
		const trimmed = raw.trim();
		if (trimmed === "") return null;
		const value = Number(trimmed);
		if (!Number.isFinite(value)) {
			setProblems([`${field}: enter a number or leave it empty.`]);
			return undefined;
		}
		return value;
	};

	const parseSeriesText = (raw: string): ChartSeriesDraft[] | null => {
		const blocks = raw
			.split(/\n\s*\n/)
			.map((block) => block.trim())
			.filter((block) => block.length > 0);
		const errors: string[] = [];
		const series = blocks.flatMap((block, blockIndex) => {
			const lines = block
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			const name = lines[0] ?? "";
			if (name === "") {
				errors.push(`Series ${blockIndex + 1}: give the series a name on its first line.`);
				return [];
			}
			const points = lines.slice(1).flatMap((line, lineIndex) => {
				const comma = line.indexOf(",");
				if (comma < 0) {
					errors.push(`Series "${name}" line ${lineIndex + 1}: use "label, value".`);
					return [];
				}
				const x = line.slice(0, comma).trim();
				const y = Number(line.slice(comma + 1).trim());
				if (x === "" || !Number.isFinite(y)) {
					errors.push(`Series "${name}" line ${lineIndex + 1}: use "label, value" with a number.`);
					return [];
				}
				return [{ x, y }];
			});
			if (points.length === 0) {
				errors.push(`Series "${name}": add at least one "label, value" line.`);
				return [];
			}
			return [{ name, points }];
		});
		if (errors.length > 0) {
			setProblems(errors);
			return null;
		}
		if (series.length === 0) {
			setProblems(['Series: add one block per series: the name, then "label, value" lines.']);
			return null;
		}
		return series;
	};

	const parseTableText = (
		columnsRaw: string,
		rowsRaw: string,
	): { readonly columns: string[]; readonly rows: (string | number | null)[][] } | null => {
		const columns = columnsRaw
			.split(",")
			.map((column) => column.trim())
			.filter((column) => column.length > 0);
		if (columns.length === 0) {
			setProblems(["Columns: list at least one column name, separated by commas."]);
			return null;
		}
		const errors: string[] = [];
		const rows = rowsRaw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line, lineIndex) => {
				const cells = line.split(",").map((cell) => parseTableCell(cell.trim()));
				if (cells.length !== columns.length) {
					errors.push(`Row ${lineIndex + 1}: needs ${columns.length} cells, has ${cells.length}.`);
				}
				return cells;
			});
		if (errors.length > 0) {
			setProblems(errors);
			return null;
		}
		return { columns, rows };
	};

	const problemsId = createUniqueId();

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			class="rounded bg-slate-100 p-4"
			onCancel={(event) => {
				event.preventDefault();
				props.onClose();
				closeToOpener();
			}}
			onClose={() => closeToOpener()}
		>
			<h3 id={headingId} class="text-base font-semibold text-slate-900">
				Edit {NOTEBOOK_WIDGET_TYPE_META[props.widget.type].label.toLowerCase()} widget
			</h3>
			<div class="mt-2 max-w-md space-y-2">
				<Show when={problems().length > 0}>
					<ul
						id={problemsId}
						aria-label="Problems"
						class="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
					>
						<For each={problems()}>{(problem) => <li>{problem}</li>}</For>
					</ul>
				</Show>
				<Show when={saveError()}>{(error) => <p class="text-xs text-red-900">{error()}</p>}</Show>
				<div>
					<label for={`${headingId}-title`} class={LABEL}>
						Title
					</label>
					<input
						id={`${headingId}-title`}
						type="text"
						class={INPUT}
						maxLength={NOTEBOOK_LIMITS.maxTitleChars}
						value={title()}
						onInput={(event) => setTitle(event.currentTarget.value)}
					/>
				</div>
				<WidgetSizePicker
					value={size()}
					sizes={[...NOTEBOOK_WIDGET_TYPE_META[props.widget.type].sizes]}
					label={`Size of “${props.widget.title}”`}
					onChange={setSize}
				/>
				<Switch>
					<Match when={props.widget.type === "text"}>
						<div>
							<label for={`${headingId}-text`} class={LABEL}>
								Text
							</label>
							<textarea
								id={`${headingId}-text`}
								class={INPUT}
								rows={6}
								value={text()}
								onInput={(event) => setText(event.currentTarget.value)}
							/>
						</div>
					</Match>
					<Match when={props.widget.type === "metric"}>
						<div class="space-y-2">
							<div>
								<label for={`${headingId}-value`} class={LABEL}>
									Value (empty means unavailable)
								</label>
								<input
									id={`${headingId}-value`}
									type="text"
									inputmode="decimal"
									class={INPUT}
									value={metricValue()}
									onInput={(event) => setMetricValue(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-unit`} class={LABEL}>
									Unit
								</label>
								<input
									id={`${headingId}-unit`}
									type="text"
									class={INPUT}
									maxLength={NOTEBOOK_LIMITS.maxUnitChars}
									value={metricUnit()}
									onInput={(event) => setMetricUnit(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-change`} class={LABEL}>
									Change (empty means unknown)
								</label>
								<input
									id={`${headingId}-change`}
									type="text"
									inputmode="decimal"
									class={INPUT}
									value={metricChange()}
									onInput={(event) => setMetricChange(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-caption`} class={LABEL}>
									Caption
								</label>
								<input
									id={`${headingId}-caption`}
									type="text"
									class={INPUT}
									maxLength={NOTEBOOK_LIMITS.maxCaptionChars}
									value={metricCaption()}
									onInput={(event) => setMetricCaption(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-asof`} class={LABEL}>
									As-of date (YYYY-MM-DD, empty means unstated)
								</label>
								<input
									id={`${headingId}-asof`}
									type="text"
									inputmode="numeric"
									class={INPUT}
									value={metricAsOf()}
									onInput={(event) => setMetricAsOf(event.currentTarget.value)}
								/>
							</div>
						</div>
					</Match>
					<Match when={props.widget.type === "chart"}>
						<div class="space-y-2">
							<div>
								<label for={`${headingId}-charttype`} class={LABEL}>
									Chart type
								</label>
								<select
									id={`${headingId}-charttype`}
									class="min-h-6 w-full rounded border border-slate-400 bg-white px-2 py-1 text-sm text-slate-900"
									value={chartType()}
									onChange={(event) => setChartType(event.currentTarget.value as "line" | "bar")}
								>
									<option value="line">Line</option>
									<option value="bar">Bar</option>
								</select>
							</div>
							<div>
								<label for={`${headingId}-chartunit`} class={LABEL}>
									Unit
								</label>
								<input
									id={`${headingId}-chartunit`}
									type="text"
									class={INPUT}
									maxLength={NOTEBOOK_LIMITS.maxUnitChars}
									value={chartUnit()}
									onInput={(event) => setChartUnit(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-series`} class={LABEL}>
									Series (one block per series: the name, then “label, value” lines)
								</label>
								<textarea
									id={`${headingId}-series`}
									class={`${INPUT} font-mono`}
									rows={8}
									value={chartText()}
									onInput={(event) => setChartText(event.currentTarget.value)}
								/>
							</div>
						</div>
					</Match>
					<Match when={props.widget.type === "table"}>
						<div class="space-y-2">
							<div>
								<label for={`${headingId}-columns`} class={LABEL}>
									Columns (comma-separated)
								</label>
								<input
									id={`${headingId}-columns`}
									type="text"
									class={INPUT}
									value={tableColumns()}
									onInput={(event) => setTableColumns(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-rows`} class={LABEL}>
									Rows (one line per row, comma-separated)
								</label>
								<textarea
									id={`${headingId}-rows`}
									class={`${INPUT} font-mono`}
									rows={6}
									value={tableRows()}
									onInput={(event) => setTableRows(event.currentTarget.value)}
								/>
							</div>
						</div>
					</Match>
					<Match when={props.widget.type === "research"}>
						<p class="text-xs text-slate-600">
							Research content is read-only; only the title and size can be changed here.
						</p>
					</Match>
				</Switch>
			</div>
			<div class="mt-3 flex gap-2">
				<button
					type="button"
					class={BUTTON}
					disabled={saving()}
					onClick={() => {
						props.onClose();
						closeToOpener();
					}}
				>
					Cancel
				</button>
				<button
					type="button"
					class={BUTTON_PRIMARY}
					disabled={saving()}
					aria-describedby={problems().length > 0 ? problemsId : undefined}
					onClick={() => void save()}
				>
					{saving() ? "Saving…" : "Save widget"}
				</button>
			</div>
		</dialog>
	);
}

function seriesToText(
	series: readonly {
		readonly name: string;
		readonly points: readonly { readonly x: string; readonly y: number }[];
	}[],
): string {
	return series
		.map((entry) =>
			[entry.name, ...entry.points.map((point) => `${point.x}, ${point.y}`)].join("\n"),
		)
		.join("\n\n");
}

function parseTableCell(token: string): string | number | null {
	if (token === "") return null;
	if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
		const value = Number(token);
		if (Number.isFinite(value)) return value;
	}
	return token.slice(0, NOTEBOOK_LIMITS.maxCellChars);
}
