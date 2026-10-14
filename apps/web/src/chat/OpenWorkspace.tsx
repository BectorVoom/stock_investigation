import type {
	NotebookAssistResponse,
	NotebookTurn,
	NotebookWidgetCore,
	NotebookWidgetOrigin,
} from "@research/contracts";
import { isTerminalJobState } from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import { createEffect, createMemo, createSignal, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiResult } from "../api/http.ts";
import { BUTTON, CHAT_PANEL, ErrorNotice, Notice, PanelCollapseButton } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import { createWorkspaceSession, type WorkspaceSession } from "../lib/session.ts";
import { NotebookPanel } from "../notebook/NotebookPanel.tsx";
import { widgetFromAnswer } from "../notebook/notebookModel.ts";
import { createNotebookSession, type NotebookSession } from "../notebook/notebookSession.ts";
import type { WorkspaceMode } from "../notebook/types.ts";
import {
	dismissNotebookSuggest,
	isNotebookSuggestDismissed,
	isKeptRemoval as isStoredKeptRemoval,
	readKeptRemovals,
	rememberKeptRemoval,
} from "../notebook/workspaceMode.ts";
import { Composer, type ComposerTarget } from "./Composer.tsx";
import { Conversation, type Message } from "./Conversation.tsx";
import { focusComposerBox } from "./composerFocus.ts";
import { ModeSwitch } from "./ModeSwitch.tsx";
import { RecordsDrawer } from "./RecordsDrawer.tsx";

export interface OpenWorkspaceProps {
	readonly api: ApiClient;
	readonly registry: UiRegistry;
	readonly visibility: VisibilitySource;
	readonly workspaceId: string;
	readonly listTitle: string | null;
	readonly onActivity: () => void;
	readonly focusNonce: number;
	readonly mode: WorkspaceMode;
	readonly onModeChange: (mode: WorkspaceMode) => void;
	readonly wide: () => boolean;
	readonly secondaryCollapsed: () => boolean;
	readonly onToggleSecondary: () => void;
}

/**
 * One open conversation in exactly two states — Chat-first or
 * Notebook-first — over ONE workspace session and ONE notebook session
 * shared by both panels (no duplicated polling). Switching states changes
 * only proportions and visibility: both panels stay mounted in the same DOM
 * order, so the thread, the composer draft, the selection and scroll
 * positions survive. The notebook session is created once here, next to the
 * workspace session, and never re-created by a layout change.
 */
