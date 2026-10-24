import {
	NOTEBOOK_LIMITS,
	type NotebookWidget,
	type NotebookWidgetOrigin,
	WIDGET_TYPES,
	type WorkspaceView,
} from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import type { UiRegistry } from "@research/ui-registry";
import { WidgetFrame, WidgetGrid } from "@research/widget-grid";
// The package stylesheet: without it the grid and the frames are unstyled
// markup. Home loads it in its own lazy chunk, so the Chat page imports it too.
import "@research/widget-grid/styles.css";
import { type JSX, Match, Show, Switch } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { BUTTON, Empty, ErrorNotice, IconButton, Loading, Notice } from "../components/ui.tsx";
import { ensureHomeIconLibraries } from "../home/shoelace.ts";
import { WidgetBody } from "../widgets/WidgetBody.tsx";
import { createWidgetBoard } from "../widgets/widgetBoard.tsx";
import { type WidgetClipboardStore, widgetClipboard } from "../widgets/widgetClipboard.ts";
import { notebookPanelMessages } from "./notebook.messages.ts";
import { createNotebookMarketContext } from "./notebookMarket.ts";
import type { NotebookSession } from "./notebookSession.ts";
import type { WorkspaceMode } from "./types.ts";

/**
 * The Notebook panel (ADR-0020): persistent widgets on the shared
 * `@research/widget-grid` package (container columns, quiet variant,
 * untitled frames, header-click selection). One panel, two modes: `chat` is
 * the narrow secondary panel, `notebook` the dominant workspace. Every
 * widget action is the shared board's (ADR-0024), the same as on Home; the
 * Notebook adds Ask AI and Go to source.
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
	 * chats and Home; a test double in tests so clipboard state never leaks
	 * between cases through `localStorage`).
	 */
	readonly clipboard?: WidgetClipboardStore;
	/** Typed backend access for market widgets (series data, refresh, watchlist). */
	readonly api: ApiClient;
}

export function NotebookPanel(props: NotebookPanelProps): JSX.Element {
	// Market widgets reuse Home's Shoelace controls (range select, add/edit
	// form): point the icon libraries at the shipped SVGs like Home does, so
	// no `data:` fetch ever hits `connect-src`. Idempotent.
	ensureHomeIconLibraries();
	const m = useMessages(notebookPanelMessages);
	const widgets = () => props.session.widgets();
	/**
	 * Live market data for the notebook's market widgets (ADR-0021): the
	 * market components in `WidgetBody` read their series through this, the
	 * same shape Home passes them. Loads nothing until the notebook holds a
	 * market widget.
	 */
	const market = createNotebookMarketContext({
		api: props.api,
		workspaceId: () => props.session.state()?.workspaceId ?? null,
		widgets,
	});
	const pending = () => props.session.pending();
	const notice = () => props.session.notice();

	const board = createWidgetBoard<NotebookWidget>({
		session: props.session,
		types: WIDGET_TYPES,
		clipboard: props.clipboard ?? widgetClipboard(),
		scope: () => props.session.state()?.workspaceId ?? null,
		api: props.api,
		seriesById: market.seriesById,
		marketLimits: {
			scope: "notebook",
			maxWidgets: NOTEBOOK_LIMITS.maxWidgets,
			maxSeries: NOTEBOOK_LIMITS.maxMarketSeries,
		},
		pageItems: (widget) => [
			{
				value: "ask",
				label: m().askAi,
				icon: "chat",
				disabled: pending(),
				onSelect: () => props.onAskAssistant([widget.widgetId]),
			},
			...(widget.origin.messageId !== null
				? [
						{
							value: "source",
							label: m().goToSource,
							disabled: pending(),
							onSelect: () => props.onOpenOrigin?.(widget.origin),
						},
					]
				: []),
		],
	});

	return (
		<section
			aria-label={m().notebook}
			data-panel="notebook"
			data-mode={props.mode}
			class="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
			ref={(element) => board.attach(element)}
			onKeyDown={(event) => board.onSectionKeyDown(event)}
		>
			<div class="flex items-center gap-1">
				<h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
					{m().notebook}
					<span class="font-normal text-slate-600"> ({widgets().length})</span>
				</h3>
				{props.headerActions}
				<board.HeaderButtons />
			</div>

			<Show when={notice()}>
				{(item) => (
					<Notice tone={item().failure?.code === "VERSION_CONFLICT" ? "warning" : "error"}>
						<span class="flex flex-wrap items-center gap-2">
							<span>{item().text}</span>
							<button type="button" class={BUTTON} onClick={() => props.session.dismissNotice()}>
								{m().dismiss}
							</button>
						</span>
					</Notice>
				)}
			</Show>

			<board.SelectionToolbar>
				<IconButton
					label={m().askAboutSelected}
					icon="chat"
					onClick={() => props.onAskAssistant(props.session.selection())}
				/>
			</board.SelectionToolbar>

			<board.Announcements />

			{/* The widget list scrolls on its own below the fixed header and
			    toolbar (the Chat page is viewport-tall from lg up). The
			    bottom padding keeps the last frame's focus ring visible. */}
			<div
				data-notebook-scroll
				class="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pt-3 pb-2"
			>
				<Switch>
					<Match when={props.session.state() === null && props.session.loadError() === null}>
						<Loading label={m().loadingLabel} />
					</Match>
					<Match when={props.session.loadError()}>
						{(error) => (
							<ErrorNotice
								failure={error()}
								title={m().loadFailed}
								onRetry={() => void props.session.reload()}
							/>
						)}
					</Match>
					<Match when={widgets().length === 0}>
						<Empty>{m().empty}</Empty>
					</Match>
					<Match when={widgets().length > 0}>
						<WidgetGrid
							widgets={board.entries()}
							columnsFrom="container"
							variant="quiet"
							canDrag={!pending()}
							ignoreDragFrom="dialog,input,select,textarea,[data-rich-text-editor]"
							onReorder={board.onDrop}
						>
							{(entry, index) => (
								<WidgetFrame
									widget={entry}
									titleHidden
									selected={board.isSelected(entry.widgetId)}
									onSelectChange={(id, mode) => board.select(id, mode)}
									actions={<board.ActionsMenu widget={entry.widget} index={index()} />}
								>
									<WidgetBody
										widget={entry.widget}
										view={props.view}
										registry={props.registry}
										market={market}
										editingDisabled={pending()}
										onSaveText={board.saveText}
										onSaveMarketWidget={board.saveMarketWidget}
									/>
								</WidgetFrame>
							)}
						</WidgetGrid>
					</Match>
				</Switch>
			</div>

			<board.Dialogs />
		</section>
	);
}
