import { DEFAULT_CONVERSATION_TITLE } from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, ErrorNotice, Loading, PANEL } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { ChatsPanel, DeleteChatDialog } from "./ChatsPanel.tsx";
import { byNewestActivity, createConversationList } from "./conversationList.ts";
import { OpenWorkspace } from "./OpenWorkspace.tsx";

/**
 * Chat page: past chats, one open conversation and its canvas in one
 * NotebookLM-style view. Chat and Canvas share ONE workspace session (inside
 * `OpenWorkspace`), so there is no duplicated polling. The selected id lives
 * in the URL hash, so reloading reopens the same conversation from server
 * state without rerunning any research (FR-010).
 */
export function ChatView(props: {
	readonly api: ApiClient;
	readonly registry: UiRegistry;
	readonly visibility: VisibilitySource;
	readonly workspaceId: string | null;
	/** Null opens the page with no conversation selected (the welcome). */
	readonly onSelectConversation: (workspaceId: string | null) => void;
}): JSX.Element {
	const conversations = createConversationList(props.api, props.visibility);
	const ordered = createMemo(() => [...(conversations.value() ?? [])].sort(byNewestActivity));
	const selectedSummary = createMemo(
		() => ordered().find((entry) => entry.workspaceId === props.workspaceId) ?? null,
	);

	// With no conversation in the URL, open the one with the newest activity (URL sync is external).
	createEffect(() => {
		const list = ordered();
		if (props.workspaceId !== null || list.length === 0) return;
		const latest = list[0];
		if (latest !== undefined) props.onSelectConversation(latest.workspaceId);
	});

	const mediaQuery = "(min-width: 1024px)";
	const [wide, setWide] = createSignal(
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia(mediaQuery).matches
			: true,
	);
	createEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(mediaQuery);
		const update = () => setWide(query.matches);
		update();
		query.addEventListener("change", update);
		onCleanup(() => query.removeEventListener("change", update));
	});

	const [chatsCollapsed, setChatsCollapsed] = createSignal(false);
	const [canvasCollapsed, setCanvasCollapsed] = createSignal(false);
	const [mobileTab, setMobileTab] = createSignal<"chat" | "canvas">("chat");

	const [newChatPending, setNewChatPending] = createSignal(false);
	const [newChatError, setNewChatError] = createSignal<ApiFailure | null>(null);
	const [renamingId, setRenamingId] = createSignal<string | null>(null);
	const [renameError, setRenameError] = createSignal<ApiFailure | null>(null);
	const [headerRenaming, setHeaderRenaming] = createSignal(false);
	const [headerRenameError, setHeaderRenameError] = createSignal<ApiFailure | null>(null);
	const [deleteTarget, setDeleteTarget] = createSignal<{
		readonly workspaceId: string;
		readonly title: string;
	} | null>(null);
	const [deleteOpener, setDeleteOpener] = createSignal<HTMLElement | null>(null);
	const [deletePending, setDeletePending] = createSignal(false);
	const [deleteError, setDeleteError] = createSignal<ApiFailure | null>(null);
	const [focusNonce, setFocusNonce] = createSignal(0);

	// The create may still be in flight when the owner leaves Chat: a late
	// response must not pull them back. The conversation appears in the list
	// next time Chat loads.
	let disposed = false;
	let createSeq = 0;
	onCleanup(() => {
		disposed = true;
	});

	const focusComposer = (workspaceId: string) => {
		setFocusNonce((nonce) => nonce + 1);
		// Fallback for engines where the effect runs before mount: retry once.
		setTimeout(() => {
			const box = document.querySelector('form[aria-label="Research composer"] textarea');
			if (box instanceof HTMLElement && document.activeElement !== box) {
				// Only steal focus when the open conversation matches: the
				// timeout may fire after the owner navigated elsewhere.
				if (props.workspaceId === workspaceId) box.focus();
			}
		}, 100);
	};

	const handleNewChat = async () => {
		// Reuse an empty "New chat" instead of creating another one.
		const reusable = ordered().find(
			(entry) => entry.title === DEFAULT_CONVERSATION_TITLE && entry.messageCount === 0,
		);
		if (reusable !== undefined) {
			props.onSelectConversation(reusable.workspaceId);
			focusComposer(reusable.workspaceId);
			return;
		}
		if (newChatPending()) return;
		setNewChatPending(true);
		setNewChatError(null);
		createSeq += 1;
		const seq = createSeq;
		const result = await props.api.createWorkspace();
		if (disposed || seq !== createSeq) return;
		setNewChatPending(false);
		if (result.ok) {
			void conversations.reload();
			props.onSelectConversation(result.value.workspaceId);
			focusComposer(result.value.workspaceId);
		} else {
			setNewChatError(result.error);
		}
	};

	const handleRename = async (workspaceId: string, currentTitle: string, nextRaw: string) => {
		const next = nextRaw.trim();
		// An empty or unchanged title sends no request.
		if (next === "" || next === currentTitle) {
			setRenamingId(null);
			setHeaderRenaming(false);
			return;
		}
		const fromHeader = headerRenaming() && props.workspaceId === workspaceId;
		const result = await props.api.renameWorkspace(workspaceId, next);
		if (disposed) return;
		if (result.ok) {
			setRenamingId(null);
			setHeaderRenaming(false);
			setRenameError(null);
			setHeaderRenameError(null);
			await conversations.reload();
		} else {
			// The old title stays: the list is not reloaded on failure.
			if (fromHeader) setHeaderRenameError(result.error);
			else setRenameError(result.error);
			setRenamingId(null);
			setHeaderRenaming(false);
		}
	};

	const handleRequestDelete = (
		entry: { readonly workspaceId: string; readonly title: string },
		opener: HTMLElement | null,
	) => {
		setDeleteTarget(entry);
		setDeleteOpener(() => opener);
		setDeleteError(null);
		setDeletePending(false);
	};

	const handleConfirmDelete = async () => {
		const target = deleteTarget();
		if (target === null || deletePending()) return;
		setDeletePending(true);
		setDeleteError(null);
		const result = await props.api.deleteWorkspace(target.workspaceId);
		if (disposed) return;
		if (!result.ok) {
			// A 409 (a question is still running) shows the server's message
			// in the dialog and deletes nothing: the dialog stays open.
			setDeleteError(result.error);
			setDeletePending(false);
			return;
		}
		setDeletePending(false);
		setDeleteTarget(null);
		const wasOpen = props.workspaceId === target.workspaceId;
		await conversations.reload();
		if (disposed) return;
		if (wasOpen) {
			const remaining = [...(conversations.value() ?? [])].sort(byNewestActivity);
			// No chats remain: a null selection shows the welcome.
			props.onSelectConversation(remaining[0]?.workspaceId ?? null);
		}
		// Return focus to the opener (the More actions button).
		deleteOpener()?.focus();
	};

	const handleCancelDelete = () => {
		setDeleteTarget(null);
		setDeleteError(null);
		setDeletePending(false);
		deleteOpener()?.focus();
	};

	const gridColumns = () => {
		if (chatsCollapsed() && canvasCollapsed()) return "lg:grid-cols-[3rem_minmax(0,1fr)_3rem]";
		if (chatsCollapsed()) return "lg:grid-cols-[3rem_minmax(0,1fr)_minmax(18rem,26rem)]";
		if (canvasCollapsed()) return "lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_3rem]";
		return "lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(18rem,26rem)]";
	};

	const onMobileTabKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
		event.preventDefault();
		setMobileTab((current) => (current === "chat" ? "canvas" : "chat"));
		// Move focus to the newly selected tab.
		queueMicrotask(() => {
			const next = mobileTab() === "chat" ? "chat-tab-mobile" : "canvas-tab-mobile";
			document.getElementById(next)?.focus();
		});
	};

	const welcome = () => (
		<section aria-label="Chat" data-panel="chat" class={`${PANEL} flex min-w-0 flex-1 flex-col`}>
			<h3 class="text-base font-semibold text-slate-900">Welcome to Chat</h3>
			<p class="mt-1 text-sm text-slate-600">
				Start a new chat to ask a research question. Prior findings stay available here even when
				the local runner is offline.
			</p>
			<div class="mt-2">
				<button
					type="button"
					class={`${BUTTON} inline-flex items-center gap-1`}
					disabled={newChatPending()}
					onClick={() => void handleNewChat()}
				>
					New chat
				</button>
			</div>
			<Show when={newChatError()}>
				{(error) => (
					<div class="mt-1">
						<ErrorNotice failure={error()} title="The chat was not created." />
					</div>
				)}
			</Show>
		</section>
	);

	return (
		// One session per open conversation: `OpenWorkspace` is keyed by
		// workspace id OUTSIDE the narrow/wide branch, so crossing the `lg`
		// breakpoint swaps the layout without recreating the session (no
		// duplicated polling, no loading flash). Only the layout branches;
		// the hidden tab's heavy content stays unmounted in both.
		<div class={`flex min-w-0 flex-1 flex-col gap-3 lg:grid lg:min-h-0 ${gridColumns()}`}>
			<ChatsPanel
				conversations={conversations}
				ordered={ordered}
				selectedId={props.workspaceId}
				onSelect={props.onSelectConversation}
				onNewChat={() => void handleNewChat()}
				newChatPending={newChatPending}
				newChatError={newChatError}
				collapsed={chatsCollapsed}
				onToggleCollapsed={() => setChatsCollapsed((current) => !current)}
				wide={wide}
				renamingId={renamingId}
				onStartRename={(id) => {
					setRenameError(null);
					setRenamingId(id);
				}}
				onRename={(id, current, next) => void handleRename(id, current, next)}
				onCancelRename={() => setRenamingId(null)}
				onRequestDelete={handleRequestDelete}
				renameError={renameError}
			/>
			<Show when={!wide() && props.workspaceId !== null && ordered().length > 0}>
				<div role="tablist" aria-label="Chat or Canvas" onKeyDown={onMobileTabKeyDown}>
					<div class="flex gap-1 lg:hidden">
						<button
							id="chat-tab-mobile"
							type="button"
							role="tab"
							aria-selected={mobileTab() === "chat"}
							aria-controls="chat-panel-mobile"
							class="rounded px-2 py-1 text-sm font-medium"
							classList={{
								"bg-blue-700 text-white": mobileTab() === "chat",
								"text-slate-800 hover:bg-slate-200": mobileTab() !== "chat",
							}}
							onClick={() => setMobileTab("chat")}
						>
							Chat
						</button>
						<button
							id="canvas-tab-mobile"
							type="button"
							role="tab"
							aria-selected={mobileTab() === "canvas"}
							aria-controls="canvas-panel-mobile"
							class="rounded px-2 py-1 text-sm font-medium"
							classList={{
								"bg-blue-700 text-white": mobileTab() === "canvas",
								"text-slate-800 hover:bg-slate-200": mobileTab() !== "canvas",
							}}
							onClick={() => setMobileTab("canvas")}
						>
							Canvas
						</button>
					</div>
				</div>
			</Show>
			<Show
				when={props.workspaceId}
				keyed
				fallback={
					<Show when={conversations.value() !== null && ordered().length === 0}>{welcome()}</Show>
				}
			>
				{(workspaceId) => (
					<OpenWorkspace
						api={props.api}
						registry={props.registry}
						visibility={props.visibility}
						workspaceId={workspaceId}
						listTitle={selectedSummary()?.title ?? null}
						onActivity={() => void conversations.reload()}
						focusNonce={focusNonce()}
						headerRenaming={headerRenaming()}
						onStartHeaderRename={() => {
							setHeaderRenameError(null);
							setHeaderRenaming(true);
						}}
						onRenameHeader={(next) =>
							void handleRename(workspaceId, selectedSummary()?.title ?? "", next)
						}
						onCancelHeaderRename={() => setHeaderRenaming(false)}
						headerRenameError={headerRenameError}
						canvasCollapsed={canvasCollapsed}
						onToggleCanvas={() => setCanvasCollapsed((current) => !current)}
						mobileTab={mobileTab}
						wide={wide}
					/>
				)}
			</Show>
			<Show when={props.workspaceId === null && conversations.value() === null}>
				<Loading label="conversation" />
			</Show>

			<Show when={deleteTarget()} keyed>
				{(target) => (
					<DeleteChatDialog
						target={target}
						opener={deleteOpener}
						pending={deletePending}
						failure={deleteError}
						onConfirm={() => void handleConfirmDelete()}
						onCancel={handleCancelDelete}
					/>
				)}
			</Show>
		</div>
	);
}