export function OpenWorkspace(props: OpenWorkspaceProps): JSX.Element {
	const session: WorkspaceSession = createWorkspaceSession(
		props.api,
		props.workspaceId,
		props.visibility,
	);
	const notebookSession: NotebookSession = createNotebookSession(
		props.api,
		props.workspaceId,
		props.visibility,
	);
	const agents = createRemote(() => props.api.listAgents());
	// Saved agent choices (backend, model, effort, limits, web access): loaded
	// once per mount, so returning from Settings → AI agent fetches them again.
	const agentSettings = createRemote(() => props.api.getAgentSettings());
	const [recordsRunId, setRecordsRunId] = createSignal<string | null>(null);
	const [recordsOpener, setRecordsOpener] = createSignal<HTMLElement | null>(null);
	const openRecords = (runId: string, opener: HTMLElement | null) => {
		setRecordsOpener(() => opener);
		setRecordsRunId(runId);
	};
	const closeRecords = () => {
		setRecordsRunId(null);
		setRecordsOpener(() => null);
	};
	const recordsRun = createMemo(() => session.runs().find((run) => run.runId === recordsRunId()));
	const title = createMemo(
		() => props.listTitle ?? session.view()?.workspace.title ?? props.workspaceId,
	);
	// A suggestion chip fills the input without sending; the nonce retriggers the effect.
	const [suggestion, setSuggestion] = createSignal<{
		readonly text: string;
		readonly nonce: number;
	} | null>(null);
	let suggestionNonce = 0;

	// The composer target: the owner's manual choice wins; otherwise Notebook
	// when Notebook-first or when widgets are selected, Research otherwise.
	const [targetManual, setTargetManual] = createSignal<ComposerTarget | null>(null);
	const target = createMemo((): ComposerTarget => {
		const manual = targetManual();
		if (manual !== null) return manual;
		if (props.mode === "notebook" || notebookSession.selection().length > 0) return "notebook";
		return "research";
	});
	const selectedWidgets = createMemo(() => {
		const ids = new Set(notebookSession.selection());
		return notebookSession
			.widgets()
			.filter((widget) => ids.has(widget.widgetId))
			.map((widget) => ({ widgetId: widget.widgetId, title: widget.title }));
	});

	// Assistant-proposed removals the owner kept, remembered per workspace.
	const [kept, setKept] = createSignal<Readonly<Record<string, true>>>(
		readKeptRemovals(props.workspaceId),
	);
	// "Add to Notebook" saves in flight, by component or message id.
	const [savingNotebookIds, setSavingNotebookIds] = createSignal<readonly string[]>([]);
	// Undo in flight, by assistant run id.
	const [undoPendingRunId, setUndoPendingRunId] = createSignal<string | null>(null);
	// The quiet "notebook is taking shape" suggestion, dismissed per workspace.
	const [suggestDismissed, setSuggestDismissed] = createSignal(
		isNotebookSuggestDismissed(props.workspaceId),
	);
	const showSuggest = () =>
		props.mode === "chat" && notebookSession.widgets().length >= 3 && !suggestDismissed();

	// When a notebook-assist run reaches a terminal state the notebook changed
	// on the server: reload once per run (the session's own polling is for the
	// thread; no second poller is added).
	const assistReloaded = new Set<string>();
	createEffect(() => {
		let fresh = false;
		for (const run of session.runs()) {
			if (
				run.kind === "notebook-assist" &&
				isTerminalJobState(run.state) &&
				!assistReloaded.has(run.runId)
			) {
				assistReloaded.add(run.runId);
				fresh = true;
			}
		}
		if (fresh) void notebookSession.reload();
	});

	// New-chat focus: after the New chat button opens a conversation, focus
	// moves to the question input. The nonce identifies the request; the
	// effect runs when the composer for this workspace is mounted.
	const focusWanted = createMemo(() => props.focusNonce);
	let focusedNonce = 0;
	createEffect(() => {
		const nonce = focusWanted();
		if (nonce === 0 || nonce === focusedNonce) return;
		if (nonce > 0) {
			focusedNonce = nonce;
			// The composer mounts with this workspace; focus after Solid commits it.
			// The guard keeps a late effect from stealing focus the owner has
			// since taken (e.g. the chat rename input, which saves on blur).
			queueMicrotask(() => {
				focusComposerBox();
			});
		}
	});

	const trackNotebookSave = (id: string, save: () => Promise<unknown>): void => {
		setSavingNotebookIds((current) => [...current, id]);
		void save().finally(() => {
			setSavingNotebookIds((current) => current.filter((entry) => entry !== id));
		});
	};

	const addComponent = (core: NotebookWidgetCore, origin: NotebookWidgetOrigin): void => {
		trackNotebookSave(origin.componentId ?? core.widgetId, () =>
			notebookSession.addWidget(core, origin),
		);
	};

	const addAnswer = (message: Message): void => {
		trackNotebookSave(message.messageId, () =>
			notebookSession.addWidget(widgetFromAnswer(message), {
				kind: "chat",
				messageId: message.messageId,
				runId: message.runId,
				componentId: null,
			}),
		);
	};

	const answerInNotebook = (messageId: string): boolean =>
		notebookSession
			.widgets()
			.some(
				(widget) => widget.origin.messageId === messageId && widget.origin.componentId === null,
			);

	const componentInNotebook = (componentId: string): boolean =>
		notebookSession.widgets().some((widget) => widget.origin.componentId === componentId);

	const undoTurn = (turn: NotebookTurn): void => {
		const version = notebookSession.state()?.version ?? 0;
		if (turn.appliedVersion === null || version !== turn.appliedVersion) return;
		if (undoPendingRunId() !== null) return;
		setUndoPendingRunId(turn.runId);
		void notebookSession.undo().finally(() => setUndoPendingRunId(null));
	};

	const keepRemoval = (runId: string, widgetIds: readonly string[]): void => {
		let next = kept();
		for (const widgetId of widgetIds) {
			next = rememberKeptRemoval(props.workspaceId, next, runId, widgetId);
		}
		setKept(next);
	};

	/** "Ask AI" on widgets: selects them, targets the Notebook assistant, focuses the composer. */
	const askAssistant = (widgetIds: readonly string[]): void => {
		notebookSession.select(null, "replace");
		for (const widgetId of widgetIds) notebookSession.select(widgetId, "toggle");
		setTargetManual("notebook");
		focusComposerBox();
		// Fallback for engines where the panel is still committing: retry once.
		setTimeout(() => {
			focusComposerBox();
		}, 100);
	};

	const submitNotebook = (
		instruction: string,
		idempotencyKey: string,
	): Promise<ApiResult<NotebookAssistResponse>> => {
		const result = props.api.assistNotebook(
			props.workspaceId,
			{
				instruction,
				selectedWidgetIds: [...notebookSession.selection()],
				notebookVersion: notebookSession.state()?.version ?? 0,
			},
			idempotencyKey,
		);
		void result.then((outcome) => {
			if (outcome.ok) props.onActivity();
		});
		return result;
	};

	/** Navigates to where a widget came from: its chat message, scrolled to and briefly lit. */
	const openOrigin = (origin: NotebookWidgetOrigin): void => {
		if (origin.messageId === null) return;
		const messageId = origin.messageId;
		if (!props.wide()) props.onModeChange("chat");
		queueMicrotask(() => {
			const element = document.querySelector(`[data-message-id="${messageId}"]`);
			if (!(element instanceof HTMLElement)) return;
			if (typeof element.scrollIntoView === "function") {
				element.scrollIntoView({ block: "center" });
			}
			// A shape as well as a colour (an outline), removed shortly after.
			element.classList.add("ring-2", "ring-blue-700", "rounded");
			setTimeout(() => element.classList.remove("ring-2", "ring-blue-700", "rounded"), 1600);
		});
	};

	const notices = () => (
		<>
			<Show when={session.notice()}>
				{(notice) => (
					<div class="mb-2 flex items-start gap-2">
						<div class="min-w-0 flex-1">
							<Show when={notice().failure} fallback={<Notice tone="info">{notice().text}</Notice>}>
								{(failure) => <ErrorNotice failure={failure()} title={notice().text} />}
							</Show>
						</div>
						<button type="button" class={BUTTON} onClick={() => session.dismissNotice()}>
							Dismiss
						</button>
					</div>
				)}
			</Show>
			<Show when={session.loadError()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title="Could not load this conversation."
						onRetry={() => void session.reload()}
					/>
				)}
			</Show>
			<Show when={session.conversationError()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title="Could not load the messages."
						onRetry={() => void session.reload()}
					/>
				)}
			</Show>
		</>
	);

	const notebookStates = () => (
		<>
			<Show when={notebookSession.notice()}>
				{(notice) => (
					<div class="mb-2 flex items-start gap-2">
						<div class="min-w-0 flex-1">
							<Show when={notice().failure} fallback={<Notice tone="info">{notice().text}</Notice>}>
								{(failure) => <ErrorNotice failure={failure()} title={notice().text} />}
							</Show>
						</div>
						<button type="button" class={BUTTON} onClick={() => notebookSession.dismissNotice()}>
							Dismiss
						</button>
					</div>
				)}
			</Show>
			<Show when={notebookSession.loadError()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title="Could not load the notebook."
						onRetry={() => void notebookSession.reload()}
					/>
				)}
			</Show>
		</>
	);

	// Below `lg` only the active state shows; at `lg` and up both panels show
	// side by side. Both stay mounted either way: only classes change, so a
	// state switch re-creates nothing. A collapsed secondary panel unmounts
	// to its rail (at `lg`); the flag only applies while that panel is
	// secondary, so switching states can never strand a hidden panel.
	const chatVisible = () => props.mode === "chat" || !props.secondaryCollapsed();
	const notebookVisible = () => props.mode === "notebook" || !props.secondaryCollapsed();

	const chatPanel = () => (
		// WHY `px-3 pb-0 pt-3 lg:p-3` instead of `CHAT_PANEL` (p-3): on narrow
		// screens the composer is pinned to the viewport bottom and the E2E
		// tall-narrow test budgets 24 px below it. The stacked bottom
		// paddings (composer wrapper, panel, page) already reach 33 px; the
		// panel keeps its card look through the fill and side/top padding
		// while the composer rests at the bottom. At `lg` the composer is
		// static inside the panel, so the full p-3 returns.
		<section
			aria-label="Chat"
			data-panel="chat"
			class="min-h-0 min-w-0 flex-1 flex-col rounded bg-white px-3 pb-0 pt-3 lg:p-3"
			classList={{
				flex: props.mode === "chat",
				"hidden lg:flex": props.mode === "notebook",
			}}
		>
			{notices()}
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<h3 class="min-w-0 flex-1 truncate text-base font-semibold text-slate-900" title={title()}>
					{title()}
				</h3>
				<ModeSwitch mode={props.mode} onChange={props.onModeChange} />
				<Show when={props.mode === "notebook"}>
					<PanelCollapseButton
						label="Collapse Chat panel"
						expanded={true}
						onToggle={props.onToggleSecondary}
						side="left"
					/>
				</Show>
			</div>
			<div class="flex min-h-0 min-w-0 flex-1 flex-col">
				<Conversation
					conversation={session.conversation()}
					hasEarlier={session.hasEarlierMessages()}
					loadingEarlier={session.loadingEarlier()}
					earlierError={session.earlierError()}
					onLoadEarlier={() => void session.loadEarlierMessages()}
					runs={session.runs()}
					agents={agents.value()}
					onCancel={session.cancelRun}
					onRetry={session.retryRun}
					onApprove={session.approveRun}
					onOpenRecords={openRecords}
					showSuggestions={target() === "research"}
					onSelectSuggestion={(text) => {
						suggestionNonce += 1;
						setSuggestion({ text, nonce: suggestionNonce });
					}}
					view={session.view()}
					registry={props.registry}
					turns={notebookSession.turns()}
					notebookVersion={notebookSession.state()?.version ?? 0}
					onSelectComponent={(componentId, itemKey) =>
						void session.dispatch({ operation: "component.select", componentId, itemKey })
					}
					onAddComponent={addComponent}
					onAddAnswer={addAnswer}
					answerInNotebook={answerInNotebook}
					componentInNotebook={componentInNotebook}
					savingNotebookIds={savingNotebookIds()}
					onUndoTurn={undoTurn}
					undoPendingRunId={undoPendingRunId()}
					onRemoveWidgets={(ids) => void notebookSession.removeWidgets(ids)}
					onKeepRemoval={keepRemoval}
					isKeptRemoval={(runId, widgetId) => isStoredKeptRemoval(kept(), runId, widgetId)}
					composer={
						<Composer
							workspaceId={props.workspaceId}
							agents={agents.state()}
							settings={agentSettings.state()}
							onReloadAgents={() => void agents.reload()}
							onReloadSettings={() => void agentSettings.reload()}
							newIdempotencyKey={props.api.newIdempotencyKey}
							onSubmit={async (request, key) => {
								const result = await session.submitRun(request, key);
								if (result.ok) props.onActivity();
								return result;
							}}
							suggestion={suggestion}
							runs={session.runs()}
							target={target()}
							onTargetChange={setTargetManual}
							selection={selectedWidgets()}
							onRemoveSelection={(widgetId) => {
								if (notebookSession.selection().includes(widgetId)) {
									notebookSession.select(widgetId, "toggle");
								}
							}}
							onSubmitNotebook={submitNotebook}
						/>
					}
				/>
			</div>
			<Show when={recordsRunId()} keyed>
				{(runId) => (
					<RecordsDrawer
						api={props.api}
						runId={runId}
						startedAt={recordsRun()?.createdAt ?? null}
						opener={recordsOpener()}
						onClose={closeRecords}
					/>
				)}
			</Show>
		</section>
	);

	const notebookPanel = () => (
		<div
			data-panel="notebook"
			class="min-h-0 min-w-0 flex-1 flex-col rounded bg-white px-3 pb-0 pt-3 lg:p-3"
			classList={{
				flex: props.mode === "notebook",
				"hidden lg:flex": props.mode === "chat",
			}}
		>
			{notebookStates()}
			<Show when={showSuggest()}>
				<p class="mb-1 text-xs text-slate-600">
					Your notebook is taking shape —{" "}
					<button
						type="button"
						class="min-h-6 text-blue-800 underline"
						onClick={() => props.onModeChange("notebook")}
					>
						Focus Notebook
					</button>{" "}
					<button
						type="button"
						aria-label="Dismiss suggestion"
						title="Dismiss suggestion"
						class="min-h-6 text-blue-800 underline"
						onClick={() => {
							dismissNotebookSuggest(props.workspaceId);
							setSuggestDismissed(true);
						}}
					>
						Dismiss
					</button>
				</p>
			</Show>
			<div class="flex min-h-0 min-w-0 flex-1 flex-col">
				<NotebookPanel
					session={notebookSession}
					api={props.api}
					registry={props.registry}
					view={session.view()}
					mode={props.mode}
					onAskAssistant={askAssistant}
					onOpenOrigin={openOrigin}
					headerActions={
						<>
							<ModeSwitch mode={props.mode} onChange={props.onModeChange} />
							<Show when={props.mode === "chat"}>
								<PanelCollapseButton
									label="Collapse Notebook panel"
									expanded={true}
									onToggle={props.onToggleSecondary}
									side="right"
								/>
							</Show>
						</>
					}
				/>
			</div>
		</div>
	);

	const chatRail = () => (
		<div class={`${CHAT_PANEL} hidden flex-col items-center gap-2 lg:flex`} data-panel="chat-rail">
			<PanelCollapseButton
				label="Expand Chat panel"
				expanded={false}
				onToggle={props.onToggleSecondary}
				side="left"
			/>
		</div>
	);

	const notebookRail = () => (
		<div
			class={`${CHAT_PANEL} hidden flex-col items-center gap-2 lg:flex`}
			data-panel="notebook-rail"
		>
			<PanelCollapseButton
				label="Expand Notebook panel"
				expanded={false}
				onToggle={props.onToggleSecondary}
				side="right"
			/>
		</div>
	);

	// One tree for both breakpoints: `wide` only changes the tabpanel
	// chrome, never the panels, so crossing `lg` (like switching states)
	// swaps no sessions and remounts nothing.
	const tabPanelProps = (): Record<string, string> =>
		props.wide()
			? {}
			: {
					role: "tabpanel",
					id: props.mode === "chat" ? "chat-panel-mobile" : "notebook-panel-mobile",
					"aria-labelledby": props.mode === "chat" ? "chat-tab-mobile" : "notebook-tab-mobile",
				};
	return (
		<div {...tabPanelProps()} class="flex min-w-0 flex-1 flex-col lg:contents">
			<Show when={chatVisible()} fallback={chatRail()}>
				{chatPanel()}
			</Show>
			<Show when={notebookVisible()} fallback={notebookRail()}>
				{notebookPanel()}
			</Show>
		</div>
	);
}
