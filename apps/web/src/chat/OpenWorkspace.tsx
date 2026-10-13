import type { UiRegistry } from "@research/ui-registry";
import { createEffect, createMemo, createSignal, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { Canvas } from "../canvas/Canvas.tsx";
import {
	BUTTON,
	CHAT_PANEL,
	ErrorNotice,
	Loading,
	Notice,
	PanelCollapseButton,
	PanelHeader,
} from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import { createWorkspaceSession, type WorkspaceSession } from "../lib/session.ts";
import { Composer } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";
import { RecordsDrawer } from "./RecordsDrawer.tsx";

export interface OpenWorkspaceProps {
	readonly api: ApiClient;
	readonly registry: UiRegistry;
	readonly visibility: VisibilitySource;
	readonly workspaceId: string;
	readonly listTitle: string | null;
	readonly onActivity: () => void;
	readonly focusNonce: number;
	readonly canvasCollapsed: () => boolean;
	readonly onToggleCanvas: () => void;
	readonly mobileTab: () => "chat" | "canvas";
	readonly wide: () => boolean;
}

/**
 * One open conversation with ONE workspace session shared by its Chat and
 * Canvas panels (no duplicated polling). The thread and the canvas read from
 * the same `view`, `conversation` and `runs` signals, so a poll that changes
 * nothing updates neither.
 */
export function OpenWorkspace(props: OpenWorkspaceProps): JSX.Element {
	const session: WorkspaceSession = createWorkspaceSession(
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
			queueMicrotask(() => {
				const box = document.querySelector('form[aria-label="Research composer"] textarea');
				if (box instanceof HTMLElement) box.focus();
			});
		}
	});

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
			class="flex min-h-0 min-w-0 flex-1 flex-col rounded bg-white px-3 pb-0 pt-3 lg:p-3"
		>
			{notices()}
			<div class="flex min-w-0 flex-wrap items-baseline gap-2">
				<h3 class="min-w-0 flex-1 truncate text-base font-semibold text-slate-900" title={title()}>
					{title()}
				</h3>
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
					onSelectSuggestion={(text) => {
						suggestionNonce += 1;
						setSuggestion({ text, nonce: suggestionNonce });
					}}
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

	const canvasBody = () => (
		<Show when={session.view()} fallback={<Loading label="canvas" />}>
			{(view) => (
				<Canvas
					view={view()}
					registry={props.registry}
					busy={session.commandPending()}
					onOperation={(operation) => void session.dispatch(operation)}
				/>
			)}
		</Show>
	);

	const canvasPanel = () => (
		<Show
			when={!props.canvasCollapsed()}
			fallback={
				<div
					class={`${CHAT_PANEL} hidden flex-col items-center gap-2 lg:flex`}
					data-panel="canvas-rail"
				>
					<PanelCollapseButton
						label="Expand Canvas panel"
						expanded={false}
						onToggle={props.onToggleCanvas}
						side="right"
					/>
				</div>
			}
		>
			<section
				aria-label="Canvas"
				data-panel="canvas"
				aria-busy={session.commandPending()}
				class={`${CHAT_PANEL} hidden min-h-0 min-w-0 flex-col lg:flex`}
			>
				<PanelHeader
					title="Canvas"
					expanded={true}
					collapseLabel="Collapse Canvas panel"
					expandLabel="Expand Canvas panel"
					onToggle={props.onToggleCanvas}
					side="right"
				/>
				<div class="mt-2 min-h-0 flex-1 overflow-y-auto">{canvasBody()}</div>
			</section>
		</Show>
	);

	// Wide layout renders both panels from this one session; narrow layout
	// renders one tab at a time (the hidden tab's heavy content stays
	// unmounted). The session lives in this component, outside the layout
	// branch, so crossing the `lg` breakpoint swaps the layout without
	// recreating the session (no duplicated polling, no loading flash).
	return (
		<Show
			when={props.wide()}
			fallback={
				<div
					id={props.mobileTab() === "chat" ? "chat-panel-mobile" : "canvas-panel-mobile"}
					role="tabpanel"
					aria-labelledby={props.mobileTab() === "chat" ? "chat-tab-mobile" : "canvas-tab-mobile"}
					class="flex min-w-0 flex-1 flex-col lg:hidden"
				>
					<Show
						when={props.mobileTab() === "chat"}
						fallback={
							<section
								aria-label="Canvas"
								data-panel="canvas"
								class={`${CHAT_PANEL} flex min-h-0 flex-col`}
							>
								<h3 class="text-sm font-semibold text-slate-900">Canvas</h3>
								<div class="mt-2">{canvasBody()}</div>
							</section>
						}
					>
						{chatPanel()}
					</Show>
				</div>
			}
		>
			{chatPanel()}
			{canvasPanel()}
		</Show>
	);
}
